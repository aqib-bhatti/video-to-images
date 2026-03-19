const Redis = require('ioredis');
const { URL } = require('url');

let redisUrl = process.env.REDIS_URL;
if (redisUrl && (redisUrl.startsWith('"') || redisUrl.startsWith("'"))) {
  redisUrl = redisUrl.substring(1, redisUrl.length - 1);
}

// Parse Redis URL for BullMQ compatibility
let parsedRedis = {};
if (redisUrl) {
  try {
    const url = new URL(redisUrl);
    parsedRedis = {
      host: url.hostname,
      port: url.port ? parseInt(url.port) : (url.protocol === 'rediss:' ? 6380 : 6379),
      username: url.username || undefined,
      password: url.password || undefined,
    };
    if (url.protocol === 'rediss:') {
      parsedRedis.tls = { rejectUnauthorized: false };
    }
  } catch (e) {
    console.error('❌ Failed to parse REDIS_URL:', e.message);
  }
}

const commonConfig = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  keepAlive: 10000,
  retryStrategy: (times) => Math.min(times * 50, 2000)
};

const connectionOptions = {
  ...commonConfig,
  ...parsedRedis
};

const createConnection = () => {
  return new Redis(redisUrl || connectionOptions, commonConfig);
};

const subscriber = new Redis(redisUrl || connectionOptions, commonConfig);
const client = new Redis(redisUrl || connectionOptions, commonConfig);

subscriber.on('connect', () => console.log('✅ [Redis Subscriber] Connected'));
subscriber.on('error', (err) => console.error('❌ [Redis Subscriber] Error:', err.message));

client.on('connect', () => console.log('✅ [Redis Client] Connected'));
client.on('error', (err) => console.error('❌ [Redis Client] Error:', err.message));

console.log(redisUrl ? '✅ [Redis] Configured for Upstash Cloud' : '⚠️ [Redis] Configured for Localhost');

module.exports = {
  subscriber,
  client,
  connectionOptions,
  redisUrl,
  createConnection
};
