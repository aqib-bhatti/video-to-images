const { Queue } = require('bullmq');
const { createConnection, redisIsAvailable } = require('./redis');

let videoProcessingQueue = null;

if (redisIsAvailable) {
  videoProcessingQueue = new Queue('video-processing', {
    connection: createConnection(),
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: true,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
    },
  });
  
  videoProcessingQueue.on('error', (err) => {
      console.error('❌ Redis Queue Error:', err.message);
  });
}

module.exports = videoProcessingQueue;