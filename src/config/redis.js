const Redis = require('ioredis');

let redisUrl = process.env.REDIS_URL;
if (redisUrl && (redisUrl.startsWith('"') || redisUrl.startsWith("'"))) {
  redisUrl = redisUrl.substring(1, redisUrl.length - 1);
}

const commonConfig = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  keepAlive: 10000, // Connection ko zinda rakhne ke liye
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay; // Connection toote to foran reconnect kare
  }
};

const tlsConfig = redisUrl ? { tls: { rejectUnauthorized: false } } : {};

const connectionOptions = {
  ...commonConfig,
  ...tlsConfig,
};

// Helper function for BullMQ to create a new connection
const createConnection = () => {
  if (redisUrl) {
    return new Redis(redisUrl, connectionOptions);
  }
  return new Redis(connectionOptions);
};

const subscriber = createConnection();
const client = createConnection();

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
