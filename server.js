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

// Fallback default rooms (in case DB fails)
const FALLBACK_ROOMS = [
  { _id: "room1", name: "Chill Donations", desc: "Relax and donate to small creators.", type: "Public", players: [], queue: [], maxPlayers: 18, createdBy: "system" },
  { _id: "room2", name: "Big Donators", desc: "High donation rooms with active players.", type: "Public", players: [], queue: [], maxPlayers: 18, createdBy: "system" },
  { _id: "room3", name: "Anime Fans", desc: "A room for anime lovers.", type: "Public", players: [], queue: [], maxPlayers: 18, createdBy: "system" }
];

mongoose.connect(MONGO_URI).then(async () => {
  console.log('MongoDB connected');
  const userSchema = new mongoose.Schema({
    _id: String, robloxUsername: String, robloxDisplayName: String,
    customDisplayName: String, avatarUrl: String,
    role: { type: String, default: 'user', enum: ['user', 'vip', 'admin', 'owner'] },
    profile: { showBooth: { type: Boolean, default: true }, statusDot: { type: String, default: 'online' }, showRoomId: { type: Boolean, default: true } },
    roomId: String, inQueue: Boolean,
    donations: { received: Number, given: Number },
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
  const roomSchema = new mongoose.Schema({
    _id: String, name: String, desc: String, type: { type: String, enum: ['Public', 'Private', 'VIP'] },
    players: [String], queue: [String], maxPlayers: { type: Number, default: 18 },
    createdBy: String, createdAt: { type: Date, default: Date.now }
  });
  const donationSchema = new mongoose.Schema({
    _id: String, donorId: String, donorName: String, receiverId: String,
    receiverName: String, gamepassId: String, amount: Number,
    roomId: String, verified: { type: Boolean, default: true },
    timestamp: { type: Date, default: Date.now }
  });
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

  mongoose.model('User', userSchema);
  mongoose.model('Room', roomSchema);
  mongoose.model('Donation', donationSchema);
  mongoose.model('Ad', adSchema);
  mongoose.model('AdBroadcast', adBroadcastSchema);

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
const OAuthState = mongoose.model('OAuthState', oauthStateSchema);

function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user; next();
  });
}

// ========== PUBLIC API PATHS (no token required) ==========
const publicApiPaths = ['/rooms', '/health', '/guest-login', '/search'];
app.use('/api', (req, res, next) => {
  if (publicApiPaths.some(path => req.path === path)) {
    return next();
  }
  authenticateToken(req, res, next);
});

// Update lastSeen only for authenticated requests (req.user is set by authenticateToken)
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
    const ui = await axios.get(ROBLOX_CONFIG.userInfoUrl, { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } });
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

    await mongoose.model('User').findOneAndUpdate({ _id: userId }, { $set: { robloxUsername, robloxDisplayName, avatarUrl } }, { upsert: true, setDefaultsOnInsert: true });
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
    role: user.role, acceptedTos: user.acceptedTos
  });
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
    avatarUrl: user.avatarUrl
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

app.post('/api/profile/update', authenticateToken, async (req, res) => {
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  const { showBooth, statusDot, showRoomId, customDisplayName } = req.body;
  const update = {};
  if (showBooth !== undefined) update['profile.showBooth'] = showBooth;
  if (statusDot) update['profile.statusDot'] = statusDot;
  if (showRoomId !== undefined) update['profile.showRoomId'] = showRoomId;
  if (customDisplayName !== undefined) update.customDisplayName = customDisplayName.trim().substring(0,20) || null;
  await User.findByIdAndUpdate(req.user.id, { $set: update });
  res.json({ success: true });
});

app.get('/api/search', async (req, res) => {
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  const q = (req.query.username || '').toLowerCase().trim();
  if (!q) return res.status(400).json({ error: 'Username required' });
  const found = await User.findOne({ robloxUsername: new RegExp(`^${q}$`, 'i') });
  if (!found) return res.json({ error: 'User not found' });
  res.json({ id: found._id, robloxUsername: found.robloxUsername, displayName: found.customDisplayName || found.robloxDisplayName, avatarUrl: found.avatarUrl, board: found.profile?.showBooth !== false ? (found.board || []) : [] });
});

