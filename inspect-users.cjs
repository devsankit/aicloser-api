const { Pool } = require('/var/www/aicloser-api/node_modules/pg');
const pool = new Pool({ connectionString: "postgresql://aicloser_user:AIcloser%4012345@127.0.0.1:5432/aicloser" });

async function checkUsers() {
  const emails = [
    'hello.ankitrathore@gmail.com',
    'theankit.storage@gmail.com',
    'callingankit@gmail.com',
    'managertest@gmail.com'
  ];

  const res = await pool.query(
    'SELECT id, email, phone, role, "tenantId", "displayName", "passwordSalt", "passwordHash" FROM "AppAuthUser" WHERE lower(email) = ANY($1)',
    [emails]
  );

  console.log("Found users count:", res.rows.length);
  for (const row of res.rows) {
    console.log({
      id: row.id,
      email: row.email,
      phone: row.phone,
      role: row.role,
      tenantId: row.tenantId,
      displayName: row.displayName,
      hasSalt: Boolean(row.passwordSalt),
      hasHash: Boolean(row.passwordHash)
    });
  }

  await pool.end();
}

checkUsers().catch(console.error);
