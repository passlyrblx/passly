const express = require('express');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// JWT secret – fixed so tokens survive restarts
const JWT_SECRET = process.env.JWT_SECRET || 'passly-jwt-secret-2024';

// Create data folder if not exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}

// JSON Database files
const DB_USERS = path.join(__dirname, 'data', 'users.json');
const DB_ROOMS = path.join(__dirname, 'data', 'rooms.json');
const DB_DONATIONS = path.join(__dirname, 'data', 'donations.json');
const DB_ADS = path.join(__dirname, 'data', 'ads.json');

function readJSON(f) { try { if(fs.existsSync(f)) return JSON.parse(fs.readFileSync(f,'utf8')); } catch(e){} return {}; }
function writeJSON(f, d) { try{ fs.writeFileSync(f, JSON.stringify(d,null,2)); } catch(e){} }

let users = readJSON(DB_USERS);
let rooms = readJSON(DB_ROOMS);
let donations = readJSON(DB_DONATIONS);
let ads = readJSON(DB_ADS);

function saveUsers() { writeJSON(DB_USERS, users); }
function saveRooms() { writeJSON(DB_ROOMS, rooms); }
function saveDonations() { writeJSON(DB_DONATIONS, donations); }
function saveAds() { writeJSON(DB_ADS, ads); }

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname)));

const ROBLOX_CONFIG = {
  clientId: process.env.ROBLOX_CLIENT_ID,
  clientSecret: process.env.ROBLOX_CLIENT_SECRET,
  redirectUri: process.env.ROBLOX_REDIRECT_URI || 'http://localhost:3000/auth/roblox/callback',
  authUrl: 'https://apis.roblox.com/oauth/v1/authorize',
  tokenUrl: 'https://apis.roblox.com/oauth/v1/token',
  userInfoUrl: 'https://apis.roblox.com/oauth/v1/userinfo'
};

const GAMEPASSES = { '5k': process.env.GAMEPASS_5K, '10k': process.env.GAMEPASS_10K };

// ========== AUTH MIDDLEWARE ==========
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = decoded;
    next();
  });
}

