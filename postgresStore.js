const { Pool } = require('pg');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const STRUCTURED_TABLES = {
  User: 'users',
  Donation: 'donations',
  ConsumedPurchase: 'consumed_purchases',
  Coupon: 'coupons'
};
const SECRET_RE = /(token|secret|password|database_url|mongo_uri|accessToken|robloxAccessToken)/i;

function sanitizeDoc(doc = {}) {
  const copy = JSON.parse(JSON.stringify(doc));
  return copy;
}
function redactError(err) {
  return { message: err?.message || 'Database error', code: err?.code };
}
function getByPath(obj, path) { return String(path).split('.').reduce((v, k) => v == null ? undefined : v[k], obj); }
function setByPath(obj, path, value) { const keys = String(path).split('.'); let cur = obj; while (keys.length > 1) { const k = keys.shift(); cur[k] = cur[k] && typeof cur[k] === 'object' ? cur[k] : {}; cur = cur[k]; } cur[keys[0]] = value; }
function unsetByPath(obj, path) { const keys = String(path).split('.'); let cur = obj; while (keys.length > 1) { cur = cur?.[keys.shift()]; if (!cur) return; } delete cur[keys[0]]; }
function matchesValue(actual, expected) {
  if (expected instanceof RegExp) return expected.test(String(actual || ''));
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if ('$in' in expected) return expected.$in.map(String).includes(String(actual));
    if ('$ne' in expected) return String(actual) !== String(expected.$ne);
    if ('$gt' in expected) return Number(actual || 0) > Number(expected.$gt);
    if ('$gte' in expected) return String(actual || '') >= String(expected.$gte);
    if ('$exists' in expected) return expected.$exists ? actual !== undefined : actual === undefined;
  }
  return String(actual) === String(expected);
}
function matches(doc, query = {}) {
  return Object.entries(query || {}).every(([key, expected]) => {
    if (key === '$or') return expected.some(q => matches(doc, q));
    if (key === '$and') return expected.every(q => matches(doc, q));
    if (key === '_id') return matchesValue(doc._id, expected);
    return matchesValue(getByPath(doc, key), expected);
  });
}
function applyUpdate(doc, update = {}) {
  if (update.$set || update.$inc || update.$unset || update.$addToSet || update.$pull || update.$setOnInsert) {
    for (const [k, v] of Object.entries(update.$setOnInsert || {})) if (getByPath(doc, k) === undefined) setByPath(doc, k, v);
    for (const [k, v] of Object.entries(update.$set || {})) setByPath(doc, k, v);
    for (const [k, v] of Object.entries(update.$inc || {})) setByPath(doc, k, Number(getByPath(doc, k) || 0) + Number(v || 0));
    for (const k of Object.keys(update.$unset || {})) unsetByPath(doc, k);
    for (const [k, v] of Object.entries(update.$addToSet || {})) { const arr = getByPath(doc, k) || []; if (!arr.includes(v)) arr.push(v); setByPath(doc, k, arr); }
    for (const [k, v] of Object.entries(update.$pull || {})) { const arr = getByPath(doc, k) || []; setByPath(doc, k, arr.filter(item => !matchesValue(item?.id || item, v?.id || v))); }
  } else {
    Object.assign(doc, update);
  }
  return doc;
}

