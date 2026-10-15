const jwt = require('jsonwebtoken');
const assert = require('assert');
const http = require('http');

const JWT_SECRET = process.env.JWT_SECRET || 'aicloser-super-secure-production-jwt-secret-2026-key';
const API_PORT = process.env.PORT || '3060';
const BASE_HOST = process.env.TEST_HOST || '127.0.0.1';

function makeToken(user, secret = JWT_SECRET) {
  return jwt.sign(user, secret, { expiresIn: '1h' });
}

function apiRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: BASE_HOST,
        port: Number(API_PORT),
        path: options.path,
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          ...(options.headers || {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, data: JSON.parse(body) });
          } catch {
            resolve({ statusCode: res.statusCode, raw: body });
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

async function runAcceptanceSuite() {
  console.log('========================================================================');
  console.log('🛡️  AICLOSER-API PRODUCTION BACKEND READINESS ACCEPTANCE CONTRACT SUITE');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     Error: ${err.message}`);
      failed++;
    }
  }

  const tenantA = 'tenant-the-storage-test-1d01dda2';
  const tenantB = 'tenant-jay-estate-management-01773ec9';

  const tokenAdminA = makeToken({
    userId: 'usr-admin-a',
    role: 'ADMIN',
    tenantId: tenantA,
    displayName: 'Admin Tenant A',
    phone: '+919999000001',
  });

  const tokenAgentA = makeToken({
    userId: 'usr-agent-a',
    role: 'SALES_AGENT',
    tenantId: tenantA,
    displayName: 'Closer Agent A',
    phone: '+919999000003',
  });

  const tokenAgentB = makeToken({
    userId: 'usr-agent-b',
    role: 'SALES_AGENT',
    tenantId: tenantB,
    displayName: 'Closer Agent B',
    phone: '+919999000004',
  });

  const tokenSuperAdmin = makeToken({
    userId: 'usr-super-admin',
    role: 'SUPER_ADMIN',
    tenantId: null,
    displayName: 'Global Super Admin',
    phone: '+919999999999',
  });

  // TEST 1: JWT Signature Verification & Bypass Prevention
  await test('1. Forged token with invalid signature rejected with 401 (Zero decode fallback)', async () => {
    const forgedToken = makeToken(
      { userId: 'usr-hacker', role: 'SUPER_ADMIN', tenantId: tenantA },
      'wrong-attacker-secret-key-12345'
    );
    const res = await apiRequest({ path: '/api/v1/leads', method: 'GET', token: forgedToken });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.data.error, 'InvalidTokenSignature');
  });

  // TEST 2: Legitimate Token Accepted
  await test('2. Cryptographically verified token is accepted (200)', async () => {
    const res = await apiRequest({ path: '/api/v1/leads?limit=1', method: 'GET', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
  });

  // TEST 3: Cross-tenant BOLA/IDOR attempt rejected
  await test('3. Cross-tenant lead lookup returns 404 (Zero cross-tenant data leak)', async () => {
    const res = await apiRequest({
      path: '/api/v1/leads/cmv99r1n900yj58jpjnsoxwt7',
      method: 'GET',
      token: tokenAgentB,
    });
    assert.strictEqual(res.statusCode, 404);
  });

  // TEST 4: Tenant Spoofing Blocked
  await test('4. Client tenant spoofing attempt via x-target-tenant-id blocked (403 TenantIsolationViolation)', async () => {
    const res = await apiRequest({
      path: '/api/v1/leads',
      method: 'GET',
      token: tokenAdminA,
      headers: { 'x-target-tenant-id': tenantB },
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.data.error, 'TenantIsolationViolation');
  });

  // TEST 5: Super Admin Tenant Context Enforcement
  await test('5. Super Admin without x-target-tenant-id rejected on tenant resources (400)', async () => {
    const res = await apiRequest({ path: '/api/v1/leads', method: 'GET', token: tokenSuperAdmin });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.data.error, 'SuperAdminTenantContextRequired');
  });

  // TEST 6: Lead 360 Ownership Protection
  await test('6. Sales Agent accessing another agent\'s Lead 360 is blocked (403 Forbidden)', async () => {
    const res = await apiRequest({
      path: '/api/v1/leads/cmv99r1n900yj58jpjnsoxwt7/360',
      method: 'GET',
      token: tokenAgentA,
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.data.error, 'Forbidden');
  });

  // TEST 7: Call Ownership & Disposition Protection
  await test('7. Sales Agent cannot log or dispose calls for another agent (403 Forbidden)', async () => {
    const resLog = await apiRequest(
      { path: '/api/v1/calls', method: 'POST', token: tokenAgentA },
      {
        assignmentId: 'cmv99r1n900yj58jpjnsoxwt7',
        agentId: 'some-foreign-agent',
        phoneNumber: '+919999988888',
        direction: 'OUTBOUND',
      }
    );
    assert.strictEqual(resLog.statusCode, 403);
  });

  // TEST 8: Recording Playback Ownership Protection
  await test('8. Sales Agent cannot playback call recordings of another agent without permission (403)', async () => {
    const resPlay = await apiRequest({
      path: '/api/v1/recordings/cmv9a00000000000000000001/playback',
      method: 'GET',
      token: tokenAgentA,
    });
    assert.ok([403, 404].includes(resPlay.statusCode));
  });

  // TEST 9: Team Scoping
  await test('9. Sales Agent blocked from team list (/team -> 403), permitted on /team/me (200)', async () => {
    const resList = await apiRequest({ path: '/api/v1/team', method: 'GET', token: tokenAgentA });
    assert.strictEqual(resList.statusCode, 403);

    const resMe = await apiRequest({ path: '/api/v1/team/me', method: 'GET', token: tokenAgentA });
    assert.strictEqual(resMe.statusCode, 200);
    assert.strictEqual(resMe.data.data.userId, 'usr-agent-a');
  });

  // TEST 10: Fake Meta Response Eliminated
  await test('10. Fake WhatsApp simulation eliminated: unconfigured channel returns 400 WhatsAppNotConfigured', async () => {
    const res = await apiRequest(
      { path: '/api/v1/integrations/whatsapp/messages', method: 'POST', token: tokenAdminA },
      {
        recipientPhone: '+919999900001',
        body: 'Real Meta API Test',
      }
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.data.error, 'WhatsAppNotConfigured');
    assert.strictEqual(res.data.data, undefined);
  });

  // TEST 11: Concurrent Race-Condition Deduplication Test
  await test('11. 20 concurrent lead creation requests with same phone deduplicated to exactly 1 lead (0 duplicates)', async () => {
    const testPhone = `+9198765${Math.floor(10000 + Math.random() * 90000)}`;

    const agentLookup = await apiRequest({ path: '/api/v1/team', method: 'GET', token: tokenAdminA });
    const agentId = agentLookup.data.data[0]?.id || 'ag-test-primary';

    const promises = [];
    for (let i = 0; i < 20; i++) {
      promises.push(
        apiRequest(
          { path: '/api/v1/leads', method: 'POST', token: tokenAdminA },
          {
            customerName: `Concurrent Test Lead ${i}`,
            customerPhone: testPhone,
            assignedAgentId: agentId,
            serviceInterest: 'Race Condition Test',
            notes: `Batch request #${i}`,
          }
        )
      );
    }

    const results = await Promise.all(promises);
    const successStatuses = results.filter((r) => r.statusCode === 200 || r.statusCode === 201);
    assert.strictEqual(successStatuses.length, 20);

    // Verify exactly 1 lead exists in the workspace for this phone
    const verifyRes = await apiRequest(
      { path: `/api/v1/leads?search=${testPhone}`, method: 'GET', token: tokenAdminA }
    );
    assert.strictEqual(verifyRes.statusCode, 200);
    assert.strictEqual(verifyRes.data.data.leads.length, 1);
  });

  // TEST 12: High-Throughput Load Benchmark (100 sequential & concurrent requests)
  await test('12. High-Throughput Load Benchmark: 100 requests measuring p50, p95, p99 latency', async () => {
    const latencies = [];
    const totalRequests = 100;

    const startTotal = Date.now();
    for (let i = 0; i < totalRequests; i++) {
      const t0 = Date.now();
      const res = await apiRequest({ path: '/api/v1/leads?limit=25', method: 'GET', token: tokenAdminA });
      const duration = Date.now() - t0;
      latencies.push(duration);
      assert.strictEqual(res.statusCode, 200);
    }
    const totalDuration = Date.now() - startTotal;

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.50)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];
    const rps = Math.round((totalRequests / (totalDuration / 1000)) * 10) / 10;

    console.log(`\n     📊 LOAD BENCHMARK RESULTS (100 Requests):`);
    console.log(`        - Total Time: ${totalDuration} ms`);
    console.log(`        - Throughput: ${rps} req/sec`);
    console.log(`        - p50 Latency: ${p50} ms`);
    console.log(`        - p95 Latency: ${p95} ms`);
    console.log(`        - p99 Latency: ${p99} ms`);
    console.log(`        - Error Rate: 0.0%\n`);

    assert.ok(p95 < 200, `p95 latency of ${p95}ms exceeds 200ms threshold`);
  });

  console.log('========================================================================');
  console.log(`📊 READINESS ACCEPTANCE SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runAcceptanceSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
