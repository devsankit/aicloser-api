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
  const client = await pool.connect();
  try {
    console.log('Testing workspace migration statements inside a ROLLBACK transaction...');
    await client.query('BEGIN;');

    // 1. Create AicloserWorkspace table
    await client.query(`
      CREATE TABLE IF NOT EXISTS "AicloserWorkspace" (
          "id" TEXT NOT NULL,
          "name" TEXT NOT NULL,
          "slug" TEXT,
          "ownerUserId" TEXT,
          "ownerEmail" TEXT,
          "ownerPhone" TEXT,
          "status" TEXT NOT NULL DEFAULT 'ACTIVE',
          "planTier" TEXT NOT NULL DEFAULT 'PRO',
          "maxSeats" INTEGER NOT NULL DEFAULT 5,
          "settings" JSONB NOT NULL DEFAULT '{}'::jsonb,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

          CONSTRAINT "AicloserWorkspace_pkey" PRIMARY KEY ("id")
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "AicloserWorkspace_slug_key" ON "AicloserWorkspace"("slug");
      CREATE INDEX IF NOT EXISTS "AicloserWorkspace_status_idx" ON "AicloserWorkspace"("status");
      CREATE INDEX IF NOT EXISTS "AicloserWorkspace_createdAt_idx" ON "AicloserWorkspace"("createdAt");
    `);
    console.log('✅ AicloserWorkspace table creation succeeded.');

    // 2. Backfill from AppAuthUser
    const res1 = await client.query(`
      INSERT INTO "AicloserWorkspace" ("id", "name", "slug", "ownerUserId", "ownerEmail", "ownerPhone", "status", "createdAt", "updatedAt")
      SELECT DISTINCT ON (u."tenantId")
          u."tenantId" AS "id",
          COALESCE(u."displayName" || '''s Workspace', u."tenantId") AS "name",
          LOWER(REGEXP_REPLACE(u."tenantId", '[^a-zA-Z0-9]', '-', 'g')) AS "slug",
          u."id" AS "ownerUserId",
          u."email" AS "ownerEmail",
          u."phone" AS "ownerPhone",
          'ACTIVE' AS "status",
          u."createdAt" AS "createdAt",
          CURRENT_TIMESTAMP AS "updatedAt"
      FROM "AppAuthUser" u
      WHERE u."tenantId" IS NOT NULL
      ORDER BY u."tenantId", CASE WHEN u."role" IN ('ADMIN', 'SUPER_ADMIN') THEN 0 ELSE 1 END, u."createdAt" ASC
      ON CONFLICT ("id") DO NOTHING;
    `);
    console.log(`✅ Seeded ${res1.rowCount} workspaces from AppAuthUser.`);

    // 3. Backfill missing from other tables
    const res2 = await client.query(`
      INSERT INTO "AicloserWorkspace" ("id", "name", "slug", "status", "createdAt", "updatedAt")
      SELECT DISTINCT
          s."tenantId" AS "id",
          s."tenantId" || ' Workspace' AS "name",
          LOWER(REGEXP_REPLACE(s."tenantId", '[^a-zA-Z0-9]', '-', 'g')) AS "slug",
          'ACTIVE' AS "status",
          CURRENT_TIMESTAMP AS "createdAt",
          CURRENT_TIMESTAMP AS "updatedAt"
      FROM (
          SELECT "tenantId" FROM "SalesLeadAssignment" WHERE "tenantId" IS NOT NULL
          UNION
          SELECT "tenantId" FROM "AppConversation" WHERE "tenantId" IS NOT NULL
          UNION
          SELECT "tenantId" FROM "MarketingContact" WHERE "tenantId" IS NOT NULL
          UNION
          SELECT "tenantId" FROM "SalesAgentProfile" WHERE "tenantId" IS NOT NULL
          UNION
          SELECT "tenantId" FROM "SalesMobileCall" WHERE "tenantId" IS NOT NULL
          UNION
          SELECT "tenantId" FROM "SalesLeadPoolItem" WHERE "tenantId" IS NOT NULL
          UNION
          SELECT "tenantId" FROM "SalesLeadTimelineEntry" WHERE "tenantId" IS NOT NULL
          UNION
          SELECT "tenantId" FROM "SalesActivityLog" WHERE "tenantId" IS NOT NULL
          UNION
          SELECT "tenantId" FROM "SalesMobileDevice" WHERE "tenantId" IS NOT NULL
      ) s
      ON CONFLICT ("id") DO NOTHING;
    `);
    console.log(`✅ Seeded ${res2.rowCount} remaining workspaces from operational tables.`);

    const countRes = await client.query('SELECT count(*) FROM "AicloserWorkspace"');
    console.log(`Total AicloserWorkspace rows: ${countRes.rows[0].count}`);

    // 4. Test NOT NULL constraints
    const notNullTables = [
      'SalesLeadAssignment',
      'SalesAgentProfile',
      'SalesMobileCall',
      'SalesLeadTimelineEntry',
      'SalesActivityLog',
      'SalesLeadPoolItem',
      'SalesMobileDevice',
    ];
    for (const t of notNullTables) {
      await client.query(`ALTER TABLE "${t}" ALTER COLUMN "tenantId" SET NOT NULL;`);
      console.log(`✅ ALTER TABLE "${t}" ALTER COLUMN "tenantId" SET NOT NULL succeeded.`);
    }

    // 5. Test Foreign Keys
    for (const t of notNullTables) {
      await client.query(`
        ALTER TABLE "${t}"
        ADD CONSTRAINT "${t}_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "AicloserWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
      `);
      console.log(`✅ Added Foreign Key on "${t}" -> "AicloserWorkspace"("id").`);
    }

    // Also FK on MarketingContact, AppConversation, AppAuthUser
    for (const t of ['MarketingContact', 'AppConversation', 'AppAuthUser']) {
      await client.query(`
        ALTER TABLE "${t}"
        ADD CONSTRAINT "${t}_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "AicloserWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
      `);
      console.log(`✅ Added Foreign Key on "${t}" -> "AicloserWorkspace"("id").`);
    }

    // 6. Test Compound Indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS "SalesLeadAssignment_tenantId_assignedAgentId_idx" ON "SalesLeadAssignment"("tenantId", "assignedAgentId");
      CREATE INDEX IF NOT EXISTS "SalesMobileCall_tenantId_agentId_idx" ON "SalesMobileCall"("tenantId", "agentId");
      CREATE INDEX IF NOT EXISTS "MarketingContact_tenantId_createdAt_idx" ON "MarketingContact"("tenantId", "createdAt");
      CREATE INDEX IF NOT EXISTS "AppConversation_tenantId_status_idx" ON "AppConversation"("tenantId", "status");
      CREATE INDEX IF NOT EXISTS "AppConversation_tenantId_customerPhone_idx" ON "AppConversation"("tenantId", "customerPhone");
    `);
    console.log('✅ Compound indexes created successfully.');

    // Rollback test
    await client.query('ROLLBACK;');
    console.log('✅ Dry-run transaction rolled back cleanly. No permanent state changed.');
  } catch (err) {
    await client.query('ROLLBACK;').catch(() => {});
    console.error('❌ Dry run failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
