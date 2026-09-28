process.env.DATABASE_URL ??= 'postgresql://loanbot:loanbot@localhost:5432/loanbot_test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.SESSION_HMAC_SECRET ??= 'test-secret-at-least-16-chars';
process.env.PII_ENCRYPTION_KEY ??= 'test-encryption-key-32-bytes-min';