// ========== PAGES ==========
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/rooms', (req, res) => res.sendFile(path.join(__dirname, 'rooms.html')));
app.get('/leaderboard', (req, res) => res.sendFile(path.join(__dirname, 'leaderboard.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'profile.html')));

// ========== API: check token ==========
app.get('/api/check-auth', authenticateToken, (req, res) => {
  res.json({ authenticated: true, user: req.user });
});

// ========== OAUTH (cookie‑based state, debug output) ==========

function setStateCookie(res, state) {
  res.cookie('oauth_state', state, {
    maxAge: 600000, // 10 minutes
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  });
}

app.get('/auth/roblox', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  setStateCookie(res, state);

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

  // If user denied
  if (error === 'access_denied') {
    return res.send(`<html><body style="background:#0a0a14;color:white;text-align:center;padding:50px;">
      <h1 style="color:#f87171;">Authorization Denied</h1>
      <p>You must allow Passly to access your account.</p>
      <a href="/" style="color:#8b5cf6;">Try Again</a></body></html>`);
  }

  // Verify state via cookie
  const cookieState = req.cookies?.oauth_state;
  if (!state || state !== cookieState) {
    return res.status(403).send(`<html><body style="background:#0a0a14;color:white;text-align:center;padding:50px;">
      <h1 style="color:#f87171;">Invalid State</h1>
      <p>Expected: ${cookieState}, got: ${state}</p>
      <a href="/" style="color:#8b5cf6;">Go back</a></body></html>`);
  }
  res.clearCookie('oauth_state');

  if (!code) {
    return res.redirect('/?error=no_code');
  }

  try {
    // Exchange code for access token
    const tokenRes = await axios.post(ROBLOX_CONFIG.tokenUrl,
      new URLSearchParams({
        client_id: ROBLOX_CONFIG.clientId,
        client_secret: ROBLOX_CONFIG.clientSecret,
        grant_type: 'authorization_code',
        code
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const userRes = await axios.get(ROBLOX_CONFIG.userInfoUrl, {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
    });

    const rb = userRes.data;

    // Save user to database
    if (!users[rb.sub]) {
      users[rb.sub] = {
        id: rb.sub,
        username: rb.name || 'Player',
        displayName: rb.nickname || rb.name || 'Player',
        avatarUrl: rb.picture || '',
        profile: { showBooth: true, statusDot: 'online', showRoomId: true },
        roomId: null,
        inQueue: false,
        donations: { received: 0, given: 0 },
        createdAt: new Date().toISOString()
      };
    } else {
      users[rb.sub].username = rb.name || users[rb.sub].username;
      users[rb.sub].displayName = rb.nickname || users[rb.sub].displayName;
      users[rb.sub].avatarUrl = rb.picture || users[rb.sub].avatarUrl;
    }
    saveUsers();

    // Create JWT
    const tokenPayload = {
      id: rb.sub,
      username: users[rb.sub].username,
      avatarUrl: users[rb.sub].avatarUrl
    };
    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

    // Redirect with token in URL hash
    res.redirect(`/dashboard#token=${token}`);
  } catch (err) {
    // Debug: show exact error
    const errorMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    res.send(`<html><body style="background:#0a0a14;color:white;text-align:center;padding:50px;">
      <h1 style="color:#f87171;">OAuth Error</h1>
      <pre>${errorMsg}</pre>
      <a href="/" style="color:#8b5cf6;">Try again</a></body></html>`);
  }
});

// ========== USER API ==========
app.get('/api/user', authenticateToken, (req, res) => {
  const user = users[req.user.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const ad = Object.values(ads).find(a => a.userId === user.id && a.active);
  res.json({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    profile: user.profile,
    roomId: user.roomId,
    inQueue: user.inQueue,
    donations: user.donations,
    ad: ad || null
  });
});

app.post('/api/profile/update', authenticateToken, (req, res) => {
  const user = users[req.user.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { showBooth, statusDot, showRoomId } = req.body;
  if (showBooth !== undefined) user.profile.showBooth = showBooth;
  if (statusDot) user.profile.statusDot = statusDot;
  if (showRoomId !== undefined) user.profile.showRoomId = showRoomId;
  saveUsers();
  res.json({ success: true });
});

// ========== ROOMS ==========
app.get('/api/rooms', (req, res) => res.json(Object.values(rooms)));

app.post('/api/rooms/create', authenticateToken, (req, res) => {
  const { name, desc, type } = req.body;
  if (!name) return res.status(400).json({ error: 'Room name required' });
  const roomId = crypto.randomBytes(8).toString('hex');
  rooms[roomId] = {
    id: roomId, name, desc: desc||'', type: type||'Public',
    players: [], queue: [], maxPlayers: 18,
    createdBy: req.user.id, createdAt: new Date().toISOString()
  };
  saveRooms();
  res.json(rooms[roomId]);
});

app.post('/api/rooms/join/:roomId', authenticateToken, (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const userId = req.user.id;
  // leave previous room
  if (users[userId]?.roomId && rooms[users[userId].roomId]) {
    const old = rooms[users[userId].roomId];
    old.players = old.players.filter(id => id !== userId);
    old.queue = old.queue.filter(id => id !== userId);
    if (old.queue.length && old.players.length < old.maxPlayers) old.players.push(old.queue.shift());
  }
  if (room.players.length >= room.maxPlayers) {
    if (!room.queue.includes(userId)) {
      room.queue.push(userId);
      if (users[userId]) { users[userId].roomId = room.id; users[userId].inQueue = true; saveUsers(); }
      saveRooms();
      return res.json({ queued: true, position: room.queue.length });
    }
  }
  room.players.push(userId);
  if (users[userId]) { users[userId].roomId = room.id; users[userId].inQueue = false; saveUsers(); }
  saveRooms();
  res.json({ success: true, room });
});

app.post('/api/rooms/leave', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const room = rooms[users[userId]?.roomId];
  if (room) {
    room.players = room.players.filter(id => id !== userId);
    room.queue = room.queue.filter(id => id !== userId);
    if (room.queue.length && room.players.length < room.maxPlayers) room.players.push(room.queue.shift());
    saveRooms();
  }
  if (users[userId]) { users[userId].roomId = null; users[userId].inQueue = false; saveUsers(); }
  res.json({ success: true });
});

// ========== DONATIONS ==========
app.post('/api/donate', authenticateToken, async (req, res) => {
  const { receiverId, gamepassId, amount } = req.body;
  const donor = users[req.user.id];
  const receiver = users[receiverId];
  if (!donor || !receiver) return res.status(404).json({ error: 'User not found' });
  try {
    const check = await axios.get(`https://inventory.roblox.com/v1/users/${donor.id}/items/GamePass/${gamepassId}`, { timeout: 5000 });
    if (!check.data?.data?.length) return res.status(400).json({ error: 'You do not own this gamepass' });
  } catch(e) { return res.status(400).json({ error: 'Verification failed' }); }
  const recent = Object.values(donations).find(d => d.donorId===donor.id && d.receiverId===receiverId && d.gamepassId===gamepassId && (Date.now()-d.timestamp)<300000);
  if (recent) return res.status(400).json({ error: 'Wait 5 minutes' });
  const donationId = crypto.randomBytes(8).toString('hex');
  donations[donationId] = { id: donationId, donorId: donor.id, donorName: donor.username, receiverId, receiverName: receiver.username, gamepassId, amount, timestamp: Date.now() };
  donor.donations.given += amount;
  receiver.donations.received += amount;
  saveDonations(); saveUsers();
  res.json({ success: true, message: `${donor.username} donated ${amount} Robux to ${receiver.username}!` });
});

app.get('/api/donations', (req, res) => {
  const now = Date.now();
  for (const k in donations) if (now - donations[k].timestamp > 300000) delete donations[k];
  res.json(Object.values(donations));
});

// ========== ADS ==========
app.post('/api/purchase-ad', authenticateToken, async (req, res) => {
  const { tier } = req.body;
  const user = users[req.user.id];
  if (Object.values(ads).some(a => a.userId===user.id && a.active)) return res.status(400).json({ error: 'Delete existing ad first' });
  const gpId = GAMEPASSES[tier];
  try {
    const check = await axios.get(`https://inventory.roblox.com/v1/users/${user.id}/items/GamePass/${gpId}`, { timeout:5000 });
    if (!check.data?.data?.length) return res.status(400).json({ error: 'You do not own this gamepass' });
  } catch(e) { return res.status(400).json({ error: 'Verification failed' }); }
  const adId = crypto.randomBytes(8).toString('hex');
  ads[adId] = { id: adId, userId: user.id, username: user.username, tier: parseInt(tier), gamepassId: gpId, showsLeft: tier==='5k'?1:3, active: true, purchasedAt: new Date().toISOString() };
  saveAds();
  res.json({ success: true, ad: ads[adId] });
});

app.post('/api/delete-ad', authenticateToken, (req, res) => {
  for (const k in ads) if (ads[k].userId === req.user.id) { delete ads[k]; saveAds(); return res.json({success:true}); }
  res.json({ success: true });
});

app.get('/api/ads', (req, res) => res.json(Object.values(ads).filter(a => a.active && a.showsLeft>0)));

app.get('/api/leaderboard', (req, res) => {
  const all = Object.values(users);
  res.json({
    receivers: all.sort((a,b)=>b.donations.received-a.donations.received).slice(0,10).map(u=>({username:u.username,amount:u.donations.received})),
    donors: all.sort((a,b)=>b.donations.given-a.donations.given).slice(0,10).map(u=>({username:u.username,amount:u.donations.given}))
  });
});

// ========== Guest endpoint (no token needed) ==========
app.post('/api/guest-login', (req, res) => {
  const guestNum = Math.floor(10000 + Math.random() * 90000);
  res.json({ username: `Guest#${guestNum}`, isGuest: true });
});

app.listen(PORT, () => console.log(`Passly running on port ${PORT}`));