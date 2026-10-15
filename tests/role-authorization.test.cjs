const jwt = require('jsonwebtoken');
const assert = require('assert');
const http = require('http');

const JWT_SECRET = process.env.JWT_SECRET || 'aicloser-super-secure-production-jwt-secret-2026-key';
const API_PORT = process.env.PORT || '3060';
const BASE_HOST = process.env.TEST_HOST || '127.0.0.1';

function makeToken(user) {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '1h' });
}

function apiRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: BASE_HOST,
        port: Number(API_PORT),
        path: options.path,
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          ...(options.headers || {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, data: JSON.parse(body) });
          } catch {
            resolve({ statusCode: res.statusCode, raw: body });
          }
        });
      }
    );
    req.on('error', reject);
    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

async function runRoleAuthorizationTests() {
  console.log('===================================================================');
  console.log('🧪 RUNNING AICLOSER-API ROLE & PERMISSION AUTHORIZATION MATRIX SUITE ');
  console.log('===================================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     Error: ${err.message}`);
      failed++;
    }
  }

  // Workspaces
  const tenantA = 'tenant-the-storage-test-1d01dda2';
  const tenantB = 'tenant-jay-estate-management-01773ec9';

  // Tokens for different roles in Tenant A
  const tokenAdminA = makeToken({
    userId: 'usr-admin-a',
    role: 'ADMIN',
    tenantId: tenantA,
    displayName: 'Admin Tenant A',
    phone: '+919999000001',
  });

  const tokenManagerA = makeToken({
    userId: 'usr-manager-a',
    role: 'MANAGER',
    tenantId: tenantA,
    displayName: 'Manager Tenant A',
    phone: '+919999000002',
  });

  const tokenAgentA = makeToken({
    userId: 'usr-agent-a',
    role: 'SALES_AGENT',
    tenantId: tenantA,
    displayName: 'Closer Agent A',
    phone: '+919999000003',
  });

  // Token for Sales Agent in Tenant B
  const tokenAgentB = makeToken({
    userId: 'usr-agent-b',
    role: 'SALES_AGENT',
    tenantId: tenantB,
    displayName: 'Closer Agent B',
    phone: '+919999000004',
  });

  // Global Super Admin (no tenant)
  const tokenSuperAdmin = makeToken({
    userId: 'usr-super-admin',
    role: 'SUPER_ADMIN',
    tenantId: null,
    displayName: 'Global Super Admin',
    phone: '+919999999999',
  });

  // TEST 1: Unauthenticated request rejected
  await test('1. Unauthenticated request to /api/v1/leads is rejected with 401', async () => {
    const res = await apiRequest({ path: '/api/v1/leads', method: 'GET' });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.data.success, false);
  });

  // TEST 2: Sales Agent restricted on /api/v1/team PATCH
  await test('2. Sales Agent cannot modify team member settings (PATCH /api/v1/team/:id -> 403)', async () => {
    const res = await apiRequest(
      { path: '/api/v1/team/some-agent-id', method: 'PATCH', token: tokenAgentA },
      { commissionPercent: 50 }
    );
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.data.success, false);
  });

  // TEST 3: Manager restricted from modifying team member commission settings
  await test('3. Manager cannot modify team member settings without team:manage (PATCH /api/v1/team/:id -> 403)', async () => {
    const res = await apiRequest(
      { path: '/api/v1/team/some-agent-id', method: 'PATCH', token: tokenManagerA },
      { commissionPercent: 50 }
    );
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.data.success, false);
  });

  // TEST 4: Sales Agent without team:view cannot list full team, but CAN view /team/me
  await test('4. Sales Agent blocked from full team list (GET /api/v1/team -> 403), allowed on /team/me (200)', async () => {
    const resList = await apiRequest({ path: '/api/v1/team', method: 'GET', token: tokenAgentA });
    assert.strictEqual(resList.statusCode, 403);
    assert.strictEqual(resList.data.success, false);

    const resMe = await apiRequest({ path: '/api/v1/team/me', method: 'GET', token: tokenAgentA });
    assert.strictEqual(resMe.statusCode, 200);
    assert.strictEqual(resMe.data.success, true);
    assert.strictEqual(resMe.data.data.userId, 'usr-agent-a');
  });

  // TEST 5: Non-Super-Admin blocked from /api/v1/super-admin
  await test('5. Admin & Sales Agent blocked from /api/v1/super-admin/tenants -> 403', async () => {
    const resAdmin = await apiRequest({ path: '/api/v1/super-admin/tenants', method: 'GET', token: tokenAdminA });
    assert.strictEqual(resAdmin.statusCode, 403);

    const resAgent = await apiRequest({ path: '/api/v1/super-admin/tenants', method: 'GET', token: tokenAgentA });
    assert.strictEqual(resAgent.statusCode, 403);
  });

  // TEST 6: Super Admin without target tenant header blocked from tenant-scoped routes
  await test('6. Super Admin without target tenant header blocked from tenant-scoped /api/v1/leads -> 400', async () => {
    const res = await apiRequest({ path: '/api/v1/leads', method: 'GET', token: tokenSuperAdmin });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.data.error, 'SuperAdminTenantContextRequired');
  });

  // TEST 7: Super Admin with target tenant header authorized
  await test('7. Super Admin with x-target-tenant-id header successfully accesses tenant leads', async () => {
    const res = await apiRequest({
      path: '/api/v1/leads?limit=1',
      method: 'GET',
      token: tokenSuperAdmin,
      headers: { 'x-target-tenant-id': tenantA },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
  });

  // TEST 8: Cross-tenant isolation verification
  await test('8. Cross-tenant lead access returns 404 (Tenant B user cannot access Tenant A leads)', async () => {
    const res = await apiRequest({
      path: '/api/v1/leads/cmv99r1n900yj58jpjnsoxwt7',
      method: 'GET',
      token: tokenAgentB,
    });
    assert.strictEqual(res.statusCode, 404);
  });

  // TEST 9: Super Admin impersonation lifecycle
  await test('9. Super Admin impersonation creates audited 2h token, returns, and revokes cleanly', async () => {
    const impRes = await apiRequest(
      { path: `/api/v1/super-admin/tenants/${tenantA}/impersonate`, method: 'POST', token: tokenSuperAdmin },
      {}
    );
    assert.strictEqual(impRes.statusCode, 200);
    assert.strictEqual(impRes.data.success, true);
    assert.ok(impRes.data.data.token);
    assert.strictEqual(impRes.data.data.expiresIn, '2h');

    const sessionId = impRes.data.data.sessionId;

    // Return from impersonation
    const retRes = await apiRequest(
      { path: '/api/v1/super-admin/impersonation/return', method: 'POST', token: impRes.data.data.token },
      {}
    );
    assert.strictEqual(retRes.statusCode, 200);
    assert.strictEqual(retRes.data.success, true);

    // Revoke test
    const revRes = await apiRequest(
      { path: `/api/v1/super-admin/impersonation/revoke/${sessionId}`, method: 'POST', token: tokenSuperAdmin },
      {}
    );
    assert.strictEqual(revRes.statusCode, 200);
    assert.strictEqual(revRes.data.success, true);
  });

  // TEST 10: Sales Agent blocked from accessing another agent's Lead 360
  await test('10. Sales Agent cannot access Lead 360 of another agent\'s lead -> 403', async () => {
    // Lead cmv99r1n900yj58jpjnsoxwt7 exists in Tenant A under another agent
    const res = await apiRequest({
      path: '/api/v1/leads/cmv99r1n900yj58jpjnsoxwt7/360',
      method: 'GET',
      token: tokenAgentA,
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.data.error, 'Forbidden');
  });

  // TEST 11: Sales Agent blocked from adding notes to another agent's lead
  await test('11. Sales Agent cannot add notes to another agent\'s lead -> 403', async () => {
    const res = await apiRequest(
      { path: '/api/v1/leads/cmv99r1n900yj58jpjnsoxwt7/notes', method: 'POST', token: tokenAgentA },
      { body: 'Unauthorized note attempt' }
    );
    assert.strictEqual(res.statusCode, 403);
  });

  // TEST 12: Sales Agent blocked from reassigning leads
  await test('12. Sales Agent cannot reassign leads via POST /api/v1/leads/:id/reassign -> 403', async () => {
    const res = await apiRequest(
      { path: '/api/v1/leads/cmv99r1n900yj58jpjnsoxwt7/reassign', method: 'POST', token: tokenAgentA },
      { assignedAgentId: 'some-other-agent' }
    );
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.data.error, 'Forbidden');
  });

  // TEST 13: Sales Agent blocked from logging call for another agent
  await test('13. Sales Agent cannot log call on behalf of another agent (POST /api/v1/calls -> 403)', async () => {
    const res = await apiRequest(
      { path: '/api/v1/calls', method: 'POST', token: tokenAgentA },
      {
        assignmentId: 'cmv99r1n900yj58jpjnsoxwt7',
        agentId: 'some-other-agent-id',
        phoneNumber: '+919876543210',
        direction: 'OUTBOUND',
      }
    );
    assert.strictEqual(res.statusCode, 403);
  });

  // TEST 14: Sales Agent blocked from updating disposition on another agent's call
  await test('14. Sales Agent cannot submit disposition on another agent\'s call -> 403', async () => {
    const res = await apiRequest(
      { path: '/api/v1/calls/cmv9a00000000000000000001/disposition', method: 'POST', token: tokenAgentA },
      { outcome: 'INTERESTED', note: 'Malicious update' }
    );
    // 403 if call exists and owned by another agent, or 404 if mock call id not found
    assert.ok([403, 404].includes(res.statusCode));
  });

  // TEST 15: Sales Agent blocked from playback of another agent's call recording
  await test('15. Sales Agent cannot access recording playback of another agent -> 403/404', async () => {
    const res = await apiRequest(
      { path: '/api/v1/recordings/cmv9a00000000000000000001/playback', method: 'GET', token: tokenAgentA }
    );
    assert.ok([403, 404].includes(res.statusCode));
  });

  console.log('\n===================================================================');
  console.log(`📊 AUTHORIZATION MATRIX SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('===================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runRoleAuthorizationTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
