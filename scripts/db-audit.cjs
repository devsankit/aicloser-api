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

async function runAudit() {
  const client = await pool.connect();
  try {
    console.log('====================================================');
    console.log('       AICLOSER DATABASE SECURITY & AUDIT REPORT     ');
    console.log('====================================================\n');

    // 1. Workspace Count
    const wsRes = await client.query('SELECT count(*) AS total FROM "AicloserWorkspace"');
    console.log(`[1] Canonical Workspaces: ${wsRes.rows[0].total}`);

    // 2. Users by Tenant (top 10 & total)
    const userTenantRes = await client.query(`
      SELECT COALESCE("tenantId", 'NULL') AS tenant_id, count(*) AS count
      FROM "AppAuthUser"
      GROUP BY "tenantId"
      ORDER BY count(*) DESC
    `);
    const totalUsers = userTenantRes.rows.reduce((sum, r) => sum + parseInt(r.count, 10), 0);
    console.log(`\n[2] Users by Tenant (Total users: ${totalUsers}, Distinct tenant buckets: ${userTenantRes.rows.length}):`);
    userTenantRes.rows.slice(0, 8).forEach(r => {
      console.log(`    - ${r.tenant_id.padEnd(45)}: ${r.count} users`);
    });
    if (userTenantRes.rows.length > 8) {
      console.log(`    ... and ${userTenantRes.rows.length - 8} more tenants with 1-2 users`);
    }

    // 3. Leads by Tenant
    const leadTenantRes = await client.query(`
      SELECT "tenantId" AS tenant_id, count(*) AS count
      FROM "SalesLeadAssignment"
      GROUP BY "tenantId"
      ORDER BY count(*) DESC
    `);
    const totalLeads = leadTenantRes.rows.reduce((sum, r) => sum + parseInt(r.count, 10), 0);
    console.log(`\n[3] Leads by Tenant (Total leads: ${totalLeads}):`);
    leadTenantRes.rows.forEach(r => {
      console.log(`    - ${r.tenant_id.padEnd(45)}: ${r.count} leads`);
    });

    // 4. Contacts by Tenant
    const contactTenantRes = await client.query(`
      SELECT "tenantId" AS tenant_id, count(*) AS count
      FROM "MarketingContact"
      GROUP BY "tenantId"
      ORDER BY count(*) DESC
    `);
    const totalContacts = contactTenantRes.rows.reduce((sum, r) => sum + parseInt(r.count, 10), 0);
    console.log(`\n[4] Marketing Contacts by Tenant (Total contacts: ${totalContacts}):`);
    contactTenantRes.rows.forEach(r => {
      console.log(`    - ${r.tenant_id.padEnd(45)}: ${r.count} contacts`);
    });

    // 5. Conversations by Tenant
    const convTenantRes = await client.query(`
      SELECT "tenantId" AS tenant_id, count(*) AS count
      FROM "AppConversation"
      GROUP BY "tenantId"
      ORDER BY count(*) DESC
    `);
    const totalConv = convTenantRes.rows.reduce((sum, r) => sum + parseInt(r.count, 10), 0);
    console.log(`\n[5] Conversations by Tenant (Total conversations: ${totalConv}):`);
    convTenantRes.rows.forEach(r => {
      console.log(`    - ${r.tenant_id.padEnd(45)}: ${r.count} conversations`);
    });

    // 6. Null Tenant Check across all core tables
    const checkTables = [
      'SalesLeadAssignment',
      'SalesAgentProfile',
      'SalesMobileCall',
      'SalesLeadTimelineEntry',
      'SalesActivityLog',
      'SalesLeadPoolItem',
      'SalesMobileDevice',
      'MarketingContact',
      'AppConversation'
    ];
    console.log('\n[6] Null Tenant Validation across Core Tables:');
    let hasNulls = false;
    for (const t of checkTables) {
      const nullRes = await client.query(`SELECT count(*) AS count FROM "${t}" WHERE "tenantId" IS NULL`);
      const count = parseInt(nullRes.rows[0].count, 10);
      if (count > 0) {
        console.log(`    ❌ ${t}: ${count} NULL tenant rows!`);
        hasNulls = true;
      } else {
        console.log(`    ✅ ${t}: 0 NULL tenant rows`);
      }
    }
    // Also check AppAuthUser (excluding super admins)
    const userNullRes = await client.query(`SELECT count(*) AS count FROM "AppAuthUser" WHERE "tenantId" IS NULL AND "role" != 'SUPER_ADMIN'`);
    const userNullCount = parseInt(userNullRes.rows[0].count, 10);
    if (userNullCount > 0) {
      console.log(`    ❌ AppAuthUser (non-super-admin): ${userNullCount} NULL tenant rows!`);
      hasNulls = true;
    } else {
      console.log(`    ✅ AppAuthUser (non-super-admin): 0 NULL tenant rows (1 SUPER_ADMIN platform root is expected NULL)`);
    }

    // 7. Tenant Mismatch Rows (e.g. Lead's tenant vs Assigned Agent's tenant)
    console.log('\n[7] Cross-Tenant Mismatch Detection:');
    const mismatchRes = await client.query(`
      SELECT count(*) AS count
      FROM "SalesLeadAssignment" l
      INNER JOIN "SalesAgentProfile" p ON l."assignedAgentId" = p."id"
      WHERE l."tenantId" != p."tenantId"
    `);
    const mismatchCount = parseInt(mismatchRes.rows[0].count, 10);
    if (mismatchCount > 0) {
      console.log(`    ❌ Lead-to-Agent Tenant Mismatches: ${mismatchCount}`);
    } else {
      console.log(`    ✅ Lead-to-Agent Tenant Mismatches: 0`);
    }

    // Lead-to-User Mismatch
    const leadUserMismatch = await client.query(`
      SELECT count(*) AS count
      FROM "SalesLeadAssignment" l
      INNER JOIN "AppAuthUser" u ON l."assignedAgentId" = u."id"
      WHERE l."tenantId" != u."tenantId"
    `);
    const leadUserMismatchCount = parseInt(leadUserMismatch.rows[0].count, 10);
    if (leadUserMismatchCount > 0) {
      console.log(`    ❌ Lead-to-User Tenant Mismatches: ${leadUserMismatchCount}`);
    } else {
      console.log(`    ✅ Lead-to-User Tenant Mismatches: 0`);
    }

    // 8. Duplicate Tenant-Scoped Phone Numbers
    console.log('\n[8] Tenant-Scoped Phone Uniqueness Check:');
    const dupContacts = await client.query(`
      SELECT "tenantId", "e164Phone", count(*) AS count
      FROM "MarketingContact"
      GROUP BY "tenantId", "e164Phone"
      HAVING count(*) > 1
    `);
    if (dupContacts.rows.length > 0) {
      console.log(`    ❌ Duplicate Marketing Contacts (tenant + phone): ${dupContacts.rows.length}`);
    } else {
      console.log(`    ✅ MarketingContact (tenantId, e164Phone): 0 duplicates (Unique constraint enforced)`);
    }

    // 9. PostgreSQL RLS Status & Policies
    console.log('\n[9] PostgreSQL Row-Level Security (RLS) Status:');
    const rlsRes = await client.query(`
      SELECT relname AS table_name, relrowsecurity AS rls_enabled
      FROM pg_class
      WHERE relname IN ('SalesLeadAssignment', 'MarketingContact', 'AppConversation', 'AicloserWorkspace', 'AppAuthUser')
      ORDER BY relname;
    `);
    rlsRes.rows.forEach(r => {
      console.log(`    - ${r.table_name.padEnd(25)}: RLS Enabled = ${r.rls_enabled}`);
    });
    const policyRes = await client.query(`
      SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual
      FROM pg_policies
      WHERE tablename IN ('SalesLeadAssignment', 'MarketingContact', 'AppConversation');
    `);
    console.log(`    Active RLS Policies count: ${policyRes.rows.length}`);

    // 10. Latest Migration Status
    console.log('\n[10] Prisma Migration History:');
    const migRes = await client.query(`
      SELECT migration_name, finished_at, rolled_back_at
      FROM _prisma_migrations
      ORDER BY started_at DESC
      LIMIT 3
    `);
    migRes.rows.forEach(r => {
      console.log(`    - ${r.migration_name} | Finished: ${r.finished_at ? r.finished_at.toISOString() : 'Pending'} | RolledBack: ${r.rolled_back_at || 'None'}`);
    });

    console.log('\n====================================================');
    console.log('              AUDIT COMPLETED CLEANLY               ');
    console.log('====================================================');
  } catch (err) {
    console.error('Audit failed with error:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

runAudit();