class PgDoc {
  constructor(model, data) { Object.assign(this, data); Object.defineProperty(this, '__model', { value: model, enumerable: false }); }
  set(path, value) { setByPath(this, path, value); }
  async save() { await this.__model.upsert(this); return this; }
  async deleteOne() { await this.__model.deleteById(this._id); }
}
class Query {
  constructor(promise, single = false) { this.promise = promise; this.ops = []; this.single = single; }
  select() { return this; }
  lean() { this.asLean = true; return this; }
  sort(spec) { this.ops.push(['sort', spec]); return this; }
  limit(n) { this.ops.push(['limit', n]); return this; }
  then(r, j) { return this.promise.then(rows => { let out = this.single ? (rows ? [rows] : []) : rows; for (const [op, arg] of this.ops) { if (op === 'sort') { const [[k, dir]] = Object.entries(arg); out = [...out].sort((a,b)=>(Number(getByPath(b,k)||0)-Number(getByPath(a,k)||0)) * (dir < 0 ? 1 : -1)); } if (op === 'limit') out = out.slice(0, arg); } const val = this.single ? (out[0] || null) : out; return this.asLean ? JSON.parse(JSON.stringify(val)) : val; }).then(r, j); }
  catch(j) { return this.then(v => v, j); }
}
class PgJsonModel {
  constructor(pool, name) { this.pool = pool; this.name = name; this.table = STRUCTURED_TABLES[name]; }
  wrap(row) { return row ? new PgDoc(this, row.data) : null; }
  async all() { const r = await this.pool.query(`select data from ${this.table}`); return r.rows.map(x => this.wrap(x)); }
  find(query = {}) { return new Query(this.all().then(rows => rows.filter(d => matches(d, query)))); }
  findById(id) { return new Query(this.pool.query(`select data from ${this.table} where id=$1`, [String(id)]).then(r => this.wrap(r.rows[0])), true); }
  findOne(query = {}) { return new Query(this.all().then(rows => rows.find(d => matches(d, query)) || null), true); }
  async findByIdAndUpdate(id, update, opts = {}) { const doc = (await this.findById(id)) || new PgDoc(this, { _id: String(id) }); applyUpdate(doc, update); await this.upsert(doc); return opts.new ? doc : doc; }
  async findOneAndUpdate(query, update, opts = {}) { let doc = await this.findOne(query); if (!doc && opts.upsert) doc = new PgDoc(this, { _id: query._id || crypto.randomUUID?.() || String(Date.now()) }); if (!doc) return null; applyUpdate(doc, update); await this.upsert(doc); return doc; }
  async create(doc) { const wrapped = new PgDoc(this, doc); await this.upsert(wrapped); return wrapped; }
  async upsert(doc) { const data = sanitizeDoc(doc); if (!data._id) data._id = data.id || `${this.name.toLowerCase()}_${Date.now()}`; await this.pool.query(`insert into ${this.table}(id,data,updated_at) values($1,$2,now()) on conflict(id) do update set data=excluded.data, updated_at=now()`, [String(data._id), data]); }
  async updateMany(query, update) { const rows = (await this.all()).filter(d => matches(d, query)); for (const doc of rows) { applyUpdate(doc, update); await this.upsert(doc); } return { modifiedCount: rows.length }; }
  async deleteById(id) { await this.pool.query(`delete from ${this.table} where id=$1`, [String(id)]); }
  async countDocuments(query = {}) { return (await this.all()).filter(d => matches(d, query)).length; }
  aggregate(pipeline = []) { return Promise.resolve(this.all().then(rows => aggregateRows(rows, pipeline))); }
}
function aggregateRows(rows, pipeline) {
  let out = rows.map(r => JSON.parse(JSON.stringify(r)));
  for (const stage of pipeline) {
    if (stage.$match) out = out.filter(d => matches(d, stage.$match));
    if (stage.$group) { const idExpr = stage.$group._id; const keyPath = String(idExpr).replace(/^\$/, ''); const map = new Map(); for (const d of out) { const key = getByPath(d, keyPath); const cur = map.get(key) || { _id: key }; for (const [field, spec] of Object.entries(stage.$group)) if (field !== '_id' && spec.$sum) cur[field] = Number(cur[field] || 0) + Number(getByPath(d, String(spec.$sum).replace(/^\$/, '')) || 0); map.set(key, cur); } out = [...map.values()]; }
    if (stage.$sort) { const [[k, dir]] = Object.entries(stage.$sort); out.sort((a,b)=>(Number(b[k]||0)-Number(a[k]||0)) * (dir < 0 ? 1 : -1)); }
    if (stage.$limit) out = out.slice(0, stage.$limit);
  }
  return out;
}
async function initPostgres(logger = console) {
  if (!process.env.DATABASE_URL) return null;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.PGPOOL_MAX || 10), idleTimeoutMillis: 30000, connectionTimeoutMillis: 8000, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false } });
  pool.on('error', err => logger.error?.('PostgreSQL pool error', redactError(err)));
  await pool.query(`
    create table if not exists users (id text primary key, data jsonb not null default '{}'::jsonb, created_at timestamptz default now(), updated_at timestamptz default now());
    create table if not exists donations (id text primary key, data jsonb not null default '{}'::jsonb, created_at timestamptz default now(), updated_at timestamptz default now());
    create table if not exists consumed_purchases (id text primary key, data jsonb not null default '{}'::jsonb, created_at timestamptz default now(), updated_at timestamptz default now());
    create table if not exists coupons (id text primary key, data jsonb not null default '{}'::jsonb, created_at timestamptz default now(), updated_at timestamptz default now());
    create index if not exists users_roblox_id_idx on users ((data->>'robloxId'));
    create index if not exists users_roblox_username_idx on users (lower(data->>'robloxUsername'));
    create index if not exists users_discord_id_idx on users ((data#>>'{discord,id}'));
    create index if not exists donations_donor_idx on donations ((data->>'donorId'));
    create index if not exists donations_receiver_idx on donations ((data->>'receiverId'));
    create index if not exists donations_verified_idx on donations ((data->>'verified'));
    create unique index if not exists coupons_code_idx on coupons ((data->>'code'));
  `);
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY) createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
  return { pool, User: new PgJsonModel(pool, 'User'), Donation: new PgJsonModel(pool, 'Donation'), ConsumedPurchase: new PgJsonModel(pool, 'ConsumedPurchase'), Coupon: new PgJsonModel(pool, 'Coupon') };
}
async function migrateMongoToPostgres(models, pg, logger = console) {
  if (!pg) return;
  for (const name of Object.keys(STRUCTURED_TABLES)) {
    const model = models[name]; if (!model) continue;
    const rows = await model.find({}).lean();
    for (const row of rows) await pg[name].upsert(row);
    logger.info?.(`Migrated ${rows.length} ${name} records to PostgreSQL without deleting MongoDB data.`);
  }
}
module.exports = { initPostgres, migrateMongoToPostgres, STRUCTURED_TABLES, redactError };
