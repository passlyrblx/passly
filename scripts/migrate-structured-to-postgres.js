const mongoose = require('mongoose');
const { initPostgres, migrateMongoToPostgres, redactError } = require('../postgresStore');

const MONGO_URI = process.env.mongo_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/passly';

const userSchema = new mongoose.Schema({}, { strict: false });
const donationSchema = new mongoose.Schema({}, { strict: false });
const consumedPurchaseSchema = new mongoose.Schema({}, { strict: false });
const couponSchema = new mongoose.Schema({}, { strict: false });

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL migration.');
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000, socketTimeoutMS: 20000 });
  const models = {
    User: mongoose.models.User || mongoose.model('User', userSchema),
    Donation: mongoose.models.Donation || mongoose.model('Donation', donationSchema),
    ConsumedPurchase: mongoose.models.ConsumedPurchase || mongoose.model('ConsumedPurchase', consumedPurchaseSchema),
    Coupon: mongoose.models.Coupon || mongoose.model('Coupon', couponSchema)
  };
  const pg = await initPostgres(console);
  await migrateMongoToPostgres(models, pg, console);
  await mongoose.disconnect();
  await pg.pool.end();
}

main().catch(err => {
  console.error('Structured PostgreSQL migration failed', redactError(err));
  process.exit(1);
});
