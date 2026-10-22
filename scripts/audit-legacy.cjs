const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const pg = require('pg');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  const pool = new pg.Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  console.log('=== Step 1: Listing All Live Tables & Row Counts ===');
  const rows = await prisma.$queryRawUnsafe(`
    SELECT relname as name, n_live_tup as count 
    FROM pg_stat_user_tables 
    WHERE schemaname = 'public' 
    ORDER BY n_live_tup DESC, relname ASC;
  `);

  const tablesWithRows = [];
  const emptyTables = [];
  const backupTables = [];
  const legacyMarketplaceTables = [];

  const marketplaceKeywords = [
    'freelancer', 'editor', 'task', 'delivery', 'revision', 'assessment', 
    'portfolio', 'trust', 'service', 'quote', 'match', 'showcase', 
    'wallet', 'webinar', 'gx_journey'
  ];

  for (const r of rows) {
    const name = r.name;
    const count = Number(r.count);

    if (name.includes('Backup') || name.includes('backup')) {
      backupTables.push({ name, count });
    } else if (marketplaceKeywords.some(kw => name.toLowerCase().includes(kw))) {
      legacyMarketplaceTables.push({ name, count });
    } else if (count > 0) {
      tablesWithRows.push({ name, count });
    } else {
      emptyTables.push({ name, count });
    }
  }

  console.log(`\n--- TABLES WITH DATA (${tablesWithRows.length}) ---`);
  tablesWithRows.forEach(t => console.log(`  ${t.name.padEnd(45)}: ${t.count} rows`));

  console.log(`\n--- LEGACY MARKETPLACE / GIGXOMI TABLES (${legacyMarketplaceTables.length}) ---`);
  legacyMarketplaceTables.forEach(t => console.log(`  ${t.name.padEnd(45)}: ${t.count} rows`));

  console.log(`\n--- BACKUP TABLES (${backupTables.length}) ---`);
  backupTables.forEach(t => console.log(`  ${t.name.padEnd(45)}: ${t.count} rows`));

  console.log(`\n--- OTHER EMPTY TABLES (${emptyTables.length}) ---`);
  emptyTables.slice(0, 30).forEach(t => console.log(`  ${t.name.padEnd(45)}: 0 rows`));
  if (emptyTables.length > 30) {
    console.log(`  ... and ${emptyTables.length - 30} more empty tables.`);
  }

  console.log('\n=== Step 2: Inspecting Non-Empty Legacy Tables ===');
  try {
    const freelanceServices = await prisma.appFreelancerService.findMany({ take: 3 });
    console.log('AppFreelancerService sample (first 3):', JSON.stringify(freelanceServices, null, 2));
  } catch (e) {
    console.log('Could not read AppFreelancerService:', e.message);
  }

  try {
    const leadTasks = await prisma.gx_lead_tasks.findMany({ take: 5 });
    console.log('gx_lead_tasks sample:', JSON.stringify(leadTasks, null, 2));
  } catch (e) {
    console.log('Could not read gx_lead_tasks:', e.message);
  }

  try {
    const gappWebinars = await prisma.gapp_webinars.findMany({ take: 2 });
    console.log('gapp_webinars sample:', JSON.stringify(gappWebinars, null, 2));
  } catch (e) {
    console.log('Could not read gapp_webinars:', e.message);
  }

  await prisma.$disconnect();
  await pool.end();
}

main().catch(console.error);
