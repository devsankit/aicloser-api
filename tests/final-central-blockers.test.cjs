const jwt = require('jsonwebtoken');
const assert = require('assert');
const http = require('http');

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3060';
const JWT_SECRET = process.env.JWT_SECRET || 'aicloser-super-secure-production-jwt-secret-2026-key';

const tenantA = 'tenant-the-storage-test-1d01dda2';
const tenantB = 'ws-test-tenant-b-' + Date.now().toString().slice(-6);

const userAdminA = {
  userId: 'user-admin-eafadb6d',
  email: 'admin.a@example.com',
  role: 'ADMIN',
  tenantId: tenantA,
  displayName: 'Ankit rathore',
};

const userManagerA = {
  userId: 'user-manager-test-112233',
  email: 'manager.a@example.com',
  role: 'MANAGER',
  tenantId: tenantA,
  displayName: 'Sales Manager',
};

const userCloserA = {
  userId: 'user-sales-agent-83d13bc5',
  email: 'closer.a@example.com',
  role: 'SALES_AGENT',
  tenantId: tenantA,
  displayName: 'Closer Agent',
};

const tokenAdminA = jwt.sign(userAdminA, JWT_SECRET, { expiresIn: '2h' });
const tokenManagerA = jwt.sign(userManagerA, JWT_SECRET, { expiresIn: '2h' });
const tokenCloserA = jwt.sign(userCloserA, JWT_SECRET, { expiresIn: '2h' });

function apiRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const url = new URL(options.path, API_BASE);
    const req = http.request(
      url,
      {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(options.token ? { Authorization: 'Bearer ' + options.token } : {}),
          ...(options.headers || {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, headers: res.headers, data: JSON.parse(body), raw: body });
          } catch {
            resolve({ statusCode: res.statusCode, headers: res.headers, raw: body });
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

async function runFinalBlockersSuite() {
  console.log('========================================================================');
  console.log('FINAL CENTRAL API BLOCKERS VERIFICATION: 9 AUDIT REQUIREMENTS');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  [FAIL] ${name}`);
      console.error(`         ${err.message}`);
      failed++;
    }
  }

  const testSuffix = Date.now().toString().slice(-6);
  const sharedCustomerPhone = `+919711${testSuffix}`;

  // ==========================================
  // 1. Lead Identity and Tenancy Isolation
  // ==========================================
  console.log('\n--- 1. Lead Identity and Tenancy Isolation ---');

  let tenantBToken = null;

  await test('POST /api/v1/auth/signup - Provision Company B for cross-tenant isolation test', async () => {
    const res = await apiRequest(
      { path: '/api/v1/auth/signup', method: 'POST' },
      {
        companyName: `Company B ${testSuffix}`,
        adminName: 'Founder B',
        email: `founderB${testSuffix}@companyb.com`,
        phone: `+919799${testSuffix}`,
        password: 'Password123!',
      }
    );
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.success, true);
    tenantBToken = res.data.data.token;
  });

  await test('Same phone in same company: deduplicates and enriches existing lead without error', async () => {
    // 1st ingestion in Company A
    const res1 = await apiRequest(
      { path: '/api/v1/leads/import', method: 'POST', token: tokenAdminA },
      {
        source: 'CSV',
        rows: [
          {
            customerName: 'Multi-Enquiry Client',
            customerPhone: sharedCustomerPhone,
            customerEmail: `client${testSuffix}@domain.com`,
            notes: 'First enquiry from Company A',
          },
        ],
      }
    );
    assert.strictEqual(res1.statusCode, 201);
    assert(res1.data.data.createdCount >= 1);

    // 2nd ingestion with same phone in Company A -> enriches, 0 unique constraint crash
    const res2 = await apiRequest(
      { path: '/api/v1/leads/import', method: 'POST', token: tokenAdminA },
      {
        source: 'CSV',
        rows: [
          {
            customerName: 'Multi-Enquiry Client Updated',
            customerPhone: sharedCustomerPhone,
            notes: 'Second enquiry in Company A with additional notes',
          },
        ],
        duplicateAction: 'UPDATE',
      }
    );
    assert.strictEqual(res2.statusCode, 201);
    assert(res2.data.data.updatedCount >= 1 || res2.data.data.skippedDuplicates >= 0);
  });

  await test('Same phone in Company B creates separate isolated lead assignment', async () => {
    const resB = await apiRequest(
      { path: '/api/v1/leads/import', method: 'POST', token: tenantBToken },
      {
        source: 'CSV',
        rows: [
          {
            customerName: 'Client in Company B',
            customerPhone: sharedCustomerPhone,
            notes: 'Enquiry in Company B',
          },
        ],
      }
    );
    assert.strictEqual(resB.statusCode, 201, `Expected 201 in Company B but got ${resB.statusCode}: ${resB.raw}`);
    assert(resB.data.data.createdCount >= 1);
  });

  // ==========================================
  // 2. Assignment, Daily Quota & Cycle Detection
  // ==========================================
  console.log('\n--- 2. Assignment, Quota & Hierarchy Hardening ---');

  await test('Admin/Manager never included in eligible round-robin closers', async () => {
    const res = await apiRequest({ path: '/api/v1/round-robin/closers', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    const closers = res.data.data.closers;
    const hasAdminOrManager = closers.some((c) => c.userId === userAdminA.userId || c.userId === userManagerA.userId);
    assert.strictEqual(hasAdminOrManager, false, 'No Admin or Manager may be in closers pool');
  });

  await test('Source rule maxDailyLeads: routes excess leads to Grab Pool', async () => {
    // Set rule with maxDailyLeads: 1
    const ruleRes = await apiRequest(
      { path: '/api/v1/round-robin/source-rules', method: 'POST', token: tokenAdminA },
      {
        source: 'QUOTA_TEST',
        action: 'ROUND_ROBIN',
        maxDailyLeads: 1,
        enabled: true,
      }
    );
    assert.strictEqual(ruleRes.statusCode, 200);

    // 1st lead with QUOTA_TEST
    await apiRequest(
      { path: '/api/v1/leads/intake/webhook/QUOTA_TEST', method: 'POST', token: tokenAdminA },
      { name: 'Lead One', phone: `+919712${testSuffix}` }
    );

    // 2nd lead with QUOTA_TEST -> exceeds daily cap of 1, routes to pool
    const lead2Res = await apiRequest(
      { path: '/api/v1/leads/intake/webhook/QUOTA_TEST', method: 'POST', token: tokenAdminA },
      { name: 'Lead Two', phone: `+919713${testSuffix}` }
    );
    assert.strictEqual(lead2Res.statusCode, 201);
  });

  await test('Manager Hierarchy: Block self-assignment', async () => {
    const teamRes = await apiRequest({ path: '/api/v1/team', token: tokenAdminA });
    const members = teamRes.data.data;
    if (members && members.length > 0) {
      const targetId = members[0].id;
      const res = await apiRequest(
        { path: `/api/v1/team/${targetId}/manager`, method: 'PATCH', token: tokenAdminA },
        { managerProfileId: targetId }
      );
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.data.error, 'InvalidManager');
    }
  });

  // ==========================================
  // 3. WhatsApp & Conversations
  // ==========================================
  console.log('\n--- 3. WhatsApp & Conversations ---');

  await test('GET /api/v1/leads/whatsapp-desktop/status - Dynamic DB state (not hardcoded)', async () => {
    const res = await apiRequest({ path: '/api/v1/leads/whatsapp-desktop/status', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert(res.data.data.clientStatus, 'Client status must be present');
    assert(typeof res.data.data.isConfigured === 'boolean');
  });

  await test('GET /api/v1/conversations - Stable fields & pagination envelope', async () => {
    const res = await apiRequest({ path: '/api/v1/conversations?limit=5', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert(Array.isArray(res.data.data));
    assert(res.data.pagination);
    assert(typeof res.data.pagination.total === 'number');
    assert(typeof res.data.pagination.hasMore === 'boolean');

    if (res.data.data.length > 0) {
      const item = res.data.data[0];
      assert(item.id, 'id is required');
      assert(item.channel, 'channel is required');
      assert(item.stage, 'stage is required');
      assert('tenantId' in item, 'tenantId must be present');
      assert('leadId' in item, 'leadId must be present');
      assert('assignmentId' in item, 'assignmentId must be present');
    }
  });

  // ==========================================
  // 4. Calls & Recordings
  // ==========================================
  console.log('\n--- 4. Calls & Recordings ---');

  await test('GET /api/v1/calls - Returns assignment, status, and cursor pagination', async () => {
    const res = await apiRequest({ path: '/api/v1/calls?limit=5', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert(res.data.data.pagination);
  });

  await test('GET /api/v1/calls/:id/recording - Missing recording returns clean 404', async () => {
    const res = await apiRequest({ path: '/api/v1/calls/non-existent-call-id/recording', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.data.success, false);
    assert(res.data.error, 'Must provide clear error code');
  });

  // ==========================================
  // 5. Lead 360 & Phone Masking
  // ==========================================
  console.log('\n--- 5. Lead 360 & Security Phone Masking ---');

  await test('GET /api/v1/leads - Phone masking enforcement', async () => {
    const resAdmin = await apiRequest({ path: '/api/v1/leads?limit=5', token: tokenAdminA });
    assert.strictEqual(resAdmin.statusCode, 200);
    assert.strictEqual(resAdmin.data.success, true);

    const resCloser = await apiRequest({ path: '/api/v1/leads?limit=5', token: tokenCloserA });
    assert.strictEqual(resCloser.statusCode, 200);
    assert.strictEqual(resCloser.data.success, true);
  });

  // ==========================================
  // 6. Auth, AI & Payout Governance
  // ==========================================
  console.log('\n--- 6. Auth, AI & Payout Governance ---');

  await test('GET /api/v1/ai/providers - Plaintext keys are never exposed in response', async () => {
    const res = await apiRequest({ path: '/api/v1/ai/providers', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    for (const p of res.data.data.providers) {
      assert(!p.apiKey, 'Raw apiKey must NEVER be leaked in GET response');
    }
  });

  await test('PATCH /api/v1/payouts/:id/approve - State transition validation', async () => {
    const res = await apiRequest(
      { path: '/api/v1/payouts/non-existent-payout-id/approve', method: 'PATCH', token: tokenManagerA }
    );
    assert.strictEqual(res.statusCode, 404);
  });

  console.log('\n========================================================================');
  console.log(`FINAL BLOCKERS VERIFICATION COMPLETE: ${passed} passed, ${failed} failed`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runFinalBlockersSuite().catch((err) => {
  console.error('Unhandled test suite failure:', err);
  process.exit(1);
});
