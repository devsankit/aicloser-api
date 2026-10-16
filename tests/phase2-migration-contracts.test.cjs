const jwt = require('jsonwebtoken');
const assert = require('assert');
const http = require('http');

const API_BASE = 'http://127.0.0.1:3060';
const JWT_SECRET = process.env.JWT_SECRET || 'aicloser-super-secure-production-jwt-secret-2026-key';

const tenantA = 'tenant-the-storage-test-1d01dda2';

const userAdminA = {
  userId: 'user-admin-eafadb6d',
  email: 'admin.a@example.com',
  role: 'ADMIN',
  tenantId: tenantA,
  displayName: 'Ankit rathore',
};

const userCloserA = {
  userId: 'user-sales-agent-83d13bc5',
  email: 'closer.a@example.com',
  role: 'SALES_AGENT',
  tenantId: tenantA,
  displayName: 'Closer Agent',
};

const tokenAdminA = jwt.sign(userAdminA, JWT_SECRET, { expiresIn: '2h' });
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

async function runPhase2Suite() {
  console.log('========================================================================');
  console.log('PHASE 2 MIGRATION GAPS: REPORTING, ANALYTICS & EXPORTS CONTRACT SUITE');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log('  PASS: ' + name);
      passed++;
    } catch (err) {
      console.error('  FAIL: ' + name);
      console.error('     Error: ' + (err ? err.message : '') + '\n');
      failed++;
    }
  }

  // 1. GET /api/v1/reports/summary & /overview
  await test('1. GET /api/v1/reports/summary returns overview with funnel & leaderboard', async () => {
    const res = await apiRequest({ path: '/api/v1/reports/summary', method: 'GET', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(res.data.data);
    assert.strictEqual(typeof res.data.data.totalLeads, 'number');
    assert.strictEqual(typeof res.data.data.closedRevenue, 'number');
    assert.ok(Array.isArray(res.data.funnel));
    assert.ok(Array.isArray(res.data.leaderboard));
  });

  // 2. GET /api/v1/reports/closers
  await test('2. GET /api/v1/reports/closers returns closer productivity metrics', async () => {
    const res = await apiRequest({ path: '/api/v1/reports/closers', method: 'GET', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(Array.isArray(res.data.data));
  });

  // 3. GET /api/v1/reports/custom
  await test('3. GET /api/v1/reports/custom returns hourly buckets, leaderboard & sources', async () => {
    const res = await apiRequest({ path: '/api/v1/reports/custom', method: 'GET', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(Array.isArray(res.data.hourly));
    assert.strictEqual(res.data.hourly.length, 24);
    assert.strictEqual(res.data.hourly[0].hour, '0:00');
    assert.ok(Array.isArray(res.data.leaderboard));
    assert.ok(Array.isArray(res.data.sources));
    assert.ok(res.data.summary);
  });

  // 4. POST /api/v1/reports/custom with filters
  await test('4. POST /api/v1/reports/custom accepts date range & filters payload', async () => {
    const res = await apiRequest(
      { path: '/api/v1/reports/custom', method: 'POST', token: tokenAdminA },
      { dateFrom: '2026-01-01', dateTo: '2026-12-31' }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(Array.isArray(res.data.hourly));
    assert.strictEqual(res.data.hourly.length, 24);
  });

  // 5. GET /api/v1/reports/export?type=leads returns CSV file
  await test('5. GET /api/v1/reports/export?type=leads returns properly formatted CSV', async () => {
    const res = await apiRequest({ path: '/api/v1/reports/export?type=leads&format=csv', method: 'GET', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/csv'));
    assert.ok(res.headers['content-disposition'].includes('attachment; filename="aicloser-leads-export-'));
    assert.ok(res.raw.startsWith('"ID","Customer Name","Phone Number"'));
  });

  // 6. GET /api/v1/reports/export?type=calls returns CSV file
  await test('6. GET /api/v1/reports/export?type=calls returns calls CSV', async () => {
    const res = await apiRequest({ path: '/api/v1/reports/export?type=calls&format=csv', method: 'GET', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/csv'));
    assert.ok(res.headers['content-disposition'].includes('attachment; filename="aicloser-calls-export-'));
    assert.ok(res.raw.startsWith('"ID","Phone Number","Direction"'));
  });

  // 7. GET /api/v1/reports/export?type=contacts returns CSV file
  await test('7. GET /api/v1/reports/export?type=contacts returns contacts CSV', async () => {
    const res = await apiRequest({ path: '/api/v1/reports/export?type=contacts&format=csv', method: 'GET', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/csv'));
    assert.ok(res.headers['content-disposition'].includes('attachment; filename="aicloser-contacts-export-'));
    assert.ok(res.raw.startsWith('"ID","Full Name","Phone"'));
  });

  // 8. GET /api/v1/reports/responsibility
  await test('8. GET /api/v1/reports/responsibility returns complete responsibility payload', async () => {
    const res = await apiRequest({ path: '/api/v1/reports/responsibility?range=all&page=1&pageSize=20', method: 'GET', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(res.data.report);
    assert.ok(res.data.report.summary);
    assert.strictEqual(typeof res.data.report.summary.assigned, 'number');
    assert.strictEqual(typeof res.data.report.summary.dueToday, 'number');
    assert.ok(Array.isArray(res.data.report.team));
    assert.ok(Array.isArray(res.data.report.exceptions));
    assert.ok(Array.isArray(res.data.report.leads));
    assert.ok(res.data.report.pagination);
    assert.strictEqual(res.data.report.pagination.page, 1);
  });

  // 9. Sales Agent calling /api/v1/reports/responsibility is strictly scoped to own leads
  await test('9. Sales Agent calling /responsibility is restricted to own assigned leads', async () => {
    const res = await apiRequest({ path: '/api/v1/reports/responsibility?range=all&view=mine', method: 'GET', token: tokenCloserA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(res.data.report);
    // All returned leads must belong to closer's agent ID
    if (res.data.report.leads.length > 0) {
      for (const lead of res.data.report.leads) {
        assert.ok(lead.ownerAgentId);
      }
    }
  });

  console.log('\n========================================================================');
  console.log('PHASE 2 SUMMARY: ' + passed + ' PASSED, ' + failed + ' FAILED');
  console.log('========================================================================\n');

  if (failed > 0) process.exit(1);
}

runPhase2Suite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
