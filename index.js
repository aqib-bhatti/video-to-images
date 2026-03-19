
require('dotenv').config();
const express = require('express');
const path = require('path');
const videoRoutes = require('./src/routes/video.routes');
const setupDatabase = require('./src/db/setup');
const { WebSocketServer } = require('ws');

// Setup database on start
setupDatabase();

// Start the worker (Original flow)
require('./src/workers/video.worker');

const app = express();
const port = process.env.PORT || 3000;
const host = '0.0.0.0';

// Disable body parsing for large multipart uploads to enable streaming
app.use((req, res, next) => {
  if (req.path.includes('/extract-frames') && req.headers['content-type']?.includes('multipart/form-data')) {
    return next();
  }
  return express.json()(req, res, next);
});

app.use(express.urlencoded({ extended: true }));

// Serve frontend files from the root 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Fallback route to serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use('/api/v1/video', videoRoutes);

// Export the app for Vercel
module.exports = app;

// Only listen if not running on Vercel
if (!process.env.VERCEL) {
  const server = app.listen(port, host, () => {
    console.log(`Server is running on port: ${port}`);
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    console.log('✅ Client connected to WebSocket');
    ws.on('close', () => console.log('❌ Client disconnected'));
  });

  app.set('wss', wss);
}
