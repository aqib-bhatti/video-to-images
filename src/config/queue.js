const { Queue } = require('bullmq');

const redisConnection = {
  host: 'localhost',
  port: 6379,
};

const videoProcessingQueue = new Queue('video-processing', { connection: redisConnection });

module.exports = {
  videoProcessingQueue,
  redisConnection,
};
