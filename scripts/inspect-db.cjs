require('dotenv').config({ path: '/var/www/aicloser-api/.env' });
const { prisma } = require('../dist/lib/prisma.js');

const tenantId = 'tenant-the-storage-test-1d01dda2';

async function main() {
  const conversations = await prisma.appConversation.findMany({
    where: { tenantId },
    select: {
      id: true,
      customerName: true,
      customerPhone: true,
      serviceSlug: true,
      assignedFreelancerName: true,
      assignedFreelancerId: true,
      payload: true,
      createdAt: true
    }
  });
  console.log('--- ALL CONVERSATIONS in workspace (' + conversations.length + ') ---');
  for (const c of conversations) {
    const p = c.payload || {};
    console.log(`[${c.id}] ${c.customerName} (${c.customerPhone}) | slug: ${c.serviceSlug} | assigned: ${c.assignedFreelancerName} | externalSource: ${p.externalSourceType} | scannedByName: ${p.scannedByName} | scannedByUserId: ${p.scannedByUserId}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
