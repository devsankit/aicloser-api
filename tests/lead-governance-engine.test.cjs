const jwt = require('jsonwebtoken');
const assert = require('assert');
const http = require('http');
const { Pool } = require('pg');

process.env.PORT = '3097';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'aicloser-super-secure-production-jwt-secret-2026-key';
process.env.DATABASE_URL = 'postgresql://aicloser_user:AIcloser%4012345@127.0.0.1:5432/aicloser?schema=public';

function createToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function request(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, rawBody: body });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, rawBody: body });
        }
      });
    });
    req.on('error', reject);
    if (data) {
      if (typeof data === 'string' || Buffer.isBuffer(data)) {
        req.write(data);
      } else {
        req.write(JSON.stringify(data));
      }
    }
    req.end();
  });
}

async function runTests() {
  console.log('🧪 RUNNING LEAD GOVERNANCE & INTEGRATIONS CERTIFICATION SUITE...\n');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = await pool.connect();

  let tenantId;
  let adminUserId;
  let agent1UserId;
  let agent1ProfileId;
  let agent2UserId;
  let agent2ProfileId;
  let testLeadId;
  let testPoolItemId;

  try {
    const wsRes = await db.query('SELECT "tenantId" as id FROM "SalesLeadAssignment" GROUP BY "tenantId" ORDER BY count(*) DESC LIMIT 1');
    tenantId = wsRes.rows[0].id;
    console.log(`✅ Using active workspace: ${tenantId}`);

    const usersRes = await db.query('SELECT id, role, "displayName" FROM "AppAuthUser" WHERE "tenantId" = $1', [tenantId]);
    const admin = usersRes.rows.find(u => u.role === 'ADMIN' || u.role === 'SUPER_ADMIN') || usersRes.rows[0];
    adminUserId = admin.id;

    const agentProfiles = await db.query(
      'SELECT sap.id, sap."userId", u."displayName" FROM "SalesAgentProfile" sap JOIN "AppAuthUser" u ON sap."userId" = u.id WHERE sap."tenantId" = $1 AND sap.status = \'ACTIVE\' AND u.role NOT IN (\'ADMIN\', \'SUPER_ADMIN\')',
      [tenantId]
    );

    if (agentProfiles.rows.length >= 2) {
      agent1ProfileId = agentProfiles.rows[0].id;
      agent1UserId = agentProfiles.rows[0].userId;
      agent2ProfileId = agentProfiles.rows[1].id;
      agent2UserId = agentProfiles.rows[1].userId;
    } else {
      const uid1 = `test-ag1-${Date.now()}`;
      await db.query('INSERT INTO "AppAuthUser" (id, "tenantId", email, role, "displayName") VALUES ($1, $2, $3, $4, $5)', [
        uid1, tenantId, `${uid1}@test.com`, 'SALES_AGENT', 'Closer Alpha'
      ]);
      const prof1 = await db.query(
        'INSERT INTO "SalesAgentProfile" (id, "userId", "tenantId", "agentCode", "status", "updatedAt") VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id',
        [`prof-${uid1}`, uid1, tenantId, `AG1-${Date.now().toString().slice(-4)}`, 'ACTIVE']
      );
      agent1UserId = uid1;
      agent1ProfileId = prof1.rows[0].id;

      const uid2 = `test-ag2-${Date.now()}`;
      await db.query('INSERT INTO "AppAuthUser" (id, "tenantId", email, role, "displayName") VALUES ($1, $2, $3, $4, $5)', [
        uid2, tenantId, `${uid2}@test.com`, 'SALES_AGENT', 'Closer Beta'
      ]);
      const prof2 = await db.query(
        'INSERT INTO "SalesAgentProfile" (id, "userId", "tenantId", "agentCode", "status", "updatedAt") VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id',
        [`prof-${uid2}`, uid2, tenantId, `AG2-${Date.now().toString().slice(-4)}`, 'ACTIVE']
      );
      agent2UserId = uid2;
      agent2ProfileId = prof2.rows[0].id;
    }

    // Lead assigned to Agent 1
    const leadRes = await db.query('SELECT id FROM "SalesLeadAssignment" WHERE "tenantId" = $1 AND stage != \'RECYCLED\' LIMIT 1', [tenantId]);
    testLeadId = leadRes.rows[0].id;
    await db.query('UPDATE "SalesLeadAssignment" SET "assignedAgentId" = $1 WHERE id = $2', [agent1ProfileId, testLeadId]);

    // Ensure open pool item exists
    const poolRes = await db.query('SELECT id FROM "SalesLeadPoolItem" WHERE "tenantId" = $1 AND status = \'OPEN\' LIMIT 1', [tenantId]);
    if (poolRes.rows.length > 0) {
      testPoolItemId = poolRes.rows[0].id;
    } else {
      const newPoolId = `pool-${Date.now()}`;
      await db.query(
        'INSERT INTO "SalesLeadPoolItem" (id, "tenantId", "customerName", "customerPhone", status, "updatedAt") VALUES ($1, $2, $3, $4, $5, NOW())',
        [newPoolId, tenantId, 'Grab Pool Lead', '+919876543210', 'OPEN']
      );
      testPoolItemId = newPoolId;
    }
  } finally {
    db.release();
    await pool.end();
  }

  const adminToken = createToken({
    userId: adminUserId,
    role: 'ADMIN',
    tenantId,
    displayName: 'Admin User',
  });

  const agent1Token = createToken({
    userId: agent1UserId,
    role: 'SALES_AGENT',
    tenantId,
    displayName: 'Closer Alpha',
  });

  // Start app
  const { createServer } = await import('../dist/server.js');
  const app = createServer();
  const server = app.listen(process.env.PORT);

  try {
    // ==========================================
    // TEST 1: LEAD TRANSFER & REASSIGNMENT API
    // ==========================================
    console.log('--- TEST 1: Lead Transfer & Reassignment API (POST /api/v1/leads/:id/transfer) ---');
    const transferRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: `/api/v1/leads/${testLeadId}/transfer`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
    }, {
      targetAgentId: agent2ProfileId,
      note: 'Handoff for enterprise closing call',
    });

    assert.strictEqual(transferRes.status, 200, 'POST /:id/transfer should return 200');
    assert.strictEqual(transferRes.body?.lead?.assignedAgentId, agent2ProfileId, 'Lead should be reassigned to Agent 2');
    console.log(`✅ Lead ${testLeadId} successfully transferred to Agent 2 (${agent2ProfileId})`);

    // Verify timeline entry created
    const checkTimeline = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: `/api/v1/leads/${testLeadId}/360`,
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const history = checkTimeline.body?.data?.history || [];
    const transferTimeline = history.find(h => h.kind === 'LEAD_TRANSFERRED' || h.title?.includes('Lead Transferred') || h.body?.includes('Handoff for enterprise'));
    assert.ok(transferTimeline, 'LEAD_TRANSFERRED entry should exist in timeline');
    console.log('✅ SalesLeadTimelineEntry (LEAD_TRANSFERRED) verified in Lead 360');

    // ==========================================
    // TEST 2: GRAB POOL ROTATION & MISSED LEADS
    // ==========================================
    console.log('\n--- TEST 2: Grab Pool 10-Minute Rotation & Missed Lead Engine ---');
    const poolRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/leads/pool',
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(poolRes.status, 200, 'GET /api/v1/leads/pool should return 200');
    const poolItems = poolRes.body?.data || [];
    assert.ok(poolItems.length > 0, 'Pool items should be returned');
    assert.ok(typeof poolItems[0].expiresInSeconds === 'number', 'Pool item should include expiresInSeconds');
    assert.ok(poolItems[0].slotExpiresAt, 'Pool item should include slotExpiresAt');
    console.log(`✅ GET /api/v1/leads/pool returned ${poolItems.length} items with slotting (expiresInSeconds: ${poolItems[0].expiresInSeconds}s)`);

    const missedRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/leads/missed',
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(missedRes.status, 200, 'GET /api/v1/leads/missed should return 200');
    assert.ok(typeof missedRes.body?.totalMissed === 'number', 'Should return totalMissed count');
    console.log(`✅ GET /api/v1/leads/missed returned totalMissed: ${missedRes.body.totalMissed}`);

    // ==========================================
    // TEST 3: AGENT BREAK MODE API
    // ==========================================
    console.log('\n--- TEST 3: Agent Break Mode API ---');
    // Start break
    const breakStartRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/team/break/start',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agent1Token}`,
      },
    }, {
      durationMinutes: 20,
    });
    assert.strictEqual(breakStartRes.status, 200, 'POST /team/break/start should return 200');
    assert.strictEqual(breakStartRes.body?.isOnBreak, true, 'Agent should be on break');
    console.log(`✅ POST /api/v1/team/break/start activated break for 20m (remaining: ${breakStartRes.body?.remainingSeconds}s)`);

    // Check status
    const breakStatusRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/team/break/status',
      method: 'GET',
      headers: { Authorization: `Bearer ${agent1Token}` },
    });
    assert.strictEqual(breakStatusRes.status, 200, 'GET /team/break/status should return 200');
    assert.strictEqual(breakStatusRes.body?.isOnBreak, true, 'Agent status should show on break');
    console.log('✅ GET /api/v1/team/break/status verified active break');

    // End break
    const breakEndRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/team/break/end',
      method: 'POST',
      headers: { Authorization: `Bearer ${agent1Token}` },
    });
    assert.strictEqual(breakEndRes.status, 200, 'POST /team/break/end should return 200');
    assert.strictEqual(breakEndRes.body?.isOnBreak, false, 'Break should be cleared');
    console.log('✅ POST /api/v1/team/break/end resumed agent from break');

    // ==========================================
    // TEST 4: INDIAMART & JUSTDIAL INGESTION
    // ==========================================
    console.log('\n--- TEST 4: IndiaMART & JustDial Ingestion APIs ---');
    // Save IndiaMART config
    const imConfigRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/integrations/indiamart/config',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
    }, {
      crmKey: 'mKey_ABCD_1234_EFGH',
      mobileNumber: '+919988776655',
      syncIntervalMinutes: 10,
      distributionMode: 'ROUND_ROBIN',
    });
    assert.strictEqual(imConfigRes.status, 200, 'POST /integrations/indiamart/config should return 200');
    console.log('✅ POST /api/v1/integrations/indiamart/config saved configuration');

    // Get IndiaMART config (masked key)
    const getImConfigRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/integrations/indiamart/config',
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(getImConfigRes.status, 200, 'GET /integrations/indiamart/config should return 200');
    assert.ok(getImConfigRes.body?.data?.crmKey?.startsWith('***'), 'CRM key must be masked for security');
    console.log(`✅ GET /api/v1/integrations/indiamart/config returned masked key: ${getImConfigRes.body?.data?.crmKey}`);

    // Trigger IndiaMART sync
    const imSyncRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/integrations/indiamart/sync',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
    }, {
      leads: [
        {
          SENDER_NAME: 'Rajesh Sharma',
          SENDER_MOBILE: `+919911${Date.now().toString().slice(-6)}`,
          SENDER_EMAIL: `rajesh-${Date.now()}@example.com`,
          PRODUCT_NAME: 'B2B Enterprise CRM',
          QUERY_MESSAGE: 'Need pricing for 25 seats',
          ENQ_ORDER_VALUE: 150000,
        },
      ],
    });
    assert.strictEqual(imSyncRes.status, 200, 'POST /integrations/indiamart/sync should return 200');
    assert.ok(imSyncRes.body?.createdCount >= 1, 'Should create at least 1 lead from IndiaMART sync');
    console.log(`✅ POST /api/v1/integrations/indiamart/sync ingested ${imSyncRes.body.createdCount} new leads`);

    // Ingest JustDial inbound webhook
    const jdPhone = `+919822${Date.now().toString().slice(-6)}`;
    const jdWebhookRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: `/api/v1/integrations/justdial/webhook?tenantId=${tenantId}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    }, {
      lead_name: 'Amit Verma',
      mobile: jdPhone,
      email: `amit-${Date.now()}@test.com`,
      requirement: 'Telephony dialer and CRM automation software',
      area: 'Mumbai Western Suburbs',
    });
    assert.strictEqual(jdWebhookRes.status, 200, 'POST /integrations/justdial/webhook should return 200');
    assert.strictEqual(jdWebhookRes.body?.status, 'OK', 'Status should be OK');
    console.log(`✅ POST /api/v1/integrations/justdial/webhook successfully ingested lead for ${jdPhone}`);

    // ==========================================
    // TEST 5: PAYMENT BINDING BY LEAD ID
    // ==========================================
    console.log('\n--- TEST 5: Payment Binding by Lead ID ---');
    const createPaymentRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/payments',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
    }, {
      leadId: testLeadId,
      amount: 34999,
      productName: 'Annual SaaS Closer License',
    });
    assert.strictEqual(createPaymentRes.status, 201, 'POST /api/v1/payments should return 201');
    const createdPayment = createPaymentRes.body?.data || createPaymentRes.body?.payment;
    assert.strictEqual(createdPayment.customFields?.leadId, testLeadId, 'customFields.leadId must match passed leadId');
    console.log(`✅ POST /api/v1/payments bound customFields.leadId = ${testLeadId}`);

    const getPaymentByLeadRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: `/api/v1/payments?leadId=${testLeadId}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(getPaymentByLeadRes.status, 200, 'GET /api/v1/payments?leadId= should return 200');
    const fetchedPayments = getPaymentByLeadRes.body?.data || [];
    assert.ok(fetchedPayments.length >= 1, 'Should find payment by leadId filter');
    assert.strictEqual(fetchedPayments[0].customFields?.leadId, testLeadId, 'Filtered payment must have matching leadId');
    console.log(`✅ GET /api/v1/payments?leadId=${testLeadId} successfully filtered payment`);

    console.log('\n========================================================');
    console.log('🎉 ALL 5 BACKEND GOVERNANCE FEATURES CERTIFIED & VERIFIED!');
    console.log('========================================================\n');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
