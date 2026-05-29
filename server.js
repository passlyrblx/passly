const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const mongoose = require('mongoose');
const { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } = require('@simplewebauthn/server');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'passly-jwt-secret-2024';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/passly';
const RP_ID = process.env.RP_ID || 'localhost';
const RP_NAME = 'Passly';
const ORIGIN = process.env.ORIGIN || 'http://localhost:3000';

// ----- MongoDB & Default Rooms (created BEFORE server starts) -----
mongoose.connect(MONGO_URI).then(async () => {
  console.log('MongoDB connected');

  const Room = mongoose.model('Room');
  const count = await Room.countDocuments();
  if (count === 0) {
    const defaultRooms = [
      { name: "Chill Donations", desc: "Relax and donate to small creators." },
      { name: "Big Donators", desc: "High donation rooms with active players." },
      { name: "Anime Fans", desc: "A room for anime lovers." }
    ];
    for (const r of defaultRooms) {
      await Room.create({
        _id: crypto.randomBytes(8).toString('hex'),
        name: r.name, desc: r.desc, type: 'Public',
        players: [], queue: [], maxPlayers: 18, createdBy: 'system'
      });
    }
    console.log('Default rooms created.');
  }

  server.listen(PORT, () => console.log(`Passly running on port ${PORT}`));
}).catch(err => { console.error('MongoDB error:', err); process.exit(1); });

// ----- Schemas -----
const oauthStateSchema = new mongoose.Schema({
  state: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now, expires: 600 }   // auto‑delete after 10 minutes
});
const OAuthState = mongoose.model('OAuthState', oauthStateSchema);

const userSchema = new mongoose.Schema({
  _id: String, robloxUsername: String, robloxDisplayName: String,
  customDisplayName: String, avatarUrl: String,
  profile: { showBooth: { type: Boolean, default: true }, statusDot: { type: String, default: 'online' }, showRoomId: { type: Boolean, default: true } },
  roomId: String, inQueue: Boolean,
  donations: { received: Number, given: Number },
  board: [{ id: String, name: String, price: Number }],
  credentials: [{ id: String, publicKey: Buffer, counter: Number, transports: [String] }],
  createdAt: { type: Date, default: Date.now }
});

const roomSchema = new mongoose.Schema({
  _id: String, name: String, desc: String, type: String,
  players: [String], queue: [String], maxPlayers: { type: Number, default: 18 },
  createdBy: String, createdAt: { type: Date, default: Date.now }
});

