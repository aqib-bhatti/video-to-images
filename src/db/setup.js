const db = require('../config/db');

function setupDatabase() {
  const createTableStmt = db.prepare(`
    CREATE TABLE IF NOT EXISTS jobs (
      jobId TEXT PRIMARY KEY,
      userId TEXT,
      videoUrl TEXT,
      fps INTEGER,
      status TEXT,
      createdAt TEXT,
      startedAt TEXT,
      completedAt TEXT,
      failedAt TEXT,
      error TEXT,
      frames TEXT,
      webhookUrl TEXT
    )
  `);
  createTableStmt.run();

  // Migration: Add columns if they don't exist
  const tableInfo = db.prepare("PRAGMA table_info(jobs)").all();
  const columns = tableInfo.map(c => c.name);

  if (!columns.includes('webhookUrl')) {
    try {
      db.prepare("ALTER TABLE jobs ADD COLUMN webhookUrl TEXT").run();
      console.log("Database updated: 'webhookUrl' column added.");
    } catch (err) {
      console.error("Failed to add webhookUrl column:", err.message);
    }
  }

  if (!columns.includes('userId')) {
    try {
      db.prepare("ALTER TABLE jobs ADD COLUMN userId TEXT").run();
      console.log("Database updated: 'userId' column added.");
    } catch (err) {
      console.error("Failed to add userId column:", err.message);
    }
  }

  console.log("Database setup complete. 'jobs' table is ready.");
}

module.exports = setupDatabase;
