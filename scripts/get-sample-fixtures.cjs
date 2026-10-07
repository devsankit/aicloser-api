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
    const alphaLead = await client.query('SELECT id, "customerName" FROM "SalesLeadAssignment" WHERE "tenantId" = $1 LIMIT 1', ['tenant-acme-agency-6478aca1']);
    const betaLead = await client.query('SELECT id, "customerName" FROM "SalesLeadAssignment" WHERE "tenantId" = $1 LIMIT 1', ['tenant-agency-8deafdbb']);
    const betaLeadCount = await client.query('SELECT count(*) FROM "SalesLeadAssignment" WHERE "tenantId" = $1', ['tenant-agency-8deafdbb']);
    const alphaContact = await client.query('SELECT id, "e164Phone" FROM "MarketingContact" WHERE "tenantId" = $1 LIMIT 1', ['tenant-acme-agency-6478aca1']);
    const betaContact = await client.query('SELECT id, "e164Phone" FROM "MarketingContact" WHERE "tenantId" = $1 LIMIT 1', ['tenant-agency-8deafdbb']);
    const betaConv = await client.query('SELECT id, "tenantId" FROM "AppConversation" LIMIT 1');
    const alphaAgent = await client.query('SELECT id, "tenantId" FROM "SalesAgentProfile" WHERE "tenantId" = $1 LIMIT 1', ['tenant-acme-agency-6478aca1']);
    const betaAgent = await client.query('SELECT id, "tenantId" FROM "SalesAgentProfile" WHERE "tenantId" = $1 LIMIT 1', ['tenant-agency-8deafdbb']);
    const callSample = await client.query('SELECT id, "tenantId", "assignmentId", "agentId" FROM "SalesMobileCall" LIMIT 1');

    console.log(JSON.stringify({
      alphaLead: alphaLead.rows[0],
      betaLead: betaLead.rows[0],
      betaLeadCount: betaLeadCount.rows[0].count,
      alphaContact: alphaContact.rows[0],
      betaContact: betaContact.rows[0],
      betaConv: betaConv.rows[0],
      alphaAgent: alphaAgent.rows[0],
      betaAgent: betaAgent.rows[0],
      callSample: callSample.rows[0],
    }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
