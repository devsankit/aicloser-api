const { Pool } = require('/var/www/aicloser-api/node_modules/pg');
const { scryptSync, randomBytes, timingSafeEqual, randomUUID } = require('crypto');

const pool = new Pool({ connectionString: "postgresql://aicloser_user:AIcloser%4012345@127.0.0.1:5432/aicloser" });

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, expectedHex) {
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

const usersToSeed = [
  {
    email: 'hello.ankitrathore@gmail.com',
    password: 'Ankit@1143',
    role: 'SUPER_ADMIN',
    assignedRole: 'SUPER_ADMIN',
    displayName: 'Ankit Rathore',
    phone: '+910000000000',
    preferredTenantId: null,
  },
  {
    email: 'theankit.storage@gmail.com',
    password: 'demo@123',
    role: 'ADMIN',
    assignedRole: 'ADMIN',
    displayName: 'Ankit Rathore',
    phone: '+919999888899',
    preferredTenantId: 'tenant-the-storage-test-1d01dda2',
  },
  {
    email: 'callingankit@gmail.com',
    password: 'Ankit@123',
    role: 'SALES_AGENT',
    assignedRole: 'SALES_AGENT',
    displayName: 'Calling Ankit',
    phone: '+919999888898',
    preferredTenantId: 'tenant-the-storage-test-1d01dda2',
  },
  {
    email: 'managertest@gmail.com',
    password: 'Manager@123',
    role: 'MANAGER',
    assignedRole: 'MANAGER',
    displayName: 'Manager Test',
    phone: '+919876543210',
    preferredTenantId: 'tenant-the-storage-test-1d01dda2',
  },
];

async function main() {
  console.log("=== SEEDING / RESETTING 4 CORE HIERARCHY CREDENTIALS IN POSTGRESQL ===");

  for (const u of usersToSeed) {
    const salt = randomBytes(16).toString('hex');
    const hash = hashPassword(u.password, salt);

    if (!verifyPassword(u.password, salt, hash)) {
      throw new Error(`Self-verification failed for ${u.email}`);
    }

    // Check if user exists by email OR phone
    const existing = await pool.query(
      'SELECT id, email, phone, "tenantId" FROM "AppAuthUser" WHERE lower(email) = lower($1) OR phone = $2',
      [u.email, u.phone]
    );

    let userId = '';
    let tenantId = u.preferredTenantId;

    if (existing.rows.length > 0) {
      const match = existing.rows[0];
      userId = match.id;
      tenantId = u.preferredTenantId || match.tenantId;
      console.log(`[FOUND EXISTING RECORD] id: ${userId}, prev email: ${match.email}, prev phone: ${match.phone}`);

      await pool.query(
        `UPDATE "AppAuthUser" 
         SET email = lower($1), role = $2, "assignedRole" = $3, "displayName" = $4, 
             "passwordSalt" = $5, "passwordHash" = $6, phone = $7,
             "tenantId" = $8, "lastLoginAt" = NOW()
         WHERE id = $9`,
        [u.email, u.role, u.assignedRole, u.displayName, salt, hash, u.phone, tenantId, userId]
      );
      console.log(`[UPDATED] ${u.role} -> ${u.email} (id: ${userId}, tenantId: ${tenantId})`);
    } else {
      userId = `user-${u.role.toLowerCase().replace(/_/g, '-')}-${randomUUID().slice(0, 8)}`;
      await pool.query(
        `INSERT INTO "AppAuthUser" 
         (id, role, "assignedRole", "tenantId", "displayName", email, phone, "loginPhoneAliases", "passwordSalt", "passwordHash", "otpCode", permissions, "isSeeded", "createdAt")
         VALUES ($1, $2, $3, $4, $5, lower($6), $7, $8, $9, $10, '111111', $11, true, NOW())`,
        [userId, u.role, u.assignedRole, tenantId, u.displayName, u.email, u.phone, [u.phone], salt, hash, [u.role.toLowerCase()]]
      );
      console.log(`[CREATED] ${u.role} -> ${u.email} (id: ${userId}, tenantId: ${tenantId})`);
    }

    // Ensure SalesAgentProfile exists for CLOSER and MANAGER
    if (u.role === 'SALES_AGENT' || u.role === 'MANAGER') {
      const existingProfile = await pool.query(
        'SELECT id FROM "SalesAgentProfile" WHERE "userId" = $1',
        [userId]
      );

      if (existingProfile.rows.length === 0 && tenantId) {
        const agentCode = `GX-${u.role === 'MANAGER' ? 'MGR' : 'REP'}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        const profileId = `profile-${u.role.toLowerCase()}-${randomUUID().slice(0, 8)}`;
        await pool.query(
          `INSERT INTO "SalesAgentProfile"
           (id, "userId", "tenantId", "agentCode", status, "canClaimLeads", "maxActiveLeads", "commissionPercent", permissions, "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, 'ACTIVE', true, $5, $6, $7, NOW(), NOW())`,
          [
            profileId,
            userId,
            tenantId,
            agentCode,
            u.role === 'MANAGER' ? 30 : 15,
            u.role === 'MANAGER' ? 25 : 20,
            JSON.stringify(u.role === 'MANAGER' ? {
              leadsView: true,
              leadsManage: true,
              teamView: true,
              teamManage: true,
              reportsView: true,
              recordingsListen: true,
              recordingsExport: true,
              phoneMaskingToggle: true,
              broadcastSend: true,
            } : {})
          ]
        );
        console.log(`[PROFILE CREATED] ${u.role} profile linked (code: ${agentCode})`);
      } else if (existingProfile.rows.length > 0) {
        await pool.query(
          `UPDATE "SalesAgentProfile" 
           SET status = 'ACTIVE', "canClaimLeads" = true, "tenantId" = $1, "updatedAt" = NOW()
           WHERE "userId" = $2`,
          [tenantId, userId]
        );
        console.log(`[PROFILE VERIFIED ACTIVE] for ${u.email}`);
      }
    }
  }

  // Verification step: Query all 4 users from DB and verify password scrypt match
  console.log("\n=== VERIFYING CREDENTIAL HASHES FROM DATABASE ===");
  for (const u of usersToSeed) {
    const res = await pool.query(
      'SELECT email, phone, role, "tenantId", "passwordSalt", "passwordHash" FROM "AppAuthUser" WHERE lower(email) = lower($1)',
      [u.email]
    );
    const row = res.rows[0];
    const match = verifyPassword(u.password, row.passwordSalt, row.passwordHash);
    console.log(`User: ${row.email} | Role: ${row.role} | Tenant: ${row.tenantId} | Phone: ${row.phone} | Match: ${match ? '✅ VERIFIED' : '❌ FAILED'}`);
    if (!match) {
      throw new Error(`Verification failed for ${row.email}`);
    }
  }

  await pool.end();
  console.log("\n=== SEED & VERIFICATION COMPLETE: ALL 4 CREDENTIALS ACTIVE ===");
}

main().catch((err) => {
  console.error("Seed error:", err);
  pool.end();
  process.exit(1);
});
