
require('dotenv').config();
const express = require('express');
const path = require('path');
const videoRoutes = require('./src/routes/video.routes');
const setupDatabase = require('./src/db/setup');

// Setup database on start
setupDatabase();

// Start the worker
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

// Start the server
app.listen(port, host, () => {
  console.log(`Server is running on port ${port}`);
});
