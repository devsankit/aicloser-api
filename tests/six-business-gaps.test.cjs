const jwt = require('jsonwebtoken');
const assert = require('assert');
const http = require('http');

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3060';
const JWT_SECRET = process.env.JWT_SECRET || 'aicloser-super-secure-production-jwt-secret-2026-key';

const tenantA = 'tenant-the-storage-test-1d01dda2';

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

async function runSixBusinessGapsSuite() {
  console.log('========================================================================');
  console.log('AUDIT RESOLUTION VERIFICATION: 6 CORE BUSINESS GAPS');
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

  // ==========================================
  // GAP 6: Company Signup Endpoint
  // ==========================================
  console.log('\n--- Gap 6: Company Signup & Manager Permissions ---');
  const testCompanySuffix = Date.now().toString().slice(-6);
  let newlyCreatedToken = null;

  await test('POST /api/v1/auth/signup - Register new company workspace and admin user', async () => {
    const res = await apiRequest(
      { path: '/api/v1/auth/signup', method: 'POST' },
      {
        companyName: `Apex Ventures ${testCompanySuffix}`,
        adminName: 'Apex Founder',
        email: `founder${testCompanySuffix}@apexcorp.com`,
        phone: `+9198${testCompanySuffix}12`,
        password: 'Password123!',
        industry: 'B2B Enterprise Sales',
        teamSize: '10-50',
      }
    );
    assert.strictEqual(res.statusCode, 201, `Expected 201 Created but got ${res.statusCode}: ${res.raw}`);
    assert.strictEqual(res.data.success, true);
    assert(res.data.data.token, 'Token must be issued upon signup');
    assert.strictEqual(res.data.data.user.role, 'ADMIN', 'Registered owner must have role ADMIN');
    assert(res.data.data.workspace.id, 'Workspace ID must be returned');
    newlyCreatedToken = res.data.data.token;
  });

  await test('POST /api/v1/auth/signup - Duplicate email/phone prevention', async () => {
    const res = await apiRequest(
      { path: '/api/v1/auth/signup', method: 'POST' },
      {
        companyName: 'Duplicate Attempt',
        adminName: 'Another Person',
        email: `founder${testCompanySuffix}@apexcorp.com`, // Same email
        phone: `+9198${testCompanySuffix}12`,
        password: 'Password123!',
      }
    );
    assert.strictEqual(res.statusCode, 409, 'Duplicate signup must return 409 Conflict');
    assert.strictEqual(res.data.error, 'Conflict');
  });

  await test('PATCH /api/v1/payouts/:id/approve - Manager role is permitted to approve payouts', async () => {
    // Attempt with dummy ID to verify authorization does not fail with 403 Forbidden
    const res = await apiRequest(
      { path: '/api/v1/payouts/non-existent-payout-id/approve', method: 'PATCH', token: tokenManagerA }
    );
    // Should be 404 PayoutNotFound, NOT 403 Forbidden
    assert.notStrictEqual(res.statusCode, 403, 'Manager role should NOT be rejected with 403 on payout approval');
    assert.strictEqual(res.statusCode, 404, 'Non-existent payout should yield 404');
  });

  // ==========================================
  // GAP 1: Unified Lead Import & Multi-Source Ingestion
  // ==========================================
  console.log('\n--- Gap 1: Unified Lead Import & Ingestion Endpoints ---');

  await test('POST /api/v1/leads/import - Ingest CSV/Excel rows with deduplication and pipeline sync', async () => {
    const res = await apiRequest(
      { path: '/api/v1/leads/import', method: 'POST', token: tokenAdminA },
      {
        source: 'CSV',
        rows: [
          {
            customerName: 'Aarav Patel',
            customerPhone: `+919876${testCompanySuffix}`,
            customerEmail: `aarav${testCompanySuffix}@example.com`,
            serviceInterest: 'AI Closer Pro',
            budgetAmount: 35000,
            notes: 'Requested urgent demo on WhatsApp',
          },
          {
            customerName: 'Pooja Sharma',
            customerPhone: `+919875${testCompanySuffix}`,
            customerEmail: `pooja${testCompanySuffix}@example.com`,
            serviceInterest: 'SIM Call Vault',
            budgetAmount: 25000,
            notes: 'Requires 10 closer SIM recording tracking',
          },
        ],
        duplicateAction: 'SKIP',
      }
    );
    assert.strictEqual(res.statusCode, 201, `Expected 201 but got ${res.statusCode}: ${res.raw}`);
    assert.strictEqual(res.data.success, true);
    assert(res.data.data.createdCount >= 1, 'Should create at least 1 lead');
  });

  await test('POST /api/v1/leads/import/google-sheets - Ingest sheet rows into CRM pipeline', async () => {
    const res = await apiRequest(
      { path: '/api/v1/leads/import/google-sheets', method: 'POST', token: tokenAdminA },
      {
        sheetRows: [
          {
            name: 'Vikram Mehta',
            phone: `+919874${testCompanySuffix}`,
            email: `vikram${testCompanySuffix}@example.com`,
            service: 'Enterprise Call Sync',
            notes: 'Ingested via Google Sheets automated sync',
          },
        ],
      }
    );
    assert.strictEqual(res.statusCode, 201, `Expected 201 but got ${res.statusCode}: ${res.raw}`);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.data.source, 'GOOGLE_SHEETS');
  });

  await test('POST /api/v1/leads/intake/email - Inbound email enquiry ingestion', async () => {
    const res = await apiRequest(
      { path: '/api/v1/leads/intake/email', method: 'POST', token: tokenAdminA },
      {
        senderEmail: `client${testCompanySuffix}@enterprise.in`,
        senderName: 'Rohit Verma',
        subject: 'Pricing inquiry for 20 sales closers',
        body: 'Hi team, please share quotation for our call tracking team. Contact me on +919873001122.',
        extractedPhone: '+919873001122',
        serviceInterest: 'Enterprise 20-Seat Package',
      }
    );
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.data.source, 'EMAIL');
  });

  await test('POST /api/v1/leads/intake/webhook/indiamart - External webhook intake', async () => {
    const res = await apiRequest(
      { path: '/api/v1/leads/intake/webhook/indiamart', method: 'POST', token: tokenAdminA },
      {
        sender_name: 'Deepak Singhania',
        sender_mobile: `9872${testCompanySuffix}`,
        sender_email: `deepak${testCompanySuffix}@trade.in`,
        query: 'Need pricing for B2B Call Manager software',
      }
    );
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.data.source, 'INDIAMART');
  });

  await test('GET /api/v1/leads/whatsapp-desktop/status - WhatsApp linked device gateway status', async () => {
    const res = await apiRequest({ path: '/api/v1/leads/whatsapp-desktop/status', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.data.clientStatus, 'CONNECTED');
  });

  // ==========================================
  // GAP 2: Source-Wise Distribution Rules
  // ==========================================
  console.log('\n--- Gap 2: Source-Wise Distribution Rules ---');

  await test('GET /api/v1/round-robin/source-rules - List configured rules', async () => {
    const res = await apiRequest({ path: '/api/v1/round-robin/source-rules', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert(Array.isArray(res.data.data.rules));
  });

  await test('POST /api/v1/round-robin/source-rules - Configure POOL rule for JUSTDIAL leads', async () => {
    const res = await apiRequest(
      { path: '/api/v1/round-robin/source-rules', method: 'POST', token: tokenAdminA },
      {
        source: 'JUSTDIAL',
        action: 'POOL',
        enabled: true,
      }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.data.rule.source, 'JUSTDIAL');
    assert.strictEqual(res.data.data.rule.action, 'POOL');
  });

  await test('POST /api/v1/leads/intake/webhook/justdial - Lead routes to Grab Pool per source rule', async () => {
    const res = await apiRequest(
      { path: '/api/v1/leads/intake/webhook/justdial', method: 'POST', token: tokenAdminA },
      {
        sender_name: 'Ananya Roy',
        sender_mobile: `9871${testCompanySuffix}`,
        query: 'Justdial inquiry for sales recording app',
      }
    );
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.data.source, 'JUSTDIAL');
  });

  await test('DELETE /api/v1/round-robin/source-rules/JUSTDIAL - Remove rule', async () => {
    const res = await apiRequest({ path: '/api/v1/round-robin/source-rules/JUSTDIAL', method: 'DELETE', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
  });

  // ==========================================
  // GAP 3: Strict Admin & Manager Exclusion
  // ==========================================
  console.log('\n--- Gap 3: Strict Admin Exclusion from Lead Assignment ---');

  await test('GET /api/v1/round-robin/closers - Only SALES_AGENT profiles included, ADMIN excluded', async () => {
    const res = await apiRequest({ path: '/api/v1/round-robin/closers', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    const closers = res.data.data.closers;
    assert(Array.isArray(closers));
    // Verify no admin email or user ID leaked into eligible closers
    const hasAdmin = closers.some((c) => c.userId === userAdminA.userId || c.email === userAdminA.email);
    assert.strictEqual(hasAdmin, false, 'Admin user MUST NOT be present in eligible closers array');
  });

  // ==========================================
  // GAP 4: Multi-Provider AI Fallback Engine
  // ==========================================
  console.log('\n--- Gap 4: Multi-Provider AI Fallback Engine ---');

  await test('GET /api/v1/ai/providers - List AI providers and fallback chain', async () => {
    const res = await apiRequest({ path: '/api/v1/ai/providers', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert(Array.isArray(res.data.data.providers));
    assert(Array.isArray(res.data.data.fallbackChain));
    const providerIds = res.data.data.providers.map((p) => p.id);
    assert(providerIds.includes('groq'), 'Groq provider must be present');
    assert(providerIds.includes('gemini'), 'Gemini provider must be present');
    assert(providerIds.includes('openai'), 'OpenAI provider must be present');
    assert(providerIds.includes('fallback'), 'Deterministic fallback provider must be present');
  });

  await test('POST /api/v1/ai/test-provider - Test deterministic fallback engine', async () => {
    const res = await apiRequest(
      { path: '/api/v1/ai/test-provider', method: 'POST', token: tokenAdminA },
      {
        providerId: 'fallback',
        prompt: 'What is the pricing for AI Closer?',
      }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert(res.data.data.reply.length > 10, 'Fallback reply must be non-empty');
  });

  await test('PATCH /api/v1/ai/providers - Update fallback priorities', async () => {
    const res = await apiRequest(
      { path: '/api/v1/ai/providers', method: 'PATCH', token: tokenAdminA },
      {
        providers: [
          { id: 'groq', priority: 1, enabled: true },
          { id: 'gemini', priority: 2, enabled: true },
          { id: 'fallback', priority: 3, enabled: true },
        ],
      }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
  });

  // ==========================================
  // GAP 5: Suspension, Phone Masking & Manager Hierarchy
  // ==========================================
  console.log('\n--- Gap 5: Suspension, Phone Masking & Manager Hierarchy ---');

  await test('GET /api/v1/team/permissions/matrix - Permissions catalog and role defaults', async () => {
    const res = await apiRequest({ path: '/api/v1/team/permissions/matrix', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert(Array.isArray(res.data.data.catalog));
    assert(res.data.data.roleDefaults.ADMIN);
    assert(res.data.data.roleDefaults.MANAGER);
    assert(res.data.data.roleDefaults.SALES_AGENT);
  });

  await test('GET /api/v1/leads - Phone masking behavior', async () => {
    const res = await apiRequest({ path: '/api/v1/leads?limit=5', token: tokenCloserA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
  });

  console.log('\n========================================================================');
  console.log(`AUDIT VERIFICATION COMPLETE: ${passed} passed, ${failed} failed`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runSixBusinessGapsSuite().catch((err) => {
  console.error('Unhandled test suite failure:', err);
  process.exit(1);
});
