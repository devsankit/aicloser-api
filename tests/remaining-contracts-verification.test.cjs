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

async function runRemainingContractsSuite() {
  console.log('========================================================================');
  console.log('CENTRAL API CONTRACT VERIFICATION: 6 REQUIRED PRE-MIGRATION DOMAINS');
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
  // DOMAIN 1: Custom Fields
  // ==========================================
  console.log('\n--- 1. Custom Fields Contracts & RBAC ---');
  let testFieldId = null;
  const testKey = `test_budget_${Date.now()}`;

  await test('GET /api/v1/custom-fields - List definitions', async () => {
    const res = await apiRequest({ path: '/api/v1/custom-fields', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert(Array.isArray(res.data.data.fields));
  });

  await test('POST /api/v1/custom-fields - Create definition (Admin)', async () => {
    const res = await apiRequest(
      { path: '/api/v1/custom-fields', method: 'POST', token: tokenAdminA },
      {
        fieldLabel: 'Test Budget Amount',
        fieldKey: testKey,
        fieldType: 'number',
        isRequired: false,
        showInKanban: true,
      }
    );
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.data.field.fieldKey, testKey);
    testFieldId = res.data.data.field.id;
  });

  await test('POST /api/v1/custom-fields - Reject duplicate fieldKey (409 Conflict)', async () => {
    const res = await apiRequest(
      { path: '/api/v1/custom-fields', method: 'POST', token: tokenAdminA },
      {
        fieldLabel: 'Duplicate Key',
        fieldKey: testKey,
        fieldType: 'text',
      }
    );
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.data.success, false);
  });

  await test('POST /api/v1/custom-fields - Reject SALES_AGENT creation (403 Forbidden)', async () => {
    const res = await apiRequest(
      { path: '/api/v1/custom-fields', method: 'POST', token: tokenCloserA },
      {
        fieldLabel: 'Unauthorized Field',
        fieldKey: `unauth_${Date.now()}`,
        fieldType: 'text',
      }
    );
    assert.strictEqual(res.statusCode, 403);
  });

  await test('GET /api/v1/custom-fields/:id - Read definition detail', async () => {
    assert(testFieldId);
    const res = await apiRequest({ path: `/api/v1/custom-fields/${testFieldId}`, token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.data.field.id, testFieldId);
  });

  await test('PATCH /api/v1/custom-fields/:id - Update definition', async () => {
    assert(testFieldId);
    const res = await apiRequest(
      { path: `/api/v1/custom-fields/${testFieldId}`, method: 'PATCH', token: tokenAdminA },
      { fieldLabel: 'Updated Budget Amount' }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.data.field.fieldLabel, 'Updated Budget Amount');
  });

  // Fetch or create a test lead for custom fields values test
  let sampleLeadId = null;
  const leadRes = await apiRequest({ path: '/api/v1/leads?limit=1', token: tokenAdminA });
  if (leadRes.data?.data?.leads?.[0]) {
    sampleLeadId = leadRes.data.data.leads[0].id;
  } else {
    const createLeadRes = await apiRequest(
      { path: '/api/v1/leads', method: 'POST', token: tokenAdminA },
      { customerName: 'Contract Test Lead', customerPhone: `+9199999${Math.floor(10000 + Math.random() * 90000)}` }
    );
    sampleLeadId = createLeadRes.data?.data?.lead?.id || createLeadRes.data?.data?.id;
  }

  await test('GET /api/v1/custom-fields/lead/:leadId - Read lead custom field values', async () => {
    assert(sampleLeadId, 'Sample lead required');
    const res = await apiRequest({ path: `/api/v1/custom-fields/lead/${sampleLeadId}`, token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert(res.data.data.values !== undefined);
    assert(Array.isArray(res.data.data.fields));
  });

  await test('PUT /api/v1/custom-fields/lead/:leadId - Write valid values', async () => {
    assert(sampleLeadId);
    const res = await apiRequest(
      { path: `/api/v1/custom-fields/lead/${sampleLeadId}`, method: 'PUT', token: tokenAdminA },
      {
        values: {
          [testKey]: 50000,
        },
      }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.data.customFields[testKey], 50000);
  });

  await test('PUT /api/v1/custom-fields/lead/:leadId - Reject invalid number value (400)', async () => {
    assert(sampleLeadId);
    const res = await apiRequest(
      { path: `/api/v1/custom-fields/lead/${sampleLeadId}`, method: 'PUT', token: tokenAdminA },
      {
        values: {
          [testKey]: 'invalid-not-a-number',
        },
      }
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.data.success, false);
  });

  await test('DELETE /api/v1/custom-fields/:id - Delete definition', async () => {
    assert(testFieldId);
    const res = await apiRequest({ path: `/api/v1/custom-fields/${testFieldId}`, method: 'DELETE', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.data.deleted, true);
  });

  // ==========================================
  // DOMAIN 2: Pipeline Stages
  // ==========================================
  console.log('\n--- 2. Pipeline Stages Contracts ---');
  let testStageId = null;

  await test('GET /api/v1/stages - List stages with leadsCount', async () => {
    const res = await apiRequest({ path: '/api/v1/stages', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert(Array.isArray(res.data.data));
    assert(res.data.data.length >= 3);
    assert(res.data.data[0].leadsCount !== undefined);
  });

  await test('GET /api/v1/stages/status-labels - Status labels dictionary', async () => {
    const res = await apiRequest({ path: '/api/v1/stages/status-labels', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert(res.data.data.labels !== undefined);
    assert(res.data.data.map !== undefined);
    assert.strictEqual(res.data.data.labels['NEW'], 'New Lead');
  });

  await test('POST /api/v1/stages - Create custom stage', async () => {
    const res = await apiRequest(
      { path: '/api/v1/stages', method: 'POST', token: tokenAdminA },
      {
        label: 'VIP Demo Booked',
        color: '#8B5CF6',
        probability: 0.65,
      }
    );
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.data.label, 'VIP Demo Booked');
    testStageId = res.data.data.id;
  });

  await test('POST /api/v1/stages/reorder - Reorder stages', async () => {
    const currentRes = await apiRequest({ path: '/api/v1/stages', token: tokenAdminA });
    const currentIds = currentRes.data.data.map((s) => s.id);
    const reversedIds = [...currentIds].reverse();

    const res = await apiRequest(
      { path: '/api/v1/stages/reorder', method: 'POST', token: tokenAdminA },
      { stageIds: reversedIds }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.data[0].id, reversedIds[0]);

    // Restore original order
    await apiRequest(
      { path: '/api/v1/stages/reorder', method: 'POST', token: tokenAdminA },
      { stageIds: currentIds }
    );
  });

  await test('DELETE /api/v1/stages/NEW - Reject deleting protected stage (400)', async () => {
    const res = await apiRequest({ path: '/api/v1/stages/NEW', method: 'DELETE', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.data.error, 'ProtectedStage');
  });

  await test('DELETE /api/v1/stages/:id - Delete custom stage', async () => {
    assert(testStageId);
    const res = await apiRequest({ path: `/api/v1/stages/${testStageId}`, method: 'DELETE', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
  });

  // ==========================================
  // DOMAIN 3: Lead Assignment & Round-Robin
  // ==========================================
  console.log('\n--- 3. Lead Assignment & Round-Robin Contracts ---');
  let testRuleId = null;

  await test('GET /api/v1/round-robin - Get settings & telemetry', async () => {
    const res = await apiRequest({ path: '/api/v1/round-robin', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert(res.data.data.settings !== undefined);
    assert(Array.isArray(res.data.data.closers));
  });

  await test('PATCH /api/v1/round-robin - Update round-robin settings', async () => {
    const res = await apiRequest(
      { path: '/api/v1/round-robin', method: 'PATCH', token: tokenAdminA },
      {
        enabled: true,
        mode: 'LOAD_BALANCED',
        maxActiveLeadsPerCloser: 60,
      }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.data.mode, 'LOAD_BALANCED');
    assert.strictEqual(res.data.data.maxActiveLeadsPerCloser, 60);
  });

  await test('PATCH /api/v1/round-robin - Reject SALES_AGENT modification (403)', async () => {
    const res = await apiRequest(
      { path: '/api/v1/round-robin', method: 'PATCH', token: tokenCloserA },
      { enabled: false }
    );
    assert.strictEqual(res.statusCode, 403);
  });

  await test('POST /api/v1/round-robin/rules - Create distribution rule', async () => {
    const res = await apiRequest(
      { path: '/api/v1/round-robin/rules', method: 'POST', token: tokenAdminA },
      {
        title: 'High-Ticket Inbound Rule',
        maxActiveLeads: 25,
        priorityMode: 'ROUND_ROBIN',
        batchSize: 1,
      }
    );
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.data.rule.title, 'High-Ticket Inbound Rule');
    testRuleId = res.data.data.rule.id;
  });

  await test('GET /api/v1/round-robin/rules - List rules', async () => {
    const res = await apiRequest({ path: '/api/v1/round-robin/rules', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert(Array.isArray(res.data.data.rules));
  });

  await test('GET /api/v1/round-robin/closers - List eligible closers & quotas', async () => {
    const res = await apiRequest({ path: '/api/v1/round-robin/closers', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert(Array.isArray(res.data.data.closers));
  });

  await test('POST /api/v1/round-robin/assign - Assign lead via round-robin', async () => {
    assert(sampleLeadId);
    const res = await apiRequest(
      { path: '/api/v1/round-robin/assign', method: 'POST', token: tokenAdminA },
      { leadId: sampleLeadId }
    );
    // Can succeed with 200 or 409 if no active closers are registered in local mock DB
    assert(res.statusCode === 200 || res.statusCode === 409);
    if (res.statusCode === 200) {
      assert.strictEqual(res.data.success, true);
      assert(res.data.data.assignedAgent !== undefined);
    }
  });

  if (testRuleId) {
    await test('DELETE /api/v1/round-robin/rules/:id - Delete rule', async () => {
      const res = await apiRequest({ path: `/api/v1/round-robin/rules/${testRuleId}`, method: 'DELETE', token: tokenAdminA });
      assert.strictEqual(res.statusCode, 200);
    });
  }

  // ==========================================
  // DOMAIN 4: Chat Visibility
  // ==========================================
  console.log('\n--- 4. Chat Visibility Contracts & Scoping ---');

  await test('GET /api/v1/conversations/chat-visibility - Get policy', async () => {
    const res = await apiRequest({ path: '/api/v1/conversations/chat-visibility', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert(res.data.data.visibilityMode !== undefined);
  });

  await test('PATCH /api/v1/conversations/chat-visibility - Update to COMPANY_WIDE', async () => {
    const res = await apiRequest(
      { path: '/api/v1/conversations/chat-visibility', method: 'PATCH', token: tokenAdminA },
      { visibilityMode: 'COMPANY_WIDE' }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.data.visibilityMode, 'COMPANY_WIDE');
  });

  await test('PATCH /api/v1/conversations/chat-visibility - Reject SALES_AGENT modification (403)', async () => {
    const res = await apiRequest(
      { path: '/api/v1/conversations/chat-visibility', method: 'PATCH', token: tokenCloserA },
      { visibilityMode: 'ASSIGNED_ONLY' }
    );
    assert.strictEqual(res.statusCode, 403);
  });

  await test('GET /api/v1/conversations - List conversations (Admin)', async () => {
    const res = await apiRequest({ path: '/api/v1/conversations', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert(Array.isArray(res.data.data));
  });

  await test('GET /api/v1/conversations/:id - 404 for non-existent conversation', async () => {
    const res = await apiRequest({ path: '/api/v1/conversations/non-existent-id-999', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 404);
  });

  // Revert chat-visibility to ASSIGNED_ONLY default
  await apiRequest(
    { path: '/api/v1/conversations/chat-visibility', method: 'PATCH', token: tokenAdminA },
    { visibilityMode: 'ASSIGNED_ONLY' }
  );

  // ==========================================
  // DOMAIN 5: Contacts and Imports
  // ==========================================
  console.log('\n--- 5. Contacts and Imports Contracts ---');
  let testContactId = null;
  const testPhone = `+9198765${Math.floor(10000 + Math.random() * 90000)}`;

  await test('GET /api/v1/contacts - List contacts with pagination', async () => {
    const res = await apiRequest({ path: '/api/v1/contacts', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert(Array.isArray(res.data.data.contacts));
    assert(res.data.data.pagination !== undefined);
  });

  await test('POST /api/v1/contacts - Create contact with deduplication', async () => {
    const res = await apiRequest(
      { path: '/api/v1/contacts', method: 'POST', token: tokenAdminA },
      {
        fullName: 'Rahul Sharma',
        e164Phone: testPhone,
        email: 'rahul.test@example.com',
        tags: ['ENTERPRISE', 'CONTRACT_TEST'],
      }
    );
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.data.fullName, 'Rahul Sharma');
    testContactId = res.data.data.id;

    // Deduplication check
    const dupRes = await apiRequest(
      { path: '/api/v1/contacts', method: 'POST', token: tokenAdminA },
      {
        fullName: 'Rahul Sharma Duplicate',
        e164Phone: testPhone,
      }
    );
    assert.strictEqual(dupRes.statusCode, 200);
    assert.strictEqual(dupRes.data.deduplicated, true);
  });

  await test('PUT /api/v1/contacts/:id - Update contact properties', async () => {
    assert(testContactId);
    const res = await apiRequest(
      { path: `/api/v1/contacts/${testContactId}`, method: 'PUT', token: tokenAdminA },
      { fullName: 'Rahul Sharma Updated', tags: ['VIP_CLIENT'] }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.data.fullName, 'Rahul Sharma Updated');
  });

  await test('GET /api/v1/contacts/duplicates - Duplicate detection', async () => {
    const res = await apiRequest({ path: '/api/v1/contacts/duplicates', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert(Array.isArray(res.data.data.duplicates));
  });

  let importJobId = null;
  await test('POST /api/v1/contacts/import-job - Trigger CSV import with progress tracking', async () => {
    const res = await apiRequest(
      { path: '/api/v1/contacts/import-job', method: 'POST', token: tokenAdminA },
      {
        fileName: 'leads_october.csv',
        contacts: [
          { fullName: 'Lead One', phone: `+9199111${Math.floor(10000 + Math.random() * 90000)}`, email: 'one@test.com' },
          { fullName: 'Lead Two', phone: `+9199222${Math.floor(10000 + Math.random() * 90000)}`, email: 'two@test.com' },
          { fullName: 'Lead Invalid', phone: '123' }, // intentional invalid row to test error logging
        ],
      }
    );
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.data.summary.totalRows, 3);
    assert.strictEqual(res.data.data.summary.validRows, 2);
    assert.strictEqual(res.data.data.summary.invalidRows, 1);
    importJobId = res.data.data.job.id;
  });

  await test('GET /api/v1/contacts/import-job/:jobId - Poll import job progress & errors', async () => {
    assert(importJobId);
    const res = await apiRequest({ path: `/api/v1/contacts/import-job/${importJobId}`, token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.data.job.id, importJobId);
    assert.strictEqual(res.data.data.job.status, 'COMPLETED');
    assert(Array.isArray(res.data.data.job.rowErrors));
  });

  await test('GET /api/v1/contacts/whatsapp/scanner - WhatsApp scanner / sync status', async () => {
    const res = await apiRequest({ path: '/api/v1/contacts/whatsapp/scanner', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert(res.data.data.status !== undefined);
    assert(res.data.data.connected !== undefined);
  });

  await test('GET /api/v1/contacts/email-inbox - Email inbox communications', async () => {
    const res = await apiRequest({ path: '/api/v1/contacts/email-inbox', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert(Array.isArray(res.data.data.threads));
  });

  if (testContactId) {
    await test('DELETE /api/v1/contacts/:id - Delete contact', async () => {
      const res = await apiRequest({ path: `/api/v1/contacts/${testContactId}`, method: 'DELETE', token: tokenAdminA });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.data.data.deletedId, testContactId);
    });
  }

  // ==========================================
  // DOMAIN 6: AI Bot
  // ==========================================
  console.log('\n--- 6. AI Bot Config, Training, Correction & Chat ---');

  await test('GET /api/v1/ai/bot-config - Get bot configuration', async () => {
    const res = await apiRequest({ path: '/api/v1/ai/bot-config', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.data.enabled, true);
    assert(res.data.data.personaName !== undefined);
  });

  await test('PATCH /api/v1/ai/bot-config - Update bot settings', async () => {
    const res = await apiRequest(
      { path: '/api/v1/ai/bot-config', method: 'PATCH', token: tokenAdminA },
      {
        personaName: 'Enterprise Sales AI Closer',
        tone: 'CONSULTATIVE',
        responseStyle: 'SHORT_CONVERSATIONAL',
      }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.data.personaName, 'Enterprise Sales AI Closer');
  });

  await test('POST /api/v1/ai/bot-train - Ingest Q&A training pairs', async () => {
    const res = await apiRequest(
      { path: '/api/v1/ai/bot-train', method: 'POST', token: tokenAdminA },
      {
        qaPairs: [
          {
            question: 'What is the refund policy?',
            answer: 'We provide a 14-day zero-risk money-back guarantee if call recording sync does not operate as described.',
            category: 'REFUNDS',
          },
        ],
      }
    );
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.success, true);
    assert(res.data.data.totalQAPairs >= 1);
  });

  await test('GET /api/v1/ai/bot-train - Read training knowledge', async () => {
    const res = await apiRequest({ path: '/api/v1/ai/bot-train', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert(Array.isArray(res.data.data.qaPairs));
  });

  await test('POST /api/v1/ai/bot-correct - Submit agent correction and auto-update training', async () => {
    const res = await apiRequest(
      { path: '/api/v1/ai/bot-correct', method: 'POST', token: tokenAdminA },
      {
        originalQuery: 'Do you support iPhone call recording?',
        botResponse: 'Yes, call recording works on all iOS devices directly.',
        correctedResponse: 'On iPhone, due to Apple sandbox policies, inbound/outbound calls are logged via our cloud VoIP trunk or WhatsApp business integration.',
        reason: 'Apple App Store sandbox limitation accuracy',
      }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert(res.data.data.correctionId !== undefined);
  });

  await test('GET /api/v1/ai/bot-corrections - List audit corrections', async () => {
    const res = await apiRequest({ path: '/api/v1/ai/bot-corrections', token: tokenAdminA });
    assert.strictEqual(res.statusCode, 200);
    assert(Array.isArray(res.data.data.corrections));
  });

  await test('POST /api/v1/ai/bot-chat - Test chat returns guaranteed non-empty valid JSON', async () => {
    const res = await apiRequest(
      { path: '/api/v1/ai/bot-chat', method: 'POST', token: tokenAdminA },
      { message: 'What is the pricing for a team of 5 closers?' }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert(typeof res.data.data.reply === 'string' && res.data.data.reply.length > 10);
    assert(typeof res.data.data.confidence === 'number');
    assert(Array.isArray(res.data.data.suggestedFollowUps));
  });

  await test('POST /api/v1/ai/bot-chat - Handles learned correction query accurately', async () => {
    const res = await apiRequest(
      { path: '/api/v1/ai/bot-chat', method: 'POST', token: tokenAdminA },
      { message: 'Do you support iPhone call recording?' }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert(res.data.data.reply.includes('Apple sandbox') || res.data.data.reply.includes('cloud VoIP'));
  });

  console.log('\n========================================================================');
  console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runRemainingContractsSuite().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
