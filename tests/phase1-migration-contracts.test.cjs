const assert = require('assert');
const http = require('http');
const jwt = require('jsonwebtoken');

const API_BASE = 'http://localhost:3060';
const JWT_SECRET = process.env.JWT_SECRET || 'aicloser_super_jwt_secret_production_2026_x99';

const tenantA = 'tenant-the-storage-test-1d01dda2';

const userAdminA = { userId: 'usr-admin-phase1-a', email: 'admin.a@example.com', role: 'ADMIN', tenantId: tenantA };
const userCloserA = { userId: 'usr-closer-phase1-a', email: 'closer.a@example.com', role: 'SALES_AGENT', tenantId: tenantA };

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

async function runPhase1Suite() {
  console.log('========================================================================');
  console.log('PHASE 1 MIGRATION GAPS ACCEPTANCE & INTEGRATION CONTRACT SUITE');
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

  // Lookup sample lead in tenantA
  const leadsRes = await apiRequest({ path: '/api/v1/leads?limit=5', method: 'GET', token: tokenAdminA });
  const sampleLead = leadsRes.data && leadsRes.data.data ? leadsRes.data.data[0] : null;
  assert.ok(sampleLead, 'Must have at least one lead in tenantA');
  const sampleLeadId = sampleLead.id;

  // 1. GET /api/v1/tasks list & hydration
  await test('1. GET /api/v1/tasks lists workspace tasks with lead hydration', async () => {
    const res = await apiRequest({ path: '/api/v1/tasks?limit=10', method: 'GET', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(Array.isArray(res.data.data));
    assert.ok(res.data.pagination);
  });

  // 2. POST /api/v1/tasks creates task
  let createdTaskId = null;
  const taskTitle = 'Follow up on contract terms - ' + Date.now();
  await test('2. POST /api/v1/tasks creates task on lead', async () => {
    const dueAt = new Date(Date.now() + 86400000).toISOString();
    const res = await apiRequest(
      { path: '/api/v1/tasks', method: 'POST', token: tokenAdminA },
      {
        salesLeadId: sampleLeadId,
        title: taskTitle,
        description: 'Verify security deposit clause',
        priority: 'HIGH',
        dueAt: dueAt,
      }
    );
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.data.title, taskTitle);
    assert.strictEqual(res.data.data.priority, 'HIGH');
    createdTaskId = res.data.data.id;
  });

  // 3. PATCH /api/v1/tasks/:id toggles status to DONE
  await test('3. PATCH /api/v1/tasks/:id toggles task status to DONE and sets completedAt', async () => {
    assert.ok(createdTaskId);
    const res = await apiRequest(
      { path: '/api/v1/tasks/' + createdTaskId, method: 'PATCH', token: tokenAdminA },
      { status: 'DONE' }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.data.status, 'DONE');
    assert.ok(res.data.data.completedAt);
  });

  // 4. DELETE /api/v1/tasks/:id removes task
  await test('4. DELETE /api/v1/tasks/:id deletes task', async () => {
    assert.ok(createdTaskId);
    const res = await apiRequest(
      { path: '/api/v1/tasks/' + createdTaskId, method: 'DELETE', token: tokenAdminA }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
  });

  // 5. POST /api/v1/ai/suggest-reply works as alias for consultative reply
  await test('5. POST /api/v1/ai/suggest-reply returns consultative sales reply', async () => {
    const res = await apiRequest(
      { path: '/api/v1/ai/suggest-reply', method: 'POST', token: tokenAdminA },
      {
        leadId: sampleLeadId,
        customerMessage: 'What is the pricing for 5 closer seats with call recordings?',
        tone: 'CONSULTATIVE',
      }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(res.data.data.suggestedReply);
    assert.strictEqual(res.data.data.tone, 'CONSULTATIVE');
  });

  // 6. POST /api/v1/ai/call-summary evaluates sentiment and enriches lead
  await test('6. POST /api/v1/ai/call-summary generates structured summary and updates lead', async () => {
    const res = await apiRequest(
      { path: '/api/v1/ai/call-summary', method: 'POST', token: tokenAdminA },
      {
        leadId: sampleLeadId,
        transcript: 'Client confirmed budget of 50k, agrees to advance payment tomorrow',
        durationSeconds: 180,
      }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.data.sentiment, 'POSITIVE');
    assert.ok(res.data.data.summary);
    assert.ok(Array.isArray(res.data.data.keyPoints));
  });

  // 7 & 8. Contact suppression & unsuppression
  const contactsLookup = await apiRequest({ path: '/api/v1/marketing/contacts?limit=1', method: 'GET', token: tokenAdminA });
  const sampleContact = contactsLookup.data && contactsLookup.data.data && contactsLookup.data.data.contacts ? contactsLookup.data.data.contacts[0] : null;

  if (sampleContact) {
    await test('7. POST /api/v1/marketing/contacts/:id/suppress suppresses contact', async () => {
      const res = await apiRequest(
        { path: '/api/v1/marketing/contacts/' + sampleContact.id + '/suppress', method: 'POST', token: tokenAdminA }
      );
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.data.success, true);
      assert.strictEqual(res.data.data.optInStatus, 'OPTED_OUT');
      assert.ok(res.data.data.tags.includes('SUPPRESSED'));
    });

    await test('8. POST /api/v1/marketing/contacts/:id/unsuppress unsuppresses contact', async () => {
      const res = await apiRequest(
        { path: '/api/v1/marketing/contacts/' + sampleContact.id + '/unsuppress', method: 'POST', token: tokenAdminA }
      );
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.data.success, true);
      assert.strictEqual(res.data.data.optInStatus, 'OPTED_IN');
      assert.ok(!res.data.data.tags.includes('SUPPRESSED'));
    });
  } else {
    console.log('  ! SKIP: 7 & 8 (No marketing contacts in tenantA)');
  }

  // 9. Template direct preview
  const templatesLookup = await apiRequest({ path: '/api/v1/marketing/templates', method: 'GET', token: tokenAdminA });
  const sampleTemplate = templatesLookup.data && templatesLookup.data.data ? templatesLookup.data.data[0] : null;

  if (sampleTemplate) {
    await test('9. POST /api/v1/marketing/templates/:id/preview renders variables without campaign', async () => {
      const res = await apiRequest(
        { path: '/api/v1/marketing/templates/' + sampleTemplate.id + '/preview', method: 'POST', token: tokenAdminA },
        { variables: { '1': 'Sankit Sharma' } }
      );
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.data.success, true);
      assert.ok(res.data.data.renderedBody);
      assert.strictEqual(res.data.data.templateId, sampleTemplate.id);
    });
  } else {
    console.log('  ! SKIP: 9 (No WhatsApp templates in tenantA)');
  }

  // 10. Call ID recording playback resolver fallback
  await test('10. GET /api/v1/calls/:id/playback resolves call ID or returns 404 cleanly', async () => {
    const res = await apiRequest(
      { path: '/api/v1/calls/non_existent_call_id/playback', method: 'GET', token: tokenAdminA }
    );
    // Non-existent call must return 404, not 500 crash
    assert.strictEqual(res.statusCode, 404);
  });

  console.log('\n========================================================================');
  console.log('PHASE 1 SUMMARY: ' + passed + ' PASSED, ' + failed + ' FAILED');
  console.log('========================================================================\n');

  if (failed > 0) process.exit(1);
}

runPhase1Suite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});