const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const mongoose = require('mongoose');
const morgan = require('morgan');
const winston = require('winston');
const rateLimit = require('express-rate-limit');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});
if (process.env.NODE_ENV !== 'production') logger.add(new winston.transports.Console({ format: winston.format.simple() }));

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'passly-jwt-secret-2024';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/passly';
const VIP_GAMEPASS_ID = '1859054633';
mongoose.set('bufferCommands', false);

// Fallback default rooms
const FALLBACK_ROOMS = [
  { _id: "room1", name: "Chill Donations", desc: "Relax and donate to small creators.", type: "Public", players: [], queue: [], maxPlayers: 18, createdBy: "system" },
  { _id: "room2", name: "Big Donators", desc: "High donation rooms with active players.", type: "Public", players: [], queue: [], maxPlayers: 18, createdBy: "system" },
  { _id: "room3", name: "Anime Fans", desc: "A room for anime lovers.", type: "Public", players: [], queue: [], maxPlayers: 18, createdBy: "system" }
];

const userSchema = new mongoose.Schema({
  _id: String, robloxUsername: String, robloxDisplayName: String,
  customDisplayName: String, avatarUrl: String,
  robloxAccessToken: String,
  role: { type: String, default: 'user', enum: ['guest', 'user', 'vip', 'admin', 'owner'] },
  isGuest: { type: Boolean, default: false },
  profile: { showBooth: { type: Boolean, default: true }, statusDot: { type: String, default: 'online' }, showRoomId: { type: Boolean, default: true }, displayTag: { type: String, default: null } },
  notificationPreferences: { offlineDonations: { type: Boolean, default: true }, friendRequests: { type: Boolean, default: true }, friendMessages: { type: Boolean, default: true }, friendAccepted: { type: Boolean, default: true } },
  roomId: String, inQueue: Boolean,
  donations: { received: Number, given: Number },
  coins: { type: Number, default: 0, min: 0 },
  totalCoins: { type: Number, default: 0, min: 0 },
  lastClaimDate: { type: String, default: '' },
  streakDay: { type: Number, default: 0, min: 0 },
  dailyReward: { streak: { type: Number, default: 0 }, lastClaimDate: { type: String, default: '' }, totalClaims: { type: Number, default: 0 } },
  adWatchCountToday: { type: Number, default: 0, min: 0 },
  lastAdWatchTime: { type: Date, default: null },
  adWatchDate: { type: String, default: '' },
  adReward: {
    pendingToken: { type: String, default: '' },
    startedAt: { type: Date, default: null },
    verifyAfter: { type: Date, default: null },
    expiresAt: { type: Date, default: null }
  },
  booth: { activeTheme: { type: String, default: 'default' }, ownedThemes: { type: [String], default: ['default'] } },
  board: [{ id: String, name: String, price: Number }],
  acceptedTos: { type: Boolean, default: false },
  acceptedTosAt: Date,
  lastSeen: { type: Date, default: Date.now },
  roomCreationCounts: {
    public: { count: Number, date: String },
    private: { count: Number, date: String }
  },
  createdAt: { type: Date, default: Date.now }
});

const TAG_LABELS = { owner: 'Owner', admin: 'Admin', vip: 'VIP' };
function effectiveRoleFor(user) {
  if (!user) return 'user';
  if (String(user._id) === OWNER_ROBLOX_ID || user.role === 'owner') return 'owner';
  return user.role || 'user';
}
function getAvailableTags(user) {
  const role = effectiveRoleFor(user);
  if (role === 'owner') return ['owner', 'admin', 'vip'];
  if (role === 'admin') return ['admin', 'vip'];
  if (role === 'vip') return ['vip'];
  return [];
}
function getPublicTag(user) {
  const availableTags = getAvailableTags(user);
  const selectedTag = String(user?.profile?.displayTag || '').toLowerCase();
  return availableTags.includes(selectedTag) ? selectedTag : (availableTags[0] || null);
}
function serializeTag(tag) {
  return tag ? { key: tag, label: TAG_LABELS[tag] || tag.toUpperCase() } : null;
}
function isGuestRecord(user) {
  return !!(user?.isGuest || user?.role === 'guest' || /^Guest_/i.test(user?.robloxUsername || '') || /^Guest_/i.test(user?.customDisplayName || ''));
}
function serializeUserTags(user) {
  const availableTags = getAvailableTags(user);
  const publicTag = getPublicTag(user);
  return {
    availableTags: availableTags.map(serializeTag),
    displayTag: serializeTag(publicTag)
  };
}

const roomSchema = new mongoose.Schema({
  _id: String, name: String, desc: String, type: { type: String, enum: ['Public', 'Private', 'VIP'] },
  players: [String], queue: [String], maxPlayers: { type: Number, default: 18 },
  createdBy: String, createdAt: { type: Date, default: Date.now }
});
const donationSchema = new mongoose.Schema({
  _id: String, donorId: String, donorName: String, receiverId: String,
  receiverName: String, gamepassId: String, amount: Number,
  roomId: String, verified: { type: Boolean, default: true },
  coinRewards: { donor: { type: Number, default: 0 }, receiver: { type: Number, default: 0 } },
  consumedPurchaseKey: String,
  timestamp: { type: Date, default: Date.now }
});

const consumedPurchaseSchema = new mongoose.Schema({
  _id: String,
  donorId: { type: String, index: true },
  gamepassId: { type: String, index: true },
  receiverId: String,
  amount: Number,
  donationId: String,
  consumedAt: { type: Date, default: Date.now }
});

const couponSchema = new mongoose.Schema({
  _id: String,
  code: { type: String, required: true, unique: true, index: true },
  passlyAmount: { type: Number, required: true, min: 1, max: 1000000 },
  createdBy: String,
  createdAt: { type: Date, default: Date.now },
  redeemedBy: { type: String, default: null, index: true },
  redeemedUsername: { type: String, default: null },
  redeemedAt: { type: Date, default: null }
});

const MONETAG_DIRECT_LINK = 'https://omg10.com/4/11105268';
const AD_REWARD_COINS = 3;
const AD_DAILY_LIMIT = 10;
const AD_VERIFY_DELAY_MS = 18000;
const AD_REWARD_COOLDOWN_MS = 30000;
const AD_PENDING_EXPIRY_MS = 5 * 60 * 1000;

const BOOTH_THEMES = [
  { id: 'neon', name: 'Neon', price: 100, tier: 'Starter', animated: false },
  { id: 'cyber', name: 'Cyber', price: 250, tier: 'Starter', animated: false },
  { id: 'galaxy', name: 'Galaxy', price: 500, tier: 'Rare', animated: false },
  { id: 'crystal', name: 'Crystal', price: 1000, tier: 'Rare', animated: true },
  { id: 'gold', name: 'Gold', price: 2500, tier: 'Epic', animated: true },
  { id: 'shadow', name: 'Shadow', price: 5000, tier: 'Epic', animated: true },
  { id: 'royal', name: 'Royal', price: 10000, tier: 'Legendary', animated: true },
  { id: 'energy', name: 'Energy', price: 25000, tier: 'Legendary', animated: true },
  { id: 'futuristic', name: 'Futuristic', price: 50000, tier: 'Mythic', animated: true },
  { id: 'mythic', name: 'Mythic', price: 100000, tier: 'Mythic', animated: true }
];
function getTodayKey(date = new Date()) { return date.toISOString().slice(0, 10); }
function getYesterdayKey() { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return getTodayKey(d); }
function parseStoredDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function getCoinBalance(user) {
  const storedTotal = Number(user?.totalCoins);
  const legacyCoins = Number(user?.coins);
  if (Number.isFinite(storedTotal) && storedTotal > 0) return Math.max(0, Math.floor(storedTotal));
  return Math.max(0, Math.floor(Number.isFinite(legacyCoins) ? legacyCoins : 0));
}
function getDailyRewardAmount(streak) {
  const day = Math.max(1, Number(streak) || 1);
  if (day >= 20 && day % 10 === 0) return Math.min(20, 8 + Math.floor(day / 10));
  if (day === 10) return 5;
  if (day <= 9) return 2;
  return 3;
}
function getRewardState(user) {
  const legacy = user?.dailyReward || {};
  const lastClaimDate = user?.lastClaimDate || legacy.lastClaimDate || '';
  const streak = Number(user?.streakDay || legacy.streak || 0);
  return { lastClaimDate, streak, totalClaims: Number(legacy.totalClaims || 0) };
}
function getAdRewardState(user, now = new Date()) {
  const today = getTodayKey(now);
  const count = user?.adWatchDate === today ? Number(user?.adWatchCountToday || 0) : 0;
  const lastTime = user?.lastAdWatchTime ? new Date(user.lastAdWatchTime) : null;
  const cooldownUntil = lastTime && now - lastTime < AD_REWARD_COOLDOWN_MS ? new Date(lastTime.getTime() + AD_REWARD_COOLDOWN_MS) : null;
  const pending = user?.adReward || {};
  const pendingActive = !!(pending.pendingToken && pending.expiresAt && new Date(pending.expiresAt) > now);
  return {
    rewardCoins: AD_REWARD_COINS,
    dailyLimit: AD_DAILY_LIMIT,
    watchedToday: count,
    remainingToday: Math.max(0, AD_DAILY_LIMIT - count),
    dailyLimitReached: count >= AD_DAILY_LIMIT,
    cooldownUntil: cooldownUntil ? cooldownUntil.toISOString() : null,
    cooldownSeconds: cooldownUntil ? Math.max(0, Math.ceil((cooldownUntil - now) / 1000)) : 0,
    canStart: count < AD_DAILY_LIMIT && !cooldownUntil && !pendingActive,
    pending: pendingActive ? {
      startedAt: pending.startedAt?.toISOString?.() || pending.startedAt,
      verifyAfter: pending.verifyAfter?.toISOString?.() || pending.verifyAfter,
      expiresAt: pending.expiresAt?.toISOString?.() || pending.expiresAt,
      verifySeconds: pending.verifyAfter ? Math.max(0, Math.ceil((new Date(pending.verifyAfter) - now) / 1000)) : 0
    } : null
  };
}
function serializeEconomy(user) {
  const reward = getRewardState(user);
  const now = new Date();
  const lastClaimAt = parseStoredDate(reward.lastClaimDate);
  const currentStreak = Number(reward.streak || 0);
  const claimedToday = !!(lastClaimAt && now - lastClaimAt < 24 * 60 * 60 * 1000);
  const keepsStreak = !!(lastClaimAt && now - lastClaimAt <= 48 * 60 * 60 * 1000);
  const nextStreak = claimedToday ? currentStreak : (keepsStreak ? currentStreak + 1 : 1);
  const balance = getCoinBalance(user);
  return {
    coins: balance,
    totalCoins: balance,
    dailyReward: {
      streak: currentStreak,
      streakDay: currentStreak,
      lastClaimDate: reward.lastClaimDate || '',
      nextClaimAt: lastClaimAt ? new Date(lastClaimAt.getTime() + 24 * 60 * 60 * 1000).toISOString() : null,
      claimedToday,
      nextReward: getDailyRewardAmount(nextStreak),
      nextStreak
    },
    adRewards: getAdRewardState(user),
    booth: { activeTheme: user?.booth?.activeTheme || 'default', ownedThemes: user?.booth?.ownedThemes || ['default'] }
  };
}
const adSchema = new mongoose.Schema({
  _id: String, userId: String, username: String, tier: Number,
  gamepassId: String, broadcastsLeft: Number, showsLeft: Number,
  active: Boolean, message: String, purchasedAt: { type: Date, default: Date.now }
});
const adBroadcastSchema = new mongoose.Schema({
  roomId: String, board: [mongoose.Schema.Types.Mixed],
  advertiserName: String, advertiserId: String, message: String,
  timestamp: { type: Date, default: Date.now }
});
const friendRequestSchema = new mongoose.Schema({
  _id: String,
  from: String,
  to: String,
  status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
  timestamp: { type: Date, default: Date.now }
});
const privateMessageSchema = new mongoose.Schema({
  _id: String,
  from: String,
  to: String,
  message: String,
  timestamp: { type: Date, default: Date.now },
  read: { type: Boolean, default: false }
});
const notificationSchema = new mongoose.Schema({
  _id: String,
  userId: String,
  type: { type: String, enum: ['friend_request', 'friend_accepted', 'new_message', 'offline_donation', 'admin_message'] },
  fromUserId: String,
  message: String,
  timestamp: { type: Date, default: Date.now },
  read: { type: Boolean, default: false }
});

