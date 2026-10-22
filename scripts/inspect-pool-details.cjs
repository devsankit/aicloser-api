require('dotenv').config({ path: '/var/www/aicloser-api/.env' });
const { prisma } = require('../dist/lib/prisma.js');

const tenantId = 'tenant-the-storage-test-1d01dda2';

async function main() {
  const poolItems = await prisma.salesLeadPoolItem.findMany({
    where: { tenantId },
    select: { id: true, customerName: true, customerPhone: true, source: true, status: true }
  });
  console.log(`Total pool items: ${poolItems.length}`);
  const countsBySource = {};
  for (const p of poolItems) {
    const k = `${p.source} | ${p.status}`;
    countsBySource[k] = (countsBySource[k] || 0) + 1;
  }
  console.log('Pool items breakdown:', countsBySource);
  console.log('Sample pool items:', poolItems.slice(0, 25));
}

main().catch(console.error).finally(() => prisma.$disconnect());
