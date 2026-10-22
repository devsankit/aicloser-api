require('dotenv').config({ path: '/var/www/aicloser-api/.env' });
const { prisma } = require('../dist/lib/prisma.js');

const tenantId = 'tenant-the-storage-test-1d01dda2';

async function main() {
  const deleted = await prisma.salesLeadAssignment.deleteMany({
    where: {
      tenantId,
      customerName: 'Phone contact'
    }
  });
  console.log(`Deleted ${deleted.count} synthetic 'Phone contact' leads.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
