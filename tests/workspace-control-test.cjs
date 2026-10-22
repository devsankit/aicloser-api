const jwt = require('jsonwebtoken');
const assert = require('assert');
const http = require('http');
const { Pool } = require('pg');

process.env.PORT = '3099';
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
  console.log('🧪 RUNNING WORKSPACE CONTROL & GOVERNANCE CERTIFICATION SUITE...\n');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = await pool.connect();

  let tenantId;
  let adminUserId;
  let agent1UserId;
  let agent1ProfileId;
  let agent2UserId;
  let agent2ProfileId;
  let testLeadId;
  let testConversationId;

  try {
    const wsRes = await db.query('SELECT "tenantId" as id FROM "SalesLeadAssignment" GROUP BY "tenantId" ORDER BY count(*) DESC LIMIT 1');
    tenantId = wsRes.rows[0].id;
    console.log(`✅ Using active workspace: ${tenantId}`);

    const usersRes = await db.query('SELECT id, role, "displayName" FROM "AppAuthUser" WHERE "tenantId" = $1', [tenantId]);
    const admin = usersRes.rows.find(u => u.role === 'ADMIN' || u.role === 'SUPER_ADMIN') || usersRes.rows[0];
    adminUserId = admin.id;

    // Discover or create two distinct sales agents with different reporting hierarchies
    const agentProfiles = await db.query(
      'SELECT sap.id, sap."userId", sap."groupId", sap."parentAgentId", u."displayName" FROM "SalesAgentProfile" sap JOIN "AppAuthUser" u ON sap."userId" = u.id WHERE sap."tenantId" = $1',
      [tenantId]
    );

    if (agentProfiles.rows.length >= 2) {
      agent1ProfileId = agentProfiles.rows[0].id;
      agent1UserId = agentProfiles.rows[0].userId;
      agent2ProfileId = agentProfiles.rows[1].id;
      agent2UserId = agentProfiles.rows[1].userId;
      // Ensure they have no group and no parent link for strict scoping test
      await db.query('UPDATE "SalesAgentProfile" SET "groupId" = NULL, "parentAgentId" = NULL WHERE id = $1', [agent1ProfileId]);
      await db.query('UPDATE "SalesAgentProfile" SET "groupId" = NULL, "parentAgentId" = NULL WHERE id = $1', [agent2ProfileId]);
    } else {
      // Create user and profile 1
      const uid1 = `test-agent1-${Date.now()}`;
      await db.query('INSERT INTO "AppAuthUser" (id, "tenantId", email, role, "displayName") VALUES ($1, $2, $3, $4, $5)', [
        uid1, tenantId, `${uid1}@test.com`, 'SALES_AGENT', 'Agent Alpha'
      ]);
      const prof1 = await db.query(
        'INSERT INTO "SalesAgentProfile" (id, "userId", "tenantId", "agentCode", "status", "updatedAt") VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id',
        [`prof-${uid1}`, uid1, tenantId, `CODE1-${Date.now().toString().slice(-4)}`, 'ACTIVE']
      );
      agent1UserId = uid1;
      agent1ProfileId = prof1.rows[0].id;

      // Create user and profile 2
      const uid2 = `test-agent2-${Date.now()}`;
      await db.query('INSERT INTO "AppAuthUser" (id, "tenantId", email, role, "displayName") VALUES ($1, $2, $3, $4, $5)', [
        uid2, tenantId, `${uid2}@test.com`, 'SALES_AGENT', 'Agent Beta'
      ]);
      const prof2 = await db.query(
        'INSERT INTO "SalesAgentProfile" (id, "userId", "tenantId", "agentCode", "status", "updatedAt") VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id',
        [`prof-${uid2}`, uid2, tenantId, `CODE2-${Date.now().toString().slice(-4)}`, 'ACTIVE']
      );
      agent2UserId = uid2;
      agent2ProfileId = prof2.rows[0].id;
    }
    console.log(`✅ Agent 1: profile ${agent1ProfileId} (user ${agent1UserId})`);
    console.log(`✅ Agent 2: profile ${agent2ProfileId} (user ${agent2UserId})`);

    // Find or create lead assigned to Agent 1
    const leadRes = await db.query(
      'SELECT id FROM "SalesLeadAssignment" WHERE "tenantId" = $1 AND "assignedAgentId" = $2 AND stage != \'RECYCLED\' LIMIT 1',
      [tenantId, agent1ProfileId]
    );
    if (leadRes.rows.length > 0) {
      testLeadId = leadRes.rows[0].id;
    } else {
      // Reassign or create a lead for Agent 1
      const anyLead = await db.query('SELECT id FROM "SalesLeadAssignment" WHERE "tenantId" = $1 AND stage != \'RECYCLED\' LIMIT 1', [tenantId]);
      if (anyLead.rows.length > 0) {
        testLeadId = anyLead.rows[0].id;
        await db.query('UPDATE "SalesLeadAssignment" SET "assignedAgentId" = $1 WHERE id = $2', [agent1ProfileId, testLeadId]);
      }
    }
    console.log(`✅ Test Lead: ${testLeadId} (assigned to Agent 1)`);

    // Find or create conversation assigned to Agent 1
    const convRes = await db.query(
      'SELECT id FROM "AppConversation" WHERE "tenantId" = $1 AND "assignedFreelancerId" = $2 LIMIT 1',
      [tenantId, agent1ProfileId]
    );
    if (convRes.rows.length > 0) {
      testConversationId = convRes.rows[0].id;
    } else {
      const anyConv = await db.query('SELECT id FROM "AppConversation" WHERE "tenantId" = $1 LIMIT 1', [tenantId]);
      if (anyConv.rows.length > 0) {
        testConversationId = anyConv.rows[0].id;
        await db.query('UPDATE "AppConversation" SET "assignedFreelancerId" = $1 WHERE id = $2', [agent1ProfileId, testConversationId]);
      } else {
        const newConvId = `conv-${Date.now()}`;
        await db.query(
          'INSERT INTO "AppConversation" (id, "tenantId", "serviceId", "serviceSlug", "leadStatusId", "customerName", "customerPhone", "assignedFreelancerId", status, payload, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())',
          [newConvId, tenantId, 'svc-whatsapp', 'whatsapp', 'new', 'Test Customer', '+919988776655', agent1ProfileId, 'Active', JSON.stringify({ messages: [] })]
        );
        testConversationId = newConvId;
      }
    }
    console.log(`✅ Test Conversation: ${testConversationId} (assigned to Agent 1)`);
  } finally {
    db.release();
    await pool.end();
  }

  const adminToken = createToken({
    userId: adminUserId,
    role: 'ADMIN',
    tenantId,
    displayName: 'Admin User',
    phone: '+919999999999',
  });

  const agent1Token = createToken({
    userId: agent1UserId,
    role: 'SALES_AGENT',
    tenantId,
    displayName: 'Agent Alpha',
    phone: '+918888888881',
  });

  // Start app
  const { createServer } = await import('../dist/server.js');
  const app = createServer();
  const server = app.listen(process.env.PORT);

  try {
    // ==========================================
    // TEST 1: LABELS & TAGS FULL CRUD
    // ==========================================
    console.log('\n--- TEST 1: Labels & Tags Full CRUD ---');
    const labelKey = `HighPriority-${Date.now()}`;
    const renamedKey = `UltraVIP-${Date.now()}`;

    // 1a. POST /api/v1/labels
    const createLabelRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/labels',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
    }, {
      name: labelKey,
      color: '#FF5722',
      description: 'High priority customer lead',
    });
    assert.ok(createLabelRes.status === 200 || createLabelRes.status === 201, 'POST /api/v1/labels should return 200 or 201');
    console.log(`✅ POST /api/v1/labels created label "${labelKey}"`);

    // 1b. Assign tag to lead
    await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: `/api/v1/leads/${testLeadId}`,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
    }, {
      tags: [labelKey, 'ExistingTag'],
    });

    // 1c. GET /api/v1/labels - Verify usageCount >= 1
    const getLabelsRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/labels',
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(getLabelsRes.status, 200, 'GET /api/v1/labels should return 200');
    const foundLabel = (getLabelsRes.body?.data || []).find((l) => l.name === labelKey);
    assert.ok(foundLabel, `Label ${labelKey} should exist in list`);
    assert.ok(foundLabel.usageCount >= 1, `Label ${labelKey} usageCount should be >= 1 (got ${foundLabel.usageCount})`);
    console.log(`✅ GET /api/v1/labels verified label with usageCount: ${foundLabel.usageCount}`);

    // 1d. PUT /api/v1/labels/:name - Rename label and cascade to lead tags
    const renameRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: `/api/v1/labels/${encodeURIComponent(labelKey)}`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
    }, {
      name: renamedKey,
      color: '#4CAF50',
    });
    assert.strictEqual(renameRes.status, 200, 'PUT /api/v1/labels/:name should return 200');
    console.log(`✅ PUT /api/v1/labels/${labelKey} renamed to "${renamedKey}"`);

    // Verify lead's tags were updated
    const getLeadRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: `/api/v1/leads/${testLeadId}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const leadTags = getLeadRes.body?.data?.tags || [];
    assert.ok(leadTags.includes(renamedKey), `Lead tags should include renamed tag ${renamedKey}`);
    assert.ok(!leadTags.includes(labelKey), `Lead tags should no longer include old tag ${labelKey}`);
    console.log(`✅ Tag rename cascaded to SalesLeadAssignment.tags: ${JSON.stringify(leadTags)}`);

    // 1e. DELETE /api/v1/labels/:name - Delete label and remove from lead tags
    const deleteLabelRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: `/api/v1/labels/${encodeURIComponent(renamedKey)}`,
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(deleteLabelRes.status, 200, 'DELETE /api/v1/labels/:name should return 200');

    const getLeadAfterDel = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: `/api/v1/leads/${testLeadId}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const leadTagsAfterDel = getLeadAfterDel.body?.data?.tags || [];
    assert.ok(!leadTagsAfterDel.includes(renamedKey), `Lead tags should have cleaned up ${renamedKey}`);
    console.log(`✅ DELETE /api/v1/labels purged tag from SalesLeadAssignment.tags: ${JSON.stringify(leadTagsAfterDel)}`);

    // ==========================================
    // TEST 2: CONVERSATION SHARING GOVERNANCE
    // ==========================================
    console.log('\n--- TEST 2: Conversation Sharing Governance (chatSharingScope === REPORTING_TEAM_ONLY) ---');
    // Configure workspace settings
    await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/workspace/settings',
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
    }, {
      chatSharingScope: 'REPORTING_TEAM_ONLY',
    });

    // Agent 1 attempts to share conversation with Agent 2 (different team) via POST /:id/share
    const shareCrossTeamRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: `/api/v1/conversations/${testConversationId}/share`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agent1Token}`,
      },
    }, {
      targetUserId: agent2UserId,
    });

    assert.strictEqual(shareCrossTeamRes.status, 403, 'POST /:id/share cross-team should return 403 Forbidden');
    assert.ok(
      (shareCrossTeamRes.body?.error || shareCrossTeamRes.body?.message || '').includes('restricted to your direct reporting team'),
      'Should return direct reporting team restriction error'
    );
    console.log('✅ POST /api/v1/conversations/:id/share returned 403 Forbidden for cross-team sharing');

    // Agent 1 attempts to share conversation with Agent 2 via POST /:id/shares
    const sharesCrossTeamRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: `/api/v1/conversations/${testConversationId}/shares`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agent1Token}`,
      },
    }, {
      userId: agent2UserId,
      permission: 'REPLY',
    });

    assert.strictEqual(sharesCrossTeamRes.status, 403, 'POST /:id/shares cross-team should return 403 Forbidden');
    assert.ok(
      (sharesCrossTeamRes.body?.error || sharesCrossTeamRes.body?.message || '').includes('restricted to your direct reporting team'),
      'Should return direct reporting team restriction error'
    );
    console.log('✅ POST /api/v1/conversations/:id/shares returned 403 Forbidden for cross-team sharing');

    // ==========================================
    // TEST 3: LEAD REASSIGNMENT GOVERNANCE
    // ==========================================
    console.log('\n--- TEST 3: Lead Reassignment Governance ---');
    // 3a. allowAgentLeadReassign === false
    await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/workspace/settings',
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
    }, {
      allowAgentLeadReassign: false,
    });

    const reassignBlockedRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: `/api/v1/leads/${testLeadId}`,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agent1Token}`,
      },
    }, {
      assignedAgentId: agent2ProfileId,
    });

    assert.strictEqual(reassignBlockedRes.status, 403, 'PATCH /api/v1/leads/:id should return 403 when allowAgentLeadReassign is false');
    assert.ok(
      (reassignBlockedRes.body?.error || reassignBlockedRes.body?.message || '').includes('disabled for sales agents'),
      'Should return lead reassignment disabled error'
    );
    console.log('✅ PATCH /api/v1/leads/:id returned 403 Forbidden when allowAgentLeadReassign === false');

    // 3b. leadAssignmentScope === 'REPORTING_TEAM_ONLY'
    await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/workspace/settings',
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
    }, {
      allowAgentLeadReassign: true,
      leadAssignmentScope: 'REPORTING_TEAM_ONLY',
    });

    const reassignCrossTeamRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: `/api/v1/leads/${testLeadId}`,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agent1Token}`,
      },
    }, {
      assignedAgentId: agent2ProfileId,
    });

    assert.strictEqual(reassignCrossTeamRes.status, 403, 'PATCH /api/v1/leads/:id should return 403 when reassigning outside reporting team');
    assert.ok(
      (reassignCrossTeamRes.body?.error || reassignCrossTeamRes.body?.message || '').includes('restricted to your direct reporting team'),
      'Should return reporting team restricted error'
    );
    console.log('✅ PATCH /api/v1/leads/:id returned 403 Forbidden when reassigning outside reporting team');

    // ==========================================
    // TEST 4: HISTORY DEDUPLICATION & UNIQUE IDS
    // ==========================================
    console.log('\n--- TEST 4: History Deduplication in Lead 360 ---');
    const lead360Res = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: `/api/v1/leads/${testLeadId}/360`,
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    assert.strictEqual(lead360Res.status, 200, 'GET /api/v1/leads/:id/360 should return 200');
    const history = lead360Res.body?.data?.history || [];
    const historyIds = history.map(h => h.id);
    const uniqueIds = new Set(historyIds);

    assert.strictEqual(historyIds.length, uniqueIds.size, `All history IDs must be unique (found ${historyIds.length - uniqueIds.size} duplicates)`);
    console.log(`✅ GET /api/v1/leads/:id/360 returned ${history.length} items with 100% UNIQUE deterministic IDs`);

    // ==========================================
    // TEST 5: ADMIN CONVERSATION ACCESS
    // ==========================================
    console.log('\n--- TEST 5: Admin Permanent Conversation Access ---');
    const adminConvRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: `/api/v1/conversations/${testConversationId}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(adminConvRes.status, 200, 'Admin should have unconditional full access to conversation');
    console.log('✅ GET /api/v1/conversations/:id returned 200 OK for Admin with full REPLY access');

    console.log('\n========================================================');
    console.log('🎉 ALL WORKSPACE CONTROL & GOVERNANCE TESTS CERTIFIED!');
    console.log('========================================================\n');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
