/**
 * Database connection pool + schema setup.
 *
 * Two lessons baked in here from hard-won experience building the Python
 * version of this same backend:
 *
 * 1. SSL must be configured in code, not as a query-string parameter on
 *    the connection URL. Different MySQL drivers expect different SSL
 *    parameter names/shapes (some want `ssl_mode=REQUIRED`, others want a
 *    boolean, others want an object) and a URL string can't express most
 *    of them correctly. Configuring it explicitly here avoids that whole
 *    category of "unexpected keyword argument" style failures.
 *
 * 2. `timezone: 'Z'` tells mysql2 to treat all DATETIME values as UTC,
 *    both when writing and reading. Without this, the driver assumes the
 *    *server's local* timezone, which silently corrupts every timestamp
 *    by however many hours your timezone differs from UTC -- exactly the
 *    bug that had to be chased down and fixed on the Flutter side last
 *    time. Setting this here means the Node/Express side never produces
 *    that bug in the first place.
 */

const mysql = require('mysql2/promise');

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error(
    'DATABASE_URL is not set. Put it in your .env file locally, or in ' +
      'your Render service\'s Environment settings in production.'
  );
  process.exit(1);
}

// Parse user/password/host/port/database out of a standard
// mysql://user:pass@host:port/dbname connection string.
const parsed = new URL(DATABASE_URL);

const useSsl = process.env.DATABASE_SSL !== 'false';

const pool = mysql.createPool({
  host: parsed.hostname,
  port: parsed.port ? Number(parsed.port) : 3306,
  user: decodeURIComponent(parsed.username),
  password: decodeURIComponent(parsed.password),
  database: parsed.pathname.replace(/^\//, ''),
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  timezone: 'Z',
  // Encrypts the connection but doesn't verify the server's certificate
  // chain -- equivalent to other clients' "REQUIRED" SSL mode (encrypted,
  // not strictly CA-verified). Hosted providers like Aiven require this;
  // a bare local MySQL/MariaDB usually doesn't support it at all, so set
  // DATABASE_SSL=false in your local .env if you're testing against one.
  ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

async function initDb() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS qr_codes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        qr_type VARCHAR(10) NOT NULL DEFAULT 'dynamic',
        short_code VARCHAR(32) UNIQUE,
        title VARCHAR(255) NOT NULL,
        content_type VARCHAR(20) NOT NULL DEFAULT 'website',
        destination_url TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        expires_at DATETIME NULL,
        password_hash VARCHAR(255) NULL,
        android_url TEXT NULL,
        ios_url TEXT NULL,
        desktop_url TEXT NULL,
        owner_id VARCHAR(64) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_short_code (short_code),
        INDEX idx_owner_id (owner_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // CREATE TABLE IF NOT EXISTS is a no-op if the table is already there
    // from before this change, so the new column needs adding separately.
    // Ignoring "duplicate column" lets this run safely on every startup.
    try {
      await conn.query(`ALTER TABLE qr_codes ADD COLUMN owner_id VARCHAR(64) NULL, ADD INDEX idx_owner_id (owner_id)`);
      console.log('Migrated: added owner_id column to qr_codes');
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }

    await conn.query(`
      CREATE TABLE IF NOT EXISTS scan_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        qr_id INT NOT NULL,
        scanned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ip_address VARCHAR(64) NULL,
        device_type VARCHAR(20) NULL,
        os_name VARCHAR(50) NULL,
        browser VARCHAR(50) NULL,
        country VARCHAR(100) NULL,
        city VARCHAR(100) NULL,
        referrer VARCHAR(255) NULL,
        INDEX idx_qr_id (qr_id),
        INDEX idx_scanned_at (scanned_at),
        CONSTRAINT fk_scan_qr FOREIGN KEY (qr_id) REFERENCES qr_codes(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  } finally {
    conn.release();
  }
}

module.exports = { pool, initDb };
