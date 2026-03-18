const Database = require('better-sqlite3');
const path = require('path');

// Create or connect to a local SQLite database file
const dbPath = path.join(__dirname, '../../database.sqlite');
const db = new Database(dbPath);

module.exports = db;
