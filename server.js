const express = require('express');
const cookieSession = require('cookie-session');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Create data directory
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}

// JSON Database
const DB_USERS = path.join(__dirname, 'data', 'users.json');
const DB_ROOMS = path.join(__dirname, 'data', 'rooms.json');
const DB_DONATIONS = path.join(__dirname, 'data', 'donations.json');
const DB_ADS = path.join(__dirname, 'data', 'ads.json');

function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {}
  return {};
}

function writeJSON(filePath, data) {
  try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); } catch (e) {}
}

let users = readJSON(DB_USERS);
let rooms = readJSON(DB_ROOMS);
let donations = readJSON(DB_DONATIONS);
let ads = readJSON(DB_ADS);

function saveUsers() { writeJSON(DB_USERS, users); }
function saveRooms() { writeJSON(DB_ROOMS, rooms); }
function saveDonations() { writeJSON(DB_DONATIONS, donations); }
function saveAds() { writeJSON(DB_ADS, ads); }

// Trust proxy for Render
app.set('trust proxy', 1);

// Cookie session – stores session in browser cookie
app.use(cookieSession({
  name: 'passly_session',
  keys: [process.env.SESSION_SECRET || 'passly-secret-key-2024'],
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  secure: process.env.NODE_ENV === 'production',
  httpOnly: true,
  sameSite: 'lax'
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// Make user object available in templates (if needed)
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

const captchaStore = new Map();

const ROBLOX_CONFIG = {
  clientId: process.env.ROBLOX_CLIENT_ID,
  clientSecret: process.env.ROBLOX_CLIENT_SECRET,
  redirectUri: process.env.ROBLOX_REDIRECT_URI || 'http://localhost:3000/auth/roblox/callback',
  authUrl: 'https://apis.roblox.com/oauth/v1/authorize',
  tokenUrl: 'https://apis.roblox.com/oauth/v1/token',
  userInfoUrl: 'https://apis.roblox.com/oauth/v1/userinfo'
};

const GAMEPASSES = {
  '5k': process.env.GAMEPASS_5K,
  '10k': process.env.GAMEPASS_10K
};

function generateCaptcha() {
  const num1 = Math.floor(Math.random() * 10) + 1;
  const num2 = Math.floor(Math.random() * 10) + 1;
  const id = crypto.randomBytes(16).toString('hex');
  captchaStore.set(id, { answer: num1 + num2, expires: Date.now() + 300000 });
  return { id, question: `What is ${num1} + ${num2}?` };
}

function cleanExpiredDonations() {
  const now = Date.now();
  let changed = false;
  for (const key in donations) {
    if (donations[key].timestamp && (now - donations[key].timestamp) > 300000) {
      delete donations[key];
      changed = true;
    }
  }
  if (changed) saveDonations();
}
setInterval(cleanExpiredDonations, 60000);

// ============ PAGES ============

app.get('/', (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect('/dashboard');
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  res.redirect('/?error=login_required');
}

app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/rooms', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'rooms.html'));
});

app.get('/leaderboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'leaderboard.html'));
});

app.get('/profile', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'profile.html'));
});

// ============ API ============

app.get('/api/captcha', (req, res) => {
  res.json(generateCaptcha());
});

app.post('/api/verify-captcha', (req, res) => {
  const { captchaId, answer } = req.body;
  const captcha = captchaStore.get(captchaId);
  if (!captcha || Date.now() > captcha.expires) {
    captchaStore.delete(captchaId);
    return res.status(400).json({ error: 'Captcha expired' });
  }
  if (parseInt(answer) === captcha.answer) {
    captchaStore.delete(captchaId);
    req.session.captchaVerified = true;
    return res.json({ success: true });
  }
  res.status(400).json({ error: 'Wrong answer' });
});

app.get('/api/check-auth', (req, res) => {
  if (req.session && req.session.user) {
    res.json({ authenticated: true, user: req.session.user });
  } else {
    res.json({ authenticated: false });
  }
});

// ============ OAUTH ============

