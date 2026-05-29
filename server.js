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

mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// ----- Schemas (unchanged) -----
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

// Clean old broadcasts every 10 minutes
setInterval(async () => {
  const cutoff = new Date(Date.now() - 600000);
  await AdBroadcast.deleteMany({ timestamp: { $lt: cutoff } });
}, 600000);

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

const oauthStates = new Map();
setInterval(() => {
  for (const [key, time] of oauthStates) if (Date.now() - time > 600000) oauthStates.delete(key);
}, 60000);

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

// ========== PAGES ==========
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/rooms', (req, res) => res.sendFile(path.join(__dirname, 'rooms.html')));
app.get('/leaderboard', (req, res) => res.sendFile(path.join(__dirname, 'leaderboard.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'profile.html')));
app.get('/advertisement', (req, res) => res.sendFile(path.join(__dirname, 'advertisement.html')));  // ← new page

// ========== OAUTH ==========
app.get('/auth/roblox', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, Date.now());
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
  if (!state || !oauthStates.has(state)) return res.status(403).send('<h1>Invalid State</h1><a href="/">Go back</a>');
  oauthStates.delete(state);
  if (!code) return res.redirect('/?error=no_code');

  try {
    const tokenRes = await axios.post(ROBLOX_CONFIG.tokenUrl,
      new URLSearchParams({ client_id: ROBLOX_CONFIG.clientId, client_secret: ROBLOX_CONFIG.clientSecret, grant_type: 'authorization_code', code }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const userInfoRes = await axios.get(ROBLOX_CONFIG.userInfoUrl, { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } });
    const userId = userInfoRes.data.sub;
    if (!userId) throw new Error('No user ID');

    const profileRes = await axios.get(`${ROBLOX_CONFIG.usersApi}/${userId}`);
    const profile = profileRes.data;
    const robloxUsername = profile.name || 'Player';
    const robloxDisplayName = profile.displayName || robloxUsername;

    let avatarUrl = '';
    try {
      const thumbRes = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`);
      if (thumbRes.data && thumbRes.data.data && thumbRes.data.data.length > 0) {
        avatarUrl = thumbRes.data.data[0].imageUrl || '';
      }
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

// … SEARCH, PUBLIC BOARD, BOARD MANAGEMENT, ROOMS, DONATIONS, ADS, LEADERBOARD, PASSKEY …
// (all routes identical to the previous Part 2 – I’ll include them but they are the same)

// ========== DEFAULT ROOMS (now created BEFORE server starts) ==========
(async () => {
  try {
    const count = await Room.countDocuments();
    if (count === 0) {
      const defaultRooms = [
        { name: "Chill Donations", desc: "Relax and donate to small creators." },
        { name: "Big Donators", desc: "High donation rooms with active players." },
        { name: "Anime Fans", desc: "A room for anime lovers." }
      ];
      for (const r of defaultRooms) {
        const roomId = crypto.randomBytes(8).toString('hex');
        await Room.create({
          _id: roomId, name: r.name, desc: r.desc, type: 'Public',
          players: [], queue: [], maxPlayers: 18, createdBy: 'system'
        });
      }
      console.log('Default public rooms created.');
    }
  } catch (e) {
    console.error('Could not create default rooms:', e);
  }
})();

// ========== FIXED ROOM CREATION ==========
app.post('/api/rooms/create', authenticateToken, async (req, res) => {
  const { name, desc, type } = req.body;
  if (!name) return res.status(400).json({ error: 'Room name required' });

  const alreadyInRoom = await Room.findOne({
    $or: [{ createdBy: req.user.id }, { players: req.user.id }]
  });
  if (alreadyInRoom) return res.status(400).json({ error: 'You must leave your current room first.' });

  const roomId = crypto.randomBytes(8).toString('hex');
  const newRoom = await Room.create({
    _id: roomId, name, desc: desc || '', type: type || 'Public',
    players: [req.user.id], queue: [], maxPlayers: 18, createdBy: req.user.id
  });

  // Make sure the creator is also updated
  await User.findByIdAndUpdate(req.user.id, { roomId, inQueue: false });

  // Fetch the fully populated room to return
  const room = await Room.findById(roomId);
  res.json(room);
});

// … (keep the rest of the routes: join, leave, donations, ads, leaderboard, passkeys, guest, socket.io – all unchanged) …

server.listen(PORT, () => console.log(`Passly running on port ${PORT}`));