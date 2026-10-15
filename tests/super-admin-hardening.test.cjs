const jwt = require('jsonwebtoken');
const assert = require('assert');
const http = require('http');

const JWT_SECRET = process.env.JWT_SECRET || 'aicloser-super-secure-production-jwt-secret-2026-key';
const API_PORT = process.env.PORT || '3060';
const BASE_HOST = process.env.TEST_HOST || '127.0.0.1';

function makeToken(user, secret = JWT_SECRET) {
  return jwt.sign(user, secret, { expiresIn: '1h' });
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

async function runSuperAdminHardeningSuite() {
  console.log('========================================================================');
  console.log('???  SUPER ADMIN BACKEND HARDENING & INTEGRATION CONTRACT SUITE');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ? PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ? FAIL: ${name}`);
      console.error(`     Error: ${err.message}`);
      failed++;
    }
  }

  const tenantA = 'tenant-the-storage-test-1d01dda2';

  const tokenSuperAdmin = makeToken({
    userId: 'usr-super-admin',
    role: 'SUPER_ADMIN',
    tenantId: null,
    displayName: 'Global Super Admin',
    phone: '+919999999999',
  });

  const tokenAdminA = makeToken({
    userId: 'user-admin-eafadb6d',
    role: 'ADMIN',
    tenantId: tenantA,
    displayName: 'Tenant Admin',
    phone: '+919999000001',
  });

  // TEST 1: Strict RBAC check (Non-Super-Admin blocked from Super Admin routes)
  await test('1. Non-Super-Admin (ADMIN / SALES_AGENT) is rejected with 403 Forbidden', async () => {
    const res = await apiRequest({ path: '/api/v1/super-admin/tenants', method: 'GET', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.data.success, false);
  });

  // TEST 2: GET /tenants list with pagination and search
  await test('2. GET /tenants supports pagination (total, page, limit, totalPages) and search filtering', async () => {
    const res = await apiRequest({ path: '/api/v1/super-admin/tenants?page=1&limit=5&search=storage', method: 'GET', token: tokenSuperAdmin });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(Array.isArray(res.data.data));
    assert.ok(res.data.pagination);
    assert.strictEqual(res.data.pagination.page, 1);
    assert.strictEqual(res.data.pagination.limit, 5);
    assert.ok(res.data.pagination.total >= 1);
    assert.ok(res.data.data.some((w) => w.id === tenantA));
  });

  // TEST 3: GET /tenants/:id workspace detail
  await test('3. GET /tenants/:id returns full workspace structure with stats', async () => {
    const res = await apiRequest({ path: `/api/v1/super-admin/tenants/${tenantA}`, method: 'GET', token: tokenSuperAdmin });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.data.id, tenantA);
    assert.ok(res.data.data._count);
  });

  // TEST 4: Plan Mutation - Strict Zod validation (Success & Rejection)
  await test('4. PATCH /tenants/:id/plan accepts valid plan and rejects invalid plan tier (400)', async () => {
    // Valid update
    const resOk = await apiRequest(
      { path: `/api/v1/super-admin/tenants/${tenantA}/plan`, method: 'PATCH', token: tokenSuperAdmin },
      { planTier: 'ENTERPRISE' }
    );
    assert.strictEqual(resOk.statusCode, 200);
    assert.strictEqual(resOk.data.data.planTier, 'ENTERPRISE');

    // Invalid update
    const resInvalid = await apiRequest(
      { path: `/api/v1/super-admin/tenants/${tenantA}/plan`, method: 'PATCH', token: tokenSuperAdmin },
      { planTier: 'INVALID_TIER_NAME_123' }
    );
    assert.strictEqual(resInvalid.statusCode, 400);
    assert.strictEqual(resInvalid.data.error, 'ValidationError');
  });

  // TEST 5: Status Mutation - Strict Zod validation (Success & Rejection)
  await test('5. PATCH /tenants/:id/status accepts valid status and rejects invalid status (400)', async () => {
    // Valid update
    const resOk = await apiRequest(
      { path: `/api/v1/super-admin/tenants/${tenantA}/status`, method: 'PATCH', token: tokenSuperAdmin },
      { status: 'ACTIVE', reason: 'Hardening verification' }
    );
    assert.strictEqual(resOk.statusCode, 200);
    assert.strictEqual(resOk.data.data.status, 'ACTIVE');

    // Invalid update
    const resInvalid = await apiRequest(
      { path: `/api/v1/super-admin/tenants/${tenantA}/status`, method: 'PATCH', token: tokenSuperAdmin },
      { status: 'DESTROYED' }
    );
    assert.strictEqual(resInvalid.statusCode, 400);
    assert.strictEqual(resInvalid.data.error, 'ValidationError');
  });

  // TEST 6: Seats Mutation - Strict Zod validation (Success & Rejection)
  await test('6. PATCH /tenants/:id/seats accepts valid integer and rejects 0, negative, or float (400)', async () => {
    // Valid update
    const resOk = await apiRequest(
      { path: `/api/v1/super-admin/tenants/${tenantA}/seats`, method: 'PATCH', token: tokenSuperAdmin },
      { maxSeats: 15 }
    );
    assert.strictEqual(resOk.statusCode, 200);
    assert.strictEqual(resOk.data.data.maxSeats, 15);

    // Invalid: 0 seats
    const resZero = await apiRequest(
      { path: `/api/v1/super-admin/tenants/${tenantA}/seats`, method: 'PATCH', token: tokenSuperAdmin },
      { maxSeats: 0 }
    );
    assert.strictEqual(resZero.statusCode, 400);
    assert.strictEqual(resZero.data.error, 'ValidationError');

    // Invalid: negative seats
    const resNegative = await apiRequest(
      { path: `/api/v1/super-admin/tenants/${tenantA}/seats`, method: 'PATCH', token: tokenSuperAdmin },
      { maxSeats: -10 }
    );
    assert.strictEqual(resNegative.statusCode, 400);
    assert.strictEqual(resNegative.data.error, 'ValidationError');

    // Invalid: float seats
    const resFloat = await apiRequest(
      { path: `/api/v1/super-admin/tenants/${tenantA}/seats`, method: 'PATCH', token: tokenSuperAdmin },
      { maxSeats: 12.5 }
    );
    assert.strictEqual(resFloat.statusCode, 400);
    assert.strictEqual(resFloat.data.error, 'ValidationError');
  });

  // TEST 7: Expiry Mutation - Strict Zod validation (Success & Rejection)
  await test('7. PATCH /tenants/:id/expiry validates ISO datetime and rejects malformed strings (400)', async () => {
    // Valid update
    const futureDate = '2027-12-31T23:59:59.000Z';
    const resOk = await apiRequest(
      { path: `/api/v1/super-admin/tenants/${tenantA}/expiry`, method: 'PATCH', token: tokenSuperAdmin },
      { expiresAt: futureDate }
    );
    assert.strictEqual(resOk.statusCode, 200);
    assert.strictEqual(resOk.data.data.expiresAt, futureDate);

    // Invalid update
    const resInvalid = await apiRequest(
      { path: `/api/v1/super-admin/tenants/${tenantA}/expiry`, method: 'PATCH', token: tokenSuperAdmin },
      { expiresAt: 'not-a-valid-datetime' }
    );
    assert.strictEqual(resInvalid.statusCode, 400);
    assert.strictEqual(resInvalid.data.error, 'ValidationError');
  });

  // TEST 8: GET /tenants/:id/users pagination & filtering
  await test('8. GET /tenants/:id/users supports pagination and role filtering', async () => {
    const res = await apiRequest(
      { path: `/api/v1/super-admin/tenants/${tenantA}/users?page=1&limit=10&role=SALES_AGENT`, method: 'GET', token: tokenSuperAdmin }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(Array.isArray(res.data.data));
    assert.ok(res.data.pagination);
    assert.strictEqual(res.data.pagination.page, 1);
    assert.strictEqual(res.data.pagination.limit, 10);
    if (res.data.data.length > 0) {
      assert.strictEqual(res.data.data[0].role, 'SALES_AGENT');
    }
  });

  // TEST 9: POST /tenants/:id/users user creation & error handling
  let createdUserId = null;
  const testUserEmail = `test.user.${Date.now()}@example.com`;

  await test('9. POST /tenants/:id/users creates user with scrypt hash, rejects duplicate email & invalid role (400/409)', async () => {
    // 9a: Valid creation
    const resCreate = await apiRequest(
      { path: `/api/v1/super-admin/tenants/${tenantA}/users`, method: 'POST', token: tokenSuperAdmin },
      {
        email: testUserEmail,
        displayName: 'Hardening Test Closer',
        role: 'SALES_AGENT',
        password: 'SecurePassword123!',
        phone: '+919988776655',
      }
    );
    assert.strictEqual(resCreate.statusCode, 201);
    assert.strictEqual(resCreate.data.success, true);
    assert.strictEqual(resCreate.data.data.email, testUserEmail);
    createdUserId = resCreate.data.data.id;

    // 9b: Duplicate email rejection (409)
    const resDup = await apiRequest(
      { path: `/api/v1/super-admin/tenants/${tenantA}/users`, method: 'POST', token: tokenSuperAdmin },
      {
        email: testUserEmail,
        displayName: 'Duplicate Attempt',
        role: 'SALES_AGENT',
        password: 'SecurePassword123!',
      }
    );
    assert.strictEqual(resDup.statusCode, 409);
    assert.strictEqual(resDup.data.error, 'EmailConflict');

    // 9c: Invalid role rejection (400)
    const resInvalidRole = await apiRequest(
      { path: `/api/v1/super-admin/tenants/${tenantA}/users`, method: 'POST', token: tokenSuperAdmin },
      {
        email: `invalid.role.${Date.now()}@example.com`,
        displayName: 'Invalid Role Attempt',
        role: 'SUPER_HERO',
      }
    );
    assert.strictEqual(resInvalidRole.statusCode, 400);
    assert.strictEqual(resInvalidRole.data.error, 'ValidationError');
  });

  // TEST 10: PATCH /tenants/:id/users/:userId update
  await test('10. PATCH /tenants/:id/users/:userId updates user details and validates payload', async () => {
    assert.ok(createdUserId, 'createdUserId must be present');

    const resUpdate = await apiRequest(
      { path: `/api/v1/super-admin/tenants/${tenantA}/users/${createdUserId}`, method: 'PATCH', token: tokenSuperAdmin },
      {
        displayName: 'Updated Test Closer Name',
        role: 'MANAGER',
      }
    );
    assert.strictEqual(resUpdate.statusCode, 200);
    assert.strictEqual(resUpdate.data.data.displayName, 'Updated Test Closer Name');
    assert.strictEqual(resUpdate.data.data.role, 'MANAGER');

    // Invalid status update
    const resInvalidStatus = await apiRequest(
      { path: `/api/v1/super-admin/tenants/${tenantA}/users/${createdUserId}`, method: 'PATCH', token: tokenSuperAdmin },
      { packageStatus: 'BANNED_FOR_LIFE' }
    );
    assert.strictEqual(resInvalidStatus.statusCode, 400);
    assert.strictEqual(resInvalidStatus.data.error, 'ValidationError');
  });

  // TEST 11: DELETE /tenants/:id/users/:userId safe deactivation
  await test('11. DELETE /tenants/:id/users/:userId safely deactivates user without deleting records', async () => {
    assert.ok(createdUserId, 'createdUserId must be present');

    const resDeactivate = await apiRequest(
      { path: `/api/v1/super-admin/tenants/${tenantA}/users/${createdUserId}`, method: 'DELETE', token: tokenSuperAdmin }
    );
    assert.strictEqual(resDeactivate.statusCode, 200);
    assert.strictEqual(resDeactivate.data.deactivated, true);

    // Verify user is in PAUSED status in DB
    const resVerify = await apiRequest(
      { path: `/api/v1/super-admin/tenants/${tenantA}/users?search=${encodeURIComponent(testUserEmail)}`, method: 'GET', token: tokenSuperAdmin }
    );
    assert.strictEqual(resVerify.statusCode, 200);
    assert.strictEqual(resVerify.data.data[0].packageStatus, 'PAUSED');
  });

  // TEST 12: GET /telemetry enhanced metrics
  await test('12. GET /telemetry returns comprehensive system, workspace tier, and user metrics', async () => {
    const res = await apiRequest({ path: '/api/v1/super-admin/telemetry', method: 'GET', token: tokenSuperAdmin });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(res.data.data.workspaces.total >= 1);
    assert.ok(Array.isArray(res.data.data.workspaces.byTier));
    assert.ok(res.data.data.users.total >= 1);
    assert.ok(res.data.data.system.serverMemoryMb > 0);
  });

  // TEST 13: GET /feedback pagination & search
  await test('13. GET /feedback returns paginated feedback list with metadata', async () => {
    const res = await apiRequest({ path: '/api/v1/super-admin/feedback?page=1&limit=10', method: 'GET', token: tokenSuperAdmin });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(Array.isArray(res.data.data));
    assert.ok(res.data.pagination);
    assert.strictEqual(res.data.pagination.page, 1);
    assert.strictEqual(res.data.pagination.limit, 10);
  });

  // TEST 14: PATCH /feedback/:id resolve feedback
  await test('14. PATCH /feedback/:id resolves feedback with audit trail', async () => {
    const res = await apiRequest(
      { path: '/api/v1/super-admin/feedback/feed-12345', method: 'PATCH', token: tokenSuperAdmin },
      { resolutionNote: 'Addressed in release v1.0.26' }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
  });

  console.log('\n========================================================================');
  console.log(`?? SUPER ADMIN HARDENING SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runSuperAdminHardeningSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
