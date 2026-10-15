const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  const tenantId = 'tenant-the-storage-test-1d01dda2';

  try {
    await client.query('BEGIN');
    console.log('=== COMMENCING PRODUCTION CONSOLIDATION MIGRATION ===');

    const dupPhonesRes = await client.query(`
      SELECT "customerPhone"
      FROM "SalesLeadAssignment"
      WHERE "tenantId" = $1 AND "customerPhone" IS NOT NULL AND "customerPhone" != ''
      GROUP BY "customerPhone"
      HAVING count(*) > 1;
    `, [tenantId]);

    console.log(`Processing ${dupPhonesRes.rows.length} duplicate phone groups...`);

    let remappedCalls = 0;
    let remappedLogs = 0;
    let remappedTimeline = 0;
    let deletedRows = 0;

    for (const row of dupPhonesRes.rows) {
      const phone = row.customerPhone;
      const leadsRes = await client.query(`
        SELECT id, stage, "createdAt", "notes", "conversationId"
        FROM "SalesLeadAssignment"
        WHERE "tenantId" = $1 AND "customerPhone" = $2
        ORDER BY 
          CASE 
            WHEN stage = 'CLOSED_WON' THEN 10
            WHEN stage = 'NEGOTIATION' THEN 9
            WHEN stage = 'FOLLOW_UP' THEN 8
            WHEN stage = 'INTERESTED' THEN 7
            WHEN stage = 'CONTACTED' THEN 6
            WHEN stage = 'ASSIGNED' THEN 5
            WHEN stage = 'NEW' THEN 1
            ELSE 2
          END DESC,
          "createdAt" ASC;
      `, [tenantId, phone]);

      const primary = leadsRes.rows[0];
      const secondaries = leadsRes.rows.slice(1);
      const secondaryIds = secondaries.map(s => s.id);

      // 1. Remap Calls
      const cRes = await client.query(`UPDATE "SalesMobileCall" SET "assignmentId" = $1 WHERE "assignmentId" = ANY($2)`, [primary.id, secondaryIds]);
      remappedCalls += cRes.rowCount;

      // 2. Remap Activity Logs
      const lRes = await client.query(`UPDATE "SalesActivityLog" SET "assignmentId" = $1 WHERE "assignmentId" = ANY($2)`, [primary.id, secondaryIds]);
      remappedLogs += lRes.rowCount;

      // 3. Remap Timeline Entries
      const tRes = await client.query(`UPDATE "SalesLeadTimelineEntry" SET "leadId" = $1 WHERE "leadId" = ANY($2)`, [primary.id, secondaryIds]);
      remappedTimeline += tRes.rowCount;

      // 4. Remap Tasks
      await client.query(`UPDATE "gx_lead_tasks" SET "salesLeadId" = $1 WHERE "salesLeadId" = ANY($2)`, [primary.id, secondaryIds]);

      // 5. Delete consolidated duplicate leads
      const dRes = await client.query(`DELETE FROM "SalesLeadAssignment" WHERE id = ANY($1)`, [secondaryIds]);
      deletedRows += dRes.rowCount;
    }

    console.log(`Consolidation summary:`);
    console.log(`  - Calls preserved & remapped: ${remappedCalls}`);
    console.log(`  - Activity logs preserved & remapped: ${remappedLogs}`);
    console.log(`  - Timeline entries preserved & remapped: ${remappedTimeline}`);
    console.log(`  - Redundant duplicate lead rows purged: ${deletedRows}`);

    // Create the unique index
    console.log('Applying UNIQUE INDEX: idx_salesleadassignment_tenant_phone...');
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_salesleadassignment_tenant_phone" 
      ON "SalesLeadAssignment" ("tenantId", "customerPhone");
    `);

    await client.query('COMMIT');
    console.log('✅ TRANSACTION COMMITTED SUCCESSFULLY! Zero duplicates remain.');

    // Count remaining leads
    const countRes = await client.query(`SELECT count(*) FROM "SalesLeadAssignment" WHERE "tenantId" = $1`, [tenantId]);
    console.log(`Total verified unique leads in workspace: ${countRes.rows[0].count}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed and rolled back:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
