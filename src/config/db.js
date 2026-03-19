const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

// Create or connect to a database file.
// Use RENDER_DISK_PATH for Render (if Disk is mounted), /tmp for Vercel, otherwise local.
const dbPath = process.env.RENDER_DISK_PATH
  ? path.join(process.env.RENDER_DISK_PATH, 'database.sqlite')
  : (process.env.VERCEL
      ? path.join(os.tmpdir(), 'database.sqlite')
      : path.join(__dirname, '../../database.sqlite'));

const db = new Database(dbPath);

module.exports = db;
