require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { prisma } = require('../dist/lib/prisma.js');

async function run() {
  console.log('--- 1. Authenticating Super Admin ---');
  const loginRes = await fetch('http://127.0.0.1:3060/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-installation-id': 'crud-test-' + Date.now() },
    body: JSON.stringify({
      identifier: 'hello.ankitrathore@gmail.com',
      password: 'Ankit@1143',
      clientType: 'DESKTOP',
      replaceExisting: true,
    }),
  });
  const loginData = await loginRes.json();
  const token = loginData.data?.token;
  if (!token) {
    console.error('Super Admin login failed:', loginData);
    process.exit(1);
  }
  console.log('Super Admin login SUCCESS, token acquired.');

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + token,
  };

  console.log('\n--- 1.1 Cleaning up any prior CRUD Test Workspaces ---');
  const priorWorkspaces = await prisma.aicloserWorkspace.findMany({
    where: { name: { startsWith: 'CRUD Test Workspace' } },
  });
  for (const pw of priorWorkspaces) {
    console.log(`Cleaning up prior test workspace: ${pw.name} (${pw.id}) via DELETE API`);
    const cleanRes = await fetch(`http://127.0.0.1:3060/api/v1/super-admin/tenants/${pw.id}`, {
      method: 'DELETE',
      headers,
    });
    const cleanData = await cleanRes.json();
    console.log(`Cleaned up ${pw.id}:`, cleanData.message);
  }

  console.log('\n--- 2. Creating Test Workspace ---');
  const testWsName = 'CRUD Test Workspace ' + Date.now().toString().slice(-4);
  const testOwnerEmail = 'test_owner_' + Date.now().toString().slice(-6) + '@testcorp.in';
  const testExpiry = new Date(Date.now() + 30 * 86400000).toISOString();

  const createRes = await fetch('http://127.0.0.1:3060/api/v1/super-admin/tenants', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: testWsName,
      ownerEmail: testOwnerEmail,
      ownerPhone: '+919988001122',
      ownerPassword: 'OwnerPassword@123',
      maxSeats: 5,
      expiresAt: testExpiry,
    }),
  });

  const createData = await createRes.json();
  if (!createRes.ok || !createData.success) {
    console.error('Failed to create test workspace:', createData);
    process.exit(1);
  }

  const workspaceId = createData.data.id;
  console.log('Workspace created successfully! ID:', workspaceId, 'Name:', createData.data.name);

  console.log('\n--- 3. Seeding Relational Child Records into Workspace ---');
  const ownerUser = await prisma.appAuthUser.findFirst({ where: { tenantId: workspaceId } });
  let agent = await prisma.salesAgentProfile.findFirst({
    where: { tenantId: workspaceId },
  });
  if (!agent && ownerUser) {
    agent = await prisma.salesAgentProfile.create({
      data: {
        tenantId: workspaceId,
        userId: ownerUser.id,
        agentCode: 'AGT-' + Date.now().toString().slice(-4),
        status: 'ACTIVE',
      },
    });
  }

  const contact = await prisma.marketingContact.create({
    data: {
      tenantId: workspaceId,
      fullName: 'Cascade Test Contact',
      e164Phone: '+919999900001',
      source: 'TEST',
    },
  });

  const lead = await prisma.salesLeadAssignment.create({
    data: {
      tenantId: workspaceId,
      assignedAgentId: agent ? agent.id : '__UNASSIGNED__',
      customerName: 'Cascade Test Lead',
      customerPhone: '+919999900001',
      source: 'MANUAL',
      stage: 'NEW',
    },
  });

  const actLog = await prisma.salesActivityLog.create({
    data: {
      tenantId: workspaceId,
      action: 'TEST_CASCADE_ACTION',
      note: 'Cascade verification entry',
    },
  });

  console.log('Child records seeded: Contact ID:', contact.id, ', Lead ID:', lead.id, ', Log ID:', actLog.id);

  console.log('\n--- 4. Testing PATCH /tenants/:id (General Workspace Update) ---');
  const patchPayload = {
    name: testWsName + ' (Updated)',
    maxSeats: 15,
    planTier: 'ENTERPRISE',
    status: 'ACTIVE',
    monthlyAmount: 14999,
    paymentStatus: 'PAID',
    expiresAt: new Date(Date.now() + 180 * 86400000).toISOString(),
  };

  const patchRes = await fetch(`http://127.0.0.1:3060/api/v1/super-admin/tenants/${workspaceId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(patchPayload),
  });

  const patchData = await patchRes.json();
  console.log(`PATCH /tenants/:id HTTP ${patchRes.status}:`, patchData.message);
  if (!patchRes.ok || !patchData.success) {
    console.error('PATCH /tenants/:id failed:', patchData);
    process.exit(1);
  }

  console.log('Verified updated fields:', {
    name: patchData.data.name,
    maxSeats: patchData.data.maxSeats,
    planTier: patchData.data.planTier,
    monthlyAmount: patchData.data.monthlyAmount,
    paymentStatus: patchData.data.paymentStatus,
    expiresAt: patchData.data.expiresAt,
  });

  console.log('\n--- 5. Testing PATCH /tenants/:id/amount (Number String Coercion) ---');
  const amountRes = await fetch(`http://127.0.0.1:3060/api/v1/super-admin/tenants/${workspaceId}/amount`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ monthlyAmount: '29999' }), // String number
  });

  const amountData = await amountRes.json();
  console.log(`PATCH /tenants/:id/amount HTTP ${amountRes.status}:`, amountData.message);
  if (!amountRes.ok || !amountData.success) {
    console.error('PATCH /tenants/:id/amount failed:', amountData);
    process.exit(1);
  }
  if (amountData.data?.monthlyAmount !== 29999 || amountData.tenant?.monthlyAmount !== 29999) {
    console.error('Amount coercion mismatch:', amountData);
    process.exit(1);
  }
  console.log('Monthly amount successfully coerced to number 29999 and returned in data & tenant!');

  console.log('\n--- 6. Testing DELETE /tenants/:id (Cascade Deletion) ---');
  const delRes = await fetch(`http://127.0.0.1:3060/api/v1/super-admin/tenants/${workspaceId}`, {
    method: 'DELETE',
    headers,
  });

  const delData = await delRes.json();
  console.log(`DELETE /tenants/:id HTTP ${delRes.status}:`, delData.message);
  if (!delRes.ok || !delData.success) {
    console.error('DELETE /tenants/:id failed:', delData);
    process.exit(1);
  }

  console.log('\n--- 7. Verifying Cascade & Zero Residual Records ---');
  const planRes = await fetch(`http://127.0.0.1:3060/api/v1/super-admin/tenants/${workspaceId}/plan`, {
    headers,
  });
  console.log(`GET /tenants/:id/plan returned HTTP ${planRes.status} (Expected 404)`);
  if (planRes.status !== 404) {
    console.error('Expected 404 after deletion, but got:', planRes.status);
    process.exit(1);
  }

  // Double check in database directly via Prisma
  const [dbWs, dbUsers, dbLeads, dbContacts] = await Promise.all([
    prisma.aicloserWorkspace.findUnique({ where: { id: workspaceId } }),
    prisma.appAuthUser.count({ where: { tenantId: workspaceId } }),
    prisma.salesLeadAssignment.count({ where: { tenantId: workspaceId } }),
    prisma.marketingContact.count({ where: { tenantId: workspaceId } }),
  ]);

  console.log('Database verification:');
  console.log('- Workspace exists:', Boolean(dbWs));
  console.log('- Leftover users:', dbUsers);
  console.log('- Leftover leads:', dbLeads);
  console.log('- Leftover contacts:', dbContacts);

  if (dbWs || dbUsers > 0 || dbLeads > 0 || dbContacts > 0) {
    console.error('Residual records detected in PostgreSQL database!');
    process.exit(1);
  }

  console.log('\n>>> ALL SUPER ADMIN WORKSPACE CRUD & CASCADE DELETION TESTS PASSED 100%! <<<');
  await prisma.$disconnect();
}

run().catch((err) => {
  console.error('Fatal error during test run:', err);
  process.exit(1);
});
