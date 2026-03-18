const { Queue } = require('bullmq');

// Use Upstash Redis URL from environment variables for Vercel, or fallback to local Redis
const redisConnection = process.env.REDIS_URL || {
  host: 'localhost',
  port: 6379,
};

const videoProcessingQueue = new Queue('video-processing', { connection: redisConnection });

module.exports = {
  videoProcessingQueue,
  redisConnection,
};
