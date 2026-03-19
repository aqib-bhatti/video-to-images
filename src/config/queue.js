const { Queue } = require('bullmq');
const IORedis = require('ioredis');
require('dotenv').config();

// Sanitize REDIS_URL (remove quotes if present)
let redisUrl = process.env.REDIS_URL;
if (redisUrl && (redisUrl.startsWith('"') || redisUrl.startsWith("'"))) {
  redisUrl = redisUrl.substring(1, redisUrl.length - 1);
}

// More robust IORedis connection for Upstash
const redisConnection = redisUrl ? new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  tls: redisUrl.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
}) : new IORedis({
  host: '127.0.0.1',
  port: 6379,
  maxRetriesPerRequest: null,
});

const queueOptions = {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false
  }
};

const videoProcessingQueue = new Queue('video-processing', queueOptions);

videoProcessingQueue.on('error', (err) => {
  console.error('❌ Redis Queue Error:', err.message);
});

redisConnection.on('connect', () => {
  console.log('✅ [Redis] Connection established.');
});

redisConnection.on('error', (err) => {
  console.error('❌ [Redis] Error:', err.message);
});

console.log(redisUrl ? '✅ [Redis] Using Upstash Cloud' : '⚠️ [Redis] Using Localhost');

module.exports = {
  videoProcessingQueue,
  redisConnection,
};
