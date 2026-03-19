const { Queue } = require('bullmq');

// Upstash Redis URL configuration
let redisUrl = process.env.REDIS_URL;

// Agar user ne REST_URL aur TOKEN diya hai, to hum URL construct kar sakte hain (lekin rediss:// behtar hai)
if (!redisUrl && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  const host = process.env.UPSTASH_REDIS_REST_URL.replace('https://', '');
  const password = process.env.UPSTASH_REDIS_REST_TOKEN;
  redisUrl = `rediss://default:${password}@${host}:6379`;
}

const redisConnection = redisUrl ? redisUrl : {
  host: '127.0.0.1',
  port: 6379,
};

// Debugging
if (redisUrl) {
  console.log('✅ Connecting to Redis via URL');
} else {
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