const User = mongoose.models.User || mongoose.model('User', userSchema);
const RoomModel = mongoose.models.Room || mongoose.model('Room', roomSchema);
const Donation = mongoose.models.Donation || mongoose.model('Donation', donationSchema);
const ConsumedPurchase = mongoose.models.ConsumedPurchase || mongoose.model('ConsumedPurchase', consumedPurchaseSchema);
const Coupon = mongoose.models.Coupon || mongoose.model('Coupon', couponSchema);
const Ad = mongoose.models.Ad || mongoose.model('Ad', adSchema);
const AdBroadcast = mongoose.models.AdBroadcast || mongoose.model('AdBroadcast', adBroadcastSchema);
const FriendRequest = mongoose.models.FriendRequest || mongoose.model('FriendRequest', friendRequestSchema);
const PrivateMessage = mongoose.models.PrivateMessage || mongoose.model('PrivateMessage', privateMessageSchema);
const Notification = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);

mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000, socketTimeoutMS: 20000 }).then(async () => {
  console.log('MongoDB connected');

  const Room = mongoose.model('Room');
  // Ensure default rooms exist
  await Room.deleteMany({ name: { $in: ["Chill Donations", "Big Donators", "Anime Fans"] }, _id: { $nin: ["room1", "room2", "room3"] } });
  for (const r of FALLBACK_ROOMS) {
    await Room.findOneAndUpdate(
      { _id: r._id },
      { $setOnInsert: { ...r } },
      { upsert: true, new: true }
    );
  }
  console.log('Default rooms ensured in DB.');

  // Auto-delete inactive non-default rooms after 12 hours
  async function deleteInactiveRooms() {
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
    const result = await Room.deleteMany({
      _id: { $nin: ['room1', 'room2', 'room3'] },
      createdAt: { $lt: twelveHoursAgo }
    });
    if (result.deletedCount) console.log(`Deleted ${result.deletedCount} inactive rooms.`);
  }
  setInterval(deleteInactiveRooms, 60 * 60 * 1000);
  server.listen(PORT, () => console.log(`Passly running on port ${PORT}`));
}).catch(err => {
  console.error('MongoDB connection error:', err);
  console.log('Starting server without MongoDB – using fallback rooms only.');
  server.listen(PORT, () => console.log(`Passly running on port ${PORT} (no DB)`));
});
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: { error: 'Too many requests, try again later.' } });
app.use('/api/', apiLimiter);

function toClientError(err) {
  if (!err) return 'Something went wrong. Please try again.';
  if (err.name === 'MongooseServerSelectionError' || err.name === 'MongoNetworkError' || err.name === 'MongoTimeoutError' || /buffering timed out|connection|timeout/i.test(err.message || '')) {
    return 'Passly is having trouble reaching the database. Please try again in a moment.';
  }
  return 'Something went wrong. Please try again.';
}

function wrapAsyncHandlers(method) {
  const original = app[method].bind(app);
  app[method] = (path, ...handlers) => original(path, ...handlers.map(handler => {
    if (typeof handler !== 'function') return handler;
    return function wrappedHandler(req, res, next) {
      Promise.resolve(handler(req, res, next)).catch(err => {
        logger.error('Request failed', { path: req.path, method: req.method, error: err.message });
        if (res.headersSent) return next(err);
        res.status(/database|mongo|timeout|connection|buffering/i.test(err.message || '') ? 503 : 500).json({ error: toClientError(err) });
      });
    };
  }));
}
['get', 'post', 'put', 'delete', 'patch'].forEach(wrapAsyncHandlers);

const chatLimiter = rateLimit({ windowMs: 10 * 1000, max: 5, message: { error: 'Slow down your messages.' } });
const roomCreateLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, message: { error: 'Too many room creations, wait a minute.' } });

const ROBLOX_CONFIG = {
  clientId: process.env.ROBLOX_CLIENT_ID, clientSecret: process.env.ROBLOX_CLIENT_SECRET,
  redirectUri: process.env.ROBLOX_REDIRECT_URI || 'http://localhost:3000/auth/roblox/callback',
  authUrl: 'https://apis.roblox.com/oauth/v1/authorize', tokenUrl: 'https://apis.roblox.com/oauth/v1/token',
  userInfoUrl: 'https://apis.roblox.com/oauth/v1/userinfo', usersApi: 'https://users.roblox.com/v1/users'
};
const GAMEPASSES = { '5k': process.env.GAMEPASS_5K, '10k': process.env.GAMEPASS_10K, 'vip': VIP_GAMEPASS_ID };

const oauthStateSchema = new mongoose.Schema({ state: { type: String, required: true, unique: true }, createdAt: { type: Date, default: Date.now, expires: 600 } });
const OAuthState = mongoose.models.OAuthState || mongoose.model('OAuthState', oauthStateSchema);

function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token && req.path === '/daily-reward/claim') return res.status(401).json({ error: 'Guest users can’t earn Passly Coins. Please log in with Roblox to claim daily rewards.', guestRestricted: true });
  if (!token) return res.status(401).json({ error: 'Guest accounts can’t use this feature. Please log in to continue.', guestRestricted: true });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Your login expired. Please log in again.', guestRestricted: true });
    req.user = user; next();
  });
}

// ========== PUBLIC API PATHS (no token required) ==========
const publicApiPaths = ['/rooms', '/health', '/guest-login', '/search', '/leaderboard', '/streak-leaderboard'];
app.use('/api', (req, res, next) => {
  if (publicApiPaths.some(path => req.path === path || req.path.startsWith(`${path}/`))) {
    return next();
  }
  authenticateToken(req, res, next);
});

// Update lastSeen only for authenticated requests
app.use('/api', (req, res, next) => {
  if (req.user && req.user.id && mongoose.connection.readyState === 1) {
    mongoose.model('User').findByIdAndUpdate(req.user.id, { lastSeen: new Date() }).catch(() => {});
  }
  next();
});

