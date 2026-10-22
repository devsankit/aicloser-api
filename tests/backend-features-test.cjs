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

async function runTests() {
  console.log('🧪 RUNNING BACKEND NEW FEATURES VERIFICATION SUITE...\n');

  // Discover real tenant and users from live DB
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = await pool.connect();

  let tenantId;
  let adminUserId;
  let managerUserId;
  let agentUserId;
  let testLeadId;
  let testLeadPhone;
  let testConversationId;
  let testCallId;

  try {
    const wsRes = await db.query('SELECT "tenantId" as id FROM "SalesLeadAssignment" GROUP BY "tenantId" ORDER BY count(*) DESC LIMIT 1');
    tenantId = wsRes.rows[0].id;
    console.log(`✅ Using live workspace with leads: ${tenantId}`);

    const usersRes = await db.query('SELECT id, role, "displayName" FROM "AppAuthUser" WHERE "tenantId" = $1', [tenantId]);
    const admin = usersRes.rows.find(u => u.role === 'ADMIN' || u.role === 'SUPER_ADMIN') || usersRes.rows[0];
    adminUserId = admin.id;

    const leadRes = await db.query('SELECT id, "customerPhone" FROM "SalesLeadAssignment" WHERE "tenantId" = $1 AND stage != \'RECYCLED\' LIMIT 1', [tenantId]);
    if (leadRes.rows.length > 0) {
      testLeadId = leadRes.rows[0].id;
      testLeadPhone = leadRes.rows[0].customerPhone;
    }

    const convRes = await db.query('SELECT id FROM "AppConversation" WHERE "tenantId" = $1 LIMIT 1', [tenantId]);
    if (convRes.rows.length > 0) {
      testConversationId = convRes.rows[0].id;
    } else {
      // If none, get any conversation to test
      const anyConv = await db.query('SELECT id FROM "AppConversation" LIMIT 1');
      if (anyConv.rows.length > 0) testConversationId = anyConv.rows[0].id;
    }

    const callRes = await db.query('SELECT id FROM "SalesMobileCall" WHERE "tenantId" = $1 LIMIT 1', [tenantId]);
    if (callRes.rows.length > 0) {
      testCallId = callRes.rows[0].id;
    } else {
      const anyCall = await db.query('SELECT id FROM "SalesMobileCall" LIMIT 1');
      if (anyCall.rows.length > 0) testCallId = anyCall.rows[0].id;
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
    phone: '+919999999999',
  });

  const closerToken = createToken({
    userId: 'unauthorized-closer-id',
    role: 'SALES_AGENT',
    tenantId,
    displayName: 'Closer Rep',
    phone: '+918888888888',
  });

  const managerToken = createToken({
    userId: 'manager-user-id',
    role: 'MANAGER',
    tenantId,
    displayName: 'Manager User',
    phone: '+917777777777',
  });

  // Start app
  const { createServer } = await import('../dist/server.js');
  const app = createServer();
  const server = app.listen(process.env.PORT);

  try {
    // 1. Test Workspace Settings (allowManagerLeadDeletion)
    console.log('--- TEST 1: Workspace Settings API ---');
    const getSettingsRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/workspace/settings',
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(getSettingsRes.status, 200, 'GET /api/v1/workspace/settings should return 200');
    console.log('✅ GET /api/v1/workspace/settings returned 200');

    const patchSettingsRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/workspace/settings',
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
    }, { allowManagerLeadDeletion: false });
    assert.strictEqual(patchSettingsRes.status, 200, 'PATCH /api/v1/workspace/settings should return 200');
    assert.strictEqual(patchSettingsRes.body.allowManagerLeadDeletion, false);
    console.log('✅ PATCH /api/v1/workspace/settings allowManagerLeadDeletion: false verified');

    // 2. Test Labels API
    console.log('\n--- TEST 2: Labels API ---');
    const postLabelRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/labels',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
    }, { name: 'VIP Enterprise', color: '#10b981' });
    assert.ok(postLabelRes.status === 200 || postLabelRes.status === 201, 'POST /api/v1/labels should return 200 or 201');
    assert.strictEqual(postLabelRes.body.data.name, 'VIP Enterprise');
    console.log('✅ POST /api/v1/labels created label VIP Enterprise');

    const getLabelsRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/labels',
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(getLabelsRes.status, 200, 'GET /api/v1/labels should return 200');
    assert(Array.isArray(getLabelsRes.body.data), 'labels should return array');
    console.log(`✅ GET /api/v1/labels returned ${getLabelsRes.body.data.length} labels`);

    // 3. Test Lead Export (Role-restricted)
    console.log('\n--- TEST 3: Lead Export (.xlsx) ---');
    const closerExportRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/leads/export',
      method: 'GET',
      headers: { Authorization: `Bearer ${closerToken}` },
    });
    assert.strictEqual(closerExportRes.status, 403, 'Closer must be forbidden from exporting leads');
    console.log('✅ Closer export returned 403 Forbidden as mandated');

    const adminExportRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/leads/export',
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(adminExportRes.status, 200, 'Admin lead export should return 200');
    assert(adminExportRes.headers['content-type'].includes('spreadsheetml'), 'Export Content-Type must be xlsx');
    console.log('✅ Admin export returned 200 with Excel .xlsx Content-Type');

    // 4. Test Chat Share
    if (testConversationId) {
      console.log('\n--- TEST 4: Chat Share Endpoint ---');
      const shareRes = await request({
        hostname: '127.0.0.1',
        port: process.env.PORT,
        path: `/api/v1/conversations/${testConversationId}/share`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
      }, { targetUserId: 'shared-user-456' });
      assert.strictEqual(shareRes.status, 200, 'POST /api/v1/conversations/:id/share should return 200');
      assert.strictEqual(shareRes.body.sharedWith, 'shared-user-456');
      console.log('✅ POST /api/v1/conversations/:id/share returned sharedWith: shared-user-456');
    }

    // 5. Test Missed Call Resolve
    if (testCallId) {
      console.log('\n--- TEST 5: Resolve Missed Call ---');
      const resolveCallRes = await request({
        hostname: '127.0.0.1',
        port: process.env.PORT,
        path: `/api/v1/calls/${testCallId}/resolve-missed`,
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(resolveCallRes.status, 200, 'POST /api/v1/calls/:id/resolve-missed should return 200');
      assert.strictEqual(resolveCallRes.body.data.outcome, 'Callback Completed');
      assert.strictEqual(resolveCallRes.body.data.status, 'COMPLETED');
      console.log('✅ Missed call resolved with status COMPLETED and outcome "Callback Completed"');
    }

    // 6. Test Lead Deletion & Recycle Bin
    if (testLeadId) {
      console.log('\n--- TEST 6: Lead Deletion & Recycle Bin ---');
      // Unauthorized closer attempt
      const closerDelRes = await request({
        hostname: '127.0.0.1',
        port: process.env.PORT,
        path: `/api/v1/leads/${testLeadId}`,
        method: 'DELETE',
        headers: { Authorization: `Bearer ${closerToken}` },
      });
      assert.strictEqual(closerDelRes.status, 403, 'Unauthorized closer must be forbidden from deleting lead');
      console.log('✅ Unauthorized closer returned 403 Forbidden on lead deletion');

      // Unauthorized manager attempt (allowManagerLeadDeletion: false)
      const mgrDelRes = await request({
        hostname: '127.0.0.1',
        port: process.env.PORT,
        path: `/api/v1/leads/${testLeadId}`,
        method: 'DELETE',
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.strictEqual(mgrDelRes.status, 403, 'Manager must be forbidden when allowManagerLeadDeletion is false');
      console.log('✅ Manager returned 403 Forbidden when allowManagerLeadDeletion is false');

      // Admin soft delete
      const adminDelRes = await request({
        hostname: '127.0.0.1',
        port: process.env.PORT,
        path: `/api/v1/leads/${testLeadId}`,
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(adminDelRes.status, 200, 'Admin lead soft delete should return 200');
      assert.strictEqual(adminDelRes.body.data.stage, 'RECYCLED');
      console.log('✅ Admin soft deleted lead to RECYCLED stage');

      // View Recycle Bin
      const recycleBinRes = await request({
        hostname: '127.0.0.1',
        port: process.env.PORT,
        path: '/api/v1/leads/recycle-bin',
        method: 'GET',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(recycleBinRes.status, 200, 'GET /api/v1/leads/recycle-bin should return 200');
      const foundInBin = recycleBinRes.body.data.find(l => l.id === testLeadId);
      assert(foundInBin, 'Lead must be found in Recycle Bin');
      console.log('✅ Lead verified in GET /api/v1/leads/recycle-bin');

      // Restore Lead
      const restoreRes = await request({
        hostname: '127.0.0.1',
        port: process.env.PORT,
        path: `/api/v1/leads/${testLeadId}/restore`,
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(restoreRes.status, 200, 'POST /api/v1/leads/:id/restore should return 200');
      assert.strictEqual(restoreRes.body.data.stage, 'NEW');
      console.log('✅ Lead restored back to NEW stage');
    }

    // 7. Test Deal Value & Payment Link Sync
    console.log('\n--- TEST 7: Payment Link & Deal Value Sync ---');
    const createPaymentRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/payments',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
    }, {
      amount: 49999,
      leadId: testLeadId,
      customerPhone: testLeadPhone,
      productName: 'Enterprise Growth Package',
    });
    assert(createPaymentRes.status === 200 || createPaymentRes.status === 201, `POST /api/v1/payments returned ${createPaymentRes.status}`);
    console.log('✅ Payment request generated for ₹49,999 linked to lead');

    // Verify GET /pipeline-bootstrap reflects the payment link budget
    const bootstrapRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/leads/pipeline-bootstrap',
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(bootstrapRes.status, 200, 'GET /api/v1/leads/pipeline-bootstrap should return 200');
    const matchedLead = bootstrapRes.body.data.leads.find(l => l.id === testLeadId);
    if (matchedLead) {
      assert.strictEqual(matchedLead.budgetAmount, 49999, 'Lead budgetAmount must sync with payment amount ₹49,999');
      assert.strictEqual(matchedLead.paymentStatus, 'PENDING');
      assert(matchedLead.paymentLink.startsWith('/pay/'), 'paymentLink must start with /pay/');
      console.log(`✅ Lead ${matchedLead.id} Deal Value synced to ₹${matchedLead.budgetAmount} with payment link: ${matchedLead.paymentLink}`);
    }

    // 8. Test Quick Macros Full CRUD
    console.log('\n--- TEST 8: Quick Macros Full CRUD API ---');
    // A. GET /api/v1/macros
    const getMacrosRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/macros',
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(getMacrosRes.status, 200, 'GET /api/v1/macros should return 200');
    assert(Array.isArray(getMacrosRes.body.data), 'Macros must be an array');
    assert(getMacrosRes.body.data.length >= 4, 'Should return at least 4 default macros');
    console.log(`✅ GET /api/v1/macros returned ${getMacrosRes.body.data.length} macros`);

    // B. POST /api/v1/macros
    const postMacroRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/macros',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
    }, {
      name: 'WhatsApp Catalog',
      content: 'Here is our brochure: https://aicloser.in/catalog',
      category: 'Sales',
    });
    assert.strictEqual(postMacroRes.status, 201, 'POST /api/v1/macros should return 201 Created');
    const createdMacro = postMacroRes.body.data;
    assert.strictEqual(createdMacro.name, 'WhatsApp Catalog');
    console.log(`✅ POST /api/v1/macros created: ${createdMacro.id} (${createdMacro.name})`);

    // C. PATCH /api/v1/macros/:id
    const patchMacroRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: `/api/v1/macros/${createdMacro.id}`,
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
    }, {
      content: 'Updated brochure link: https://aicloser.in/catalog-v2',
    });
    assert.strictEqual(patchMacroRes.status, 200, 'PATCH /api/v1/macros/:id should return 200');
    assert.strictEqual(patchMacroRes.body.data.content, 'Updated brochure link: https://aicloser.in/catalog-v2');
    console.log(`✅ PATCH /api/v1/macros/${createdMacro.id} updated content successfully`);

    // D. DELETE /api/v1/macros/:id
    const deleteMacroRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: `/api/v1/macros/${createdMacro.id}`,
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(deleteMacroRes.status, 200, 'DELETE /api/v1/macros/:id should return 200');
    assert.strictEqual(deleteMacroRes.body.deletedId, createdMacro.id);
    console.log(`✅ DELETE /api/v1/macros/${createdMacro.id} deleted successfully`);

    console.log('\n========================================================');
    console.log('🎉 ALL BACKEND FEATURES CERTIFIED & VERIFIED SUCCESSFULLY');
    console.log('========================================================\n');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
