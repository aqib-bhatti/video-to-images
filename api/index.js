
require('dotenv').config();
const express = require('express');
const path = require('path');
const videoRoutes = require('../src/routes/video.routes');
const setupDatabase = require('../src/db/setup');

// Setup database on start
setupDatabase();

// Start the worker
require('../src/workers/video.worker');

const app = express();
const port = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Disable body parsing for the specific upload route to enable streaming
app.use((req, res, next) => {
  if (req.path.includes('/extract-frames')) {
    return next();
  }
  return express.json()(req, res, next);
});

// Serve frontend files from the root 'public' directory
app.use(express.static(path.join(__dirname, '../public')));

// Fallback route to serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

app.use('/api/v1/video', videoRoutes);

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