// PAGE ROUTES
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/rooms', (req, res) => res.sendFile(path.join(__dirname, 'rooms.html')));
app.get('/leaderboard', (req, res) => res.sendFile(path.join(__dirname, 'leaderboard.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'profile.html')));
app.get('/advertisement', (req, res) => res.sendFile(path.join(__dirname, 'advertisement.html')));
app.get('/livedonations', (req, res) => res.sendFile(path.join(__dirname, 'livedonations.html')));
app.get('/friends', (req, res) => res.sendFile(path.join(__dirname, 'friends.html')));
app.get('/redeem', (req, res) => res.sendFile(path.join(__dirname, 'redeem.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'terms.html')));
app.get('/loading', (req, res) => res.sendFile(path.join(__dirname, 'loading.html')));
app.get('/watch-ad', (req, res) => res.sendFile(path.join(__dirname, 'watchad.html')));

// OAUTH
app.get('/auth/roblox', async (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  await OAuthState.create({ state });
  res.redirect(`${ROBLOX_CONFIG.authUrl}?${new URLSearchParams({
    client_id: ROBLOX_CONFIG.clientId, redirect_uri: ROBLOX_CONFIG.redirectUri,
    response_type: 'code', scope: 'openid', state
  })}`);
});
app.get('/auth/roblox/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error === 'access_denied') return res.send('<h1>Authorization Denied</h1><a href="/">Try again</a>');
  const doc = await OAuthState.findOneAndDelete({ state });
  if (!doc) return res.status(403).send('<h1>Invalid State</h1><a href="/">Go back</a>');
  if (!code) return res.redirect('/');
  try {
    const tokenRes = await axios.post(ROBLOX_CONFIG.tokenUrl,
      new URLSearchParams({ client_id: ROBLOX_CONFIG.clientId, client_secret: ROBLOX_CONFIG.clientSecret, grant_type: 'authorization_code', code }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const accessToken = tokenRes.data.access_token; // <-- SAVE THIS
    const ui = await axios.get(ROBLOX_CONFIG.userInfoUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    const userId = ui.data.sub;
    const profile = (await axios.get(`${ROBLOX_CONFIG.usersApi}/${userId}`)).data;
    const robloxUsername = profile.name || 'Player';
    const robloxDisplayName = profile.displayName || robloxUsername;
    let avatarUrl = '';
    try {
      const thumb = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`);
      if (thumb.data?.data?.length) avatarUrl = thumb.data.data[0].imageUrl;
    } catch (e) {}
    if (!avatarUrl) avatarUrl = `https://www.roblox.com/headshot-thumbnail/image?userId=${userId}&width=150&height=150&format=png`;

    await mongoose.model('User').findOneAndUpdate(
      { _id: userId },
      { $set: { robloxUsername, robloxDisplayName, avatarUrl, robloxAccessToken: accessToken } }, // <-- store token
      { upsert: true, setDefaultsOnInsert: true }
    );
    const user = await mongoose.model('User').findById(userId);
    const displayName = user.customDisplayName || robloxDisplayName;
    const jwtToken = jwt.sign({ id: userId, username: robloxUsername, displayName, avatarUrl, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('passly_token', jwtToken, { maxAge: 7*24*60*60*1000, httpOnly: false, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
    res.redirect(`/dashboard#token=${jwtToken}`);
  } catch (e) { console.error(e); res.send('<h1>Login Failed</h1><a href="/">Go back</a>'); }
});
// Helper to get User model (may be undefined if DB not connected)
function getUserModel() {
  return mongoose.connection.readyState === 1 ? mongoose.model('User') : null;
}

// USER API
app.get('/api/user', authenticateToken, async (req, res) => {
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready', fallback: true });
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const avatarUrl = user.avatarUrl || '';
  const avatarFallback = avatarUrl ? '' : `https://www.roblox.com/bust-thumbnail/image?userId=${user._id}&width=150&height=150&format=png`;
  const activeAd = await mongoose.model('Ad').findOne({ userId: user._id, active: true });
  res.json({
    id: user._id, robloxUsername: user.robloxUsername || '', robloxDisplayName: user.robloxDisplayName || '',
    displayName: user.customDisplayName || user.robloxDisplayName || '', avatarUrl, avatarFallback, profile: user.profile,
    roomId: user.roomId, inQueue: user.inQueue, donations: user.donations, ad: activeAd || null,
    customDisplayName: user.customDisplayName || null, board: user.board || [],
    role: effectiveRoleFor(user), notificationPreferences: user.notificationPreferences || {}, ...serializeUserTags(user), acceptedTos: user.acceptedTos, ...serializeEconomy(user)
  });
});

app.get('/api/profile/notifications', authenticateToken, async (req, res) => {
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ preferences: user.notificationPreferences || {} });
});
app.post('/api/profile/notifications', authenticateToken, async (req, res) => {
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  const incoming = req.body.preferences || {};
  const preferences = {
    offlineDonations: incoming.offlineDonations !== false,
    friendRequests: incoming.friendRequests !== false,
    friendMessages: incoming.friendMessages !== false,
    friendAccepted: incoming.friendAccepted !== false
  };
  await User.findByIdAndUpdate(req.user.id, { notificationPreferences: preferences });
  res.json({ success: true, preferences });
});

// Get user stats for member profile
app.get('/api/user/:userId/stats', authenticateToken, async (req, res) => {
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  const user = await User.findById(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    received: user.donations?.received || 0,
    given: user.donations?.given || 0,
    displayName: user.customDisplayName || user.robloxDisplayName || user.robloxUsername,
    username: user.robloxUsername,
    avatarUrl: user.avatarUrl,
    displayTag: serializeTag(getPublicTag(user))
  });
});

app.post('/api/accept-tos', authenticateToken, async (req, res) => {
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.acceptedTos) return res.json({ success: true, alreadyAccepted: true });
  user.acceptedTos = true;
  user.acceptedTosAt = new Date();
  await user.save();
  res.json({ success: true });
});


app.get('/api/economy', authenticateToken, async (req, res) => {
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ ...serializeEconomy(user), boothThemes: BOOTH_THEMES });
});

app.post('/api/daily-reward/claim', authenticateToken, async (req, res) => {
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (isGuestRecord(user)) return res.status(403).json({ error: 'Guest users can’t earn Passly Coins. Please log in with Roblox to claim daily rewards.', guestRestricted: true });
  const now = new Date();
  const reward = getRewardState(user);
  const lastClaimAt = parseStoredDate(reward.lastClaimDate);
  if (lastClaimAt && now - lastClaimAt < 24 * 60 * 60 * 1000) {
    return res.status(400).json({ error: 'Daily reward already claimed. Please wait 24 hours between claims.', ...serializeEconomy(user) });
  }
  const streak = lastClaimAt && now - lastClaimAt <= 48 * 60 * 60 * 1000 ? Number(reward.streak || 0) + 1 : 1;
  const amount = getDailyRewardAmount(streak);
  const currentBalance = getCoinBalance(user);
  user.coins = currentBalance + amount;
  user.totalCoins = currentBalance + amount;
  user.lastClaimDate = now.toISOString();
  user.streakDay = streak;
  user.dailyReward = { streak, lastClaimDate: now.toISOString(), totalClaims: Number(reward.totalClaims || 0) + 1 };
  await user.save();
  res.json({ success: true, claimed: amount, ...serializeEconomy(user) });
});

app.get('/api/ad-rewards/status', authenticateToken, async (req, res) => {
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (isGuestRecord(user)) return res.status(403).json({ error: 'Guest users can’t earn Passly Coins. Please log in with Roblox to watch ads.', guestRestricted: true });
  const today = getTodayKey();
  if (user.adWatchDate && user.adWatchDate !== today) {
    user.adWatchDate = today;
    user.adWatchCountToday = 0;
    await user.save();
  }
  res.json({ adLink: MONETAG_DIRECT_LINK, ...serializeEconomy(user) });
});

app.post('/api/ad-rewards/start', authenticateToken, async (req, res) => {
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (isGuestRecord(user)) return res.status(403).json({ error: 'Guest users can’t earn Passly Coins. Please log in with Roblox to watch ads.', guestRestricted: true });
  const now = new Date();
  const today = getTodayKey(now);
  if (user.adWatchDate !== today) {
    user.adWatchDate = today;
    user.adWatchCountToday = 0;
  }
  const state = getAdRewardState(user, now);
  if (state.dailyLimitReached) return res.status(400).json({ error: 'Daily ad limit reached.', adLink: MONETAG_DIRECT_LINK, ...serializeEconomy(user) });
  if (state.cooldownUntil) return res.status(429).json({ error: 'Please wait for the cooldown before starting another ad.', adLink: MONETAG_DIRECT_LINK, ...serializeEconomy(user) });
  if (state.pending) return res.status(400).json({ error: 'You already have an ad verification in progress.', adLink: MONETAG_DIRECT_LINK, ...serializeEconomy(user) });
  const token = crypto.randomBytes(24).toString('hex');
  const startedAt = now;
  const verifyAfter = new Date(now.getTime() + AD_VERIFY_DELAY_MS);
  const expiresAt = new Date(now.getTime() + AD_PENDING_EXPIRY_MS);
  user.adReward = { pendingToken: token, startedAt, verifyAfter, expiresAt };
  await user.save();
  res.json({ success: true, adLink: MONETAG_DIRECT_LINK, verifyToken: token, verifyAfter: verifyAfter.toISOString(), expiresAt: expiresAt.toISOString(), ...serializeEconomy(user) });
});

app.post('/api/ad-rewards/cancel', authenticateToken, async (req, res) => {
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.adReward = { pendingToken: '', startedAt: null, verifyAfter: null, expiresAt: null };
  await user.save();
  res.json({ success: true, ...serializeEconomy(user) });
});

app.post('/api/ad-rewards/verify', authenticateToken, async (req, res) => {
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  const verifyToken = String(req.body.verifyToken || '');
  if (!verifyToken) return res.status(400).json({ error: 'Missing verification token.' });
  const now = new Date();
  const today = getTodayKey(now);
  let user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (isGuestRecord(user)) return res.status(403).json({ error: 'Guest users can’t earn Passly Coins. Please log in with Roblox to watch ads.', guestRestricted: true });
  if (user.adWatchDate !== today) {
    user.adWatchDate = today;
    user.adWatchCountToday = 0;
    await user.save();
  }
  const currentBalance = getCoinBalance(user);
  if (user.coins !== currentBalance || user.totalCoins !== currentBalance) {
    user.coins = currentBalance;
    user.totalCoins = currentBalance;
    await user.save();
  }
  user = await User.findOneAndUpdate({
    _id: req.user.id,
    adWatchDate: today,
    adWatchCountToday: { $lt: AD_DAILY_LIMIT },
    'adReward.pendingToken': verifyToken,
    'adReward.verifyAfter': { $lte: now },
    'adReward.expiresAt': { $gt: now },
    $or: [{ lastAdWatchTime: null }, { lastAdWatchTime: { $lte: new Date(now.getTime() - AD_REWARD_COOLDOWN_MS) } }]
  }, {
    $set: {
      lastAdWatchTime: now,
      adWatchDate: today,
      adReward: { pendingToken: '', startedAt: null, verifyAfter: null, expiresAt: null }
    },
    $inc: { adWatchCountToday: 1, coins: AD_REWARD_COINS, totalCoins: AD_REWARD_COINS }
  }, { new: true });
  if (!user) {
    const fresh = await User.findById(req.user.id);
    const state = getAdRewardState(fresh, now);
    const message = state.dailyLimitReached ? 'Daily ad limit reached.' : (state.cooldownUntil ? 'Please wait for the cooldown before verifying another ad.' : 'Ad is not ready to verify yet, expired, or was already verified.');
    return res.status(400).json({ error: message, ...serializeEconomy(fresh) });
  }
  res.json({ success: true, awarded: AD_REWARD_COINS, ...serializeEconomy(user) });
});

app.get('/api/streak-leaderboard', async (req, res) => {
  const User = getUserModel();
  if (!User) return res.json([]);
  const users = await User.find({ 'dailyReward.streak': { $gt: 0 } })
    .sort({ 'dailyReward.streak': -1, coins: -1 })
    .limit(10)
    .select('robloxUsername robloxDisplayName customDisplayName avatarUrl dailyReward');
  res.json(users.map(user => ({
    username: user.customDisplayName || user.robloxDisplayName || user.robloxUsername || 'Player',
    streak: user.dailyReward?.streak || 0,
    avatarUrl: user.avatarUrl || ''
  })));
});

app.get('/api/booths', authenticateToken, async (req, res) => {
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ themes: BOOTH_THEMES, ...serializeEconomy(user) });
});

app.post('/api/booths/purchase', authenticateToken, async (req, res) => {
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  const theme = BOOTH_THEMES.find(item => item.id === String(req.body.themeId || '').toLowerCase());
  if (!theme) return res.status(400).json({ error: 'Unknown booth theme.' });
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const owned = new Set(user.booth?.ownedThemes || ['default']);
  if (owned.has(theme.id)) return res.status(400).json({ error: 'You already own this booth theme.' });
  const balance = getCoinBalance(user);
  if (balance < theme.price) return res.status(400).json({ error: 'Not enough coins for this booth theme.' });
  user.coins = balance - theme.price;
  user.totalCoins = balance - theme.price;
  owned.add(theme.id);
  user.booth = { activeTheme: user.booth?.activeTheme || 'default', ownedThemes: [...owned] };
  await user.save();
  res.json({ success: true, purchased: theme, ...serializeEconomy(user) });
});

app.post('/api/booths/equip', authenticateToken, async (req, res) => {
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  const themeId = String(req.body.themeId || '').toLowerCase();
  if (themeId !== 'default' && !BOOTH_THEMES.some(item => item.id === themeId)) return res.status(400).json({ error: 'Unknown booth theme.' });
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const owned = user.booth?.ownedThemes || ['default'];
  if (!owned.includes(themeId)) return res.status(403).json({ error: 'You do not own this booth theme.' });
  user.booth = { activeTheme: themeId, ownedThemes: owned };
  await user.save();
  res.json({ success: true, ...serializeEconomy(user) });
});

app.post('/api/profile/update', authenticateToken, async (req, res) => {
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  const { showBooth, statusDot, showRoomId, customDisplayName, displayTag } = req.body;
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const update = {};
  if (showBooth !== undefined) update['profile.showBooth'] = showBooth;
  if (statusDot) update['profile.statusDot'] = statusDot;
  if (showRoomId !== undefined) update['profile.showRoomId'] = showRoomId;
  if (customDisplayName !== undefined) update.customDisplayName = customDisplayName.trim().substring(0,20) || null;
  if (displayTag !== undefined) {
    const requestedTag = String(displayTag || '').toLowerCase();
    const availableTags = getAvailableTags(user);
    if (requestedTag && !availableTags.includes(requestedTag)) return res.status(403).json({ error: 'You can only display tags available on your account.' });
    update['profile.displayTag'] = requestedTag || null;
  }
  const updatedUser = await User.findByIdAndUpdate(req.user.id, { $set: update }, { new: true });
  res.json({ success: true, displayTag: serializeTag(getPublicTag(updatedUser)) });
});

app.get('/api/search', async (req, res) => {
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  const q = (req.query.username || '').toLowerCase().trim();
  if (!q) return res.status(400).json({ error: 'Username required' });
  const found = await User.findOne({ robloxUsername: new RegExp(`^${q}$`, 'i') });
  if (!found) return res.json({ error: 'User not found' });
  res.json({ id: found._id, robloxUsername: found.robloxUsername, displayName: found.customDisplayName || found.robloxDisplayName, avatarUrl: found.avatarUrl, displayTag: serializeTag(getPublicTag(found)), booth: found.booth || { activeTheme: 'default', ownedThemes: ['default'] }, board: found.profile?.showBooth !== false ? (found.board || []) : [] });
});

app.get('/api/user/:userId/board', authenticateToken, async (req, res) => {
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  const user = await User.findById(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user._id, displayName: user.customDisplayName || user.robloxDisplayName, avatarUrl: user.avatarUrl, displayTag: serializeTag(getPublicTag(user)), booth: user.booth || { activeTheme: 'default', ownedThemes: ['default'] }, board: user.profile?.showBooth !== false ? (user.board || []) : [] });
});

app.post('/api/board/add', authenticateToken, async (req, res) => {
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  const { assetId, price } = req.body;
  if (!assetId || !price) return res.status(400).json({ error: 'Asset ID and Robux amount required' });
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.board.some(g => g.id === assetId)) return res.status(400).json({ error: 'Already on board' });
  try {
    const check = await axios.get(`https://inventory.roblox.com/v1/users/${user._id}/items/GamePass/${assetId}`, { timeout: 5000 });
    if (!check.data?.data?.length) return res.status(400).json({ error: 'You do not own this gamepass' });
  } catch (e) { return res.status(400).json({ error: 'Ownership verification failed' }); }
  user.board.push({ id: assetId, name: 'Gamepass', price: parseInt(price) });
  await user.save();
  res.json({ success: true, board: user.board });
});
app.post('/api/board/remove', authenticateToken, async (req, res) => {
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  await User.findByIdAndUpdate(req.user.id, { $pull: { board: { id: req.body.assetId } } });
  const user = await User.findById(req.user.id);
  res.json({ success: true, board: user.board });
});
function sanitizeInput(str) { if (!str) return ''; return str.replace(/<[^>]*>/g, '').trim().substring(0, 100); }
async function canCreateRoom(userId, roomType) {
  const User = getUserModel();
  if (!User) return { allowed: false, error: 'Database not ready' };
  const user = await User.findById(userId);
  if (!user) return { allowed: false, error: 'User not found' };
  const today = new Date().toISOString().slice(0,10);
  const counts = user.roomCreationCounts || { public: { count: 0, date: '' }, private: { count: 0, date: '' } };
  const key = roomType === 'Public' ? 'public' : 'private';
  if (counts[key]?.date !== today) counts[key] = { count: 0, date: today };
  const limit = 2;
  if (counts[key].count >= limit) return { allowed: false, error: `Daily limit of ${limit} ${key} rooms reached.` };
  return { allowed: true, counts, key };
}
// PUBLIC /api/rooms endpoint – always returns rooms (no auth required)
app.get('/api/rooms', async (req, res) => {
  console.log('GET /api/rooms called');
  try {
    const Room = mongoose.connection.readyState === 1 ? mongoose.model('Room') : null;
    if (!Room) {
      console.log('DB not ready, returning fallback rooms');
      return res.json(FALLBACK_ROOMS);
    }
    let rooms = await Room.find();
    for (const room of rooms) await reconcileRoomPresence(room._id, false);
    rooms = await Room.find();
    if (!rooms || rooms.length === 0) {
      console.log('No rooms in DB, inserting fallback');
      await Room.insertMany(FALLBACK_ROOMS, { ordered: false });
      rooms = FALLBACK_ROOMS;
    }
    res.json(rooms);
  } catch (err) {
    console.error('/api/rooms error:', err);
    res.json(FALLBACK_ROOMS);
  }
});

async function leaveExistingRoomsForMember(memberId, emitUpdates = true) {
  const Room = mongoose.connection.readyState === 1 ? mongoose.model('Room') : null;
  if (!Room || !memberId) return;
  const rooms = await Room.find({ $or: [{ players: memberId }, { queue: memberId }] });
  for (const room of rooms) {
    const wasPlayer = room.players.includes(memberId);
    room.players = room.players.filter(id => id !== memberId);
    room.queue = (room.queue || []).filter(id => id !== memberId);
    while (room.queue.length > 0 && room.players.length < room.maxPlayers) {
      const nextId = room.queue.shift();
      if (!room.players.includes(nextId)) room.players.push(nextId);
      const User = getUserModel();
      if (User) await User.findByIdAndUpdate(nextId, { roomId: room._id, inQueue: false }).catch(() => {});
      if (emitUpdates) io.to(room._id).emit('player-joined', { userId: nextId });
    }
    await room.save();
    if (emitUpdates) {
      if (wasPlayer) io.to(room._id).emit('player-left', { userId: memberId });
      io.to(room._id).emit('queue-updated', { queue: room.queue || [] });
      io.to(room._id).emit('room-members-updated', { roomId: room._id, players: room.players, queue: room.queue || [] });
    }
  }
}

app.post('/api/rooms/create', authenticateToken, roomCreateLimiter, async (req, res) => {
  const Room = mongoose.connection.readyState === 1 ? mongoose.model('Room') : null;
  const User = getUserModel();
  if (!Room || !User) return res.status(503).json({ error: 'Database not ready' });
  let { name, desc, type } = req.body;
  name = sanitizeInput(name); desc = sanitizeInput(desc);
  if (!name) return res.status(400).json({ error: 'Room name required' });
  if (!['Public', 'Private', 'VIP'].includes(type)) type = 'Public';
  const user = await User.findById(req.user.id);
  if (type === 'VIP' && user.role !== 'vip' && user.role !== 'admin' && user.role !== 'owner') {
    return res.status(403).json({ error: 'VIP role required to create VIP rooms.' });
  }
  const limitCheck = await canCreateRoom(req.user.id, type);
  if (!limitCheck.allowed) return res.status(429).json({ error: limitCheck.error });
  await leaveExistingRoomsForMember(req.user.id);
  const roomId = crypto.randomBytes(8).toString('hex');
  const room = new Room({ _id: roomId, name, desc, type, players: [req.user.id], queue: [], createdBy: req.user.id });
  await room.save();
  limitCheck.counts[limitCheck.key].count += 1;
  user.roomCreationCounts = limitCheck.counts;
  await user.save();
  await User.findByIdAndUpdate(req.user.id, { roomId: room._id, inQueue: false });
  res.json(room);
});

app.post('/api/rooms/join/:id', authenticateToken, async (req, res) => {
  const Room = mongoose.connection.readyState === 1 ? mongoose.model('Room') : null;
  const User = getUserModel();
  if (!Room || !User) return res.status(503).json({ error: 'Database not ready' });
  const roomId = req.params.id;
  let room = await Room.findById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  room = await reconcileRoomDocument(room) || room;
  const user = await User.findById(req.user.id);
  if (room.type === 'VIP' && user.role !== 'vip' && user.role !== 'admin' && user.role !== 'owner') {
    return res.status(403).json({ error: 'VIP room – need VIP role.' });
  }
  if (room.players.includes(req.user.id)) return res.json({ success: true, room, alreadyIn: true });
  await leaveExistingRoomsForMember(req.user.id);
  room = await Room.findById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.players.length >= room.maxPlayers) {
    if (!room.queue.includes(req.user.id)) { room.queue.push(req.user.id); await room.save(); }
    await User.findByIdAndUpdate(req.user.id, { roomId: room._id, inQueue: true });
    io.to(roomId).emit('queue-updated', { queue: room.queue });
    const position = room.queue.indexOf(req.user.id) + 1;
    return res.json({ queued: true, position });
  }
  room.players.push(req.user.id);
  await room.save();
  await User.findByIdAndUpdate(req.user.id, { roomId: room._id, inQueue: false });
  io.to(roomId).emit('player-joined', { userId: req.user.id, username: req.user.displayName });
  res.json({ success: true, room });
});

app.post('/api/rooms/guest/join/:id', async (req, res) => {
  const Room = mongoose.connection.readyState === 1 ? mongoose.model('Room') : null;
  if (!Room) return res.status(503).json({ error: 'Database not ready' });
  const roomId = req.params.id;
  const { guestId, guestName } = req.body;
  if (!guestId) return res.status(400).json({ error: 'Guest ID required' });
  let room = await Room.findById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  room = await reconcileRoomDocument(room) || room;
  if (room.type === 'VIP') return res.status(403).json({ error: 'Guests cannot join VIP rooms.' });
  if (room.players.includes(guestId)) return res.json({ success: true, room, alreadyIn: true });
  await leaveExistingRoomsForMember(guestId);
  room = await Room.findById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.players.length >= room.maxPlayers) {
    if (!room.queue.includes(guestId)) { room.queue.push(guestId); await room.save(); }
    io.to(roomId).emit('queue-updated', { queue: room.queue });
    const position = room.queue.indexOf(guestId) + 1;
    return res.json({ queued: true, position });
  }
  room.players.push(guestId);
  await room.save();
  io.to(roomId).emit('player-joined', { userId: guestId, username: guestName || 'Guest' });
  res.json({ success: true, room });
});

app.post('/api/rooms/leave', authenticateToken, async (req, res) => {
  const User = getUserModel();
  const Room = mongoose.connection.readyState === 1 ? mongoose.model('Room') : null;
  if (!User || !Room) return res.json({ success: true });
  const user = await User.findById(req.user.id);
  if (!user || !user.roomId) return res.json({ success: true });
  const room = await Room.findById(user.roomId);
  if (room) {
    room.players = room.players.filter(id => id !== req.user.id);
    if (room.queue.length > 0 && room.players.length < room.maxPlayers) {
      const nextId = room.queue.shift();
      room.players.push(nextId);
      await User.findByIdAndUpdate(nextId, { roomId: room._id, inQueue: false });
      io.to(room._id).emit('player-joined', { userId: nextId });
      io.to(room._id).emit('queue-updated', { queue: room.queue });
    }
    await room.save();
    io.to(room._id).emit('player-left', { userId: req.user.id });
  }
  await User.findByIdAndUpdate(req.user.id, { roomId: null, inQueue: false });
  res.json({ success: true });
});

app.post('/api/rooms/guest/leave', async (req, res) => {
  const Room = mongoose.connection.readyState === 1 ? mongoose.model('Room') : null;
  if (!Room) return res.json({ success: true });
  const { guestId } = req.body;
  if (!guestId) return res.status(400).json({ error: 'Guest ID required' });
  const room = await Room.findOne({ players: guestId });
  if (room) {
    room.players = room.players.filter(id => id !== guestId);
    if (room.queue.length > 0 && room.players.length < room.maxPlayers) {
      const nextId = room.queue.shift();
      room.players.push(nextId);
      const User = getUserModel();
      if (User) await User.findByIdAndUpdate(nextId, { roomId: room._id, inQueue: false });
      io.to(room._id).emit('player-joined', { userId: nextId });
      io.to(room._id).emit('queue-updated', { queue: room.queue });
    }
    await room.save();
    io.to(room._id).emit('player-left', { userId: guestId });
  }
  res.json({ success: true });
});
const BAD_WORDS_LIST_SERVER = [
  'fuck', 'shit', 'bitch', 'cunt', 'dick', 'pussy', 'twat', 'whore', 'slut', 'bastard', 'piss', 'cock',
  'faggot', 'nigga', 'nigger', 'retard', 'fck', 'fcuk', 'phuk', 'fuk', 'sh1t', 'sht', 'b1tch', 'btch', 'c0ck', 'd1ck', 'dck',
  'n1gga', 'n1gger', 'ngga', 'f4ggot', 'f4g', 'ret4rd', 'rtrd', 'b8stard', 'bstrd', 'wh0re',
  'whre', 'b!tch', 'c0k', 'dik', 'dikhed', 'clit', 'cl1t', 'tw4t', 'wanker', 'w4nker', 'bollocks', 'arsehole',
  '5hit', '5h1t', 'phoque', 'kunt'
];
const BAD_WORD_PATTERNS_SERVER = [
  /f+\W*[u*]\W*c+\W*k+/i,
  /s+\W*h+\W*[i1!*]+\W*t+/i,
  /b+\W*[i1!*]+\W*t+\W*c+\W*h+/i,
  /n+\W*[i1!*]+\W*g+\W*g+\W*(?:a|e|er)?/i,
  /f+\W*a+\W*g+(?:\W*o+\W*t+)?/i,
  /r+\W*e+\W*t+\W*a+\W*r+\W*d+/i
];
function normalizeTextServer(text) {
  let normalized = String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  normalized = normalized
    .replace(/[0º°]/g, 'o').replace(/[1!|ìíîï]/g, 'i').replace(/[3€]/g, 'e')
    .replace(/[4@]/g, 'a').replace(/[5$]/g, 's').replace(/[7+]/g, 't')
    .replace(/[8]/g, 'b').replace(/[9]/g, 'g');
  normalized = normalized.replace(/(.)\1{2,}/g, '$1$1');
  normalized = normalized.replace(/[^a-z0-9]/g, '');
  return normalized;
}
function filterMessageServer(text) {
  if (!text) return text;
  const original = String(text);
  const normalized = normalizeTextServer(original);
  const spaced = original.replace(/(.)\1{2,}/g, '$1$1');
  const compactWords = normalized.match(/[a-z]+/g)?.join(' ') || normalized;
  const hasContext = /\b(?:kill\s*yourself|kys|discord\s*\.\s*gg|free\s*robux|password|token|cookie)\b/i.test(spaced);
  if (hasContext || BAD_WORD_PATTERNS_SERVER.some(pattern => pattern.test(spaced))) return '#'.repeat(original.length);
  for (const bad of BAD_WORDS_LIST_SERVER) {
    const normalizedBad = normalizeTextServer(bad);
    if (normalizedBad.length >= 3 && (normalized.includes(normalizedBad) || compactWords.includes(normalizedBad))) return '#'.repeat(original.length);
  }
  return text;
}

const guestChatCooldown = new Map();
const onlineUsers = new Set();

function getSocketMemberId(sock) {
  return sock.userId || sock.guestId || null;
}

async function reconcileRoomPresence(roomId, emitUpdate = true) {
  if (!roomId || mongoose.connection.readyState !== 1) return [];
  const Room = mongoose.model('Room');
  const User = mongoose.model('User');
  const sockets = await io.in(roomId).fetchSockets().catch(() => []);
  const activeIds = [...new Set(sockets.map(getSocketMemberId).filter(Boolean))];
  const room = await Room.findById(roomId).catch(() => null);
  if (!room) return activeIds;

  const priorPlayers = Array.isArray(room.players) ? room.players : [];
  const removedPlayers = priorPlayers.filter(id => !activeIds.includes(id));
  room.players = activeIds;

  if (Array.isArray(room.queue) && room.queue.length) {
    room.queue = room.queue.filter(id => !activeIds.includes(id));
    while (room.queue.length && room.players.length < room.maxPlayers) {
      const nextId = room.queue.shift();
      if (!room.players.includes(nextId)) room.players.push(nextId);
      await User.findByIdAndUpdate(nextId, { roomId: room._id, inQueue: false }).catch(() => {});
    }
  }

  await room.save().catch(err => logger.warn('Failed to save reconciled room presence', { roomId, error: err.message }));
  if (removedPlayers.length) {
    await User.updateMany({ _id: { $in: removedPlayers }, roomId }, { $unset: { roomId: "", inQueue: "" } }).catch(() => {});
  }
  if (emitUpdate) io.to(roomId).emit('room-members-updated', { roomId, players: room.players, queue: room.queue || [] });
  return room.players;
}

async function reconcileRoomDocument(room) {
  if (!room || mongoose.connection.readyState !== 1) return room;
  await reconcileRoomPresence(room._id, false);
  return mongoose.model('Room').findById(room._id);
}

// ========== SOCKET.IO WITH CHAT ISOLATION ==========
io.on('connection', (socket) => {
  let currentRoomId = null;
  let userId = null;
  let guestId = null;
  let isGuest = false;

  socket.on('authenticate', async (token) => {
    if (!token) return;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.id;
      socket.userId = userId;
      socket.join(userId);
      isGuest = false;
      onlineUsers.add(userId);
      if (mongoose.connection.readyState === 1) {
        const authUser = await mongoose.model('User').findByIdAndUpdate(userId, { lastSeen: new Date() }, { new: true }).catch(()=>null);
        if (effectiveRoleFor(authUser) === 'owner' || effectiveRoleFor(authUser) === 'admin' || ADMINS.has(userId)) socket.join('passly-admins');
      }
    } catch (e) {}
  });

  socket.on('guest-auth', (id) => {
    if (id) {
      guestId = id;
      socket.guestId = id;
      isGuest = true;
      onlineUsers.add(guestId);
    }
  });

  socket.on('join-room', async (roomId) => {
    const previousRoomId = currentRoomId;
    if (previousRoomId) {
      socket.leave(previousRoomId);
      await reconcileRoomPresence(previousRoomId);
    }
    currentRoomId = roomId;
    socket.join(roomId);
    await reconcileRoomPresence(roomId);
    console.log(`Socket ${socket.id} joined room ${roomId}`);
  });

  socket.on('admin-chat-message', async (message) => {
    if (!userId || mongoose.connection.readyState !== 1) return;
    const user = await mongoose.model('User').findById(userId).catch(() => null);
    const role = effectiveRoleFor(user);
    if (role !== 'owner' && role !== 'admin' && !ADMINS.has(userId)) return socket.emit('admin-chat-error', 'Admin only');
    const cleanMessage = filterMessageServer(String(message || '').slice(0, 500).trim());
    if (!cleanMessage) return;
    io.to('passly-admins').emit('admin-chat-message', {
      userId,
      username: user?.customDisplayName || user?.robloxDisplayName || user?.robloxUsername || 'Admin',
      message: cleanMessage,
      timestamp: Date.now(),
      displayTag: serializeTag(getPublicTag(user))
    });
  });

  socket.on('disconnect', async () => {
    const roomToUpdate = currentRoomId;
    if (userId) onlineUsers.delete(userId);
    if (guestId) onlineUsers.delete(guestId);
    currentRoomId = null;
    if (roomToUpdate) await reconcileRoomPresence(roomToUpdate);
  });

  socket.on('chat-message', async (msg) => {
    if (!currentRoomId) {
      console.log('Chat message ignored – no room joined');
      return;
    }

    if (isGuest && guestId) {
      const last = guestChatCooldown.get(guestId);
      const now = Date.now();
      if (last && now - last < 25000) {
        socket.emit('chat-error', 'Guests can send one message every 25 seconds.');
        return;
      }
      guestChatCooldown.set(guestId, now);
    }

    let messageText = msg;
    let senderName = '';
    let senderAvatar = '';
    let isAdmin = false;
    let isOwner = false;
    let senderTag = null;
    let senderId = userId || guestId;

    if (isGuest) {
      if (typeof msg === 'object') {
        messageText = msg.text;
        senderName = msg.guestName || 'Guest';
      } else {
        senderName = 'Guest';
      }
    } else if (userId) {
      const User = mongoose.connection.readyState === 1 ? mongoose.model('User') : null;
      const user = User ? await User.findById(userId) : null;
      if (user) {
        senderName = user.customDisplayName || user.robloxDisplayName || user.robloxUsername;
        senderAvatar = user.avatarUrl || '';
        isOwner = (userId === OWNER_ROBLOX_ID);
        isAdmin = ADMINS.has(userId) || isOwner;
        senderTag = serializeTag(getPublicTag(user));
      } else {
        senderName = 'User';
      }
    }

    // Admin command: r.close
    if (!isGuest && (isAdmin || isOwner) && messageText.trim().toLowerCase() === 'r.close') {
      const Room = mongoose.connection.readyState === 1 ? mongoose.model('Room') : null;
      if (Room) {
        const room = await Room.findById(currentRoomId);
        if (room) {
          io.to(currentRoomId).emit('room-closed', { message: 'Room closed by admin.' });
          const sockets = await io.in(currentRoomId).fetchSockets();
          for (const sock of sockets) {
            sock.emit('force-leave', { reason: 'Room closed.' });
            sock.leave(currentRoomId);
          }
          await Room.deleteOne({ _id: currentRoomId });
          const UserModel = mongoose.connection.readyState === 1 ? mongoose.model('User') : null;
          if (UserModel) await UserModel.updateMany({ roomId: currentRoomId }, { $unset: { roomId: "", inQueue: "" } });
        }
      }
      return;
    }

    const filteredMsg = filterMessageServer(messageText);
    io.to(currentRoomId).emit('chat-message', {
      userId: senderId,
      username: senderName,
      message: filteredMsg,
      avatarUrl: senderAvatar,
      timestamp: Date.now(),
      isAdmin,
      isOwner,
      displayTag: senderTag
    });
  });

  socket.on('chat-board', async (boardData) => {
    if (!userId || !currentRoomId) return;
    const cooldownKey = `${currentRoomId}:${userId}`;
    const lastSent = boardChatCooldowns.get(cooldownKey) || 0;
    if (Date.now() - lastSent < 5 * 60 * 1000) {
      socket.emit('chat-error', 'You can send your booth once every 5 minutes.');
      return;
    }
    const User = mongoose.connection.readyState === 1 ? mongoose.model('User') : null;
    const user = User ? await User.findById(userId) : null;
    if (!user) return;
    boardChatCooldowns.set(cooldownKey, Date.now());
    io.to(currentRoomId).emit('chat-board', {
      userId,
      username: user.customDisplayName || user.robloxDisplayName || user.robloxUsername,
      board: Array.isArray(boardData) ? boardData.slice(0, 50) : [],
      avatarUrl: user.avatarUrl
    });
  });

  socket.on('voice-data', (audioBuffer) => {
    if ((!userId && !guestId) || !currentRoomId) return;
    const senderId = userId || guestId;
    socket.to(currentRoomId).emit('voice-data', { userId: senderId, audio: audioBuffer });
  });

  socket.on('leave-room', async () => {
    if (currentRoomId) {
      const roomToUpdate = currentRoomId;
      socket.leave(roomToUpdate);
      currentRoomId = null;
      await reconcileRoomPresence(roomToUpdate);
    }
  });
});

