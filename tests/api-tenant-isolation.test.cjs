const jwt = require('jsonwebtoken');
const assert = require('assert');
const http = require('http');
const { Pool } = require('pg');

// Setup environment for test
process.env.PORT = '3099';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'aicloser-super-secure-production-jwt-secret-2026-key';
process.env.DATABASE_URL = 'postgresql://aicloser_user:AIcloser%4012345@127.0.0.1:5432/aicloser?schema=public';

async function runApiTests() {
  console.log('========================================================');
  console.log('🧪 RUNNING AICLOSER-API COMPREHENSIVE ISOLATION SUITE  ');
  console.log('========================================================\n');

  // Query live DB fixtures dynamically
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  let betaCountExpected = 706;
  let alphaLeadId = '';
  let betaLeadId = '';
  let alphaContactId = '';
  let betaContactId = '';
  let foreignConvId = '';
  let alphaAgentId = '';
  let betaAgentId = '';

  try {
    const betaCountRes = await client.query('SELECT count(*) FROM "SalesLeadAssignment" WHERE "tenantId" = $1', ['tenant-agency-8deafdbb']);
    betaCountExpected = parseInt(betaCountRes.rows[0].count, 10);

    const aLead = await client.query('SELECT id FROM "SalesLeadAssignment" WHERE "tenantId" = $1 LIMIT 1', ['tenant-acme-agency-6478aca1']);
    alphaLeadId = aLead.rows[0].id;

    const bLead = await client.query('SELECT id FROM "SalesLeadAssignment" WHERE "tenantId" = $1 LIMIT 1', ['tenant-agency-8deafdbb']);
    betaLeadId = bLead.rows[0].id;

    const aContact = await client.query('SELECT id FROM "MarketingContact" WHERE "tenantId" = $1 LIMIT 1', ['tenant-acme-agency-6478aca1']);
    alphaContactId = aContact.rows[0].id;

    const bContact = await client.query('SELECT id FROM "MarketingContact" WHERE "tenantId" = $1 LIMIT 1', ['tenant-agency-8deafdbb']);
    betaContactId = bContact.rows[0].id;

    const fConv = await client.query('SELECT id FROM "AppConversation" WHERE "tenantId" = $1 LIMIT 1', ['tenant-gigxomi']);
    foreignConvId = fConv.rows[0].id;

    const aAgent = await client.query('SELECT id FROM "SalesAgentProfile" WHERE "tenantId" = $1 LIMIT 1', ['tenant-acme-agency-6478aca1']);
    alphaAgentId = aAgent.rows[0].id;

    const bAgent = await client.query('SELECT id FROM "SalesAgentProfile" WHERE "tenantId" = $1 LIMIT 1', ['tenant-agency-8deafdbb']);
    betaAgentId = bAgent.rows[0].id;
  } finally {
    client.release();
    await pool.end();
  }

  // Dynamically import compiled server
  const { createServer } = await import('../dist/server.js');
  const { prisma } = await import('../dist/lib/prisma.js');
  const app = createServer();
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(3099, resolve));
  console.log('API Server listening on http://127.0.0.1:3099\n');

  const BASE_URL = 'http://127.0.0.1:3099';
  const tenantAlpha = 'tenant-acme-agency-6478aca1';
  const tenantBeta = 'tenant-agency-8deafdbb';

  // Mint test tokens
  const tokenAlpha = jwt.sign(
    { userId: 'user-sales-agent-798c589e', role: 'SALES_AGENT', tenantId: tenantAlpha, displayName: 'Alpha Rep', phone: '+10000000001' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const tokenBeta = jwt.sign(
    { userId: 'user-sales-agent-0ead1704', role: 'SALES_AGENT', tenantId: tenantBeta, displayName: 'Beta Rep', phone: '+10000000002' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const tokenSuperAdmin = jwt.sign(
    { userId: 'user-super-admin', role: 'SUPER_ADMIN', tenantId: null, displayName: 'Root Admin', phone: '+19999999999' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const tokenNoTenant = jwt.sign(
    { userId: 'user-no-tenant', role: 'SALES_AGENT', tenantId: null, displayName: 'Orphan Rep', phone: '+18888888888' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ FAIL: ${name}`);
      console.error(`   Error: ${err.message}`);
      failed++;
    }
  }

  // 1. Health check
  await test('GET /health returns healthy database status', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.status, 'pass');
    assert.strictEqual(data.checks.database.status, 'healthy');
  });

  // 2. Unauthenticated endpoint rejection
  await test('GET /api/v1/leads without token is rejected with 401 Unauthorized', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/leads`);
    const data = await res.json();
    assert.strictEqual(res.status, 401);
    assert.strictEqual(data.error, 'Unauthorized');
  });

  // 3. Tenant Alpha queries leads
  await test('GET /api/v1/leads with Tenant Alpha token returns ONLY Tenant Alpha leads', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/leads?limit=50`, {
      headers: { Authorization: `Bearer ${tokenAlpha}` },
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.pagination.total, 34); // Exactly 34 leads for Acme Agency
    for (const lead of data.data.leads) {
      assert.strictEqual(lead.tenantId, tenantAlpha, `Leaked lead with foreign tenantId: ${lead.tenantId}`);
    }
  });

  // 4. Tenant Beta queries leads (Dynamic count check)
  await test(`GET /api/v1/leads with Tenant Beta token returns ONLY Tenant Beta leads (${betaCountExpected} leads)`, async () => {
    const res = await fetch(`${BASE_URL}/api/v1/leads?limit=5`, {
      headers: { Authorization: `Bearer ${tokenBeta}` },
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.pagination.total, betaCountExpected);
    for (const lead of data.data.leads) {
      assert.strictEqual(lead.tenantId, tenantBeta);
    }
  });

  // 5. Cross-tenant lead access rejection (GET / PATCH / DELETE)
  await test('Tenant Alpha attempting to GET foreign lead (Beta) is rejected with 404 NotFound', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/leads/${betaLeadId}`, {
      headers: { Authorization: `Bearer ${tokenAlpha}` },
    });
    const data = await res.json();
    assert.strictEqual(res.status, 404);
    assert.strictEqual(data.error, 'NotFound');
  });

  await test('Tenant Alpha attempting to PATCH foreign lead (Beta) is rejected with 404 NotFound', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/leads/${betaLeadId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${tokenAlpha}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ priority: 'high' }),
    });
    const data = await res.json();
    assert.strictEqual(res.status, 404);
    assert.strictEqual(data.error, 'NotFound');
  });

  await test('Tenant Alpha attempting to DELETE foreign lead (Beta) is rejected with 404 NotFound', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/leads/${betaLeadId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenAlpha}` },
    });
    const data = await res.json();
    assert.strictEqual(res.status, 404);
    assert.strictEqual(data.error, 'NotFound');
  });

  // 6. Cross-tenant contact access rejection
  await test('Tenant Alpha attempting to GET foreign contact (Beta) is rejected with 404 NotFound', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/contacts/${betaContactId}`, {
      headers: { Authorization: `Bearer ${tokenAlpha}` },
    });
    const data = await res.json();
    assert.strictEqual(res.status, 404);
    assert.strictEqual(data.error, 'NotFound');
  });

  // 7. Cross-tenant conversation access rejection
  await test('Tenant Alpha attempting to GET foreign conversation is rejected with 404 NotFound', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/conversations/${foreignConvId}`, {
      headers: { Authorization: `Bearer ${tokenAlpha}` },
    });
    const data = await res.json();
    assert.strictEqual(res.status, 404);
    assert.strictEqual(data.error, 'NotFound');
  });

  // 8. Cross-tenant call access rejection
  await test('Tenant Alpha attempting to log call against foreign lead is rejected with 404 NotFound', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/calls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenAlpha}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        assignmentId: betaLeadId, // Foreign lead
        agentId: alphaAgentId,
        phoneNumber: '+919999988888',
        direction: 'OUTBOUND',
      }),
    });
    const data = await res.json();
    assert.strictEqual(res.status, 404);
    assert.strictEqual(data.error, 'NotFound');
  });

  // 9. Foreign assigned-agent rejection
  await test('Tenant Alpha attempting to create lead assigned to foreign agent (Beta) is rejected with 400 InvalidAgent', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/leads`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenAlpha}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        customerName: 'Foreign Agent Test Lead',
        customerPhone: '+919876543210',
        assignedAgentId: betaAgentId, // Foreign agent!
      }),
    });
    const data = await res.json();
    assert.strictEqual(res.status, 400);
    assert.strictEqual(data.error, 'InvalidAgent');
  });

  await test('Tenant Alpha attempting to log call with foreign agent is rejected with 400 InvalidAgent', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/calls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenAlpha}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        assignmentId: alphaLeadId,
        agentId: betaAgentId, // Foreign agent!
        phoneNumber: '+919999977777',
        direction: 'OUTBOUND',
      }),
    });
    const data = await res.json();
    assert.strictEqual(res.status, 400);
    assert.strictEqual(data.error, 'InvalidAgent');
  });

  // 10. Tenant Spoofing Attempts Blocked (Header, Query, Body)
  await test('Tenant spoof attempt via x-target-tenant-id header is rejected with 403 TenantIsolationViolation', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/leads`, {
      headers: {
        Authorization: `Bearer ${tokenAlpha}`,
        'x-target-tenant-id': tenantBeta,
      },
    });
    const data = await res.json();
    assert.strictEqual(res.status, 403);
    assert.strictEqual(data.error, 'TenantIsolationViolation');
  });

  await test('Tenant spoof attempt via query string (?tenantId=...) is rejected with 403 TenantIsolationViolation', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/leads?tenantId=${tenantBeta}`, {
      headers: { Authorization: `Bearer ${tokenAlpha}` },
    });
    const data = await res.json();
    assert.strictEqual(res.status, 403);
    assert.strictEqual(data.error, 'TenantIsolationViolation');
  });

  await test('Tenant spoof attempt via JSON body ({ tenantId: ... }) is rejected with 403 TenantIsolationViolation', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/leads`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenAlpha}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        customerName: 'Spoof Test Lead',
        customerPhone: '+919876543219',
        assignedAgentId: alphaAgentId,
        tenantId: tenantBeta, // Attempting to spoof body tenantId!
      }),
    });
    const data = await res.json();
    assert.strictEqual(res.status, 403);
    assert.strictEqual(data.error, 'TenantIsolationViolation');
  });

  // 11. Super Admin Audited Cross-Tenant Override
  await test('Super Admin with valid x-target-tenant-id accesses Tenant Beta leads cleanly', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/leads?limit=5`, {
      headers: {
        Authorization: `Bearer ${tokenSuperAdmin}`,
        'x-target-tenant-id': tenantBeta,
      },
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.pagination.total, betaCountExpected);
    for (const lead of data.data.leads) {
      assert.strictEqual(lead.tenantId, tenantBeta);
    }
  });

  // 12. Super Admin Override with Unknown Workspace Rejected
  await test('Super Admin with non-existent x-target-tenant-id is rejected with 404 WorkspaceNotFound', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/leads`, {
      headers: {
        Authorization: `Bearer ${tokenSuperAdmin}`,
        'x-target-tenant-id': 'workspace-ghost-does-not-exist',
      },
    });
    const data = await res.json();
    assert.strictEqual(res.status, 404);
    assert.strictEqual(data.error, 'WorkspaceNotFound');
  });

  // 13. Super Admin Missing Tenant Context Rejection
  await test('Super Admin without x-target-tenant-id accessing tenant endpoint is rejected with 400 MissingTenantContext', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/leads`, {
      headers: { Authorization: `Bearer ${tokenSuperAdmin}` },
    });
    const data = await res.json();
    assert.strictEqual(res.status, 400);
    assert.strictEqual(data.error, 'MissingTenantContext');
  });

  // 14. Missing Tenant Rejection for Standard User
  await test('Standard user token with NULL tenantId is rejected with 403 Forbidden', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/leads`, {
      headers: { Authorization: `Bearer ${tokenNoTenant}` },
    });
    const data = await res.json();
    assert.strictEqual(res.status, 403);
    assert.strictEqual(data.error, 'Forbidden');
  });

  // 15. Standard user accessing Super Admin routes rejected
  await test('Standard sales agent accessing /api/v1/super-admin/tenants is rejected with 403 Forbidden', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/super-admin/tenants`, {
      headers: { Authorization: `Bearer ${tokenAlpha}` },
    });
    const data = await res.json();
    assert.strictEqual(res.status, 403);
    assert.strictEqual(data.error, 'Forbidden');
  });

  // 16. Super Admin lists canonical workspaces
  await test('Super Admin lists all canonical workspaces with count aggregates', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/super-admin/tenants`, {
      headers: { Authorization: `Bearer ${tokenSuperAdmin}` },
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert(Array.isArray(data.data));
    assert(data.data.length >= 78);
  });

  console.log(`\n========================================================`);
  console.log(`INTEGRATION TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log(`========================================================\n`);

  server.closeAllConnections?.();
  server.close();
  await prisma.$disconnect();

  if (failed > 0) {
    throw new Error(`${failed} integration tests failed`);
  }
  process.exit(0);
}

runApiTests()
  .catch((err) => {
    console.error('Test suite execution failed:', err);
    process.exit(1);
  });
