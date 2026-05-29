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

// ----- MongoDB Connection & Guaranteed Default Rooms -----
mongoose.connect(MONGO_URI).then(async () => {
  console.log('MongoDB connected');

  // Schemas (must be defined before use)
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

  // Register models
  mongoose.model('User', userSchema);
  mongoose.model('Room', roomSchema);
  mongoose.model('Donation', donationSchema);
  mongoose.model('Ad', adSchema);
  mongoose.model('AdBroadcast', adBroadcastSchema);

  const Room = mongoose.model('Room');

  // Default rooms with FIXED IDs (never duplicate, never missing)
  const defaultRooms = [
    { _id: "room1", name: "Chill Donations", desc: "Relax and donate to small creators." },
    { _id: "room2", name: "Big Donators", desc: "High donation rooms with active players." },
    { _id: "room3", name: "Anime Fans", desc: "A room for anime lovers." }
  ];

  for (const r of defaultRooms) {
    const exists = await Room.findById(r._id);
    if (!exists) {
      await Room.create({ ...r, type: 'Public', players: [], queue: [], maxPlayers: 18, createdBy: 'system' });
    }
  }
  console.log('Default rooms ensured.');

  // Now start the server
  server.listen(PORT, () => console.log(`Passly running on port ${PORT}`));
}).catch(err => { console.error('MongoDB error:', err); process.exit(1); });

// ----- Middleware -----
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

// OAuth state (MongoDB)
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
  res.redirect(`${ROBLOX_CONFIG.authUrl}?${new URLSearchParams({ client_id: ROBLOX_CONFIG.clientId, redirect_uri: ROBLOX_CONFIG.redirectUri, response_type:'code', scope:'openid', state })}`);
});

app.get('/auth/roblox/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error === 'access_denied') return res.send('<h1>Authorization Denied</h1><a href="/">Try again</a>');
  const doc = await OAuthState.findOneAndDelete({ state });
  if (!doc) return res.status(403).send('<h1>Invalid State</h1><a href="/">Go back</a>');
  if (!code) return res.redirect('/');
  try {
    const tokenRes = await axios.post(ROBLOX_CONFIG.tokenUrl, new URLSearchParams({ client_id: ROBLOX_CONFIG.clientId, client_secret: ROBLOX_CONFIG.clientSecret, grant_type: 'authorization_code', code }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
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
    const jwtToken = jwt.sign({ id: userId, username: robloxUsername, displayName, avatarUrl }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('passly_token', jwtToken, { maxAge: 7*24*60*60*1000, httpOnly: false, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
    res.redirect(`/dashboard#token=${jwtToken}`);
  } catch (e) { console.error(e); res.send('<h1>Login Failed</h1><a href="/">Go back</a>'); }
});