// LEADERBOARD
app.get('/api/leaderboard', async (req, res) => {
  const Donation = mongoose.connection.readyState === 1 ? mongoose.model('Donation') : null;
  if (!Donation) return res.json({ receivers: [], donors: [], streaks: [] });
  const period = req.query.period || 'daily';
  let startDate = new Date();
  if (period === 'daily') startDate.setHours(0,0,0,0);
  else if (period === 'weekly') startDate.setDate(startDate.getDate() - 7);
  else if (period === 'total') startDate = new Date(0);
  const match = period === 'total' ? {} : { timestamp: { $gte: startDate } };
  const receivers = await Donation.aggregate([{ $match: match }, { $group: { _id: '$receiverId', total: { $sum: '$amount' } } }, { $sort: { total: -1 } }, { $limit: 10 }]);
  const donors = await Donation.aggregate([{ $match: match }, { $group: { _id: '$donorId', total: { $sum: '$amount' } } }, { $sort: { total: -1 } }, { $limit: 10 }]);
  const User = mongoose.connection.readyState === 1 ? mongoose.model('User') : null;
  const enrich = async (arr) => { const result = []; for (const item of arr) { const user = User ? await User.findById(item._id) : null; result.push({ username: user ? (user.customDisplayName || user.robloxDisplayName || user.robloxUsername) : 'Unknown', amount: item.total }); } return result; };
  const streaks = User ? await User.find({ 'dailyReward.streak': { $gt: 0 } }).sort({ 'dailyReward.streak': -1, coins: -1 }).limit(10).select('robloxUsername robloxDisplayName customDisplayName dailyReward') : [];
  res.json({ receivers: await enrich(receivers), donors: await enrich(donors), streaks: streaks.map(user => ({ username: user.customDisplayName || user.robloxDisplayName || user.robloxUsername || 'Player', streak: user.dailyReward?.streak || 0 })) });
});