const donationSchema = new mongoose.Schema({
  _id: String, donorId: String, donorName: String, receiverId: String,
  receiverName: String, gamepassId: String, amount: Number,
  roomId: String,
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

const User = mongoose.model('User', userSchema);
const Room = mongoose.model('Room', roomSchema);
const Donation = mongoose.model('Donation', donationSchema);
const Ad = mongoose.model('Ad', adSchema);
const AdBroadcast = mongoose.model('AdBroadcast', adBroadcastSchema);

// Clean old broadcasts
setInterval(async () => {
  await AdBroadcast.deleteMany({ timestamp: { $lt: new Date(Date.now() - 600000) } });
}, 600000);

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

const ROBLOX_CONFIG = {
  clientId: process.env.ROBLOX_CLIENT_ID, clientSecret: process.env.ROBLOX_CLIENT_SECRET,
  redirectUri: process.env.ROBLOX_REDIRECT_URI || 'http://localhost:3000/auth/roblox/callback',
  authUrl: 'https://apis.roblox.com/oauth/v1/authorize', tokenUrl: 'https://apis.roblox.com/oauth/v1/token',
  userInfoUrl: 'https://apis.roblox.com/oauth/v1/userinfo', usersApi: 'https://users.roblox.com/v1/users'
};
const GAMEPASSES = { '5k': process.env.GAMEPASS_5K, '10k': process.env.GAMEPASS_10K };

function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user; next();
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

// ========== OAUTH (with MongoDB state) ==========
app.get('/auth/roblox', async (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  await OAuthState.create({ state });
  const params = new URLSearchParams({
    client_id: ROBLOX_CONFIG.clientId,
    redirect_uri: ROBLOX_CONFIG.redirectUri,
    response_type: 'code',
    scope: 'openid',
    state
  });
  res.redirect(`${ROBLOX_CONFIG.authUrl}?${params}`);
});

app.get('/auth/roblox/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error === 'access_denied') return res.send('<h1>Authorization Denied</h1><a href="/">Try again</a>');

  const stateDoc = await OAuthState.findOneAndDelete({ state });
  if (!stateDoc) return res.status(403).send('<h1>Invalid State</h1><p>The login session expired. Please try again.</p><a href="/">Go back</a>');

  if (!code) return res.redirect('/?error=no_code');

  try {
    const tokenRes = await axios.post(ROBLOX_CONFIG.tokenUrl,
      new URLSearchParams({ client_id: ROBLOX_CONFIG.clientId, client_secret: ROBLOX_CONFIG.clientSecret, grant_type: 'authorization_code', code }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const userInfo = await axios.get(ROBLOX_CONFIG.userInfoUrl, { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } });
    const userId = userInfo.data.sub;
    if (!userId) throw new Error('No user ID');

    const profileRes = await axios.get(`${ROBLOX_CONFIG.usersApi}/${userId}`);
    const profile = profileRes.data;
    const robloxUsername = profile.name || 'Player';
    const robloxDisplayName = profile.displayName || robloxUsername;

    let avatarUrl = '';
    try {
      const thumbRes = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`);
      if (thumbRes.data?.data?.length) avatarUrl = thumbRes.data.data[0].imageUrl || '';
    } catch (e) {
      avatarUrl = `https://www.roblox.com/headshot-thumbnail/image?userId=${userId}&width=150&height=150&format=png`;
    }

    await User.findOneAndUpdate(
      { _id: userId },
      { $set: { robloxUsername, robloxDisplayName, avatarUrl }, $setOnInsert: { profile: { showBooth: true, statusDot: 'online', showRoomId: true }, donations: { received: 0, given: 0 }, board: [], createdAt: new Date() } },
      { upsert: true, new: true }
    );

    const user = await User.findById(userId);
    const displayName = user.customDisplayName || robloxDisplayName;
    const jwtToken = jwt.sign({ id: userId, username: robloxUsername, displayName, avatarUrl }, JWT_SECRET, { expiresIn: '7d' });

    res.cookie('passly_token', jwtToken, { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: false, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
    res.redirect(`/dashboard#token=${jwtToken}`);
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.send('<h1>Login Failed</h1><a href="/">Go back</a>');
  }
});
// ========== USER API ==========
app.get('/api/user', authenticateToken, async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const avatarUrl = user.avatarUrl || '';
  const avatarFallback = avatarUrl ? '' : `https://www.roblox.com/bust-thumbnail/image?userId=${user._id}&width=150&height=150&format=png`;
  const activeAd = await Ad.findOne({ userId: user._id, active: true });
  res.json({
    id: user._id, robloxUsername: user.robloxUsername || '', robloxDisplayName: user.robloxDisplayName || '',
    displayName: user.customDisplayName || user.robloxDisplayName || '',
    avatarUrl, avatarFallback, profile: user.profile, roomId: user.roomId, inQueue: user.inQueue,
    donations: user.donations, ad: activeAd || null, customDisplayName: user.customDisplayName || null,
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
  await User.findByIdAndUpdate(req.user.id, { $set: update });
  res.json({ success: true });
});

// ========== SEARCH ==========
app.get('/api/search', async (req, res) => {
  const query = (req.query.username || '').toLowerCase().trim();
  if (!query) return res.status(400).json({ error: 'Username required' });
  const found = await User.findOne({ robloxUsername: new RegExp(`^${query}$`, 'i') });
  if (!found) return res.json({ error: 'User not found' });
  const showBoard = found.profile.showBooth !== false;
  res.json({
    id: found._id, robloxUsername: found.robloxUsername,
    displayName: found.customDisplayName || found.robloxDisplayName,
    avatarUrl: found.avatarUrl, board: showBoard ? (found.board || []) : []
  });
});

// ========== PUBLIC BOARD ==========
app.get('/api/user/:userId/board', authenticateToken, async (req, res) => {
  const user = await User.findById(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const showBoard = user.profile.showBooth !== false;
  res.json({
    id: user._id, displayName: user.customDisplayName || user.robloxDisplayName,
    avatarUrl: user.avatarUrl, board: showBoard ? (user.board || []) : []
  });
});

// ========== BOARD ==========
app.post('/api/board/add', authenticateToken, async (req, res) => {
  const { assetId, price } = req.body;
  if (!assetId || !price) return res.status(400).json({ error: 'Asset ID and Robux amount required' });
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.board.some(gp => gp.id === assetId)) return res.status(400).json({ error: 'Gamepass already on board' });
  try {
    const check = await axios.get(`https://inventory.roblox.com/v1/users/${user._id}/items/GamePass/${assetId}`, { timeout: 5000 });
    if (!check.data?.data?.length) return res.status(400).json({ error: 'You do not own this gamepass' });
  } catch (e) { return res.status(400).json({ error: 'Ownership verification failed' }); }
  user.board.push({ id: assetId, name: 'Gamepass', price: parseInt(price) });
  await user.save();
  res.json({ success: true, board: user.board });
});

app.post('/api/board/remove', authenticateToken, async (req, res) => {
  const { assetId } = req.body;
  await User.findByIdAndUpdate(req.user.id, { $pull: { board: { id: assetId } } });
  const user = await User.findById(req.user.id);
  res.json({ success: true, board: user.board });
});

// ========== ROOMS (fast, no stale state) ==========
app.get('/api/rooms', async (req, res) => {
  const rooms = await Room.find({});
  res.json(rooms);
});

app.post('/api/rooms/create', authenticateToken, async (req, res) => {
  const { name, desc, type } = req.body;
  if (!name) return res.status(400).json({ error: 'Room name required' });
  // No need to check alreadyInRoom because we force-leave on page load
  const roomId = crypto.randomBytes(8).toString('hex');
  const newRoom = await Room.create({
    _id: roomId, name, desc: desc || '', type: type || 'Public',
    players: [req.user.id], queue: [], maxPlayers: 18, createdBy: req.user.id
  });
  await User.findByIdAndUpdate(req.user.id, { roomId, inQueue: false });
  const room = await Room.findById(roomId);
  res.json(room);
});

app.post('/api/rooms/join/:roomId', authenticateToken, async (req, res) => {
  const room = await Room.findById(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const userId = req.user.id;
  const user = await User.findById(userId);

  // Clean up any stale reference
  if (user.roomId) {
    const storedRoom = await Room.findById(user.roomId);
    if (!storedRoom || storedRoom._id !== room._id) {
      if (storedRoom) {
        storedRoom.players = storedRoom.players.filter(id => id !== userId);
        storedRoom.queue = storedRoom.queue.filter(id => id !== userId);
        if (storedRoom.queue.length && storedRoom.players.length < storedRoom.maxPlayers)
          storedRoom.players.push(storedRoom.queue.shift());
        await storedRoom.save();
      }
      user.roomId = null;
      user.inQueue = false;
      await user.save();
    }
  }

  // If already in this room, just confirm
  if (room.players.includes(userId)) {
    if (!user.roomId || user.roomId !== room._id) {
      user.roomId = room._id;
      user.inQueue = false;
      await user.save();
    }
    return res.json({ success: true, room });
  }

  // Queue logic
  if (room.players.length >= room.maxPlayers) {
    if (!room.queue.includes(userId)) {
      room.queue.push(userId);
      await room.save();
      user.roomId = room._id;
      user.inQueue = true;
      await user.save();
      return res.json({ queued: true, position: room.queue.length });
    }
    return res.json({ queued: true, position: room.queue.indexOf(userId) + 1 });
  }

  // Normal join
  room.players.push(userId);
  await room.save();
  user.roomId = room._id;
  user.inQueue = false;
  await user.save();
  res.json({ success: true, room });
});

app.post('/api/rooms/leave', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const user = await User.findById(userId);
  if (!user || !user.roomId) return res.json({ success: true });
  const room = await Room.findById(user.roomId);
  if (room) {
    room.players = room.players.filter(id => id !== userId);
    room.queue = room.queue.filter(id => id !== userId);
    if (room.queue.length && room.players.length < room.maxPlayers)
      room.players.push(room.queue.shift());
    await room.save();
  }
  await User.findByIdAndUpdate(userId, { roomId: null, inQueue: false });
  res.json({ success: true });
});

// ========== DONATIONS (with roomId) ==========
app.post('/api/donate', authenticateToken, async (req, res) => {
  const { receiverId, gamepassId, amount } = req.body;
  const donor = await User.findById(req.user.id);
  const receiver = await User.findById(receiverId);
  if (!donor || !receiver) return res.status(404).json({ error: 'User not found' });
  try {
    const check = await axios.get(`https://inventory.roblox.com/v1/users/${donor._id}/items/GamePass/${gamepassId}`, { timeout: 5000 });
    if (!check.data?.data?.length) return res.status(400).json({ error: 'You do not own this gamepass' });
  } catch (e) { return res.status(400).json({ error: 'Verification failed' }); }
  const recent = await Donation.findOne({ donorId: donor._id, receiverId, gamepassId, timestamp: { $gt: new Date(Date.now() - 300000) } });
  if (recent) return res.status(400).json({ error: 'Wait 5 minutes' });
  const donationId = crypto.randomBytes(8).toString('hex');
  const roomId = donor.roomId || receiver.roomId || '';
  await Donation.create({
    _id: donationId, donorId: donor._id, donorName: donor.robloxUsername,
    receiverId, receiverName: receiver.robloxUsername, gamepassId, amount,
    roomId, timestamp: new Date()
  });
  donor.donations.given += amount;
  receiver.donations.received += amount;
  await donor.save();
  await receiver.save();
  res.json({ success: true, message: `${donor.robloxUsername} donated ${amount} Robux to ${receiver.robloxUsername}!` });
});

app.get('/api/donations', async (req, res) => {
  const recent = await Donation.find({ timestamp: { $gt: new Date(Date.now() - 300000) } });
  res.json(recent);
});

// ========== LIVE DONATIONS (immediate) ==========
app.get('/api/live-donations', async (req, res) => {
  const now = Date.now();
  const all = await Donation.find({}).sort({ timestamp: -1 });
  const live = all.filter(d => {
    const age = now - d.timestamp;
    if (d.amount >= 100000) return age <= 30 * 60 * 1000;
    if (d.amount >= 10000)  return age <= 5 * 60 * 1000;
    if (d.amount >= 1000)   return age <= 1 * 60 * 1000;
    return age <= 1 * 60 * 1000;
  });
  res.json(live);
});

// ========== ADS ==========
async function broadcastAd(ad) {
  const publicRoomIds = (await Room.find({ type: 'Public' })).map(r => r._id);
  if (publicRoomIds.length === 0) return;
  const targetCount = Math.ceil(publicRoomIds.length * 0.75);
  const shuffled = publicRoomIds.sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, targetCount);
  const advertiser = await User.findById(ad.userId);
  if (!advertiser) return;
  const broadcasts = selected.map(roomId => ({
    roomId, board: advertiser.board || [],
    advertiserName: advertiser.customDisplayName || advertiser.robloxDisplayName,
    advertiserId: advertiser._id, message: ad.message || '', timestamp: new Date()
  }));
  await AdBroadcast.insertMany(broadcasts);
}

app.post('/api/purchase-ad', authenticateToken, async (req, res) => {
  const { tier, message } = req.body;
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const existingAd = await Ad.findOne({ userId: user._id, active: true });
  if (existingAd) return res.status(400).json({ error: 'Delete existing ad first' });
  const gpId = GAMEPASSES[tier];
  if (!gpId) return res.status(400).json({ error: 'Invalid tier' });
  try {
    const check = await axios.get(`https://inventory.roblox.com/v1/users/${user._id}/items/GamePass/${gpId}`, { timeout: 5000 });
    if (!check.data?.data?.length) return res.status(400).json({ error: 'You do not own this gamepass' });
  } catch (e) { return res.status(400).json({ error: 'Verification failed' }); }
  const tierAmount = tier === '5k' ? 5000 : 10000;
  const adId = crypto.randomBytes(8).toString('hex');
  const newAd = await Ad.create({
    _id: adId, userId: user._id, username: user.robloxUsername,
    tier: tierAmount, gamepassId: gpId, broadcastsLeft: 1,
    showsLeft: tier === '5k' ? 1 : 3, active: true,
    message: message?.trim().substring(0, 200) || '', purchasedAt: new Date()
  });
  await broadcastAd(newAd);
  newAd.broadcastsLeft = 0;
  await newAd.save();
  res.json({ success: true, ad: newAd });
});

app.post('/api/delete-ad', authenticateToken, async (req, res) => {
  await Ad.deleteMany({ userId: req.user.id, active: true });
  res.json({ success: true });
});

app.get('/api/ads', async (req, res) => {
  const activeAds = await Ad.find({ active: true, showsLeft: { $gt: 0 } });
  res.json(activeAds);
});

app.get('/api/rooms/:roomId/ad-broadcasts', async (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const broadcasts = await AdBroadcast.find({ roomId: req.params.roomId, timestamp: { $gt: new Date(since) } });
  res.json(broadcasts);
});

// ========== LEADERBOARD ==========
app.get('/api/leaderboard', async (req, res) => {
  const period = req.query.period || 'total';
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const oneWeek = 7 * oneDay;
  let dateFilter = {};
  if (period === 'daily') dateFilter = { timestamp: { $gte: new Date(now - oneDay) } };
  else if (period === 'weekly') dateFilter = { timestamp: { $gte: new Date(now - oneWeek) } };
  const donations = await Donation.find(dateFilter);
  const receivedMap = {}, givenMap = {};
  donations.forEach(d => {
    const { receiverId, receiverName, donorId, donorName, amount } = d;
    if (!receivedMap[receiverId]) receivedMap[receiverId] = { username: receiverName, amount: 0 };
    receivedMap[receiverId].amount += amount;
    if (!givenMap[donorId]) givenMap[donorId] = { username: donorName, amount: 0 };
    givenMap[donorId].amount += amount;
  });
  const receivers = Object.values(receivedMap).sort((a,b) => b.amount - a.amount).slice(0,10);
  const donors = Object.values(givenMap).sort((a,b) => b.amount - a.amount).slice(0,10);
  res.json({ receivers, donors });
});

// ========== PASSKEY ENDPOINTS ==========
const challengeStore = new Map();

app.post('/api/passkey/register-options', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const options = await generateRegistrationOptions({
      rpName: RP_NAME, rpID: RP_ID, userID: user._id,
      userName: user.robloxUsername || user._id, attestationType: 'none',
      excludeCredentials: user.credentials.map(cred => ({
        id: Buffer.from(cred.id, 'base64'), type: 'public-key', transports: cred.transports
      }))
    });
    challengeStore.set(user._id, options.challenge);
    res.json(options);
  } catch (error) { console.error(error); res.status(500).json({ error: 'Registration options failed' }); }
});

app.post('/api/passkey/register-verify', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const challenge = challengeStore.get(user._id);
    if (!challenge) return res.status(400).json({ error: 'Challenge expired' });
    const verification = await verifyRegistrationResponse({
      response: req.body, expectedChallenge: challenge,
      expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: false
    });
    if (verification.verified) {
      const { registrationInfo } = verification;
      user.credentials.push({
        id: registrationInfo.credentialID,
        publicKey: Buffer.from(registrationInfo.credentialPublicKey),
        counter: registrationInfo.counter,
        transports: req.body.response.transports || []
      });
      await user.save();
      challengeStore.delete(user._id);
      res.json({ success: true });
    } else { res.status(400).json({ error: 'Verification failed' }); }
  } catch (error) { console.error(error); res.status(400).json({ error: 'Registration failed' }); }
});

app.post('/api/passkey/login-options', async (req, res) => {
  try {
    const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'preferred' });
    const loginKey = crypto.randomBytes(16).toString('hex');
    challengeStore.set(loginKey, options.challenge);
    res.json({ ...options, loginKey });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Login options failed' }); }
});

app.post('/api/passkey/login-verify', async (req, res) => {
  try {
    const { loginKey, ...response } = req.body;
    if (!loginKey) return res.status(400).json({ error: 'Missing login key' });
    const challenge = challengeStore.get(loginKey);
    if (!challenge) return res.status(400).json({ error: 'Challenge expired' });
    const user = await User.findOne({ 'credentials.id': response.id });
    if (!user) return res.status(400).json({ error: 'No account linked to this passkey' });
    const verification = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge,
      expectedOrigin: ORIGIN, expectedRPID: RP_ID,
      credential: {
        id: response.id,
        publicKey: new Uint8Array(user.credentials.find(c => c.id === response.id).publicKey),
        counter: user.credentials.find(c => c.id === response.id).counter
      },
      requireUserVerification: false
    });
    if (verification.verified) {
      const cred = user.credentials.find(c => c.id === response.id);
      cred.counter = verification.authenticationInfo.newCounter;
      await user.save();
      challengeStore.delete(loginKey);
      const token = jwt.sign(
        { id: user._id, username: user.robloxUsername, displayName: user.customDisplayName || user.robloxDisplayName, avatarUrl: user.avatarUrl },
        JWT_SECRET, { expiresIn: '7d' }
      );
      res.json({ success: true, token });
    } else { res.status(400).json({ error: 'Authentication failed' }); }
  } catch (error) { console.error(error); res.status(400).json({ error: 'Login verification failed' }); }
});

// ========== GUEST LOGIN ==========
app.post('/api/guest-login', async (req, res) => {
  const guestNum = Math.floor(10000 + Math.random() * 90000);
  const guestId = 'guest_' + Date.now() + '_' + guestNum;
  const guestUsername = `Guest#${guestNum}`;
  await User.findOneAndUpdate(
    { _id: guestId },
    { $set: { robloxUsername: guestUsername, robloxDisplayName: guestUsername } },
    { upsert: true, new: true }
  );
  const guestUser = { id: guestId, username: guestUsername, displayName: guestUsername, isGuest: true };
  const token = jwt.sign(guestUser, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username: guestUsername, isGuest: true });
});

// ========== SOCKET.IO ==========
io.on('connection', (socket) => {
  let currentRoom = null;
  let userId = null;
  let username = 'Guest';
  socket.on('authenticate', (token) => {
    if (!token) {
      userId = 'guest_' + Math.random().toString(36).substr(2,9);
      username = 'Guest#' + Math.floor(1000+Math.random()*9000);
    } else {
      try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.id; username = decoded.displayName || decoded.username; }
      catch (e) { userId = 'invalid'; }
    }
    socket.emit('authenticated', { userId, username });
  });
  socket.on('join-room', (roomId) => {
    if (currentRoom) socket.leave(currentRoom);
    socket.join(roomId); currentRoom = roomId;
    socket.to(roomId).emit('user-joined', { userId, username });
  });
  socket.on('leave-room', () => {
    if (currentRoom) { socket.to(currentRoom).emit('user-left', { userId, username }); socket.leave(currentRoom); currentRoom = null; }
  });
  socket.on('chat-message', (msg) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit('chat-message', { userId, username, message: msg, timestamp: Date.now() });
  });
  socket.on('voice-data', (audioChunk) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('voice-data', { userId, audio: audioChunk });
  });
  socket.on('voice-mute', (muted) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('voice-mute', { userId, muted });
  });
  socket.on('disconnect', () => {
    if (currentRoom) socket.to(currentRoom).emit('user-left', { userId, username });
  });
});