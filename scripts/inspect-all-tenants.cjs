const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL || 'postgresql://aicloser_user:AIcloser%4012345@127.0.0.1:5432/aicloser?schema=public';
const parsed = new URL(databaseUrl);
const pool = new Pool({
  host: parsed.hostname,
  port: parsed.port ? Number(parsed.port) : 5432,
  database: parsed.pathname.replace(/^\//, '') || 'aicloser',
  user: decodeURIComponent(parsed.username),
  password: decodeURIComponent(parsed.password),
});

async function main() {
  console.log('=== EXTRACTING ALL DISTINCT TENANT IDENTIFIERS IN AICLOSER ===');

  const sources = [
    { table: 'AppAuthUser', col: 'tenantId' },
    { table: 'SalesLeadAssignment', col: 'tenantId' },
    { table: 'SalesAgentProfile', col: 'tenantId' },
    { table: 'MarketingContact', col: 'tenantId' },
    { table: 'AppConversation', col: 'tenantId' },
    { table: 'SalesMobileCall', col: 'tenantId' },
    { table: 'SalesLeadPoolItem', col: 'tenantId' },
    { table: 'SalesActivityLog', col: 'tenantId' },
    { table: 'SalesMobileDevice', col: 'tenantId' },
  ];

  const allTenants = new Map();

  for (const s of sources) {
    const res = await pool.query(`SELECT DISTINCT "${s.col}" as tid, count(*) as count FROM "${s.table}" WHERE "${s.col}" IS NOT NULL GROUP BY "${s.col}"`);
    console.log(`\nFrom ${s.table} (${res.rows.length} distinct tenants):`);
    for (const r of res.rows) {
      if (!allTenants.has(r.tid)) {
        allTenants.set(r.tid, { id: r.tid, sources: {} });
      }
      allTenants.get(r.tid).sources[s.table] = r.count;
    }
  }

  console.log('\nTenants present in other tables but NOT in AppAuthUser:');
  for (const [tid, info] of allTenants.entries()) {
    if (!info.sources['AppAuthUser']) {
      console.log(`- ${tid}: sources = ${JSON.stringify(info.sources)}`);
    }
  }

  // Let's get user details for each tenant from AppAuthUser to see their name/email/phone
  for (const [tid, info] of allTenants.entries()) {
    const ownerRes = await pool.query(`
      SELECT id, role, "displayName", email, phone, "createdAt" 
      FROM "AppAuthUser" 
      WHERE "tenantId" = $1 
      ORDER BY CASE WHEN role IN ('ADMIN', 'SUPER_ADMIN') THEN 0 ELSE 1 END, "createdAt" ASC 
      LIMIT 1
    `, [tid]);

    if (ownerRes.rows.length > 0) {
      info.owner = ownerRes.rows[0];
    }
  }

  console.log('\nSample of 10 mapped tenants:');
  const sample = Array.from(allTenants.values()).slice(0, 10);
  console.log(JSON.stringify(sample, null, 2));
}

main()
  .catch(console.error)
  .finally(() => pool.end());
