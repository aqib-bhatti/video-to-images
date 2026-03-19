const { Queue } = require('bullmq');
require('dotenv').config();

// Sanitize REDIS_URL (remove quotes if present)
let redisUrl = process.env.REDIS_URL;
if (redisUrl && (redisUrl.startsWith('"') || redisUrl.startsWith("'"))) {
  redisUrl = redisUrl.substring(1, redisUrl.length - 1);
}

// Connection options for Upstash
const connectionOptions = redisUrl ? {
  url: redisUrl,
  tls: redisUrl.startsWith('rediss://') ? {} : undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
} : {
  host: '127.0.0.1',
  port: 6379
};

const queueOptions = {
  connection: connectionOptions,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false
  }
};

const redisConnection = connectionOptions;

const videoProcessingQueue = new Queue('video-processing', queueOptions);

videoProcessingQueue.on('error', (err) => {
  console.error('❌ Redis Queue Error:', err.message);
});

console.log(redisUrl ? '✅ [Redis] Configured for Upstash Cloud' : '⚠️ [Redis] Configured for Localhost');

module.exports = {
  videoProcessingQueue,
  redisConnection,
};