// ADS
app.get('/api/ads', async (req, res) => {
  const Ad = mongoose.connection.readyState === 1 ? mongoose.model('Ad') : null;
  if (!Ad) return res.json([]);
  const ads = await Ad.find({ active: true, showsLeft: { $gt: 0 } }).limit(5);
  res.json(ads.map(ad => ({ userId: ad.userId, username: ad.username, tier: ad.tier, message: ad.message, showsLeft: ad.showsLeft })));
});
app.post('/api/purchase-ad', authenticateToken, async (req, res) => {
  const User = getUserModel();
  const Ad = mongoose.connection.readyState === 1 ? mongoose.model('Ad') : null;
  if (!User || !Ad) return res.status(503).json({ error: 'Database not ready' });
  const { tier, message } = req.body;
  if (!tier || !['5k','10k','vip'].includes(tier)) return res.status(400).json({ error: 'Invalid tier' });
  const gamepassId = GAMEPASSES[tier];
  if (!gamepassId) return res.status(400).json({ error: 'Gamepass not configured' });
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (tier === 'vip') return res.json({ url: `https://www.roblox.com/game-pass/${gamepassId}`, pendingType: 'vip' });
  const existing = await Ad.findOne({ userId: req.user.id, active: true });
  if (existing) return res.status(400).json({ error: 'You already have an active ad. Delete it first.' });
  const tierNum = tier === '5k' ? 5000 : 10000;
  const shows = tier === '5k' ? 1 : 3;
  const ad = new Ad({ _id: crypto.randomBytes(8).toString('hex'), userId: req.user.id, username: user.customDisplayName || user.robloxDisplayName || user.robloxUsername, tier: tierNum, gamepassId, broadcastsLeft: 1, showsLeft: shows, active: true, message: message || null });
  await ad.save();
  res.json({ success: true, ad });
});
app.post('/api/verify-ad', authenticateToken, async (req, res) => {
  const User = getUserModel();
  const Ad = mongoose.connection.readyState === 1 ? mongoose.model('Ad') : null;
  if (!User || !Ad) return res.status(503).json({ error: 'Database not ready' });
  const { tier } = req.body;
  const gamepassId = GAMEPASSES[tier];
  if (!gamepassId) return res.status(400).json({ error: 'Invalid tier' });
  try {
    const inv = await axios.get(`https://inventory.roblox.com/v1/users/${req.user.id}/items/GamePass/${gamepassId}`, { timeout: 5000 });
    if (!inv.data?.data?.length) return res.status(400).json({ error: 'You do not own this gamepass.' });
    if (tier === 'vip') {
      await User.findByIdAndUpdate(req.user.id, { role: 'vip' });
      return res.json({ success: true, message: 'VIP role granted!' });
    }
    const existingAd = await Ad.findOne({ userId: req.user.id, active: true });
    if (!existingAd) {
      const user = await User.findById(req.user.id);
      const tierNum = tier === '5k' ? 5000 : 10000;
      const shows = tier === '5k' ? 1 : 3;
      const ad = new Ad({ _id: crypto.randomBytes(8).toString('hex'), userId: req.user.id, username: user.customDisplayName || user.robloxDisplayName || user.robloxUsername, tier: tierNum, gamepassId, broadcastsLeft: 1, showsLeft: shows, active: true, message: null });
      await ad.save();
    }
    res.json({ success: true, message: 'Ad activated!' });
  } catch (err) { res.status(500).json({ error: 'Verification failed' }); }
});
app.post('/api/delete-ad', authenticateToken, async (req, res) => {
  const Ad = mongoose.connection.readyState === 1 ? mongoose.model('Ad') : null;
  if (!Ad) return res.json({ success: true });
  await Ad.findOneAndDelete({ userId: req.user.id, active: true });
  res.json({ success: true });
});
app.get('/api/ads/broadcast', async (req, res) => {
  const AdBroadcast = mongoose.connection.readyState === 1 ? mongoose.model('AdBroadcast') : null;
  if (!AdBroadcast) return res.json([]);
  const { roomId, since } = req.query;
  const sinceDate = since ? new Date(parseInt(since)) : new Date(Date.now() - 60000);
  const broadcasts = await AdBroadcast.find({ roomId, timestamp: { $gt: sinceDate } }).sort({ timestamp: -1 }).limit(10);
  res.json(broadcasts);
});