app.get('/api/user/:userId/board', authenticateToken, async (req, res) => {
  const User = getUserModel();
  if (!User) return res.status(503).json({ error: 'Database not ready' });
  const user = await User.findById(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user._id, displayName: user.customDisplayName || user.robloxDisplayName, avatarUrl: user.avatarUrl, board: user.profile?.showBooth !== false ? (user.board || []) : [] });
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
  const room = await Room.findById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const user = await User.findById(req.user.id);
  if (room.type === 'VIP' && user.role !== 'vip' && user.role !== 'admin' && user.role !== 'owner') {
    return res.status(403).json({ error: 'VIP room – need VIP role.' });
  }
  if (room.players.includes(req.user.id)) return res.json({ success: true, room, alreadyIn: true });
  if (room.players.length >= room.maxPlayers) {
    if (!room.queue.includes(req.user.id)) { room.queue.push(req.user.id); await room.save(); }
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
  const room = await Room.findById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.type === 'VIP') return res.status(403).json({ error: 'Guests cannot join VIP rooms.' });
  if (room.players.includes(guestId)) return res.json({ success: true, room, alreadyIn: true });
  if (room.players.length >= room.maxPlayers) {
    if (!room.queue.includes(guestId)) { room.queue.push(guestId); await room.save(); }
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
  'fuck', 'shit', 'ass', 'bitch', 'cunt', 'dick', 'pussy', 'twat', 'whore', 'slut', 'bastard', 'damn', 'hell', 'piss', 'cock',
  'faggot', 'nigga', 'nigger', 'retard', 'fck', 'fcuk', 'phuk', 'fuk', 'sh1t', 'sht', 'b1tch', 'btch', 'c0ck', 'd1ck', 'dck',
  'pussy', 'cunt', 'cnt', 'n1gga', 'n1gger', 'ngga', 'f4ggot', 'fag', 'f4g', 'ret4rd', 'rtrd', 'b8stard', 'bstrd', 'wh0re',
  'whre', 'slut', 'b!tch', 'c0k', 'dik', 'dikhed', 'clit', 'cl1t', 'tw4t', 'wanker', 'w4nker', 'bollocks', 'arse', 'arsehole',
  '5hit', '5h1t', 'phoque', 'kunt', 'kuk', 'kak'
];
function normalizeTextServer(text) {
  let normalized = text.toLowerCase();
  normalized = normalized.replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't');
  normalized = normalized.replace(/@/g, 'a').replace(/\$/g, 's').replace(/\+/g, 't');
  normalized = normalized.replace(/[\s\._\-*]/g, '');
  return normalized;
}
function filterMessageServer(text) {
  if (!text) return text;
  const normalized = normalizeTextServer(text);
  for (const bad of BAD_WORDS_LIST_SERVER) {
    if (normalized.includes(bad)) return '#'.repeat(text.length);
  }
  return text;
}

const guestChatCooldown = new Map();
const onlineUsers = new Set();

// ========== SOCKET.IO WITH CHAT ISOLATION ==========
io.on('connection', (socket) => {
  let currentRoomId = null;
  let userId = null;
  let guestId = null;
  let isGuest = false;

  socket.on('authenticate', (token) => {
    if (!token) return;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.id;
      socket.userId = userId;
      isGuest = false;
      onlineUsers.add(userId);
      if (mongoose.connection.readyState === 1) {
        mongoose.model('User').findByIdAndUpdate(userId, { lastSeen: new Date() }).catch(()=>{});
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

  socket.on('join-room', (roomId) => {
    if (currentRoomId) socket.leave(currentRoomId);
    currentRoomId = roomId;
    socket.join(roomId);
    console.log(`Socket ${socket.id} joined room ${roomId}`);
  });

  socket.on('disconnect', () => {
    if (userId) onlineUsers.delete(userId);
    if (guestId) onlineUsers.delete(guestId);
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
        socket.emit('chat-error', 'Guest cooldown: 1 message per 25 sec.');
        return;
      }
      guestChatCooldown.set(guestId, now);
    }

    let messageText = msg;
    let senderName = '';
    let senderAvatar = '';
    let isAdmin = false;
    let isOwner = false;
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
      isOwner
    });
  });

  socket.on('chat-board', async (boardData) => {
    if (!userId || !currentRoomId) return;
    const User = mongoose.connection.readyState === 1 ? mongoose.model('User') : null;
    const user = User ? await User.findById(userId) : null;
    if (!user) return;
    io.to(currentRoomId).emit('chat-board', {
      userId,
      username: user.customDisplayName || user.robloxDisplayName || user.robloxUsername,
      board: boardData,
      avatarUrl: user.avatarUrl
    });
  });

  socket.on('voice-data', (audioBuffer) => {
    if ((!userId && !guestId) || !currentRoomId) return;
    const senderId = userId || guestId;
    socket.to(currentRoomId).emit('voice-data', { userId: senderId, audio: audioBuffer });
  });

  socket.on('leave-room', () => {
    if (currentRoomId) {
      socket.leave(currentRoomId);
      currentRoomId = null;
    }
  });
});

// LEADERBOARD (needs DB)
app.get('/api/leaderboard', async (req, res) => {
  const Donation = mongoose.connection.readyState === 1 ? mongoose.model('Donation') : null;
  if (!Donation) return res.json({ receivers: [], donors: [] });
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
  res.json({ receivers: await enrich(receivers), donors: await enrich(donors) });
});

// ADS (needs DB)
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
    const user = new User({ _id: guestId, robloxUsername: username, robloxDisplayName: username, customDisplayName: username, avatarUrl: '', donations: { received: 0, given: 0 }, board: [], role: 'user', acceptedTos: false });
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
  if (!User || !Donation) return res.status(503).json({ error: 'Database not ready' });
  const donor = await User.findById(donorId);
  if (!donor) return res.status(404).json({ error: 'User not found' });

  const existing = await Donation.findOne({ donorId, receiverId, gamepassId, amount });
  if (existing) return res.status(400).json({ error: 'You have already donated this gamepass to this user.' });

  try {
    const inv = await axios.get(`https://inventory.roblox.com/v1/users/${donorId}/items/GamePass/${gamepassId}`, { timeout: 5000 });
    if (!inv.data?.data?.length) return res.status(400).json({ error: 'You do not own this gamepass.' });
  } catch (err) { return res.status(500).json({ error: 'Failed to verify ownership.' }); }

  const receiver = await User.findById(receiverId);
  if (!receiver) return res.status(404).json({ error: 'Receiver not found' });
  const donation = new Donation({
    _id: crypto.randomBytes(8).toString('hex'), donorId, donorName: donor.robloxUsername,
    receiverId, receiverName: receiver.robloxUsername, gamepassId, amount, roomId: null, verified: true, timestamp: new Date()
  });
  await donation.save();
  await User.findByIdAndUpdate(donorId, { $inc: { 'donations.given': amount } });
  await User.findByIdAndUpdate(receiverId, { $inc: { 'donations.received': amount } });
  pendingDonations.delete(donorId);
  res.json({ success: true, message: 'Donation recorded! Thank you.' });
});
const OWNER_ROBLOX_ID = '3115362000';
const ADMINS = new Set();
const BANNED = new Set();
let REPORTS = [];

async function isAdminOrOwner(req) {
  const User = getUserModel();
  if (!User) return false;
  const user = await User.findById(req.user.id);
  if (!user) return false;
  if (user._id === OWNER_ROBLOX_ID) return true;
  return ADMINS.has(user._id);
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
  const user = await User.findOne({ robloxUsername: new RegExp(`^${req.query.username}$`, 'i') });
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
  const totalUsers = User ? await User.countDocuments({ role: { $ne: 'guest' } }) : 0;
  const totalGuests = User ? await User.countDocuments({ robloxUsername: /^Guest_/ }) : 0;
  const totalDonations = Donation ? await Donation.countDocuments() : 0;
  const totalRobuxDonated = Donation ? (await Donation.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]).then(r => r[0]?.total || 0)) : 0;
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const activeToday = User ? await User.countDocuments({ lastSeen: { $gte: oneDayAgo } }) : 0;
  res.json({
    totalUsers,
    totalGuests,
    totalDonations,
    totalRobuxDonated,
    onlineNow: onlineUsers.size,
    activeToday
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
app.get('/api/health', (req, res) => { res.status(200).send('ok'); });


app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'terms.html')));

// FALLBACK – MUST BE LAST
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });