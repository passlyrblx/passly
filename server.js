const express = require('express');
const session = require('express-session');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));
app.use(session({
  secret: crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.set('trust proxy', 1);

// Data stores
const captchaStore = new Map();
const users = new Map();
const rooms = new Map();
const donations = [];

// Roblox OAuth config
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

// Captcha
function generateCaptcha() {
  const num1 = Math.floor(Math.random() * 10) + 1;
  const num2 = Math.floor(Math.random() * 10) + 1;
  const answer = num1 + num2;
  const id = crypto.randomBytes(16).toString('hex');
  captchaStore.set(id, { answer, expires: Date.now() + 300000 });
  return { id, question: `What is ${num1} + ${num2}?` };
}

// Pages
app.get('/', (req, res) => {
  if (req.session.user) {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
  } else {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});

app.get('/dashboard', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/rooms', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'rooms.html'));
});

app.get('/leaderboard', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'leaderboard.html'));
});

app.get('/profile', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'profile.html'));
});

// API
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
    req.session.lastCaptchaTime = Date.now();
    return res.json({ success: true });
  }
  res.status(400).json({ error: 'Wrong answer' });
});

app.get('/api/check-captcha', (req, res) => {
  if (req.session.captchaVerified && req.session.lastCaptchaTime) {
    if (Date.now() - req.session.lastCaptchaTime < 1800000) {
      return res.json({ valid: true });
    }
  }
  res.json({ valid: false });
});

// OAuth
app.get('/auth/roblox', (req, res) => {
  if (!req.session.captchaVerified) return res.redirect('/');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: ROBLOX_CONFIG.clientId,
    redirect_uri: ROBLOX_CONFIG.redirectUri,
    response_type: 'code',
    scope: 'openid profile',
    state
  });
  res.redirect(`${ROBLOX_CONFIG.authUrl}?${params}`);
});

app.get('/auth/roblox/callback', async (req, res) => {
  const { code, state } = req.query;
  if (state !== req.session.oauthState) return res.status(403).send('Invalid state');
  
  try {
    const tokenRes = await axios.post(ROBLOX_CONFIG.tokenUrl, {
      client_id: ROBLOX_CONFIG.clientId,
      client_secret: ROBLOX_CONFIG.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: ROBLOX_CONFIG.redirectUri
    });
    
    const userRes = await axios.get(ROBLOX_CONFIG.userInfoUrl, {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
    });
    
    const rbUser = userRes.data;
    let user = users.get(rbUser.sub);
    
    if (!user) {
      user = {
        id: rbUser.sub,
        username: rbUser.preferred_username || rbUser.name,
        displayName: rbUser.name,
        avatarUrl: rbUser.picture || '',
        profile: { showBooth: true, statusDot: 'online', showRoomId: true },
        roomId: null,
        donations: { received: 0, given: 0 },
        ad: null,
        createdAt: new Date()
      };
    } else {
      user.username = rbUser.preferred_username || rbUser.name;
      user.displayName = rbUser.name;
      user.avatarUrl = rbUser.picture || '';
    }
    
    users.set(rbUser.sub, user);
    req.session.user = { id: user.id, username: user.username, avatarUrl: user.avatarUrl };
    res.redirect('/dashboard');
  } catch (error) {
    console.error('OAuth error:', error.message);
    res.status(500).send('Authentication failed');
  }
});

// User API
app.get('/api/user', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  const user = users.get(req.session.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  res.json({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    profile: user.profile,
    roomId: user.roomId,
    donations: user.donations,
    ad: user.ad
  });
});

app.post('/api/profile/update', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  const user = users.get(req.session.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  const { showBooth, statusDot, showRoomId } = req.body;
  if (showBooth !== undefined) user.profile.showBooth = showBooth;
  if (statusDot) user.profile.statusDot = statusDot;
  if (showRoomId !== undefined) user.profile.showRoomId = showRoomId;
  
  users.set(user.id, user);
  res.json({ success: true });
});

