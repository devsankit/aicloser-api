require('dotenv').config({ path: '/var/www/aicloser-api/.env' });
const { prisma } = require('../dist/lib/prisma.js');

const tenantId = 'tenant-the-storage-test-1d01dda2';

async function main() {
  const dummyAssignments = await prisma.salesLeadAssignment.findMany({
    where: {
      tenantId,
      OR: [
        { customerName: { in: ['Rajesh Sharma', 'Amit Verma', 'Public Web Visitor', 'test', 'Test Lead', 'user', 'Vikram Mehta', 'Ritu Sengupta', 'Phone contact'] } },
        { customerName: { startsWith: 'Concurrent Test' } },
        { customerName: { startsWith: 'Quota Test' } },
        { customerName: { startsWith: 'Unknown caller ·' } },
        { source: 'QUOTA_TEST' },
        { customerPhone: { in: ['+919911659771', '+919822492091', '+919911491859', '+919822864418', '+919822659957', '+919876543210', '+919876543211', '+919876543212', '+919876543213', '+919876543214', '+919876543215', '+919800000001', '+919800000002'] } }
      ]
    },
    select: { id: true, customerName: true, customerPhone: true, source: true }
  });

  console.log(`Found ${dummyAssignments.length} dummy assignments to purge:`);
  console.log(dummyAssignments);
}

main().catch(console.error).finally(() => prisma.$disconnect());
