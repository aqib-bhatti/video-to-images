const { Queue } = require('bullmq');
const { redisUrl, connectionOptions } = require('./redis');

const videoProcessingQueue = new Queue('video-processing', {
  connection: redisUrl || connectionOptions,
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

module.exports = {
  videoProcessingQueue,
};
