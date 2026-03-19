const { Queue } = require('bullmq');
const IORedis = require('ioredis');

// Upstash Redis URL configuration
const redisUrl = process.env.REDIS_URL;

let redisConnection;

if (redisUrl) {
  // Use IORedis for better URL parsing and TLS support (Upstash requirement)
  redisConnection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
  });
  console.log('✅ Redis Connection initialized via URL');
} else {
  redisConnection = {
    host: '127.0.0.1',
    port: 6379,
    maxRetriesPerRequest: null,
  };
  console.log('⚠️ No REDIS_URL found, using localhost:6379');
}

const videoProcessingQueue = new Queue('video-processing', { 
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false
  }
});

// Event listeners for connection status
videoProcessingQueue.on('error', (err) => {
  console.error('❌ Redis Queue Error:', err.message);
});

module.exports = {
  videoProcessingQueue,
  redisConnection,
};
