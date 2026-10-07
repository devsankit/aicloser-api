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
  console.log('--- LIVE AICLOSER DATABASE DEEP INSPECTION ---');

  // 1. Check legacy Tenant table
  const tenantRes = await pool.query('SELECT count(*) FROM "Tenant"');
  console.log('Legacy "Tenant" row count:', tenantRes.rows[0].count);

  // 2. Row counts of key tables
  const tables = [
    'AppAuthUser',
    'SalesAgentProfile',
    'SalesLeadAssignment',
    'AppConversation',
    'MarketingContact',
    'SalesLeadPoolItem',
    'SalesMobileCall',
    'SalesLeadTimelineEntry',
    'SalesActivityLog',
    'SalesMobileDevice',
    'SalesDeal',
    'SalesSettings',
  ];

  for (const t of tables) {
    try {
      const cnt = await pool.query(`SELECT count(*) FROM "${t}"`);
      const nullTenant = await pool.query(`SELECT count(*) FROM "${t}" WHERE "tenantId" IS NULL`);
      console.log(`Table [${t}]: Total = ${cnt.rows[0].count}, NULL tenantId = ${nullTenant.rows[0].count}`);
    } catch (e) {
      console.log(`Table [${t}]: Error - ${e.message.split('\n')[0]}`);
    }
  }

  // 3. Check leads breakdown by tenant
  const leadsByTenant = await pool.query(`SELECT "tenantId", count(*) FROM "SalesLeadAssignment" GROUP BY "tenantId" ORDER BY count(*) DESC`);
  console.log('\nLeads breakdown by tenantId:', leadsByTenant.rows);

  // 4. Check distinct tenantId values in AppAuthUser
  const userTenants = await pool.query(`SELECT count(DISTINCT "tenantId") as tenant_count, count(*) filter (where "tenantId" is null) as null_tenants FROM "AppAuthUser"`);
  console.log('\nAppAuthUser distinct tenants:', userTenants.rows[0]);

  // 5. Check column definition and nullability of tenantId in key tables
  const cols = await pool.query(`
    SELECT table_name, column_name, is_nullable, data_type 
    FROM information_schema.columns 
    WHERE table_schema = 'public' AND column_name = 'tenantId'
    ORDER BY table_name;
  `);
  console.log('\ntenantId columns nullability:');
  for (const r of cols.rows) {
    console.log(`- ${r.table_name}: ${r.column_name} (nullable: ${r.is_nullable}, type: ${r.data_type})`);
  }

  // 6. Check RLS status across tables
  const rlsRes = await pool.query(`
    SELECT relname as table_name, relrowsecurity as rls_enabled, relforcerowsecurity as rls_forced
    FROM pg_class
    JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
    WHERE pg_namespace.nspname = 'public' AND relkind = 'r'
    AND relname IN ('SalesLeadAssignment', 'MarketingContact', 'SalesMobileCall', 'AppConversation', 'SalesAgentProfile')
    ORDER BY relname;
  `);
  console.log('\nPostgreSQL RLS Status:');
  for (const r of rlsRes.rows) {
    console.log(`- ${r.table_name}: RLS enabled = ${r.rls_enabled}, RLS forced = ${r.rls_forced}`);
  }

  // 7. Check Prisma migrations table if exists
  const migRes = await pool.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = '_prisma_migrations'
    );
  `);
  console.log('\n_prisma_migrations table exists:', migRes.rows[0].exists);
  if (migRes.rows[0].exists) {
    const migs = await pool.query('SELECT id, migration_name, finished_at FROM "_prisma_migrations" ORDER BY finished_at DESC LIMIT 5');
    console.log('Latest 5 recorded migrations:', migs.rows);
  }
}

main()
  .catch(console.error)
  .finally(() => pool.end());
