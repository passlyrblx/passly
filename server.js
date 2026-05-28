const express = require('express');
const session = require('express-session');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}

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

// Session with FIXED secret
app.use(session({
  secret: 'passly-fixed-secret-2024',
  resave: true,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV==='production', httpOnly:true, sameSite:'lax', maxAge:7*24*60*60*1000 }
}));

app.use(express.json());
app.use(express.urlencoded({extended:true}));
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

// ========== GUEST USER SETUP ==========
app.use((req, res, next) => {
  if (!req.session.guestName) {
    const guestNum = Math.floor(10000 + Math.random() * 90000);
    req.session.guestName = `Guest#${guestNum}`;
  }
  // If not logged in via Roblox, ensure we have a guest session
  if (!req.session.user) {
    req.session.user = {
      id: `guest_${req.sessionID}`,
      username: req.session.guestName,
      isGuest: true
    };
  }
  next();
});

// ========== PAGES (no auth required) ==========
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/rooms', (req, res) => res.sendFile(path.join(__dirname, 'rooms.html')));
app.get('/leaderboard', (req, res) => res.sendFile(path.join(__dirname, 'leaderboard.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'profile.html')));

// ========== API ==========
app.get('/api/user', (req, res) => {
  // Returns current user (guest or real)
  const sessionUser = req.session.user;
  if (!sessionUser) return res.json({ isGuest: true, username: req.session.guestName });
  if (sessionUser.isGuest) {
    return res.json({ isGuest: true, username: sessionUser.username });
  }
  const user = users[sessionUser.id];
  if (!user) return res.json({ isGuest: true, username: sessionUser.username });
  const ad = Object.values(ads).find(a => a.userId === user.id && a.active);
  return res.json({
    isGuest: false,
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

app.get('/api/check-auth', (req, res) => {
  const user = req.session.user;
  if (user && !user.isGuest) {
    return res.json({ authenticated: true, user });
  }
  res.json({ authenticated: false, guestName: req.session.guestName });
});

// ========== OAUTH (unchanged but now called from "Login" button) ==========
app.get('/auth/roblox', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
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
  if (error === 'access_denied') return res.send('<h1>Authorization Denied</h1><a href="/">Go back</a>');
  if (!state || state !== req.session.oauthState) return res.status(403).send('Invalid state');
  if (!code) return res.redirect('/');
  try {
    const tokenRes = await axios.post(ROBLOX_CONFIG.tokenUrl,
      new URLSearchParams({ client_id: ROBLOX_CONFIG.clientId, client_secret: ROBLOX_CONFIG.clientSecret, grant_type: 'authorization_code', code }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const userRes = await axios.get(ROBLOX_CONFIG.userInfoUrl, {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
    });
    const rb = userRes.data;
    if (!users[rb.sub]) {
      users[rb.sub] = {
        id: rb.sub,
        username: rb.name || 'Player',
        displayName: rb.nickname || rb.name,
        avatarUrl: rb.picture || '',
        profile: { showBooth: true, statusDot: 'online', showRoomId: true },
        roomId: null, inQueue: false,
        donations: { received: 0, given: 0 },
        createdAt: new Date().toISOString()
      };
    } else {
      users[rb.sub].username = rb.name || users[rb.sub].username;
      users[rb.sub].displayName = rb.nickname || users[rb.sub].displayName;
      users[rb.sub].avatarUrl = rb.picture || users[rb.sub].avatarUrl;
    }
    saveUsers();
    req.session.user = { id: rb.sub, username: users[rb.sub].username, avatarUrl: users[rb.sub].avatarUrl, isGuest: false };
    req.session.save(() => res.redirect('/dashboard'));
  } catch (e) {
    console.error(e);
    res.redirect('/?error=oauth');
  }
});

// ========== GUEST LOGIN (just set session) ==========
app.post('/api/guest-login', (req, res) => {
  // Already set by middleware, but we can regenerate guest name if desired
  const guestNum = Math.floor(10000 + Math.random() * 90000);
  req.session.guestName = `Guest#${guestNum}`;
  req.session.user = { id: `guest_${req.sessionID}`, username: req.session.guestName, isGuest: true };
  res.json({ success: true, username: req.session.guestName });
});

// ========== PROTECTED ACTIONS (require real Roblox login) ==========
function requireRealUser(req, res, next) {
  if (req.session.user && !req.session.user.isGuest) return next();
  res.status(401).json({ error: 'LOGIN_REQUIRED', message: 'Please log in with Roblox to perform this action.' });
}

app.post('/api/rooms/create', requireRealUser, (req, res) => {
  const { name, desc, type } = req.body;
  const roomId = crypto.randomBytes(8).toString('hex');
  rooms[roomId] = { id: roomId, name, desc: desc||'', type: type||'Public', players:[], queue:[], maxPlayers:18, createdBy: req.session.user.id };
  saveRooms();
  res.json(rooms[roomId]);
});

app.post('/api/rooms/join/:roomId', (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const userId = req.session.user.id;
  // leave previous room
  if (req.session.user.roomId && rooms[req.session.user.roomId]) {
    const old = rooms[req.session.user.roomId];
    old.players = old.players.filter(id => id !== userId);
    old.queue = old.queue.filter(id => id !== userId);
    if (old.queue.length && old.players.length < old.maxPlayers) old.players.push(old.queue.shift());
  }
  if (room.players.length >= room.maxPlayers) {
    if (!room.queue.includes(userId)) {
      room.queue.push(userId);
      saveRooms();
      return res.json({ queued: true, position: room.queue.length });
    }
  }
  room.players.push(userId);
  saveRooms();
  res.json({ success: true, room });
});

app.post('/api/rooms/leave', (req, res) => {
  const userId = req.session.user.id;
  const room = rooms[req.session.user.roomId];
  if (room) {
    room.players = room.players.filter(id => id !== userId);
    room.queue = room.queue.filter(id => id !== userId);
    if (room.queue.length && room.players.length < room.maxPlayers) room.players.push(room.queue.shift());
    saveRooms();
  }
  res.json({ success: true });
});

app.get('/api/rooms', (req, res) => res.json(Object.values(rooms)));

// Donation requires Roblox login
app.post('/api/donate', requireRealUser, async (req, res) => {
  const { receiverId, gamepassId, amount } = req.body;
  const donor = users[req.session.user.id];
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

app.post('/api/purchase-ad', requireRealUser, async (req, res) => {
  const { tier } = req.body;
  const user = users[req.session.user.id];
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

app.post('/api/delete-ad', requireRealUser, (req, res) => {
  for (const k in ads) if (ads[k].userId === req.session.user.id) { delete ads[k]; saveAds(); return res.json({success:true}); }
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

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.listen(PORT, () => console.log(`Passly running on port ${PORT}`));