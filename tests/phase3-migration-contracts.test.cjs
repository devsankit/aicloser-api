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

async function runPhase3Suite() {
  console.log('========================================================================');
  console.log('PHASE 3 MIGRATION GAPS: FORMS, AUTOMATIONS, PAYOUTS & REFERRALS');
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

  // 1. GET & POST /api/v1/forms
  let createdFormId = null;
  const formSlug = 'inbound-contact-' + Date.now();
  await test('1. POST /api/v1/forms creates a custom lead capture form', async () => {
    const res = await apiRequest(
      { path: '/api/v1/forms', method: 'POST', token: tokenAdminA },
      {
        title: 'Website VIP Inbound Form',
        slug: formSlug,
        description: 'Lead capture form for enterprise sales',
        source: 'vip_landing_page',
        targetStage: 'NEW',
        tags: ['VIP Inbound', 'Web Form'],
        successMessage: 'Thank you! A dedicated closer has been assigned.',
      }
    );
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.data.slug, formSlug);
    createdFormId = res.data.data.id;
  });

  await test('2. GET /api/v1/forms lists workspace forms', async () => {
    const res = await apiRequest({ path: '/api/v1/forms', method: 'GET', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(Array.isArray(res.data.data));
    assert.ok(res.data.data.some((f) => f.slug === formSlug));
  });

  // 3. Public Form Submission (Unauthenticated)
  await test('3. POST /api/v1/forms/submit/:slug creates lead and marketing contact without auth', async () => {
    const randomPhone = '98' + Math.floor(10000000 + Math.random() * 90000000);
    const res = await apiRequest(
      { path: '/api/v1/forms/submit/' + formSlug, method: 'POST' },
      {
        customerName: 'Public Web Visitor',
        customerPhone: randomPhone,
        customerEmail: 'visitor@example.com',
        serviceInterest: 'AI Closer Enterprise Tier',
        budgetAmount: 75000,
        customFields: { requirements: 'Needs 10 closer seats with call recording' },
      }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(res.data.leadId);
  });

  // 4. GET /api/v1/forms/:id/submissions
  await test('4. GET /api/v1/forms/:id/submissions returns leads submitted via form', async () => {
    assert.ok(createdFormId);
    const res = await apiRequest(
      { path: '/api/v1/forms/' + createdFormId + '/submissions', method: 'GET', token: tokenAdminA }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(Array.isArray(res.data.data));
    assert.ok(res.data.data.length > 0);
  });

  // 5. Automations: POST /api/v1/automations
  let createdRuleId = null;
  await test('5. POST /api/v1/automations creates an automation workflow rule', async () => {
    const res = await apiRequest(
      { path: '/api/v1/automations', method: 'POST', token: tokenAdminA },
      {
        name: 'Auto-Assign High Value Leads',
        description: 'Assigns leads with budget >= 50k to senior closer',
        trigger: { type: 'LEAD_CREATED', config: { minBudget: 50000 } },
        action: { type: 'ASSIGN_AGENT', config: { priority: 'HIGH' } },
        isActive: true,
      }
    );
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.success, true);
    assert.ok(res.data.data.id);
    createdRuleId = res.data.data.id;
  });

  // 6. Automations Test & Logs
  await test('6. POST /api/v1/automations/:id/test evaluates dry-run and logs execution', async () => {
    assert.ok(createdRuleId);
    const res = await apiRequest(
      { path: '/api/v1/automations/' + createdRuleId + '/test', method: 'POST', token: tokenAdminA }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(res.data.testLog);

    const logsRes = await apiRequest({ path: '/api/v1/automations/logs', method: 'GET', token: tokenAdminA });
    assert.strictEqual(logsRes.statusCode, 200);
    assert.ok(Array.isArray(logsRes.data.data));
    assert.ok(logsRes.data.data.length > 0);
  });

  // 7. Payouts: GET /api/v1/payouts/balance
  await test('7. GET /api/v1/payouts/balance calculates commission and available balance', async () => {
    const res = await apiRequest({ path: '/api/v1/payouts/balance', method: 'GET', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(typeof res.data.data.availableBalance, 'number');
    assert.strictEqual(typeof res.data.data.totalEarnedCommission, 'number');
  });

  // 8. Payouts: POST /api/v1/payouts & PATCH /approve
  let createdPayoutId = null;
  await test('8. POST /api/v1/payouts creates payout request & PATCH /approve approves it', async () => {
    const reqRes = await apiRequest(
      { path: '/api/v1/payouts', method: 'POST', token: tokenAdminA },
      { amount: 1500, note: 'Commission withdrawal for closed deals' }
    );
    assert.strictEqual(reqRes.statusCode, 201);
    assert.strictEqual(reqRes.data.success, true);
    assert.strictEqual(reqRes.data.data.status, 'REQUESTED');
    createdPayoutId = reqRes.data.data.id;

    // Approve payout
    const appRes = await apiRequest(
      { path: '/api/v1/payouts/' + createdPayoutId + '/approve', method: 'PATCH', token: tokenAdminA }
    );
    assert.strictEqual(appRes.statusCode, 200);
    assert.strictEqual(appRes.data.success, true);
    assert.strictEqual(appRes.data.data.status, 'PAID');
  });

  // 9. Referrals: POST /api/v1/referrals & GET /stats
  await test('9. POST /api/v1/referrals creates referral code & GET /stats returns summary', async () => {
    const refCode = 'GX' + Date.now().toString().slice(-6);
    const createRes = await apiRequest(
      { path: '/api/v1/referrals', method: 'POST', token: tokenAdminA },
      { code: refCode, label: 'Spring Sales Campaign Code' }
    );
    assert.strictEqual(createRes.statusCode, 201);
    assert.strictEqual(createRes.data.success, true);
    assert.strictEqual(createRes.data.data.code, refCode);

    const statsRes = await apiRequest({ path: '/api/v1/referrals/stats', method: 'GET', token: tokenAdminA });
    assert.strictEqual(statsRes.statusCode, 200);
    assert.strictEqual(statsRes.data.success, true);
    assert.strictEqual(typeof statsRes.data.data.totalCodes, 'number');
  });

  console.log('\n========================================================================');
  console.log('PHASE 3 SUMMARY: ' + passed + ' PASSED, ' + failed + ' FAILED');
  console.log('========================================================================\n');

  if (failed > 0) process.exit(1);
}

runPhase3Suite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
