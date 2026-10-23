const jwt = require('jsonwebtoken');
const assert = require('assert');
const http = require('http');
const { Pool } = require('pg');

process.env.PORT = '3098';
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

async function runAdversarialStressSuite() {
  console.log('⚡ STARTING EMPIRICAL CHALLENGER ADVERSARIAL STRESS SUITE (5 PILLARS)...\n');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = await pool.connect();

  let tenantId;
  let adminUserId;
  let agent1UserId;
  let agent1ProfileId;
  let agent2UserId;
  let agent2ProfileId;
  let testLeadId;
  let testLeadPhone;
  let adminProfileId;

  try {
    const wsRes = await db.query('SELECT "tenantId" as id FROM "SalesLeadAssignment" GROUP BY "tenantId" ORDER BY count(*) DESC LIMIT 1');
    tenantId = wsRes.rows[0].id;
    console.log(`[INIT] Active Tenant: ${tenantId}`);

    const usersRes = await db.query('SELECT id, role, "displayName" FROM "AppAuthUser" WHERE "tenantId" = $1', [tenantId]);
    const admin = usersRes.rows.find(u => u.role === 'ADMIN' || u.role === 'SUPER_ADMIN') || usersRes.rows[0];
    adminUserId = admin.id;

    // Check if admin has a sales profile (or create one to test assignment block)
    const adminProfRes = await db.query('SELECT id FROM "SalesAgentProfile" WHERE "userId" = $1', [adminUserId]);
    if (adminProfRes.rows.length > 0) {
      adminProfileId = adminProfRes.rows[0].id;
    } else {
      const pRes = await db.query(
        'INSERT INTO "SalesAgentProfile" (id, "userId", "tenantId", "agentCode", status, "updatedAt") VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id',
        [`admin-prof-${Date.now()}`, adminUserId, tenantId, 'ADM-01', 'ACTIVE']
      );
      adminProfileId = pRes.rows[0].id;
    }

    // Closer profiles
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
      const uid1 = `challenger-ag1-${Date.now()}`;
      await db.query('INSERT INTO "AppAuthUser" (id, "tenantId", email, role, "displayName") VALUES ($1, $2, $3, $4, $5)', [
        uid1, tenantId, `${uid1}@test.com`, 'SALES_AGENT', 'Closer Alpha'
      ]);
      const prof1 = await db.query(
        'INSERT INTO "SalesAgentProfile" (id, "userId", "tenantId", "agentCode", "status", "updatedAt") VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id',
        [`prof-${uid1}`, uid1, tenantId, `AG1-${Date.now().toString().slice(-4)}`, 'ACTIVE']
      );
      agent1UserId = uid1;
      agent1ProfileId = prof1.rows[0].id;

      const uid2 = `challenger-ag2-${Date.now()}`;
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

    testLeadPhone = `+919871${Date.now().toString().slice(-6)}`;
    const newLeadId = `challenger-lead-${Date.now()}`;
    await db.query(
      'INSERT INTO "SalesLeadAssignment" (id, "tenantId", "customerName", "customerPhone", "customerEmail", stage, "assignedAgentId", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())',
      [newLeadId, tenantId, 'Stress Test Prospect', testLeadPhone, 'stress@example.com', 'NEW', agent1ProfileId]
    );
    testLeadId = newLeadId;
    console.log(`[INIT] Seeded test lead: ${testLeadId} (phone: ${testLeadPhone}, agent: ${agent1ProfileId})`);
  } finally {
    db.release();
    await pool.end();
  }

  const adminToken = createToken({
    userId: adminUserId,
    role: 'ADMIN',
    tenantId,
    displayName: 'System Admin',
  });

  const agent1Token = createToken({
    userId: agent1UserId,
    role: 'SALES_AGENT',
    tenantId,
    displayName: 'Closer Alpha',
  });

  // Start isolated express test server
  const { createServer } = await import('../dist/server.js');
  const app = createServer();
  const server = app.listen(process.env.PORT);

  try {
    // =========================================================================
    // PILLAR 1: LEAD TRANSFER RBAC & TIMELINE INTEGRITY STRESS-TESTS
    // =========================================================================
    console.log('\n--- [PILLAR 1] Lead Transfer Adversarial Validation ---');

    // 1.1: Transfer to ADMIN must fail with 403 AdminAssignmentForbidden
    const adminTransferRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: `/api/v1/leads/${testLeadId}/transfer`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    }, {
      targetAgentId: adminProfileId,
      note: 'Illegal attempt to assign lead to Company Admin',
    });
    assert.strictEqual(adminTransferRes.status, 403, 'Transfer to ADMIN must return 403 Forbidden');
    assert.strictEqual(adminTransferRes.body?.error, 'AdminAssignmentForbidden', 'Must return AdminAssignmentForbidden');
    console.log('✅ Challenge 1.1 PASSED: Transfer to ADMIN correctly blocked with 403 AdminAssignmentForbidden');

    // 1.2: Transfer to non-existent agent must fail with 400 InvalidAgent
    const invalidAgentRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: `/api/v1/leads/${testLeadId}/transfer`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    }, {
      targetAgentId: 'non-existent-agent-id-999',
    });
    assert.strictEqual(invalidAgentRes.status, 400, 'Transfer to non-existent agent must return 400');
    assert.strictEqual(invalidAgentRes.body?.error, 'InvalidAgent');
    console.log('✅ Challenge 1.2 PASSED: Transfer to non-existent agent correctly returns 400 InvalidAgent');

    // 1.3: Cross-tenant transfer attack: Transfer lead from a different tenant
    const foreignToken = createToken({
      userId: 'foreign-user-id',
      role: 'ADMIN',
      tenantId: 'unauthorized-foreign-tenant-xyz',
      displayName: 'Attacker Admin',
    });
    const foreignTransferRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: `/api/v1/leads/${testLeadId}/transfer`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${foreignToken}` },
    }, {
      targetAgentId: agent2ProfileId,
    });
    assert.ok(foreignTransferRes.status === 404 || foreignTransferRes.status === 403, 'Cross-tenant transfer must be denied (403 or 404)');
    console.log(`✅ Challenge 1.3 PASSED: Cross-tenant lead transfer rejected with ${foreignTransferRes.status}`);

    // 1.4: Valid transfer from Agent 1 to Agent 2
    const validTransferRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: `/api/v1/leads/${testLeadId}/transfer`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    }, {
      targetAgentId: agent2ProfileId,
      note: 'Reassigning to Closer Beta for specialized consultation',
    });
    assert.strictEqual(validTransferRes.status, 200, 'Valid transfer must succeed with 200');
    assert.strictEqual(validTransferRes.body?.lead?.assignedAgentId, agent2ProfileId);

    // Verify timeline entry
    const timelineRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: `/api/v1/leads/${testLeadId}/360`,
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const timeline = timelineRes.body?.data?.history || [];
    const transferEntry = timeline.find(t => t.kind === 'LEAD_TRANSFERRED' || t.title?.includes('Lead Transferred'));
    assert.ok(transferEntry, 'Timeline entry LEAD_TRANSFERRED must exist');
    console.log('✅ Challenge 1.4 PASSED: Valid transfer reassigns agent and logs LEAD_TRANSFERRED timeline record');

    // =========================================================================
    // PILLAR 2: 10-MINUTE GRAB POOL & TELEPHONY EXEMPTION VERIFICATION
    // =========================================================================
    console.log('\n--- [PILLAR 2] Grab Pool Rotation & Telephony Exemption ---');

    // 2.1: Verify pool slot countdown and schema
    const poolRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/leads/pool',
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(poolRes.status, 200);
    const poolItems = poolRes.body?.data || [];
    if (poolItems.length > 0) {
      assert.ok(typeof poolItems[0].expiresInSeconds === 'number', 'expiresInSeconds must be a number');
      assert.ok(poolItems[0].expiresInSeconds <= 600, 'Grab pool slot cannot exceed 600s (10 min)');
      assert.ok(poolItems[0].slotExpiresAt, 'slotExpiresAt must be populated');
      console.log(`✅ Challenge 2.1 PASSED: Grab pool slotting validated (countdown: ${poolItems[0].expiresInSeconds}s)`);
    }

    // 2.2: Test Telephony Live Call Exemption directly against grab-pool-rotation engine
    const { isAgentOnLiveCall, syncAndRotatePoolSlots } = await import('../dist/lib/grab-pool-rotation.js');
    const { prisma } = await import('../dist/lib/prisma.js');

    // Case A: No active call on phone number -> isAgentOnLiveCall returns false
    const callCheckNoCall = await isAgentOnLiveCall(tenantId, agent1ProfileId, '+919999999999');
    assert.strictEqual(callCheckNoCall, false, 'Should be false when no active call exists');

    // Case B: Insert an active live mobile call (CONNECTED, endedAt: null)
    const testCallId = `test-call-${Date.now()}`;
    const liveCallPhone = '+919876543210';
    await prisma.salesMobileCall.create({
      data: {
        id: testCallId,
        AicloserWorkspace: { connect: { id: tenantId } },
        agent: { connect: { id: agent1ProfileId } },
        assignment: { connect: { id: testLeadId } },
        phoneNumber: liveCallPhone,
        direction: 'OUTBOUND',
        status: 'CONNECTED',
        startedAt: new Date(),
        endedAt: null,
      },
    });

    const callCheckActive = await isAgentOnLiveCall(tenantId, agent1ProfileId, liveCallPhone);
    assert.strictEqual(callCheckActive, true, 'isAgentOnLiveCall must return TRUE when closer has active CONNECTED call');
    console.log('✅ Challenge 2.2 PASSED: isAgentOnLiveCall accurately identifies active mobile SIM call');

    // Case C: When call ends (endedAt set), exemption must immediately expire
    await prisma.salesMobileCall.update({
      where: { id: testCallId },
      data: { status: 'COMPLETED', endedAt: new Date() },
    });
    const callCheckEnded = await isAgentOnLiveCall(tenantId, agent1ProfileId, liveCallPhone);
    assert.strictEqual(callCheckEnded, false, 'isAgentOnLiveCall must return FALSE once call has ended');
    console.log('✅ Challenge 2.3 PASSED: Ended call removes telephony exemption immediately');

    // Cleanup test call
    await prisma.salesMobileCall.delete({ where: { id: testCallId } }).catch(() => undefined);

    // =========================================================================
    // PILLAR 3: AGENT BREAK MODE API VALIDATION & BOUNDS
    // =========================================================================
    console.log('\n--- [PILLAR 3] Agent Break Mode API Adversarial Validation ---');

    // 3.1: Reject negative break duration
    const negBreakRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/team/break/start',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agent1Token}` },
    }, { durationMinutes: -15 });
    assert.strictEqual(negBreakRes.status, 400, 'Negative duration must return 400 validation error');
    console.log('✅ Challenge 3.1 PASSED: Negative break duration (-15) rejected with 400');

    // 3.2: Reject excessive break duration (> 240 mins)
    const overBreakRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/team/break/start',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agent1Token}` },
    }, { durationMinutes: 1000 });
    assert.strictEqual(overBreakRes.status, 400, 'Duration > 240m must return 400 validation error');
    console.log('✅ Challenge 3.2 PASSED: Excessive break duration (1000m) rejected with 400');

    // 3.3: Start valid break of 15 minutes
    const validBreakRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/team/break/start',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agent1Token}` },
    }, { durationMinutes: 15 });
    assert.strictEqual(validBreakRes.status, 200);
    assert.strictEqual(validBreakRes.body?.isOnBreak, true);
    assert.strictEqual(validBreakRes.body?.durationMinutes, 15);
    assert.ok(validBreakRes.body?.remainingSeconds > 0 && validBreakRes.body?.remainingSeconds <= 900);
    console.log('✅ Challenge 3.3 PASSED: Valid 15-minute break started successfully');

    // 3.4: Verify break status endpoint
    const statusRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/team/break/status',
      method: 'GET',
      headers: { Authorization: `Bearer ${agent1Token}` },
    });
    assert.strictEqual(statusRes.status, 200);
    assert.strictEqual(statusRes.body?.isOnBreak, true);
    console.log('✅ Challenge 3.4 PASSED: /team/break/status reflects active break');

    // 3.5: End break early
    const endBreakRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/team/break/end',
      method: 'POST',
      headers: { Authorization: `Bearer ${agent1Token}` },
    });
    assert.strictEqual(endBreakRes.status, 200);
    assert.strictEqual(endBreakRes.body?.isOnBreak, false);

    const postEndStatus = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/team/break/status',
      method: 'GET',
      headers: { Authorization: `Bearer ${agent1Token}` },
    });
    assert.strictEqual(postEndStatus.body?.isOnBreak, false);
    console.log('✅ Challenge 3.5 PASSED: Break ended and status reset to idle');

    // =========================================================================
    // PILLAR 4: INDIAMART & JUSTDIAL INGESTION ROBUSTNESS
    // =========================================================================
    console.log('\n--- [PILLAR 4] IndiaMART & JustDial Gateway Security ---');

    // 4.1: Regular sales agent cannot configure IndiaMART (RBAC check)
    const agentImConfigRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/integrations/indiamart/config',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agent1Token}` },
    }, { crmKey: 'hack_key', mobileNumber: '+919999999999' });
    assert.strictEqual(agentImConfigRes.status, 403, 'Sales agent must be blocked from modifying integration settings');
    console.log('✅ Challenge 4.1 PASSED: RBAC prevents non-admin agents from altering IndiaMART config');

    // 4.2: Ingest JustDial lead without tenantId should be rejected or handle safely
    const missingTenantJdRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/integrations/justdial/webhook',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { lead_name: 'Anonymous Lead', mobile: '+919876500000' });
    assert.ok(missingTenantJdRes.status === 400 || missingTenantJdRes.status === 200, 'Handled without 500 crash');
    console.log(`✅ Challenge 4.2 PASSED: JustDial webhook handled missing tenant safely (status: ${missingTenantJdRes.status})`);

    // =========================================================================
    // PILLAR 5: DYNAMIC PAYMENT BINDING & VALUE SYNC
    // =========================================================================
    console.log('\n--- [PILLAR 5] Dynamic Payment Binding & Deal Value Sync ---');

    // 5.1: Negative payment amount must be rejected with 400
    const negPayRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/payments',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    }, { leadId: testLeadId, amount: -2500 });
    assert.strictEqual(negPayRes.status, 400, 'Negative payment amount must return 400');
    console.log('✅ Challenge 5.1 PASSED: Negative payment amount (-2500) rejected with 400');

    // 5.2: Zero payment amount must be rejected with 400
    const zeroPayRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/payments',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    }, { leadId: testLeadId, amount: 0 });
    assert.strictEqual(zeroPayRes.status, 400, 'Zero payment amount must return 400');
    console.log('✅ Challenge 5.2 PASSED: Zero payment amount (0) rejected with 400');

    // 5.3: Valid payment creation binds leadId and updates SalesLeadAssignment.budgetAmount
    const validPayAmount = 75000;
    const createPayRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/payments',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    }, {
      leadId: testLeadId,
      amount: validPayAmount,
      productName: 'Enterprise CRM Annual Contract',
    });
    assert.strictEqual(createPayRes.status, 201, 'Valid payment must be created with 201');
    const createdPay = createPayRes.body?.data || createPayRes.body?.payment;
    assert.strictEqual(createdPay.customFields?.leadId, testLeadId, 'customFields.leadId must be bound to lead');
    console.log(`✅ Challenge 5.3 PASSED: Payment created and bound to lead ${testLeadId}`);

    // Verify lead's budgetAmount was updated in database
    const leadCheck = await prisma.salesLeadAssignment.findUnique({
      where: { id: testLeadId },
      select: { budgetAmount: true },
    });
    assert.strictEqual(Number(leadCheck?.budgetAmount), validPayAmount, 'SalesLeadAssignment.budgetAmount must sync to payment amount');
    console.log(`✅ Challenge 5.4 PASSED: Lead budgetAmount synchronized to ₹${validPayAmount} seamlessly`);

    // 5.5: Query by leadId isolation: Searching by testLeadId returns the payment
    const filterByLeadRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: `/api/v1/payments?leadId=${testLeadId}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(filterByLeadRes.status, 200);
    const paymentsForLead = filterByLeadRes.body?.data || [];
    assert.ok(paymentsForLead.length >= 1, 'Must find payment for this leadId');
    assert.strictEqual(paymentsForLead[0].customFields?.leadId, testLeadId);

    // Searching by unrelated fake lead ID returns 0 results
    const filterByFakeLeadRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/payments?leadId=fake-lead-id-none',
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(filterByFakeLeadRes.status, 200);
    const fakeLeadPayments = filterByFakeLeadRes.body?.data || [];
    assert.strictEqual(fakeLeadPayments.length, 0, 'Must return 0 payments for unrelated leadId');
    console.log('✅ Challenge 5.5 PASSED: Payment queries isolated strictly by leadId');

    console.log('\n========================================================================');
    console.log('🏆 ALL ADVERSARIAL STRESS CHALLENGES PASSED ACROSS ALL 5 PILLARS!');
    console.log('========================================================================\n');
    process.exit(0);
  } finally {
    server.close();
  }
}

runAdversarialStressSuite().catch((err) => {
  console.error('\n❌ ADVERSARIAL TEST HARNESS FAILED:', err);
  process.exit(1);
});
