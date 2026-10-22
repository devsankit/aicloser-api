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

async function purge() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Identify test workspaces
    const wsRes = await client.query(`
      SELECT id, name, "ownerEmail"
      FROM "AicloserWorkspace"
      WHERE id NOT IN ($1, $2, $3, $4, $5, $6)
    `, KEEP_IDS);

    const testWorkspaceIds = wsRes.rows.map(r => r.id);
    console.log(`Identified ${testWorkspaceIds.length} test workspaces to purge:\n`, testWorkspaceIds);

    if (testWorkspaceIds.length === 0) {
      console.log('No test workspaces to purge.');
      await client.query('COMMIT');
      return;
    }

    // Identify users belonging to test workspaces
    const userRes = await client.query(`
      SELECT id, email, "tenantId"
      FROM "AppAuthUser"
      WHERE "tenantId" = ANY($1::text[])
    `, [testWorkspaceIds]);
    const testUserIds = userRes.rows.map(r => r.id);
    console.log(`Identified ${testUserIds.length} test users to purge.`);

    // 2. Break circular foreign key dependencies
    await client.query(`
      UPDATE "AicloserWorkspace"
      SET "ownerUserId" = NULL
      WHERE id = ANY($1::text[])
    `, [testWorkspaceIds]);

    await client.query(`
      UPDATE "SalesLeadPoolItem"
      SET "convertedAssignmentId" = NULL
      WHERE "tenantId" = ANY($1::text[])
    `, [testWorkspaceIds]);

    await client.query(`
      UPDATE "SalesLeadAssignment"
      SET "conversationId" = NULL
      WHERE "tenantId" = ANY($1::text[])
    `, [testWorkspaceIds]);

    await client.query(`
      UPDATE "SalesAgentProfile"
      SET "parentAgentId" = NULL
      WHERE "tenantId" = ANY($1::text[])
    `, [testWorkspaceIds]);

    // 3. Delete non-tenantId child records
    await client.query(`
      DELETE FROM "gx_lead_tasks"
      WHERE "salesLeadId" IN (
        SELECT id FROM "SalesLeadAssignment" WHERE "tenantId" = ANY($1::text[])
      )
    `, [testWorkspaceIds]);
    console.log('Deleted gx_lead_tasks');


    // 4. Fetch all public tables with tenantId
    const tablesRes = await client.query(`
      SELECT table_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'tenantId'
        AND table_name != 'AicloserWorkspace'
      ORDER BY table_name
    `);

    // Priority ordering for tables with FK dependencies
    const preferredOrder = [
      'CallRecordingUpload',
      'SalesLeadTimelineEntry',
      'SalesActivityLog',
      'SalesMobileCall',
      'SalesMobileDevice',
      'SalesMobileOfflineEvent',
      'SalesMobileLeadPack',
      'SalesLeadPoolItem',
      'SalesPayout',
      'upi_payment_events',
      'upi_payment_links',
      'upi_payment_field_policies',
      'upi_payment_settings',
      'CustomFieldDefinition',
      'SalesLeadAssignment',
      'MarketingContact',
      'AppChatMessageReceipt',
      'AppChatTypingPresence',
      'AppConversation',
      'SalesDeal',
      'SalesAgentProfile',
      'AppClientSession',
      'AppClientSlot',
      'AppRealtimeEvent',
      'whatsapp_flow_runs',
      'whatsapp_flow_events',
      'whatsapp_flows',
      'WhatsAppAuditLog',
      'WhatsAppCampaign',
      'WhatsAppChannel',
      'WhatsAppMessageEvent',
      'WhatsAppOptIn',
      'WhatsAppSuppression',
      'WhatsAppTemplate',
      'WhatsAppTemplateSyncLog',
      'whatsapp_webhook_message_events',
      'meta_conversion_events',
      'AppAuthUser',
    ];

    const allTablesWithTenant = tablesRes.rows.map(r => r.table_name);
    const orderedTables = [
      ...preferredOrder.filter(t => allTablesWithTenant.includes(t)),
      ...allTablesWithTenant.filter(t => !preferredOrder.includes(t)),
    ];

    for (const table of orderedTables) {
      try {
        const delRes = await client.query(
          `DELETE FROM "${table}" WHERE "tenantId" = ANY($1::text[])`,
          [testWorkspaceIds]
        );
        if (delRes.rowCount > 0) {
          console.log(`Deleted ${delRes.rowCount} rows from ${table}`);
        }
      } catch (err) {
        console.warn(`Could not delete from ${table}: ${err.message}`);
      }
    }

    // 5. Also delete any User rows pointing to testUserIds if table User exists
    if (testUserIds.length > 0) {
      try {
        await client.query(`DELETE FROM "User" WHERE id = ANY($1::text[])`, [testUserIds]);
      } catch (_) {}
    }

    // 6. Finally delete AicloserWorkspace rows
    const delWs = await client.query(`
      DELETE FROM "AicloserWorkspace"
      WHERE id = ANY($1::text[])
    `, [testWorkspaceIds]);
    console.log(`\nDeleted ${delWs.rowCount} test AicloserWorkspace rows`);

    await client.query('COMMIT');
    console.log('\n✅ Successfully purged all test workspaces and associated records!');

    // 7. Verify remaining workspaces
    const remainingRes = await client.query(`
      SELECT id, name, "ownerEmail", status, "createdAt"
      FROM "AicloserWorkspace"
      ORDER BY "createdAt" DESC
    `);
    console.log(`\nRemaining Legitimate Workspaces (${remainingRes.rows.length}):`);
    remainingRes.rows.forEach(r => console.log(`  - ${r.id} | ${r.name} | ${r.ownerEmail} | ${r.status}`));

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error during purge, transaction rolled back:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

purge();
