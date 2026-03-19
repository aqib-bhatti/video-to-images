const { Queue } = require('bullmq');

// Render/Production mein REDIS_URL environment variable lazmi hona chahiye (Upstash Redis)
const redisUrl = process.env.REDIS_URL;

const redisConnection = redisUrl ? redisUrl : {
  host: 'localhost',
  port: 6379,
};

if (!redisUrl && process.env.NODE_ENV === 'production') {
  console.warn('⚠️ WARNING: REDIS_URL is not set in production environment!');
}

const videoProcessingQueue = new Queue('video-processing', { 
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false
  }
});

module.exports = {
  videoProcessingQueue,
  redisConnection,
};