app.get('/auth/roblox', (req, res) => {
  if (!req.session.captchaVerified) {
    return res.redirect('/?error=captcha_required');
  }
  
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
  const { code, state, error: oauthError } = req.query;
  
  // If user denied authorization
  if (oauthError === 'access_denied') {
    return res.send(`
      <html><body style="background:#0a0a14;color:white;font-family:Arial;text-align:center;padding:50px;">
        <h1 style="color:#f87171;">❌ Authorization Denied</h1>
        <p>You need to authorize Passly to access your Roblox account.</p>
        <a href="/" style="color:#8b5cf6;font-size:1.2rem;">← Try Again</a>
      </body></html>
    `);
  }
  
  if (state !== req.session.oauthState) {
    return res.status(403).send('Invalid state. <a href="/">Go back</a>');
  }
  
  if (!code) {
    return res.redirect('/?error=no_code');
  }
  
  try {
    // Exchange code for token
    const tokenRes = await axios.post(ROBLOX_CONFIG.tokenUrl, 
      new URLSearchParams({
        client_id: ROBLOX_CONFIG.clientId,
        client_secret: ROBLOX_CONFIG.clientSecret,
        grant_type: 'authorization_code',
        code
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    
    // Get user info
    const userRes = await axios.get(ROBLOX_CONFIG.userInfoUrl, {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
    });
    
    const rbUser = userRes.data;
    
    // Save/update user in database
    let user = users[rbUser.sub];
    if (!user) {
      user = {
        id: rbUser.sub,
        username: rbUser.name || 'Player',
        displayName: rbUser.nickname || rbUser.name || 'Player',
        avatarUrl: rbUser.picture || '',
        profile: { showBooth: true, statusDot: 'online', showRoomId: true },
        roomId: null,
        inQueue: false,
        donations: { received: 0, given: 0 },
        createdAt: new Date().toISOString()
      };
    } else {
      // Update info on each login
      user.username = rbUser.name || user.username;
      user.displayName = rbUser.nickname || user.displayName;
      user.avatarUrl = rbUser.picture || user.avatarUrl;
    }
    
    users[rbUser.sub] = user;
    saveUsers();
    
    // Set session in cookie (automatically signed and sent to browser)
    req.session.user = {
      id: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl
    };
    
    // Redirect to dashboard – cookie will be sent automatically
    res.redirect('/dashboard');
    
  } catch (error) {
    console.error('OAuth Error:', error.response?.data || error.message);
    res.redirect('/?error=oauth_failed');
  }
});

// ============ USER API ============

app.get('/api/user', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  const user = users[req.session.user.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  const userAd = Object.values(ads).find(a => a.userId === user.id && a.active && a.showsLeft > 0);
  
  res.json({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    profile: user.profile,
    roomId: user.roomId,
    inQueue: user.inQueue,
    donations: user.donations,
    ad: userAd || null
  });
});

app.post('/api/profile/update', (req, res) => {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  
  const user = users[req.session.user.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  const { showBooth, statusDot, showRoomId } = req.body;
  if (showBooth !== undefined) user.profile.showBooth = showBooth;
  if (statusDot) user.profile.statusDot = statusDot;
  if (showRoomId !== undefined) user.profile.showRoomId = showRoomId;
  
  saveUsers();
  res.json({ success: true });
});

// ============ ROOMS ============

app.get('/api/rooms', (req, res) => {
  res.json(Object.values(rooms));
});

app.post('/api/rooms/create', (req, res) => {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  
  const { name, desc, type } = req.body;
  if (!name) return res.status(400).json({ error: 'Room name required' });
  
  const roomId = crypto.randomBytes(8).toString('hex');
  rooms[roomId] = {
    id: roomId, name, desc: desc || '', type: type || 'Public',
    players: [], queue: [], maxPlayers: 18,
    createdBy: req.session.user.id, createdAt: new Date().toISOString()
  };
  
  saveRooms();
  res.json(rooms[roomId]);
});

app.post('/api/rooms/join/:roomId', (req, res) => {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  
  const user = users[req.session.user.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  // Leave current room
  if (user.roomId && rooms[user.roomId]) {
    const oldRoom = rooms[user.roomId];
    oldRoom.players = oldRoom.players.filter(id => id !== user.id);
    oldRoom.queue = oldRoom.queue.filter(id => id !== user.id);
    if (oldRoom.queue.length > 0 && oldRoom.players.length < oldRoom.maxPlayers) {
      oldRoom.players.push(oldRoom.queue.shift());
    }
  }
  
  // Check capacity
  if (room.players.length >= room.maxPlayers) {
    if (!room.queue.includes(user.id)) {
      room.queue.push(user.id);
      user.roomId = room.id;
      user.inQueue = true;
      saveRooms();
      saveUsers();
      return res.json({ queued: true, position: room.queue.length });
    }
  }
  
  room.players.push(user.id);
  user.roomId = room.id;
  user.inQueue = false;
  saveRooms();
  saveUsers();
  
  res.json({ success: true, room });
});

app.post('/api/rooms/leave', (req, res) => {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  
  const user = users[req.session.user.id];
  if (!user || !user.roomId) return res.json({ success: true });
  
  const room = rooms[user.roomId];
  if (room) {
    room.players = room.players.filter(id => id !== user.id);
    room.queue = room.queue.filter(id => id !== user.id);
    if (room.queue.length > 0 && room.players.length < room.maxPlayers) {
      room.players.push(room.queue.shift());
    }
    saveRooms();
  }
  
  user.roomId = null;
  user.inQueue = false;
  saveUsers();
  
  res.json({ success: true });
});

// ============ DONATIONS ============

app.get('/api/verify-ownership/:userId/:gamepassId', async (req, res) => {
  try {
    const response = await axios.get(
      `https://inventory.roblox.com/v1/users/${req.params.userId}/items/GamePass/${req.params.gamepassId}`,
      { timeout: 5000 }
    );
    res.json({ owns: response.data?.data?.length > 0 });
  } catch (error) {
    res.json({ owns: false });
  }
});

app.post('/api/donate', async (req, res) => {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  
  const { receiverId, gamepassId, amount } = req.body;
  const donor = users[req.session.user.id];
  const receiver = users[receiverId];
  
  if (!donor || !receiver) return res.status(404).json({ error: 'User not found' });
  
  try {
    const check = await axios.get(
      `https://inventory.roblox.com/v1/users/${donor.id}/items/GamePass/${gamepassId}`,
      { timeout: 5000 }
    );
    if (!check.data?.data?.length) {
      return res.status(400).json({ error: 'You do not own this gamepass' });
    }
  } catch (error) {
    return res.status(400).json({ error: 'Verification failed' });
  }
  
  const recent = Object.values(donations).find(d => 
    d.donorId === donor.id && d.receiverId === receiverId && 
    d.gamepassId === gamepassId && (Date.now() - d.timestamp) < 300000
  );
  if (recent) return res.status(400).json({ error: 'Wait 5 minutes' });
  
  const donationId = crypto.randomBytes(8).toString('hex');
  donations[donationId] = {
    id: donationId, donorId: donor.id, donorName: donor.username,
    receiverId: receiver.id, receiverName: receiver.username,
    gamepassId, amount: amount || 0, timestamp: Date.now()
  };
  
  donor.donations.given += (amount || 0);
  receiver.donations.received += (amount || 0);
  
  saveDonations();
  saveUsers();
  
  res.json({ success: true, message: `${donor.username} donated ${amount} Robux to ${receiver.username}!` });
});

app.get('/api/donations', (req, res) => {
  cleanExpiredDonations();
  res.json(Object.values(donations).filter(d => Date.now() - d.timestamp < 300000));
});

// ============ ADS ============

app.post('/api/purchase-ad', async (req, res) => {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  
  const { tier } = req.body;
  const user = users[req.session.user.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  if (Object.values(ads).some(a => a.userId === user.id && a.active)) {
    return res.status(400).json({ error: 'Delete existing ad first' });
  }
  
  const gamepassId = GAMEPASSES[tier];
  if (!gamepassId) return res.status(400).json({ error: 'Invalid tier' });
  
  try {
    const check = await axios.get(
      `https://inventory.roblox.com/v1/users/${user.id}/items/GamePass/${gamepassId}`,
      { timeout: 5000 }
    );
    if (!check.data?.data?.length) {
      return res.status(400).json({ error: 'You do not own this gamepass' });
    }
  } catch (error) {
    return res.status(400).json({ error: 'Verification failed' });
  }
  
  const adId = crypto.randomBytes(8).toString('hex');
  ads[adId] = {
    id: adId, userId: user.id, username: user.username,
    tier: parseInt(tier), gamepassId,
    showsLeft: tier === '5k' ? 1 : 3, active: true,
    purchasedAt: new Date().toISOString()
  };
  
  saveAds();
  res.json({ success: true, ad: ads[adId] });
});

app.post('/api/delete-ad', (req, res) => {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  
  for (const key in ads) {
    if (ads[key].userId === req.session.user.id) {
      delete ads[key];
      saveAds();
      return res.json({ success: true });
    }
  }
  res.json({ success: true });
});

app.get('/api/ads', (req, res) => {
  res.json(Object.values(ads).filter(a => a.active && a.showsLeft > 0));
});

// ============ LEADERBOARD ============

app.get('/api/leaderboard', (req, res) => {
  const allUsers = Object.values(users);
  res.json({
    receivers: allUsers.sort((a, b) => b.donations.received - a.donations.received).slice(0, 10)
      .map(u => ({ username: u.username, amount: u.donations.received })),
    donors: allUsers.sort((a, b) => b.donations.given - a.donations.given).slice(0, 10)
      .map(u => ({ username: u.username, amount: u.donations.given }))
  });
});

// ============ LOGOUT ============

app.post('/logout', (req, res) => {
  req.session = null; // Clear cookie session
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Passly running on port ${PORT}`);
});