app.post('/api/guest-login', async (req, res) => {
  const User = getUserModel();
  const guestId = crypto.randomBytes(8).toString('hex');
  const username = `Guest_${guestId.slice(0,6)}`;
  if (User) {
    const user = new User({ _id: guestId, robloxUsername: username, robloxDisplayName: username, customDisplayName: username, avatarUrl: '', donations: { received: 0, given: 0 }, board: [], role: 'guest', isGuest: true, acceptedTos: false });
    await user.save();
  }
  res.json({ id: guestId, username, displayName: username, isGuest: true });
});
const pendingDonations = new Map();

app.post('/api/donate/initiate', authenticateToken, async (req, res) => {
  const { receiverId, gamepassId, amount } = req.body;
  if (!receiverId || !gamepassId || !amount) return res.status(400).json({ error: 'Missing fields' });
  const donorId = req.user.id;
  if (pendingDonations.has(donorId)) {
    const pending = pendingDonations.get(donorId);
    if (Date.now() - pending.timestamp < 3600000) return res.status(400).json({ error: 'You already have a pending donation. Verify or wait.' });
    else pendingDonations.delete(donorId);
  }
  pendingDonations.set(donorId, { receiverId, gamepassId, amount, timestamp: Date.now() });
  setTimeout(() => { if (pendingDonations.get(donorId)?.timestamp) pendingDonations.delete(donorId); }, 3600000);
  res.json({ url: `https://www.roblox.com/game-pass/${gamepassId}` });
});

app.post('/api/donate/verify', authenticateToken, async (req, res) => {
  const donorId = req.user.id;
  const pending = pendingDonations.get(donorId);
  let { receiverId, gamepassId, amount } = req.body;
  if (pending) { receiverId = pending.receiverId; gamepassId = pending.gamepassId; amount = pending.amount; }
  if (!receiverId || !gamepassId || !amount) return res.status(400).json({ error: 'Missing donation details' });

  const User = getUserModel();
  const Donation = mongoose.connection.readyState === 1 ? mongoose.model('Donation') : null;
  const ConsumedPurchase = mongoose.connection.readyState === 1 ? mongoose.model('ConsumedPurchase') : null;
  if (!User || !Donation || !ConsumedPurchase) return res.status(503).json({ error: 'Database not ready' });
  const donor = await User.findById(donorId);
  if (!donor) return res.status(404).json({ error: 'User not found' });

  const consumedKey = `${donorId}:${gamepassId}`;
  const consumed = await ConsumedPurchase.findById(consumedKey);
  if (consumed) {
    pendingDonations.delete(donorId);
    return res.status(400).json({ error: 'You have already verified this purchase. Remove it from your inventory and buy it again if you wish to donate again.' });
  }
  const existing = await Donation.findOne({ donorId, receiverId, gamepassId, amount });
  if (existing) return res.status(400).json({ error: 'You have already verified this purchase. Remove it from your inventory and buy it again if you wish to donate again.' });

  try {
    const inv = await axios.get(`https://inventory.roblox.com/v1/users/${donorId}/items/GamePass/${gamepassId}`, { timeout: 5000 });
    if (!inv.data?.data?.length) return res.status(400).json({ error: 'You do not own this gamepass.' });
  } catch (err) { return res.status(500).json({ error: 'Failed to verify ownership.' }); }

  const receiver = await User.findById(receiverId);
  if (!receiver) return res.status(404).json({ error: 'Receiver not found' });
  const donationAmount = Math.max(0, Math.floor(Number(amount) || 0));
  const donorCoins = Math.floor(donationAmount / 10);
  const receiverCoins = Math.floor(donationAmount / 20);
  const donation = new Donation({
    _id: crypto.randomBytes(8).toString('hex'), donorId, donorName: donor.robloxUsername,
    receiverId, receiverName: receiver.robloxUsername, gamepassId, amount: donationAmount, roomId: null, verified: true,
    coinRewards: { donor: donorCoins, receiver: receiverCoins }, consumedPurchaseKey: consumedKey, timestamp: new Date()
  });
  await donation.save();
  await ConsumedPurchase.create({ _id: consumedKey, donorId, gamepassId, receiverId, amount: donationAmount, donationId: donation._id });
  await User.findByIdAndUpdate(donorId, { $inc: { 'donations.given': donationAmount, coins: donorCoins, totalCoins: donorCoins } });
  await User.findByIdAndUpdate(receiverId, { $inc: { 'donations.received': donationAmount, coins: receiverCoins, totalCoins: receiverCoins } });
  amount = donationAmount;
  pendingDonations.delete(donorId);

  // ========== SEND DONATION MESSAGES ==========
  // Get donor's current room (if any)
  const donorRoomId = donor.roomId;
  const donorName = donor.customDisplayName || donor.robloxDisplayName || donor.robloxUsername;
  const receiverName = receiver.customDisplayName || receiver.robloxDisplayName || receiver.robloxUsername;
  if (donorRoomId) {
    io.to(donorRoomId).emit('room-donation', {
      donorName, receiverName, amount,
      donorAvatar: donor.avatarUrl, receiverAvatar: receiver.avatarUrl
    });
  }
  // If donation >= 10,000 Robux, send to all rooms (global message)
  if (amount >= 10000) {
    io.emit('global-donation', {
      donorName, receiverName, amount,
      donorAvatar: donor.avatarUrl, receiverAvatar: receiver.avatarUrl
    });
  }
  // Also send to live donations page
  io.emit('new-donation', {
    donorName, receiverName, amount,
    donorAvatar: donor.avatarUrl, receiverAvatar: receiver.avatarUrl,
    timestamp: new Date()
  });
  if (!onlineUsers.has(receiverId) && receiver.notificationPreferences?.offlineDonations !== false) {
    const Notification = mongoose.model('Notification');
    await Notification.create({
      _id: crypto.randomBytes(8).toString('hex'),
      userId: receiverId,
      type: 'offline_donation',
      fromUserId: donorId,
      message: `donated ${amount.toLocaleString()} Robux while you were offline`,
      read: false
    });
  }

  res.json({ success: true, message: 'Donation recorded! Thank you.', coinRewards: { donor: Math.floor(amount / 10), receiver: Math.floor(amount / 20) } });
});
const OWNER_ROBLOX_ID = '3115362000';
const ADMINS = new Set();
const BANNED = new Set();
const boardChatCooldowns = new Map();
let REPORTS = [];

