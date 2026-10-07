const { Pool } = require('pg');
const pool = new Pool({ host: '127.0.0.1', port: 5432, database: 'aicloser', user: 'aicloser_user', password: 'AIcloser@12345' });

async function check() {
  const migs = await pool.query('SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name');
  console.log('Total migrations in DB:', migs.rows.length);
  for (const r of migs.rows) {
    console.log(`- ${r.migration_name} (finished: ${Boolean(r.finished_at)}, rolled_back: ${Boolean(r.rolled_back_at)})`);
  }
}

check().finally(() => pool.end());
