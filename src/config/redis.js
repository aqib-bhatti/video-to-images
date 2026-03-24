const Redis = require('ioredis');

let redisUrl = process.env.REDIS_URL;
if (redisUrl && (redisUrl.startsWith('"') || redisUrl.startsWith("'"))) {
  redisUrl = redisUrl.substring(1, redisUrl.length - 1);
}

const redisIsAvailable = !!redisUrl;

if (!redisIsAvailable) {
  console.warn('\n⚠️  REDIS_URL is not set in your environment. Background processing features will be disabled.\n');
}

const commonConfig = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  keepAlive: 10000,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  }
};

const tlsConfig = redisUrl ? { tls: { rejectUnauthorized: false } } : {};

const connectionOptions = {
  ...commonConfig,
  ...tlsConfig,
};

const createConnection = () => {
  if (!redisIsAvailable) return null;
  return new Redis(redisUrl, connectionOptions);
};

const subscriber = createConnection();
const client = createConnection();

if (subscriber) {
  subscriber.on('connect', () => console.log('✅ [Redis Subscriber] Connected'));
  subscriber.on('error', (err) => console.error('❌ [Redis Subscriber] Error:', err.message));
}

if (client) {
  client.on('connect', () => console.log('✅ [Redis Client] Connected'));
  client.on('error', (err) => console.error('❌ [Redis Client] Error:', err.message));
}

if (redisIsAvailable) {
    console.log('✅ [Redis] Configured for Cloud connection.');
}

module.exports = {
  subscriber,
  client,
  connectionOptions,
  redisUrl,
  createConnection,
  redisIsAvailable
};