async function isAdminOrOwner(req) {
  const User = getUserModel();
  if (!User) return false;
  const user = await User.findById(req.user.id);
  if (!user) return false;
  const role = effectiveRoleFor(user);
  return role === 'owner' || role === 'admin' || ADMINS.has(String(user._id));
}
async function isOwnerRequest(req) {
  const User = getUserModel();
  if (!User || !req.user?.id) return false;
  const user = await User.findById(req.user.id);
  return effectiveRoleFor(user) === 'owner';
}
function generateCouponCode() {
  return `PASSLY-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}
app.use((req, res, next) => { if (req.user && BANNED.has(req.user.id)) return res.status(403).json({ error: 'Banned account.' }); next(); });
app.get('/api/admin/check', authenticateToken, async (req, res) => { res.json({ isAdmin: await isAdminOrOwner(req) }); });
app.get('/api/admin/data', authenticateToken, async (req, res) => {
  if (!(await isAdminOrOwner(req))) return res.status(403).json({ error: 'Admin only' });
  const User = getUserModel();
  if (!User) return res.json({ reports: [], banned: [] });
  const bannedUsersWithNames = await Promise.all(Array.from(BANNED).map(async (userId) => { const user = await User.findById(userId); return { userId, username: user?.robloxUsername || 'Unknown' }; }));
  const reportsWithNames = await Promise.all(REPORTS.map(async (report) => { const reportedUser = await User.findById(report.reportedId); const reporterUser = await User.findById(report.reporterId); return { ...report, reportedUsername: reportedUser?.robloxUsername || 'Unknown', reporterUsername: reporterUser?.robloxUsername || 'Unknown' }; }));
  res.json({ reports: reportsWithNames, banned: bannedUsersWithNames });
});
app.get('/api/admin/coupons', authenticateToken, async (req, res) => {
  if (!(await isOwnerRequest(req))) return res.status(403).json({ error: 'Owner only' });
  const Coupon = mongoose.connection.readyState === 1 ? mongoose.model('Coupon') : null;
  if (!Coupon) return res.status(503).json({ error: 'Database not ready' });
  const coupons = await Coupon.find().sort({ createdAt: -1 }).limit(100);
  res.json({ coupons });
});
app.post('/api/admin/coupons/create', authenticateToken, async (req, res) => {
  if (!(await isOwnerRequest(req))) return res.status(403).json({ error: 'Owner only' });
  const Coupon = mongoose.connection.readyState === 1 ? mongoose.model('Coupon') : null;
  if (!Coupon) return res.status(503).json({ error: 'Database not ready' });
  const passlyAmount = Math.floor(Number(req.body.passlyAmount || 0));
  if (!Number.isFinite(passlyAmount) || passlyAmount < 1 || passlyAmount > 1000000) return res.status(400).json({ error: 'Enter Passly amount from 1 to 1,000,000.' });
  let code = generateCouponCode();
  while (await Coupon.findOne({ code })) code = generateCouponCode();
  const coupon = await Coupon.create({ _id: crypto.randomBytes(12).toString('hex'), code, passlyAmount, createdBy: req.user.id });
  res.json({ success: true, coupon });
});
app.post('/api/coupons/redeem', authenticateToken, async (req, res) => {
  const Coupon = mongoose.connection.readyState === 1 ? mongoose.model('Coupon') : null;
  const User = getUserModel();
  if (!Coupon || !User) return res.status(503).json({ error: 'Database not ready' });
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Coupon code required.' });
  const user = await User.findById(req.user.id);
  if (!user || isGuestRecord(user)) return res.status(403).json({ error: 'Guests cannot redeem coupons. Please log in with Roblox.' });
  const coupon = await Coupon.findOneAndUpdate(
    { code, redeemedBy: null },
    { redeemedBy: user._id, redeemedUsername: user.robloxUsername, redeemedAt: new Date() },
    { new: true }
  );
  if (!coupon) {
    const existing = await Coupon.findOne({ code });
    return res.status(400).json({ error: existing ? 'This coupon has already been redeemed.' : 'Coupon not found.' });
  }
  const balance = getCoinBalance(user) + coupon.passlyAmount;
  user.coins = balance;
  user.totalCoins = balance;
  await user.save();
  res.json({ success: true, passlyAmount: coupon.passlyAmount, coins: balance, totalCoins: balance });
});
app.post('/api/admin/grant', authenticateToken, async (req, res) => {
  if (req.user.id !== OWNER_ROBLOX_ID) return res.status(403).json({ error: 'Owner only' });
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  const { userId, role } = req.body;
  await User.findByIdAndUpdate(userId, { role });
  res.json({ success: true });
});
app.post('/api/admin/ban', authenticateToken, async (req, res) => {
  if (!(await isAdminOrOwner(req))) return res.status(403).json({ error: 'Admin only' });
  const { userId } = req.body;
  BANNED.add(userId);
  io.to(userId).emit('force-logout', { reason: 'You have been banned.' });
  res.json({ success: true });
});
app.post('/api/admin/unban', authenticateToken, async (req, res) => {
  if (!(await isAdminOrOwner(req))) return res.status(403);
  BANNED.delete(req.body.userId);
  res.json({ success: true });
});
app.post('/api/report', authenticateToken, async (req, res) => {
  const { reportedUserId, reason } = req.body;
  REPORTS.push({ _id: crypto.randomBytes(8).toString('hex'), reportedId: reportedUserId, reporterId: req.user.id, reason, timestamp: Date.now() });
  res.json({ success: true });
});
app.post('/api/admin/resolve-report', authenticateToken, async (req, res) => {
  if (!(await isAdminOrOwner(req))) return res.status(403);
  REPORTS = REPORTS.filter(r => r._id !== req.body.reportId);
  res.json({ success: true });
});
app.get('/api/admin/search-user', authenticateToken, async (req, res) => {
  if (!(await isAdminOrOwner(req))) return res.status(403);
  const User = getUserModel();
  if (!User) return res.json({ error: 'Database not ready' });
  const username = String(req.query.username || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const user = await User.findOne({ robloxUsername: new RegExp(`^${username}$`, 'i') });
  if (!user) return res.json({ error: 'User not found' });
  res.json({ id: user._id, username: user.robloxUsername, role: user.role });
});
app.post('/api/admin/broadcast', authenticateToken, async (req, res) => {
  if (!(await isAdminOrOwner(req))) return res.status(403);
  io.emit('admin-message', { roomId: 'GLOBAL', message: req.body.message });
  res.json({ success: true });
});
app.post('/api/admin/close-room', authenticateToken, async (req, res) => {
  if (!(await isAdminOrOwner(req))) return res.status(403).json({ error: 'Admin only' });
  const Room = mongoose.connection.readyState === 1 ? mongoose.model('Room') : null;
  if (!Room) return res.status(503).json({ error: 'Database not ready' });
  const { roomId } = req.body;
  if (!roomId) return res.status(400).json({ error: 'Room ID required' });
  const room = await Room.findById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  io.to(roomId).emit('room-closed', { message: 'Room closed by admin.' });
  const sockets = await io.in(roomId).fetchSockets();
  for (const sock of sockets) { sock.emit('force-leave', { reason: 'Room closed.' }); sock.leave(roomId); }
  await Room.deleteOne({ _id: roomId });
  const User = getUserModel();
  if (User) await User.updateMany({ roomId: roomId }, { $unset: { roomId: "", inQueue: "" } });
  res.json({ success: true, message: `Room ${roomId} closed.` });
});
// Website status endpoint
app.get('/api/admin/stats', authenticateToken, async (req, res) => {
  if (!(await isAdminOrOwner(req))) return res.status(403).json({ error: 'Admin only' });
  const User = getUserModel();
  const Donation = mongoose.connection.readyState === 1 ? mongoose.model('Donation') : null;
  const Room = mongoose.connection.readyState === 1 ? mongoose.model('Room') : null;
  const totalUsers = User ? await User.countDocuments({ role: { $ne: 'guest' } }) : 0;
  const totalGuests = User ? await User.countDocuments({ robloxUsername: /^Guest_/ }) : 0;
  const totalDonations = Donation ? await Donation.countDocuments() : 0;
  const totalRobuxDonated = Donation ? (await Donation.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]).then(r => r[0]?.total || 0)) : 0;
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const activeToday = User ? await User.countDocuments({ lastSeen: { $gte: oneDayAgo } }) : 0;
  const totalRooms = Room ? await Room.countDocuments() : 0;
  const activeRoomPlayers = Room ? (await Room.aggregate([{ $project: { count: { $size: '$players' } } }, { $group: { _id: null, total: { $sum: '$count' } } }]).then(r => r[0]?.total || 0)) : 0;
  res.json({
    totalUsers,
    totalGuests,
    totalDonations,
    totalRobuxDonated,
    onlineNow: onlineUsers.size,
    activeToday,
    totalRooms,
    activeRoomPlayers
  });
});
// Get list of online users with usernames
app.get('/api/admin/online-users', authenticateToken, async (req, res) => {
  if (!(await isAdminOrOwner(req))) return res.status(403).json({ error: 'Admin only' });
  const User = getUserModel();
  const onlineUsersArray = Array.from(onlineUsers);
  const users = [];
  for (const id of onlineUsersArray) {
    if (User) {
      const user = await User.findById(id);
      if (user) {
        users.push({
          id: user._id,
          username: user.robloxUsername,
          displayName: user.customDisplayName || user.robloxDisplayName || user.robloxUsername,
          isGuest: user.robloxUsername?.startsWith('Guest_') || false
        });
      } else {
        users.push({ id, username: id.startsWith('Guest_') ? id : 'Unknown', displayName: 'Unknown', isGuest: true });
      }
    } else {
      users.push({ id, username: id.startsWith('Guest_') ? id : 'Unknown', displayName: 'Unknown', isGuest: true });
    }
  }
  res.json({ onlineUsers: users });
});
app.get('/api/admin/rooms', authenticateToken, async (req, res) => {
  if (!(await isAdminOrOwner(req))) return res.status(403).json({ error: 'Admin only' });
  const Room = mongoose.connection.readyState === 1 ? mongoose.model('Room') : null;
  if (!Room) return res.status(503).json({ error: 'Database not ready' });
  const rooms = await Room.find().sort({ createdAt: -1 }).limit(100);
  res.json({ rooms: rooms.map(room => ({ id: room._id, name: room.name, type: room.type, players: room.players?.length || 0, queue: room.queue?.length || 0, createdBy: room.createdBy })) });
});
app.post('/api/admin/adjust-coins', authenticateToken, async (req, res) => {
  if (!(await isAdminOrOwner(req))) return res.status(403).json({ error: 'Admin only' });
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  const amount = Math.floor(Number(req.body.amount || 0));
  if (!req.body.userId || !Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'User and non-zero amount required.' });
  const user = await User.findById(req.body.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const balance = Math.max(0, getCoinBalance(user) + amount);
  user.coins = balance;
  user.totalCoins = balance;
  await user.save();
  res.json({ success: true, coins: balance, totalCoins: balance });
});
app.post('/api/admin/message-user', authenticateToken, async (req, res) => {
  if (!(await isAdminOrOwner(req))) return res.status(403).json({ error: 'Admin only' });
  const Notification = mongoose.connection.readyState === 1 ? mongoose.model('Notification') : null;
  if (!Notification) return res.status(503).json({ error: 'Database not ready' });
  const message = filterMessageServer(String(req.body.message || '').slice(0, 300).trim());
  if (!req.body.userId || !message) return res.status(400).json({ error: 'User and message required.' });
  await Notification.create({ _id: crypto.randomBytes(8).toString('hex'), userId: req.body.userId, type: 'admin_message', fromUserId: req.user.id, message, read: false });
  io.to(req.body.userId).emit('admin-message', { roomId: 'DIRECT', message });
  res.json({ success: true });
});
app.post('/api/admin/set-role', authenticateToken, async (req, res) => {
  if (!(await isOwnerRequest(req))) return res.status(403).json({ error: 'Owner only' });
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  const role = String(req.body.role || 'user');
  if (!['user','vip','admin','owner'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  await User.findByIdAndUpdate(req.body.userId, { role });
  res.json({ success: true });
});
app.get('/api/health', (req, res) => { res.status(200).send('ok'); });
// ========== FRIEND & MESSAGE ENDPOINTS (guest‑disabled) ==========
// Helper to check if user is a guest
async function isGuestUser(userId) {
  const User = mongoose.model('User');
  const user = await User.findById(userId);
  return isGuestRecord(user);
}

async function wantsNotification(userId, key) {
  const User = getUserModel();
  const user = User ? await User.findById(userId) : null;
  return user?.notificationPreferences?.[key] !== false;
}
// Send friend request
app.post('/api/friends/request', authenticateToken, async (req, res) => {
  if (await isGuestUser(req.user.id)) return res.status(403).json({ error: 'Guests cannot use friends features.' });
  const { toUserId } = req.body;
  if (!toUserId) return res.status(400).json({ error: 'User ID required' });
  if (toUserId === req.user.id) return res.status(400).json({ error: 'Cannot send request to yourself' });
  const FriendRequest = mongoose.model('FriendRequest');
  const existing = await FriendRequest.findOne({ from: req.user.id, to: toUserId, status: 'pending' });
  if (existing) return res.status(400).json({ error: 'Request already sent' });
  const request = new FriendRequest({
    _id: crypto.randomBytes(8).toString('hex'),
    from: req.user.id,
    to: toUserId,
    status: 'pending'
  });
  await request.save();
  const Notification = mongoose.model('Notification');
  const notification = new Notification({
    _id: crypto.randomBytes(8).toString('hex'),
    userId: toUserId,
    type: 'friend_request',
    fromUserId: req.user.id,
    message: 'sent you a friend request',
    read: false
  });
  await notification.save();
  res.json({ success: true });
});

// Respond to friend request
app.post('/api/friends/respond', authenticateToken, async (req, res) => {
  if (await isGuestUser(req.user.id)) return res.status(403).json({ error: 'Guests cannot use friends features.' });
  const { requestId, accept } = req.body;
  const FriendRequest = mongoose.model('FriendRequest');
  const request = await FriendRequest.findById(requestId);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.to !== req.user.id) return res.status(403).json({ error: 'Not allowed' });
  request.status = accept ? 'accepted' : 'rejected';
  await request.save();
  if (accept) {
    const Notification = mongoose.model('Notification');
    const notification = new Notification({
      _id: crypto.randomBytes(8).toString('hex'),
      userId: request.from,
      type: 'friend_accepted',
      fromUserId: req.user.id,
      message: 'accepted your friend request',
      read: false
    });
    await notification.save();
  }
  res.json({ success: true });
});

// Get friends list
app.get('/api/friends/list', authenticateToken, async (req, res) => {
  if (await isGuestUser(req.user.id)) return res.json({ friends: [] });
  const FriendRequest = mongoose.model('FriendRequest');
  const User = mongoose.model('User');
  const requests = await FriendRequest.find({
    $or: [{ from: req.user.id }, { to: req.user.id }],
    status: 'accepted'
  });
  const friendIds = new Set();
  for (const req of requests) {
    const friendId = req.from === req.user.id ? req.to : req.from;
    friendIds.add(friendId);
  }
  const friends = [];
  for (const id of friendIds) {
    const user = await User.findById(id);
    if (user) {
      friends.push({
        id: user._id,
        username: user.robloxUsername,
        displayName: user.customDisplayName || user.robloxDisplayName || user.robloxUsername,
        avatarUrl: user.avatarUrl
      });
    }
  }
  res.json({ friends });
});
// Get pending incoming friend requests
app.get('/api/friends/requests', authenticateToken, async (req, res) => {
  if (await isGuestUser(req.user.id)) return res.json({ requests: [] });
  const FriendRequest = mongoose.model('FriendRequest');
  const User = mongoose.model('User');
  const requests = await FriendRequest.find({ to: req.user.id, status: 'pending' });
  const result = [];
  for (const req of requests) {
    const user = await User.findById(req.from);
    if (user) {
      result.push({
        id: req._id,
        fromUserId: user._id,
        username: user.robloxUsername,
        displayName: user.customDisplayName || user.robloxDisplayName || user.robloxUsername,
        avatarUrl: user.avatarUrl,
        timestamp: req.timestamp
      });
    }
  }
  res.json({ requests: result });
});

// Send private message
app.post('/api/friends/message', authenticateToken, async (req, res) => {
  if (await isGuestUser(req.user.id)) return res.status(403).json({ error: 'Guests cannot send messages.' });
  const { toUserId, message } = req.body;
  if (!toUserId || !message) return res.status(400).json({ error: 'Missing fields' });
  const filteredMsg = filterMessageServer(message);
  const PrivateMessage = mongoose.model('PrivateMessage');
  const msg = new PrivateMessage({
    _id: crypto.randomBytes(8).toString('hex'),
    from: req.user.id,
    to: toUserId,
    message: filteredMsg,
    read: false
  });
  await msg.save();
  const Notification = mongoose.model('Notification');
  if (await wantsNotification(toUserId, 'friendMessages')) {
    const notification = new Notification({
      _id: crypto.randomBytes(8).toString('hex'),
      userId: toUserId,
      type: 'new_message',
      fromUserId: req.user.id,
      message: 'sent you a message',
      read: false
    });
    await notification.save();
  }
  res.json({ success: true, message: filteredMsg });
});

// Get conversation between two users
app.get('/api/friends/messages/:userId', authenticateToken, async (req, res) => {
  if (await isGuestUser(req.user.id)) return res.json({ messages: [] });
  const otherUserId = req.params.userId;
  const PrivateMessage = mongoose.model('PrivateMessage');
  const messages = await PrivateMessage.find({
    $or: [
      { from: req.user.id, to: otherUserId },
      { from: otherUserId, to: req.user.id }
    ]
  }).sort({ timestamp: 1 });
  await PrivateMessage.updateMany({ from: otherUserId, to: req.user.id, read: false }, { read: true });
  res.json({ messages });
});

// Delete a private message
app.delete('/api/friends/messages/:messageId', authenticateToken, async (req, res) => {
  if (await isGuestUser(req.user.id)) return res.status(403).json({ error: 'Guests cannot delete messages.' });
  const PrivateMessage = mongoose.model('PrivateMessage');
  const msg = await PrivateMessage.findById(req.params.messageId);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.from !== req.user.id && msg.to !== req.user.id) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  await msg.deleteOne();
  res.json({ success: true });
});

// Get user's notifications
app.get('/api/friends/notifications', authenticateToken, async (req, res) => {
  if (await isGuestUser(req.user.id)) return res.json({ notifications: [] });
  const Notification = mongoose.model('Notification');
  const notifications = await Notification.find({ userId: req.user.id, read: false }).sort({ timestamp: -1 });
  const User = mongoose.model('User');
  const enriched = [];
  for (const notif of notifications) {
    const sender = await User.findById(notif.fromUserId);
    enriched.push({
      id: notif._id,
      type: notif.type,
      fromUserId: notif.fromUserId,
      fromName: sender ? (sender.customDisplayName || sender.robloxDisplayName || sender.robloxUsername) : 'Unknown',
      message: notif.message,
      timestamp: notif.timestamp,
      read: notif.read
    });
  }
  res.json({ notifications: enriched });
});

// Mark notification as read
app.post('/api/friends/notifications/read', authenticateToken, async (req, res) => {
  if (await isGuestUser(req.user.id)) return res.status(403).json({ error: 'Guests cannot manage notifications.' });
  const { notificationId } = req.body;
  const Notification = mongoose.model('Notification');
  await Notification.findByIdAndUpdate(notificationId, { read: true });
  res.json({ success: true });
});

// ========== FETCH USER'S GAMEPASSES FROM ROBLOX (FIXED with OAuth) ==========
app.get('/api/user/gamepasses', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const User = mongoose.model('User');
    const user = await User.findById(userId);
    if (!user || !user.robloxAccessToken) {
      return res.status(401).json({ error: 'Missing Roblox access token. Please re-login.' });
    }

    const accessToken = user.robloxAccessToken;
    // Use the v2 inventory API with Authorization header
    const url = `https://inventory.roblox.com/v2/users/${userId}/inventory?assetTypes=GamePass&limit=100`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10000
    });
    const items = response.data?.data || [];
    const gamepasses = items.map(item => ({
      assetId: item.id,
      name: item.name,
      created: item.created
    }));
    res.json({ gamepasses });
  } catch (error) {
    console.error('Failed to fetch gamepasses:', error.message);
    if (error.response && error.response.status === 401) {
      return res.status(401).json({ error: 'Roblox token expired. Please re-login.' });
    }
    res.status(500).json({ error: 'Could not fetch gamepasses from Roblox. ' + error.message });
  }
});

// ========== FALLBACK – MUST BE LAST ==========
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });