const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const mongoose = require('mongoose');
const { generateRegistrationOptions, verifyRegistrationResponse } = require('@simplewebauthn/server');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'passly-jwt-secret-2024';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/passly';
const RP_ID = process.env.RP_ID || 'localhost';
const RP_NAME = 'Passly';
const ORIGIN = process.env.ORIGIN || 'http://localhost:3000';

// ----- MongoDB Connection & Schemas -----
mongoose.connect(MONGO_URI).then(async () => {
  console.log('MongoDB connected');

  const userSchema = new mongoose.Schema({
    _id: String,
    robloxUsername: String,
    robloxDisplayName: String,
    customDisplayName: String,
    avatarUrl: String,
    profile: {
      showBooth: { type: Boolean, default: true },
      statusDot: { type: String, default: 'online' },
      showRoomId: { type: Boolean, default: true }
    },
    roomId: String,
    inQueue: Boolean,
    donations: { received: Number, given: Number },
    board: [{ id: String, name: String, price: Number }],
    credentials: [{ id: String, publicKey: Buffer, counter: Number, transports: [String] }],
    currentRegistrationChallenge: String,
    createdAt: { type: Date, default: Date.now }
  });

  const roomSchema = new mongoose.Schema({
    _id: String,
    name: String,
    desc: String,
    type: String,
    players: [String],
    queue: [String],
    maxPlayers: { type: Number, default: 18 },
    createdBy: String,
    createdAt: { type: Date, default: Date.now }
  });

  const donationSchema = new mongoose.Schema({
    _id: String,
    donorId: String,
    donorName: String,
    receiverId: String,
    receiverName: String,
    gamepassId: String,
    amount: Number,
    roomId: String,
    timestamp: { type: Date, default: Date.now }
  });

  const adSchema = new mongoose.Schema({
    _id: String,
    userId: String,
    username: String,
    tier: Number,
    gamepassId: String,
    broadcastsLeft: Number,
    showsLeft: Number,
    active: Boolean,
    message: String,
    purchasedAt: { type: Date, default: Date.now }
  });

  const adBroadcastSchema = new mongoose.Schema({
    roomId: String,
    board: [mongoose.Schema.Types.Mixed],
    advertiserName: String,
    advertiserId: String,
    message: String,
    timestamp: { type: Date, default: Date.now }
  });

  mongoose.model('User', userSchema);
  mongoose.model('Room', roomSchema);
  mongoose.model('Donation', donationSchema);
  mongoose.model('Ad', adSchema);
  mongoose.model('AdBroadcast', adBroadcastSchema);

  const Room = mongoose.model('Room');

  // Remove old duplicate default rooms
  await Room.deleteMany({
    name: { $in: ["Chill Donations", "Big Donators", "Anime Fans"] },
    _id: { $nin: ["room1", "room2", "room3"] }
  });

  const defaultRooms = [
    { _id: "room1", name: "Chill Donations", desc: "Relax and donate to small creators." },
    { _id: "room2", name: "Big Donators", desc: "High donation rooms with active players." },
    { _id: "room3", name: "Anime Fans", desc: "A room for anime lovers." }
  ];
  for (const r of defaultRooms) {
    await Room.findOneAndUpdate(
      { _id: r._id },
      { $setOnInsert: { ...r, type: 'Public', players: [], queue: [], maxPlayers: 18, createdBy: 'system' } },
      { upsert: true, new: true }
    );
  }
  console.log('Default rooms cleaned and ensured.');

  server.listen(PORT, () => console.log(`Passly running on port ${PORT}`));
}).catch(err => { console.error('MongoDB error:', err); process.exit(1); });

// ----- Middleware -----
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

const ROBLOX_CONFIG = {
  clientId: process.env.ROBLOX_CLIENT_ID,
  clientSecret: process.env.ROBLOX_CLIENT_SECRET,
  redirectUri: process.env.ROBLOX_REDIRECT_URI || 'http://localhost:3000/auth/roblox/callback',
  authUrl: 'https://apis.roblox.com/oauth/v1/authorize',
  tokenUrl: 'https://apis.roblox.com/oauth/v1/token',
  userInfoUrl: 'https://apis.roblox.com/oauth/v1/userinfo',
  usersApi: 'https://users.roblox.com/v1/users'
};
const GAMEPASSES = { '5k': process.env.GAMEPASS_5K, '10k': process.env.GAMEPASS_10K };

const oauthStateSchema = new mongoose.Schema({
  state: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now, expires: 600 }
});
const OAuthState = mongoose.model('OAuthState', oauthStateSchema);

function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

// ----- PAGES -----
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/rooms', (req, res) => res.sendFile(path.join(__dirname, 'rooms.html')));
app.get('/leaderboard', (req, res) => res.sendFile(path.join(__dirname, 'leaderboard.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'profile.html')));
app.get('/advertisement', (req, res) => res.sendFile(path.join(__dirname, 'advertisement.html')));
app.get('/livedonations', (req, res) => res.sendFile(path.join(__dirname, 'livedonations.html')));

// ========== OAUTH ==========
app.get('/auth/roblox', async (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  await OAuthState.create({ state });
  res.redirect(`${ROBLOX_CONFIG.authUrl}?${new URLSearchParams({
    client_id: ROBLOX_CONFIG.clientId,
    redirect_uri: ROBLOX_CONFIG.redirectUri,
    response_type: 'code',
    scope: 'openid',
    state
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
      new URLSearchParams({
        client_id: ROBLOX_CONFIG.clientId,
        client_secret: ROBLOX_CONFIG.clientSecret,
        grant_type: 'authorization_code',
        code
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const ui = await axios.get(ROBLOX_CONFIG.userInfoUrl, {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
    });
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
      { $set: { robloxUsername, robloxDisplayName, avatarUrl } },
      { upsert: true, setDefaultsOnInsert: true }
    );
    const user = await mongoose.model('User').findById(userId);
    const displayName = user.customDisplayName || robloxDisplayName;
    const jwtToken = jwt.sign({ id: userId, username: robloxUsername, displayName, avatarUrl }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('passly_token', jwtToken, { maxAge: 7*24*60*60*1000, httpOnly: false, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
    res.redirect(`/dashboard#token=${jwtToken}`);
  } catch (e) {
    console.error(e);
    res.send('<h1>Login Failed</h1><a href="/">Go back</a>');
  }
});

// ========== USER API ==========
app.get('/api/user', authenticateToken, async (req, res) => {
  const User = mongoose.model('User');
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const avatarUrl = user.avatarUrl || '';
  const avatarFallback = avatarUrl ? '' : `https://www.roblox.com/bust-thumbnail/image?userId=${user._id}&width=150&height=150&format=png`;
  const activeAd = await mongoose.model('Ad').findOne({ userId: user._id, active: true });
  res.json({
    id: user._id,
    robloxUsername: user.robloxUsername || '',
    robloxDisplayName: user.robloxDisplayName || '',
    displayName: user.customDisplayName || user.robloxDisplayName || '',
    avatarUrl,
    avatarFallback,
    profile: user.profile,
    roomId: user.roomId,
    inQueue: user.inQueue,
    donations: user.donations,
    ad: activeAd || null,
    customDisplayName: user.customDisplayName || null,
    board: user.board || []
  });
});

app.post('/api/profile/update', authenticateToken, async (req, res) => {
  const { showBooth, statusDot, showRoomId, customDisplayName } = req.body;
  const update = {};
  if (showBooth !== undefined) update['profile.showBooth'] = showBooth;
  if (statusDot) update['profile.statusDot'] = statusDot;
  if (showRoomId !== undefined) update['profile.showRoomId'] = showRoomId;
  if (customDisplayName !== undefined) update.customDisplayName = customDisplayName.trim().substring(0,20) || null;
  await mongoose.model('User').findByIdAndUpdate(req.user.id, { $set: update });
  res.json({ success: true });
});

// ========== SEARCH ==========
app.get('/api/search', async (req, res) => {
  const q = (req.query.username || '').toLowerCase().trim();
  if (!q) return res.status(400).json({ error: 'Username required' });
  const found = await mongoose.model('User').findOne({ robloxUsername: new RegExp(`^${q}$`, 'i') });
  if (!found) return res.json({ error: 'User not found' });
  res.json({
    id: found._id,
    robloxUsername: found.robloxUsername,
    displayName: found.customDisplayName || found.robloxDisplayName,
    avatarUrl: found.avatarUrl,
    board: found.profile?.showBooth !== false ? (found.board || []) : []
  });
});

// ========== PUBLIC BOARD ==========
app.get('/api/user/:userId/board', authenticateToken, async (req, res) => {
  const user = await mongoose.model('User').findById(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    id: user._id,
    displayName: user.customDisplayName || user.robloxDisplayName,
    avatarUrl: user.avatarUrl,
    board: user.profile?.showBooth !== false ? (user.board || []) : []
  });
});

// ========== BOARD (add/remove) ==========
app.post('/api/board/add', authenticateToken, async (req, res) => {
  const { assetId, price } = req.body;
  if (!assetId || !price) return res.status(400).json({ error: 'Asset ID and Robux amount required' });
  const User = mongoose.model('User');
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.board.some(g => g.id === assetId)) return res.status(400).json({ error: 'Already on board' });
  try {
    const check = await axios.get(`https://inventory.roblox.com/v1/users/${user._id}/items/GamePass/${assetId}`, { timeout: 5000 });
    if (!check.data?.data?.length) return res.status(400).json({ error: 'You do not own this gamepass' });
  } catch (e) {
    return res.status(400).json({ error: 'Ownership verification failed' });
  }
  user.board.push({ id: assetId, name: 'Gamepass', price: parseInt(price) });
  await user.save();
  res.json({ success: true, board: user.board });
});

app.post('/api/board/remove', authenticateToken, async (req, res) => {
  await mongoose.model('User').findByIdAndUpdate(req.user.id, { $pull: { board: { id: req.body.assetId } } });
  const user = await mongoose.model('User').findById(req.user.id);
  res.json({ success: true, board: user.board });
});
// ========== ROOMS API ==========
app.get('/api/rooms', async (req, res) => {
  const rooms = await mongoose.model('Room').find();
  res.json(rooms);
});

app.post('/api/rooms/create', authenticateToken, async (req, res) => {
  const { name, desc, type } = req.body;
  if (!name) return res.status(400).json({ error: 'Room name required' });
  const Room = mongoose.model('Room');
  const roomId = crypto.randomBytes(8).toString('hex');
  const room = new Room({
    _id: roomId,
    name,
    desc: desc || '',
    type: type || 'Public',
    players: [req.user.id],
    queue: [],
    createdBy: req.user.id
  });
  await room.save();
  await mongoose.model('User').findByIdAndUpdate(req.user.id, { roomId: room._id, inQueue: false });
  res.json(room);
});

app.post('/api/rooms/join/:id', authenticateToken, async (req, res) => {
  const roomId = req.params.id;
  const Room = mongoose.model('Room');
  const User = mongoose.model('User');
  const room = await Room.findById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  if (room.players.includes(req.user.id)) {
    return res.json({ success: true, room, alreadyIn: true });
  }

  if (room.players.length >= room.maxPlayers) {
    if (!room.queue.includes(req.user.id)) {
      room.queue.push(req.user.id);
      await room.save();
    }
    const position = room.queue.indexOf(req.user.id) + 1;
    return res.json({ queued: true, position });
  }

  room.players.push(req.user.id);
  await room.save();
  await User.findByIdAndUpdate(req.user.id, { roomId: room._id, inQueue: false });

  io.to(roomId).emit('player-joined', { userId: req.user.id, username: req.user.displayName });
  res.json({ success: true, room });
});

app.post('/api/rooms/leave', authenticateToken, async (req, res) => {
  const User = mongoose.model('User');
  const user = await User.findById(req.user.id);
  if (!user || !user.roomId) return res.json({ success: true });
  const Room = mongoose.model('Room');
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

// ----- Socket.io -----
io.on('connection', (socket) => {
  let currentRoomId = null;
  let userId = null;

  socket.on('authenticate', (token) => {
    if (!token) return;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.id;
      socket.userId = userId;
    } catch (e) {}
  });

  socket.on('join-room', async (roomId) => {
    if (currentRoomId) socket.leave(currentRoomId);
    currentRoomId = roomId;
    socket.join(roomId);
  });

  socket.on('chat-message', async (msg) => {
    if (!userId || !currentRoomId) return;
    const User = mongoose.model('User');
    const user = await User.findById(userId);
    if (!user) return;
    const username = user.customDisplayName || user.robloxDisplayName || user.robloxUsername;
    const avatarUrl = user.avatarUrl || '';
    io.to(currentRoomId).emit('chat-message', {
      userId,
      username,
      message: msg,
      avatarUrl,
      timestamp: Date.now()
    });
  });

  socket.on('chat-board', async (boardData) => {
    if (!userId || !currentRoomId) return;
    const User = mongoose.model('User');
    const user = await User.findById(userId);
    if (!user) return;
    const username = user.customDisplayName || user.robloxDisplayName || user.robloxUsername;
    io.to(currentRoomId).emit('chat-board', {
      userId,
      username,
      board: boardData,
      avatarUrl: user.avatarUrl
    });
  });

  socket.on('voice-data', (audioBuffer) => {
    if (!userId || !currentRoomId) return;
    socket.to(currentRoomId).emit('voice-data', { userId, audio: audioBuffer });
  });

  socket.on('leave-room', () => {
    if (currentRoomId) socket.leave(currentRoomId);
    currentRoomId = null;
  });
});

// ========== LEADERBOARD ==========
app.get('/api/leaderboard', async (req, res) => {
  const period = req.query.period || 'daily';
  let startDate = new Date();
  if (period === 'daily') startDate.setHours(0,0,0,0);
  else if (period === 'weekly') startDate.setDate(startDate.getDate() - 7);
  else if (period === 'total') startDate = new Date(0);

  const Donation = mongoose.model('Donation');
  const match = period === 'total' ? {} : { timestamp: { $gte: startDate } };

  const receivers = await Donation.aggregate([
    { $match: match },
    { $group: { _id: '$receiverId', total: { $sum: '$amount' } } },
    { $sort: { total: -1 } },
    { $limit: 10 }
  ]);

  const donors = await Donation.aggregate([
    { $match: match },
    { $group: { _id: '$donorId', total: { $sum: '$amount' } } },
    { $sort: { total: -1 } },
    { $limit: 10 }
  ]);

  const User = mongoose.model('User');
  const enrich = async (arr) => {
    const result = [];
    for (const item of arr) {
      const user = await User.findById(item._id);
      if (user) {
        result.push({
          username: user.customDisplayName || user.robloxDisplayName || user.robloxUsername,
          amount: item.total
        });
      } else {
        result.push({ username: 'Unknown', amount: item.total });
      }
    }
    return result;
  };

  res.json({
    receivers: await enrich(receivers),
    donors: await enrich(donors)
  });
});

// ========== ADS ==========
app.get('/api/ads', async (req, res) => {
  const ads = await mongoose.model('Ad').find({ active: true, showsLeft: { $gt: 0 } }).limit(5);
  res.json(ads.map(ad => ({
    userId: ad.userId,
    username: ad.username,
    tier: ad.tier,
    message: ad.message,
    showsLeft: ad.showsLeft
  })));
});

app.post('/api/purchase-ad', authenticateToken, async (req, res) => {
  const { tier, message } = req.body;
  if (!tier || (tier !== '5k' && tier !== '10k')) return res.status(400).json({ error: 'Invalid tier' });
  const gamepassId = GAMEPASSES[tier];
  if (!gamepassId) return res.status(400).json({ error: 'Gamepass not configured' });

  const User = mongoose.model('User');
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const existing = await mongoose.model('Ad').findOne({ userId: req.user.id, active: true });
  if (existing) return res.status(400).json({ error: 'You already have an active ad. Delete it first.' });

  const tierNum = tier === '5k' ? 5000 : 10000;
  const shows = tier === '5k' ? 1 : 3;
  const ad = new (mongoose.model('Ad'))({
    _id: crypto.randomBytes(8).toString('hex'),
    userId: req.user.id,
    username: user.customDisplayName || user.robloxDisplayName || user.robloxUsername,
    tier: tierNum,
    gamepassId,
    broadcastsLeft: 1,
    showsLeft: shows,
    active: true,
    message: message || null
  });
  await ad.save();
  res.json({ success: true, ad });
});

app.post('/api/delete-ad', authenticateToken, async (req, res) => {
  await mongoose.model('Ad').findOneAndDelete({ userId: req.user.id, active: true });
  res.json({ success: true });
});

app.get('/api/ads/broadcast', async (req, res) => {
  const { roomId, since } = req.query;
  const sinceDate = since ? new Date(parseInt(since)) : new Date(Date.now() - 60000);
  const broadcasts = await mongoose.model('AdBroadcast').find({
    roomId,
    timestamp: { $gt: sinceDate }
  }).sort({ timestamp: -1 }).limit(10);
  res.json(broadcasts);
});

// ========== GUEST LOGIN ==========
app.post('/api/guest-login', async (req, res) => {
  const guestId = crypto.randomBytes(8).toString('hex');
  const username = `Guest_${guestId.slice(0,6)}`;
  const User = mongoose.model('User');
  const user = new User({
    _id: guestId,
    robloxUsername: username,
    robloxDisplayName: username,
    customDisplayName: username,
    avatarUrl: '',
    donations: { received: 0, given: 0 },
    board: []
  });
  await user.save();
  res.json({ id: guestId, username, displayName: username, isGuest: true });
});

// ========== DONATION INITIATE ==========
app.post('/api/donate/initiate', authenticateToken, async (req, res) => {
  const { receiverId, gamepassId, amount } = req.body;
  if (!receiverId || !gamepassId || !amount) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  // For production: call Roblox API to create a purchase link
  // For demo: just return the gamepass URL
  const url = `https://www.roblox.com/game-pass/${gamepassId}`;
  res.json({ url });
});
// ========== PASKEY (WebAuthn) ==========
app.post('/api/webauthn/register/begin', authenticateToken, async (req, res) => {
  const User = mongoose.model('User');
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: new Uint8Array(Buffer.from(user._id)),
    userName: user.robloxUsername || user.customDisplayName || 'user',
    attestationType: 'none',
    authenticatorSelection: { userVerification: 'preferred' }
  });

  // Store the challenge temporarily in the user document
  user.currentRegistrationChallenge = options.challenge;
  await user.save();

  res.json(options);
});

app.post('/api/webauthn/register/complete', authenticateToken, async (req, res) => {
  const User = mongoose.model('User');
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const verification = await verifyRegistrationResponse({
    response: req.body,
    expectedChallenge: user.currentRegistrationChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID
  });

  if (verification.verified && verification.registrationInfo) {
    user.credentials.push({
      id: verification.registrationInfo.credentialID,
      publicKey: Buffer.from(verification.registrationInfo.credentialPublicKey),
      counter: verification.registrationInfo.counter,
      transports: req.body.transports || []
    });
    user.currentRegistrationChallenge = undefined;
    await user.save();
    res.json({ verified: true });
  } else {
    res.status(400).json({ error: 'Verification failed' });
  }
});

// ========== FALLBACK – THIS MUST BE THE VERY LAST ROUTE ==========
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});