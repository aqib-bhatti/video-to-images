const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

// Create or connect to a database file.
// Use /tmp directory for Vercel, otherwise use local project directory.
const dbPath = process.env.VERCEL
  ? path.join(os.tmpdir(), 'database.sqlite')
  : path.join(__dirname, '../../database.sqlite');

const db = new Database(dbPath);

module.exports = db;
