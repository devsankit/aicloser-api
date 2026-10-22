const pg = require('pg');

const tablesToDrop = [
  // 8 dead backup tables
  'AgencyResetBackup20260622',
  'AppConversation_AgencyDuplicates_Backup_20261003',
  'AppConversation_Non9993328124_Backup_20261003',
  'SalesActivityLog_NonInbound_Backup_20261003',
  'SalesLeadAssignment_AgencyDuplicates_Backup_20261003',
  'SalesLeadAssignment_Non9993328124_Backup_20261003',
  'SalesLeadAssignment_NonInbound_Backup_20261003_v2',
  'SalesMobileCall_NonInbound_Backup_20261003',

  // 33 pure Gigxomi marketplace / legacy tables
  'AppFreelancerService',
  'gx_lead_tasks',
  'gapp_webinars',
  'SalesWebinar',
  'AppDeliverySubmission',
  'AppDripDelivery',
  'AppFreelancerAssessment',
  'AppFreelancerIdentity',
  'AppFreelancerOnboarding',
  'AppFreelancerPortfolioReview',
  'AppFreelancerRating',
  'AppFreelancerTrustDispute',
  'AppFreelancerTrustEvent',
  'AppFreelancerTrustSnapshot',
  'AppFreelancerWalletEntry',
  'AppFreelancerWorkspace',
  'AppMarketplaceTask',
  'AppRevisionRequest',
  'AppTaskApplication',
  'AppTrustScoreRule',
  'DeliveryAsset',
  'EditorProfile',
  'MatchResult',
  'Quote',
  'QuoteLineItem',
  'SalesWebinarInvite',
  'Service',
  'ShowcasePermission',
  'WalletLedgerEntry',
  'gapp_webinar_payments',
  'gapp_webinar_registrations',
  'gx_journey_events',
  'gx_journey_snapshots',
];

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const pool = new pg.Pool({ connectionString });
  const client = await pool.connect();

  console.log(`=== Starting Drop of ${tablesToDrop.length} Legacy Tables ===`);

  try {
    for (const table of tablesToDrop) {
      try {
        await client.query(`DROP TABLE IF EXISTS "${table}" CASCADE;`);
        console.log(`[DROPPED] "${table}"`);
      } catch (err) {
        console.error(`[ERROR] Failed to drop "${table}":`, err.message);
      }
    }
    console.log('=== Drop Legacy Tables Completed Successfully ===');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
