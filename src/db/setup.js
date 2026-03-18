const db = require('../config/db');

function setupDatabase() {
  const createTableStmt = db.prepare(`
    CREATE TABLE IF NOT EXISTS jobs (
      jobId TEXT PRIMARY KEY,
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

  // Check if webhookUrl column exists, if not, add it (Migration)
  const tableInfo = db.prepare("PRAGMA table_info(jobs)").all();
  const hasWebhookUrl = tableInfo.some(column => column.name === 'webhookUrl');
  
  if (!hasWebhookUrl) {
    try {
      db.prepare("ALTER TABLE jobs ADD COLUMN webhookUrl TEXT").run();
      console.log("Database updated: 'webhookUrl' column added.");
    } catch (err) {
      console.error("Failed to add webhookUrl column:", err.message);
    }
  }

  console.log("Database setup complete. 'jobs' table is ready.");
}

module.exports = setupDatabase;
