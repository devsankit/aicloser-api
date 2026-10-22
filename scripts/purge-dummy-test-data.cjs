require('dotenv').config({ path: '/var/www/aicloser-api/.env' });
const { prisma } = require('../dist/lib/prisma.js');

const tenantId = 'tenant-the-storage-test-1d01dda2';

async function main() {
  console.log('Purging dummy test leads for tenant:', tenantId);

  // 1. Delete dummy pool items
  const deletedPool = await prisma.salesLeadPoolItem.deleteMany({
    where: {
      tenantId,
      OR: [
        { customerName: { in: ['Rajesh Sharma', 'Amit Verma', 'Public Web Visitor', 'test', 'Test Lead', 'user', 'Vikram Mehta', 'Ritu Sengupta'] } },
        { customerName: { startsWith: 'Concurrent Test' } },
        { customerName: { startsWith: 'Quota Test' } },
        { source: 'QUOTA_TEST' },
        { customerPhone: { in: ['+919911659771', '+919822492091', '+919911491859', '+919822864418', '+919822659957', '+919876543210', '+919876543211', '+919876543212', '+919876543213', '+919876543214', '+919876543215', '+919800000001', '+919800000002'] } }
      ]
    }
  });
  console.log(`Deleted ${deletedPool.count} dummy pool items.`);

  // 2. Identify dummy assignments
  const dummyAssignments = await prisma.salesLeadAssignment.findMany({
    where: {
      tenantId,
      OR: [
        { customerName: { in: ['Rajesh Sharma', 'Amit Verma', 'Public Web Visitor', 'test', 'Test Lead', 'user', 'Vikram Mehta', 'Ritu Sengupta'] } },
        { customerName: { startsWith: 'Concurrent Test' } },
        { customerName: { startsWith: 'Quota Test' } },
        { source: 'QUOTA_TEST' },
        { customerPhone: { in: ['+919911659771', '+919822492091', '+919911491859', '+919822864418', '+919822659957', '+919876543210', '+919876543211', '+919876543212', '+919876543213', '+919876543214', '+919876543215', '+919800000001', '+919800000002'] } }
      ]
    },
    select: { id: true }
  });

  const dummyIds = dummyAssignments.map(a => a.id);
  console.log(`Found ${dummyIds.length} dummy assignments to delete.`);

  if (dummyIds.length > 0) {
    // Delete dependent activity logs & timeline entries
    await prisma.salesActivityLog.deleteMany({
      where: { assignmentId: { in: dummyIds } }
    }).catch(() => undefined);

    await prisma.salesLeadTimelineEntry.deleteMany({
      where: { leadId: { in: dummyIds } }
    }).catch(() => undefined);

    await prisma.gxLeadTask.deleteMany({
      where: { salesLeadId: { in: dummyIds } }
    }).catch(() => undefined);

    const deletedAssignments = await prisma.salesLeadAssignment.deleteMany({
      where: { id: { in: dummyIds } }
    });
    console.log(`Deleted ${deletedAssignments.count} dummy assignments.`);
  }

  // 3. Clear slotted pool cache and missed leads in workspace settings
  const ws = await prisma.aicloserWorkspace.findUnique({
    where: { id: tenantId },
    select: { settings: true }
  });
  const currentSettings = ws?.settings || {};
  delete currentSettings.slottedPoolLeads;
  delete currentSettings.missedLeads;
  await prisma.aicloserWorkspace.update({
    where: { id: tenantId },
    data: { settings: currentSettings }
  });
  console.log('Cleared slottedPoolLeads and missedLeads cache.');
}

main().catch(console.error).finally(() => prisma.$disconnect());
