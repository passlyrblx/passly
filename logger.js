const winston = require('winston');
const path = require('path');

// Ensure logs directory exists (optional, create manually or let winston create)
const logDir = path.join(__dirname, 'logs');
try {
  if (!require('fs').existsSync(logDir)) {
    require('fs').mkdirSync(logDir);
  }
} catch(e) {}

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'passly-api' },
  transports: [
    new winston.transports.File({ filename: path.join(logDir, 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(logDir, 'combined.log') }),
  ]
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

// Stream for Morgan HTTP logger
const morganStream = {
  write: (message) => logger.info(message.trim())
};

module.exports = { logger, morganStream };