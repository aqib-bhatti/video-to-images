
require('dotenv').config();
const express = require('express');
const path = require('path');
const videoRoutes = require('../src/routes/video.routes');
const setupDatabase = require('../src/db/setup');

// Setup database on start
setupDatabase();

// Start the worker
require('./src/workers/video.worker');

const app = express();
const port = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Fallback route to serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use('/api/v1/video', videoRoutes);

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
