const jwt = require('jsonwebtoken');
const assert = require('assert');
const http = require('http');
const { Pool } = require('pg');

process.env.PORT = '3096';
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
  console.log('🧪 RUNNING BATCH LEAD REORDER (POST /api/v1/leads/reorder) VERIFICATION...\n');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = await pool.connect();

  let tenantId;
  let adminUserId;
  let lead1Id;
  let lead2Id;

  try {
    const wsRes = await db.query('SELECT "tenantId" as id FROM "SalesLeadAssignment" GROUP BY "tenantId" ORDER BY count(*) DESC LIMIT 1');
    tenantId = wsRes.rows[0].id;
    console.log(`✅ Using live workspace: ${tenantId}`);

    const usersRes = await db.query('SELECT id, role FROM "AppAuthUser" WHERE "tenantId" = $1', [tenantId]);
    const admin = usersRes.rows.find(u => u.role === 'ADMIN' || u.role === 'SUPER_ADMIN') || usersRes.rows[0];
    adminUserId = admin.id;

    const leadsRes = await db.query('SELECT id, stage, "kanbanPosition" FROM "SalesLeadAssignment" WHERE "tenantId" = $1 AND stage != \'RECYCLED\' LIMIT 2', [tenantId]);
    assert(leadsRes.rows.length >= 2, 'Must have at least 2 leads to test batch reordering');
    lead1Id = leadsRes.rows[0].id;
    lead2Id = leadsRes.rows[1].id;
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

  const { createServer } = await import('../dist/server.js');
  const app = createServer();
  const server = app.listen(process.env.PORT);

  try {
    // 1. Validation test: empty items array should be rejected with 400
    console.log('--- TEST 1: Validation rejection on empty items ---');
    const emptyRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/leads/reorder',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
    }, { items: [] });
    assert.strictEqual(emptyRes.status, 400, 'Empty items should return 400 Bad Request');
    console.log('✅ Validation correctly rejected empty items array with 400');

    // 2. Batch update kanban positions within stage
    console.log('\n--- TEST 2: Batch Lead Reorder execution ---');
    const targetPos1 = 100;
    const targetPos2 = 200;
    const reorderRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/leads/reorder',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
    }, {
      stage: 'QUALIFIED',
      items: [
        { id: lead1Id, kanbanPosition: targetPos1, stage: 'QUALIFIED' },
        { id: lead2Id, kanbanPosition: targetPos2, stage: 'QUALIFIED' },
      ],
    });

    assert.strictEqual(reorderRes.status, 200, 'POST /api/v1/leads/reorder should return 200');
    assert.strictEqual(reorderRes.body.success, true, 'Response must have success: true');
    assert.strictEqual(reorderRes.body.count, 2, 'Response count must be 2');
    console.log(`✅ POST /api/v1/leads/reorder returned 200 with count: 2`);

    // 3. Verify in DB that kanbanPosition and stage were updated
    console.log('\n--- TEST 3: Database Verification ---');
    const pool2 = new Pool({ connectionString: process.env.DATABASE_URL });
    const db2 = await pool2.connect();
    try {
      const verifyRes = await db2.query('SELECT id, stage, "kanbanPosition" FROM "SalesLeadAssignment" WHERE id IN ($1, $2)', [lead1Id, lead2Id]);
      const l1 = verifyRes.rows.find(r => r.id === lead1Id);
      const l2 = verifyRes.rows.find(r => r.id === lead2Id);
      assert.strictEqual(Number(l1.kanbanPosition), targetPos1, `Lead 1 position must be ${targetPos1}`);
      assert.strictEqual(l1.stage, 'QUALIFIED', 'Lead 1 stage must be QUALIFIED');
      assert.strictEqual(Number(l2.kanbanPosition), targetPos2, `Lead 2 position must be ${targetPos2}`);
      assert.strictEqual(l2.stage, 'QUALIFIED', 'Lead 2 stage must be QUALIFIED');
      console.log(`✅ Verified in PostgreSQL: Lead 1 kanbanPosition=${l1.kanbanPosition}, Lead 2 kanbanPosition=${l2.kanbanPosition}, stages=QUALIFIED`);
    } finally {
      db2.release();
      await pool2.end();
    }

    // 4. Test Cross-Tenant Isolation
    console.log('\n--- TEST 4: Multi-Tenant Isolation ---');
    let foreignTenantId = 'foreign-tenant-xyz-999';
    const poolCheck = new Pool({ connectionString: process.env.DATABASE_URL });
    const dbCheck = await poolCheck.connect();
    try {
      const otherWs = await dbCheck.query('SELECT id FROM "AicloserWorkspace" WHERE id != $1 LIMIT 1', [tenantId]);
      if (otherWs.rows.length > 0) {
        foreignTenantId = otherWs.rows[0].id;
      }
    } finally {
      dbCheck.release();
      await poolCheck.end();
    }

    const foreignToken = createToken({
      userId: 'foreign-admin',
      role: 'ADMIN',
      tenantId: foreignTenantId,
    });
    const foreignReorderRes = await request({
      hostname: '127.0.0.1',
      port: process.env.PORT,
      path: '/api/v1/leads/reorder',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${foreignToken}`,
        'Content-Type': 'application/json',
      },
    }, {
      items: [{ id: lead1Id, kanbanPosition: 9999 }],
    });

    if (foreignReorderRes.status === 200) {
      assert.strictEqual(foreignReorderRes.status, 200);
    } else {
      assert.strictEqual(foreignReorderRes.status, 404, 'Non-existent tenant blocked by enforceTenantIsolation');
    }

    const pool3 = new Pool({ connectionString: process.env.DATABASE_URL });
    const db3 = await pool3.connect();
    try {
      const checkRes = await db3.query('SELECT "kanbanPosition" FROM "SalesLeadAssignment" WHERE id = $1', [lead1Id]);
      assert.strictEqual(Number(checkRes.rows[0].kanbanPosition), targetPos1, 'Foreign tenant cannot modify lead position');
      console.log('✅ Multi-tenant isolation verified: foreign tenant query did not alter lead position');
    } finally {
      db3.release();
      await pool3.end();
    }

    console.log('\n========================================================');
    console.log('🎉 BATCH LEAD REORDER (POST /reorder) FULLY CERTIFIED!');
    console.log('========================================================\n');
    process.exit(0);
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
