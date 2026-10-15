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

async function runStagesAndNotesSuite() {
  console.log('========================================================================');
  console.log('?? STAGES & NOTES COMPLETE CRUD VERIFICATION SUITE');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ? PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ? FAIL: ${name}`);
      console.error(`     Error: ${err.message}`);
      failed++;
    }
  }

  const tenantA = 'tenant-the-storage-test-1d01dda2';

  const tokenAdminA = makeToken({
    userId: 'user-admin-eafadb6d',
    role: 'ADMIN',
    tenantId: tenantA,
    displayName: 'Ankit rathore',
  });

  const tokenAgentA = makeToken({
    userId: 'user-sales-agent-83d13bc5',
    role: 'SALES_AGENT',
    tenantId: tenantA,
    displayName: 'Closer Agent',
  });

  // TEST 1: GET /api/v1/stages returns pipeline stages with lead counts
  await test('1. GET /api/v1/stages returns workspace stages with leadsCount', async () => {
    const res = await apiRequest({ path: '/api/v1/stages', method: 'GET', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(Array.isArray(res.data.data));
    assert.ok(res.data.data.length >= 8);
    assert.strictEqual(typeof res.data.data[0].leadsCount, 'number');
  });

  // TEST 2: Sales Agent blocked from modifying pipeline stages (403)
  await test('2. Sales Agent blocked from POST /api/v1/stages -> 403 Forbidden', async () => {
    const res = await apiRequest(
      { path: '/api/v1/stages', method: 'POST', token: tokenAgentA },
      { label: 'Agent Custom Stage', color: '#123456' }
    );
    assert.strictEqual(res.statusCode, 403);
  });

  // TEST 3: Admin creates a custom pipeline status/stage
  let customStageId = null;
  const customLabel = `Site Visit ${Date.now().toString().slice(-4)}`;

  await test('3. POST /api/v1/stages creates a custom stage (Admin)', async () => {
    const res = await apiRequest(
      { path: '/api/v1/stages', method: 'POST', token: tokenAdminA },
      {
        label: customLabel,
        color: '#8B5CF6',
        probability: 0.75,
      }
    );
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.data.label, customLabel);
    assert.strictEqual(res.data.data.isCustom, true);
    customStageId = res.data.data.id;
  });

  // TEST 4: PATCH /api/v1/stages/:id updates the custom stage
  await test('4. PATCH /api/v1/stages/:id updates stage label, color & probability', async () => {
    assert.ok(customStageId);
    const updatedLabel = `${customLabel} Completed`;
    const res = await apiRequest(
      { path: `/api/v1/stages/${customStageId}`, method: 'PATCH', token: tokenAdminA },
      {
        label: updatedLabel,
        color: '#10B981',
        probability: 0.9,
      }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.data.label, updatedLabel);
    assert.strictEqual(res.data.data.color, '#10B981');
    assert.strictEqual(res.data.data.probability, 0.9);
  });

  // TEST 5: System baseline stages protected from deletion (400)
  await test('5. DELETE /api/v1/stages/NEW rejected with 400 ProtectedStage', async () => {
    const res = await apiRequest({ path: '/api/v1/stages/NEW', method: 'DELETE', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.data.error, 'ProtectedStage');
  });

  // TEST 6: DELETE /api/v1/stages/:id deletes the custom stage
  await test('6. DELETE /api/v1/stages/:id deletes the custom stage', async () => {
    assert.ok(customStageId);
    const res = await apiRequest({ path: `/api/v1/stages/${customStageId}`, method: 'DELETE', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);

    // Verify it is no longer in stages list
    const resList = await apiRequest({ path: '/api/v1/stages', method: 'GET', token: tokenAdminA });
    assert.ok(!resList.data.data.some((s) => s.id === customStageId));
  });

  // NOTES CRUD TESTS
  // Lookup a sample lead in workspace
  const leadLookup = await apiRequest({ path: '/api/v1/leads?limit=1', method: 'GET', token: tokenAdminA });
  const sampleLeadId = leadLookup.data.data[0]?.id;
  assert.ok(sampleLeadId, 'Must have at least 1 lead in workspace');

  // TEST 7: GET /api/v1/leads/:id/notes returns summaryNotes & timelineNotes
  await test('7. GET /api/v1/leads/:id/notes returns notes structure', async () => {
    const res = await apiRequest({ path: `/api/v1/leads/${sampleLeadId}/notes`, method: 'GET', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(res.data.data.timelineNotes);
  });

  // TEST 8: POST /api/v1/leads/:id/notes creates a new internal timeline note
  let createdNoteId = null;
  const testNoteBody = `Client confirmed budget of 85L for 3BHK at ${Date.now()}`;

  await test('8. POST /api/v1/leads/:id/notes adds an internal note (201)', async () => {
    const res = await apiRequest(
      { path: `/api/v1/leads/${sampleLeadId}/notes`, method: 'POST', token: tokenAdminA },
      { body: testNoteBody }
    );
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.data.body, testNoteBody);
    createdNoteId = res.data.data.id;
  });

  // TEST 9: PATCH /api/v1/leads/:id/notes/:noteId edits the note
  await test('9. PATCH /api/v1/leads/:id/notes/:noteId edits the note content (200)', async () => {
    assert.ok(createdNoteId);
    const updatedNoteBody = `${testNoteBody} (Updated: verified with bank pre-approval)`;
    const res = await apiRequest(
      { path: `/api/v1/leads/${sampleLeadId}/notes/${createdNoteId}`, method: 'PATCH', token: tokenAdminA },
      { body: updatedNoteBody }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.data.body, updatedNoteBody);
  });

  // TEST 10: DELETE /api/v1/leads/:id/notes/:noteId deletes the note
  await test('10. DELETE /api/v1/leads/:id/notes/:noteId removes note from lead timeline (200)', async () => {
    assert.ok(createdNoteId);
    const res = await apiRequest(
      { path: `/api/v1/leads/${sampleLeadId}/notes/${createdNoteId}`, method: 'DELETE', token: tokenAdminA }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);

    // Verify it is no longer in timeline notes
    const resVerify = await apiRequest({ path: `/api/v1/leads/${sampleLeadId}/notes`, method: 'GET', token: tokenAdminA });
    assert.ok(!resVerify.data.data.timelineNotes.some((n) => n.id === createdNoteId));
  });

  console.log('\n========================================================================');
  console.log(`?? STAGES & NOTES CRUD SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) process.exit(1);
}

runStagesAndNotesSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
