const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL || 'postgresql://aicloser_user:AIcloser%4012345@127.0.0.1:5432/aicloser?schema=public';
const pool = new Pool({ connectionString: databaseUrl });

const KEEP_IDS = [
  'tenant-super-admin-b8a96b58',
  'tenant-the-storage-test-1d01dda2',
  'tenant-tarun-realty-564074cd',
  'tenant-jay-estate-management-01773ec9',
  'tenant-ai-closer-996ec2f6',
  'tenant-gigxomi-4f22efa0',
];

async function main() {
  const client = await pool.connect();
  try {
    const res = await client.query(`
      SELECT id, name, slug, "ownerEmail", "ownerUserId", status, "createdAt"
      FROM "AicloserWorkspace"
      ORDER BY "createdAt" DESC
    `);
    
    console.log(`TOTAL WORKSPACES FOUND: ${res.rows.length}\n`);

    const toKeep = [];
    const toDelete = [];

    for (const w of res.rows) {
      if (KEEP_IDS.includes(w.id)) {
        toKeep.push(w);
      } else {
        toDelete.push(w);
      }
    }

    console.log(`=== WORKSPACES TO KEEP (${toKeep.length}) ===`);
    toKeep.forEach(w => console.log(`  [KEEP] ${w.id} | ${w.name} | ${w.ownerEmail || 'no-email'} | ${w.status}`));

    console.log(`\n=== WORKSPACES CANDIDATES TO PURGE (${toDelete.length}) ===`);
    toDelete.forEach(w => console.log(`  [PURGE] ${w.id} | ${w.name} | ${w.ownerEmail || 'no-email'} | ${w.createdAt.toISOString()}`));

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
