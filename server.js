const express = require('express');
const session = require('express-session');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// JSON Database files
const DB_USERS = path.join(__dirname, 'data', 'users.json');
const DB_ROOMS = path.join(__dirname, 'data', 'rooms.json');
const DB_DONATIONS = path.join(__dirname, 'data', 'donations.json');
const DB_ADS = path.join(__dirname, 'data', 'ads.json');

// Create data folder and files if not exist
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}

function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) { console.error('Read error:', e); }
  return {};
}

function writeJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (e) { console.error('Write error:', e); }
}

// Initialize databases
let users = readJSON(DB_USERS);
let rooms = readJSON(DB_ROOMS);
let donations = readJSON(DB_DONATIONS);
let ads = readJSON(DB_ADS);

// Save functions
function saveUsers() { writeJSON(DB_USERS, users); }
function saveRooms() { writeJSON(DB_ROOMS, rooms); }
function saveDonations() { writeJSON(DB_DONATIONS, donations); }
function saveAds() { writeJSON(DB_ADS, ads); }

// TRUST PROXY - IMPORTANT FOR RENDER
app.set('trust proxy', 1);

// Session setup - FIXED
app.use(session({
  secret: crypto.randomBytes(32).toString('hex'),
  resave: true,
  saveUninitialized: true,
  cookie: { 
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// Captcha store (memory only)
const captchaStore = new Map();

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

function generateCaptcha() {
  const num1 = Math.floor(Math.random() * 10) + 1;
  const num2 = Math.floor(Math.random() * 10) + 1;
  const answer = num1 + num2;
  const id = crypto.randomBytes(16).toString('hex');
  captchaStore.set(id, { answer, expires: Date.now() + 300000 });
  return { id, question: `What is ${num1} + ${num2}?` };
}

function cleanExpiredDonations() {
  const now = Date.now();
  const fiveMinutes = 5 * 60 * 1000;
  let changed = false;
  for (const key in donations) {
    if (donations[key].timestamp && (now - donations[key].timestamp) > fiveMinutes) {
      delete donations[key];
      changed = true;
    }
  }
  if (changed) saveDonations();
}

setInterval(cleanExpiredDonations, 60000);

// Debug middleware - shows if logged in
app.use((req, res, next) => {
  console.log('Session ID:', req.sessionID);
  console.log('User in session:', req.session.user ? req.session.user.username : 'None');
  next();
});

// Pages
app.get('/', (req, res) => {
  console.log('GET / - Session user:', req.session.user);
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/dashboard', (req, res) => {
  console.log('GET /dashboard - Session user:', req.session.user);
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
    req.session.save();
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

// OAuth - FIXED
app.get('/auth/roblox', (req, res) => {
  if (!req.session.captchaVerified) return res.redirect('/');
  
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.save();
  
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
  console.log('OAuth Callback received');
  const { code, state } = req.query;
  
  if (state !== req.session.oauthState) {
    console.log('State mismatch');
    return res.status(403).send('Invalid state');
  }
  
  try {
    console.log('Exchanging code for token...');
    const tokenRes = await axios.post(ROBLOX_CONFIG.tokenUrl, 
      new URLSearchParams({
        client_id: ROBLOX_CONFIG.clientId,
        client_secret: ROBLOX_CONFIG.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: ROBLOX_CONFIG.redirectUri
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );
    
    console.log('Getting user info...');
    const userRes = await axios.get(ROBLOX_CONFIG.userInfoUrl, {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
    });
    
    const rbUser = userRes.data;
    console.log('Roblox user:', rbUser);
    
    let user = users[rbUser.sub];
    if (!user) {
      user = {
        id: rbUser.sub,
        username: rbUser.preferred_username || rbUser.name || 'Player',
        displayName: rbUser.name || rbUser.preferred_username || 'Player',
        avatarUrl: rbUser.picture || '',
        profile: { showBooth: true, statusDot: 'online', showRoomId: true },
        roomId: null,
        inQueue: false,
        donations: { received: 0, given: 0 },
        createdAt: new Date().toISOString()
      };
    } else {
      user.username = rbUser.preferred_username || user.username;
      user.displayName = rbUser.name || user.displayName;
      user.avatarUrl = rbUser.picture || user.avatarUrl;
    }
    
    users[rbUser.sub] = user;
    saveUsers();
    
    // FIX: Set session and save before redirect
    req.session.user = {
      id: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl
    };
    
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.redirect('/?error=session');
      }
      console.log('Session saved, redirecting to dashboard');
      res.redirect('/dashboard');
    });
    
  } catch (error) {
    console.error('OAuth error:', error.response?.data || error.message);
    res.status(500).send('Authentication failed. <a href="/">Try again</a>');
  }
});

// Check if user is authenticated
app.get('/api/check-auth', (req, res) => {
  if (req.session.user) {
    res.json({ authenticated: true, user: req.session.user });
  } else {
    res.json({ authenticated: false });
  }
});

// User API
app.get('/api/user', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  
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
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  const user = users[req.session.user.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  const { showBooth, statusDot, showRoomId } = req.body;
  if (showBooth !== undefined) user.profile.showBooth = showBooth;
  if (statusDot) user.profile.statusDot = statusDot;
  if (showRoomId !== undefined) user.profile.showRoomId = showRoomId;
  
  users[user.id] = user;
  saveUsers();
  res.json({ success: true });
});

// Rooms API
app.get('/api/rooms', (req, res) => {
  res.json(Object.values(rooms));
});

app.post('/api/rooms/create', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
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
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  
  const user = users[req.session.user.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  if (user.roomId && rooms[user.roomId]) {
    const oldRoom = rooms[user.roomId];
    oldRoom.players = oldRoom.players.filter(id => id !== user.id);
    oldRoom.queue = oldRoom.queue.filter(id => id !== user.id);
    if (oldRoom.queue.length > 0 && oldRoom.players.length < oldRoom.maxPlayers) {
      oldRoom.players.push(oldRoom.queue.shift());
    }
    saveRooms();
  }
  
  if (room.players.length >= room.maxPlayers) {
    if (!room.queue.includes(user.id)) {
      room.queue.push(user.id);
      user.roomId = room.id;
      user.inQueue = true;
      users[user.id] = user;
      saveRooms();
      saveUsers();
      return res.json({ queued: true, position: room.queue.length });
    }
  }
  
  room.players.push(user.id);
  user.roomId = room.id;
  user.inQueue = false;
  users[user.id] = user;
  saveRooms();
  saveUsers();
  
  res.json({ success: true, room });
});

app.post('/api/rooms/leave', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  
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
  users[user.id] = user;
  saveUsers();
  
  res.json({ success: true });
});

// Donation verification
app.get('/api/verify-ownership/:userId/:gamepassId', async (req, res) => {
  const { userId, gamepassId } = req.params;
  try {
    const response = await axios.get(
      `https://inventory.roblox.com/v1/users/${userId}/items/GamePass/${gamepassId}`,
      { timeout: 5000 }
    );
    if (response.data && response.data.data && response.data.data.length > 0) {
      res.json({ owns: true, data: response.data.data[0] });
    } else {
      res.json({ owns: false });
    }
  } catch (error) {
    res.json({ owns: false, error: 'Could not verify' });
  }
});

app.post('/api/donate', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  
  const { receiverId, gamepassId, amount } = req.body;
  const donor = users[req.session.user.id];
  const receiver = users[receiverId];
  
  if (!donor || !receiver) return res.status(404).json({ error: 'User not found' });
  
  try {
    const check = await axios.get(
      `https://inventory.roblox.com/v1/users/${donor.id}/items/GamePass/${gamepassId}`,
      { timeout: 5000 }
    );
    if (!check.data.data || check.data.data.length === 0) {
      return res.status(400).json({ error: 'You do not own this gamepass' });
    }
  } catch (error) {
    return res.status(400).json({ error: 'Could not verify gamepass ownership' });
  }
  
  const recentDonation = Object.values(donations).find(d => 
    d.donorId === donor.id && 
    d.receiverId === receiverId && 
    d.gamepassId === gamepassId &&
    (Date.now() - d.timestamp) < 300000
  );
  
  if (recentDonation) {
    return res.status(400).json({ error: 'You already donated recently. Wait 5 minutes.' });
  }
  
  const donationId = crypto.randomBytes(8).toString('hex');
  donations[donationId] = {
    id: donationId,
    donorId: donor.id,
    donorName: donor.username,
    receiverId: receiver.id,
    receiverName: receiver.username,
    gamepassId,
    amount: amount || 0,
    timestamp: Date.now(),
    expires: Date.now() + 300000
  };
  
  donor.donations.given += (amount || 0);
  receiver.donations.received += (amount || 0);
  users[donor.id] = donor;
  users[receiver.id] = receiver;
  
  saveDonations();
  saveUsers();
  
  res.json({ 
    success: true, 
    donation: donations[donationId],
    message: `${donor.username} donated ${amount} Robux to ${receiver.username}!`
  });
});

app.get('/api/donations', (req, res) => {
  cleanExpiredDonations();
  const active = Object.values(donations).filter(d => d.timestamp > Date.now() - 300000);
  res.json(active);
});

// Ads API
app.post('/api/purchase-ad', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  
  const { tier } = req.body;
  const user = users[req.session.user.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  const existingAd = Object.values(ads).find(a => a.userId === user.id && a.active);
  if (existingAd) return res.status(400).json({ error: 'Delete existing ad first' });
  
  const gamepassId = GAMEPASSES[tier];
  if (!gamepassId) return res.status(400).json({ error: 'Invalid tier' });
  
  try {
    const check = await axios.get(
      `https://inventory.roblox.com/v1/users/${user.id}/items/GamePass/${gamepassId}`,
      { timeout: 5000 }
    );
    if (!check.data.data || check.data.data.length === 0) {
      return res.status(400).json({ error: 'You do not own this gamepass' });
    }
  } catch (error) {
    return res.status(400).json({ error: 'Verification failed' });
  }
  
  const shows = tier === '5k' ? 1 : 3;
  const adId = crypto.randomBytes(8).toString('hex');
  ads[adId] = {
    id: adId, userId: user.id, username: user.username,
    tier: parseInt(tier.replace('k', '000')), gamepassId,
    showsLeft: shows, active: true, purchasedAt: new Date().toISOString()
  };
  
  saveAds();
  res.json({ success: true, ad: ads[adId] });
});

app.post('/api/delete-ad', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  
  for (const key in ads) {
    if (ads[key].userId === req.session.user.id) {
      delete ads[key];
      saveAds();
      return res.json({ success: true });
    }
  }
  res.json({ success: true, message: 'No ad found' });
});

app.get('/api/ads', (req, res) => {
  const activeAds = Object.values(ads).filter(a => a.active && a.showsLeft > 0);
  res.json(activeAds);
});

// Leaderboard
app.get('/api/leaderboard', (req, res) => {
  const allUsers = Object.values(users);
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
  req.session.destroy((err) => {
    if (err) console.error('Logout error:', err);
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

app.listen(PORT, () => {
  console.log(`Passly running on port ${PORT}`);
  console.log('Environment:', process.env.NODE_ENV);
});