// Rooms API
app.get('/api/rooms', (req, res) => {
  res.json(Array.from(rooms.values()));
});

app.post('/api/rooms/create', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  const { name, desc, type } = req.body;
  if (!name) return res.status(400).json({ error: 'Room name required' });
  
  const roomId = crypto.randomBytes(8).toString('hex');
  const room = {
    id: roomId,
    name,
    desc: desc || '',
    type: type || 'Public',
    players: [],
    queue: [],
    maxPlayers: 18,
    createdBy: req.session.user.id,
    createdAt: new Date()
  };
  
  rooms.set(roomId, room);
  res.json(room);
});

app.post('/api/rooms/join/:roomId', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  
  const user = users.get(req.session.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  // Leave current room
  if (user.roomId) {
    const oldRoom = rooms.get(user.roomId);
    if (oldRoom) {
      oldRoom.players = oldRoom.players.filter(id => id !== user.id);
      if (oldRoom.queue.length > 0) {
        oldRoom.players.push(oldRoom.queue.shift());
      }
    }
  }
  
  // Check capacity
  if (room.players.length >= room.maxPlayers) {
    if (!room.queue.includes(user.id)) {
      room.queue.push(user.id);
      user.roomId = room.id;
      user.inQueue = true;
      users.set(user.id, user);
      return res.json({ queued: true, position: room.queue.length });
    }
  }
  
  room.players.push(user.id);
  user.roomId = room.id;
  user.inQueue = false;
  users.set(user.id, user);
  rooms.set(room.id, room);
  
  res.json({ success: true, room });
});

app.post('/api/rooms/leave', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  
  const user = users.get(req.session.user.id);
  if (!user || !user.roomId) return res.json({ success: true });
  
  const room = rooms.get(user.roomId);
  if (room) {
    room.players = room.players.filter(id => id !== user.id);
    room.queue = room.queue.filter(id => id !== user.id);
    if (room.queue.length > 0 && room.players.length < room.maxPlayers) {
      room.players.push(room.queue.shift());
    }
    rooms.set(room.id, room);
  }
  
  user.roomId = null;
  user.inQueue = false;
  users.set(user.id, user);
  
  res.json({ success: true });
});

// Ads API
app.post('/api/purchase-ad', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  
  const { tier } = req.body;
  const user = users.get(req.session.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.ad && user.ad.active) return res.status(400).json({ error: 'Delete existing ad first' });
  
  const gamepassId = GAMEPASSES[tier];
  if (!gamepassId) return res.status(400).json({ error: 'Invalid tier' });
  
  try {
    const check = await axios.get(`https://inventory.roblox.com/v1/users/${user.id}/items/GamePass/${gamepassId}`);
    if (!check.data.data || check.data.data.length === 0) {
      return res.status(400).json({ error: 'You do not own this gamepass' });
    }
  } catch (error) {
    return res.status(400).json({ error: 'Verification failed' });
  }
  
  const shows = tier === '5k' ? 1 : 3;
  user.ad = { tier: parseInt(tier), gamepassId, showsLeft: shows, active: true, purchasedAt: new Date() };
  users.set(user.id, user);
  
  res.json({ success: true, ad: user.ad });
});

app.post('/api/delete-ad', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  const user = users.get(req.session.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  user.ad = null;
  users.set(user.id, user);
  res.json({ success: true });
});

// Leaderboard API
app.get('/api/leaderboard', (req, res) => {
  const allUsers = Array.from(users.values());
  const receivers = allUsers
    .sort((a, b) => b.donations.received - a.donations.received)
    .slice(0, 10)
    .map(u => ({ username: u.username, amount: u.donations.received }));
    
  const donors = allUsers
    .sort((a, b) => b.donations.given - a.donations.given)
    .slice(0, 10)
    .map(u => ({ username: u.username, amount: u.donations.given }));
  
  res.json({ receivers, donors });
});

// Logout
app.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Passly running on port ${PORT}`);
});