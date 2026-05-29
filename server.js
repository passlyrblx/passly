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

// ----- MongoDB & Default Rooms -----
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
  roomId: String,                          // NEW – so we can show room in live donations
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
const oauthStates = new Map();
setInterval(() => { for (const [k, t] of oauthStates) if (Date.now() - t > 600000) oauthStates.delete(k); }, 60000);

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
app.get('/livedonations', (req, res) => res.sendFile(path.join(__dirname, 'livedonations.html')));   // NEW

// ========== OAUTH (unchanged) ==========
app.get('/auth/roblox', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex'); oauthStates.set(state, Date.now());
  res.redirect(`${ROBLOX_CONFIG.authUrl}?${new URLSearchParams({ client_id: ROBLOX_CONFIG.clientId, redirect_uri: ROBLOX_CONFIG.redirectUri, response_type: 'code', scope: 'openid', state })}`);
});

app.get('/auth/roblox/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error === 'access_denied') return res.send('<h1>Authorization Denied</h1><a href="/">Try again</a>');
  if (!state || !oauthStates.has(state)) return res.status(403).send('Invalid state');
  oauthStates.delete(state);
  if (!code) return res.redirect('/');
  try {
    const tokenRes = await axios.post(ROBLOX_CONFIG.tokenUrl, new URLSearchParams({ client_id: ROBLOX_CONFIG.clientId, client_secret: ROBLOX_CONFIG.clientSecret, grant_type: 'authorization_code', code }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const userInfo = await axios.get(ROBLOX_CONFIG.userInfoUrl, { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } });
    const userId = userInfo.data.sub;
    // … (rest of OAuth – unchanged from earlier) …
  } catch (err) { /* … */ }
});
// ========== USER API (unchanged) ==========
app.get('/api/user', authenticateToken, async (req, res) => { /* … same … */ });
app.post('/api/profile/update', authenticateToken, async (req, res) => { /* … same … */ });

// ========== SEARCH / BOARD / ROOMS (unchanged) ==========
// (Include all the routes from the previous server – they are the same.)

// ========== DONATIONS (updated to include roomId) ==========
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
  // Record the room ID where the donation happened (if any)
  const roomId = donor.roomId || receiver.roomId || '';

  await Donation.create({
    _id: donationId,
    donorId: donor._id,
    donorName: donor.robloxUsername,
    receiverId,
    receiverName: receiver.robloxUsername,
    gamepassId,
    amount,
    roomId,
    timestamp: new Date()
  });

  donor.donations.given += amount;
  receiver.donations.received += amount;
  await donor.save();
  await receiver.save();

  res.json({ success: true, message: `${donor.robloxUsername} donated ${amount} Robux to ${receiver.robloxUsername}!` });
});

// Normal donation list (still cleans up after 5 minutes)
app.get('/api/donations', async (req, res) => {
  const recent = await Donation.find({ timestamp: { $gt: new Date(Date.now() - 300000) } });
  res.json(recent);
});

// ─── LIVE DONATIONS endpoint ─────────────────────────────
app.get('/api/live-donations', async (req, res) => {
  const now = Date.now();
  const allDonations = await Donation.find({}).sort({ timestamp: -1 });

  // Keep only those that are still within their display window
  const live = allDonations.filter(d => {
    const age = now - d.timestamp;
    if (d.amount >= 100000) return age <= 30 * 60 * 1000;      // 30 minutes
    if (d.amount >= 10000)  return age <= 5 * 60 * 1000;       // 5 minutes
    if (d.amount >= 1000)   return age <= 1 * 60 * 1000;       // 1 minute
    return age <= 1 * 60 * 1000;                                // default 1 minute
  });

  res.json(live);
});

// ========== ADS / LEADERBOARD / PASSKEY / GUEST (unchanged) ==========
// (Include all remaining routes from the previous server – they are the same.)

// ========== SOCKET.IO (unchanged) ==========