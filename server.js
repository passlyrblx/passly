const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'passly-jwt-secret-2024';

// Data folders
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}

const DB_USERS = path.join(__dirname, 'data', 'users.json');
const DB_ROOMS = path.join(__dirname, 'data', 'rooms.json');
const DB_DONATIONS = path.join(__dirname, 'data', 'donations.json');
const DB_ADS = path.join(__dirname, 'data', 'ads.json');
const DB_ADBROADCASTS = path.join(__dirname, 'data', 'adbroadcasts.json');

function readJSON(f) { try { if(fs.existsSync(f)) return JSON.parse(fs.readFileSync(f,'utf8')); } catch(e){} return {}; }
function writeJSON(f, d) { try{ fs.writeFileSync(f, JSON.stringify(d,null,2)); } catch(e){} }

let users = readJSON(DB_USERS);
let rooms = readJSON(DB_ROOMS);
let donations = readJSON(DB_DONATIONS);
let ads = readJSON(DB_ADS);
let adBroadcasts = readJSON(DB_ADBROADCASTS);

function saveUsers() { writeJSON(DB_USERS, users); }
function saveRooms() { writeJSON(DB_ROOMS, rooms); }
function saveDonations() { writeJSON(DB_DONATIONS, donations); }
function saveAds() { writeJSON(DB_ADS, ads); }
function saveAdBroadcasts() { writeJSON(DB_ADBROADCASTS, adBroadcasts); }

// Clean old broadcasts
setInterval(() => {
  const now = Date.now();
  for (const roomId in adBroadcasts) {
    adBroadcasts[roomId] = (adBroadcasts[roomId] || []).filter(b => now - b.timestamp < 600000);
    if (adBroadcasts[roomId].length === 0) delete adBroadcasts[roomId];
  }
  saveAdBroadcasts();
}, 60000);

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

// ========== OAUTH (unchanged) ==========
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
    const avatarUrl = `https://www.roblox.com/headshot-thumbnail/image?userId=${userId}&width=150&height=150&format=png`;

    if (!users[userId]) {
      users[userId] = {
        id: userId, robloxUsername, robloxDisplayName, customDisplayName: null, avatarUrl,
        profile: { showBooth: true, statusDot: 'online', showRoomId: true },
        roomId: null, inQueue: false,
        donations: { received: 0, given: 0 },
        board: [],
        createdAt: new Date().toISOString()
      };
    } else {
      users[userId].robloxUsername = robloxUsername;
      users[userId].robloxDisplayName = robloxDisplayName;
      users[userId].avatarUrl = avatarUrl;
    }
    saveUsers();

    const displayName = users[userId].customDisplayName || robloxDisplayName;
    const token = jwt.sign({ id: userId, username: robloxUsername, displayName, avatarUrl }, JWT_SECRET, { expiresIn: '7d' });
    res.redirect(`/dashboard#token=${token}`);
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.send('<h1>Login Failed</h1><a href="/">Go back</a>');
  }
});

// ========== USER API ==========
app.get('/api/user', authenticateToken, (req, res) => {
  const user = users[req.user.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const ad = Object.values(ads).find(a => a.userId === user.id && a.active);
  res.json({
    id: user.id, robloxUsername: user.robloxUsername, robloxDisplayName: user.robloxDisplayName,
    displayName: user.customDisplayName || user.robloxDisplayName, avatarUrl: user.avatarUrl,
    profile: user.profile, roomId: user.roomId, inQueue: user.inQueue,
    donations: user.donations, ad: ad || null, customDisplayName: user.customDisplayName,
    board: user.board || []
  });
});

app.post('/api/profile/update', authenticateToken, (req, res) => {
  const user = users[req.user.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { showBooth, statusDot, showRoomId, customDisplayName } = req.body;
  if (showBooth !== undefined) user.profile.showBooth = showBooth;
  if (statusDot) user.profile.statusDot = statusDot;
  if (showRoomId !== undefined) user.profile.showRoomId = showRoomId;
  if (customDisplayName !== undefined) user.customDisplayName = customDisplayName.trim().substring(0,20) || null;
  saveUsers();
  res.json({ success: true });
});

// ========== BOARD (unchanged, still accepts price) ==========
app.post('/api/board/add', authenticateToken, async (req, res) => {
  const { assetId, price } = req.body;
  if (!assetId || !price) return res.status(400).json({ error: 'Asset ID and Robux amount required' });
  const user = users[req.user.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.board) user.board = [];
  if (user.board.some(gp => gp.id === assetId)) return res.status(400).json({ error: 'Gamepass already on board' });
  try {
    const check = await axios.get(`https://inventory.roblox.com/v1/users/${user.id}/items/GamePass/${assetId}`, { timeout: 5000 });
    if (!check.data?.data?.length) return res.status(400).json({ error: 'You do not own this gamepass' });
  } catch (e) { return res.status(400).json({ error: 'Ownership verification failed' }); }
  user.board.push({ id: assetId, name: 'Gamepass', price: parseInt(price) });
  saveUsers();
  res.json({ success: true, board: user.board });
});

app.post('/api/board/remove', authenticateToken, (req, res) => {
  const { assetId } = req.body;
  const user = users[req.user.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.board) user.board = [];
  user.board = user.board.filter(gp => gp.id !== assetId);
  saveUsers();
  res.json({ success: true, board: user.board });
});

// ========== ROOMS (FIXED: creator auto-joins) ==========
app.get('/api/rooms', (req, res) => res.json(Object.values(rooms)));

app.post('/api/rooms/create', authenticateToken, (req, res) => {
  const { name, desc, type } = req.body;
  if (!name) return res.status(400).json({ error: 'Room name required' });

  const alreadyInRoom = Object.values(rooms).some(r =>
    r.createdBy === req.user.id || r.players.includes(req.user.id)
  );
  if (alreadyInRoom) return res.status(400).json({ error: 'You must leave your current room first.' });

  const roomId = crypto.randomBytes(8).toString('hex');
  const userId = req.user.id;
  rooms[roomId] = {
    id: roomId,
    name,
    desc: desc || '',
    type: type || 'Public',
    players: [userId],          // creator added automatically
    queue: [],
    maxPlayers: 18,
    createdBy: userId,
    createdAt: new Date().toISOString()
  };

  // Update user's roomId
  if (users[userId]) {
    users[userId].roomId = roomId;
    users[userId].inQueue = false;
    saveUsers();
  }

  saveRooms();
  res.json(rooms[roomId]);
});

app.post('/api/rooms/join/:roomId', authenticateToken, (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const userId = req.user.id;

  // Leave any previous room (if user.roomId is different)
  if (users[userId]?.roomId && rooms[users[userId].roomId] && users[userId].roomId !== room.id) {
    const old = rooms[users[userId].roomId];
    old.players = old.players.filter(id => id !== userId);
    old.queue = old.queue.filter(id => id !== userId);
    if (old.queue.length && old.players.length < old.maxPlayers) old.players.push(old.queue.shift());
    saveRooms();
  }

  // Check if already in this room
  if (room.players.includes(userId)) {
    users[userId].roomId = room.id;
    users[userId].inQueue = false;
    saveUsers();
    return res.json({ success: true, room });
  }

  // Capacity check with queue
  if (room.players.length >= room.maxPlayers) {
    if (!room.queue.includes(userId)) {
      room.queue.push(userId);
      users[userId].roomId = room.id;
      users[userId].inQueue = true;
      saveUsers();
      saveRooms();
      return res.json({ queued: true, position: room.queue.length });
    } else {
      return res.json({ queued: true, position: room.queue.indexOf(userId) + 1 });
    }
  }

  // Add to room
  room.players.push(userId);
  users[userId].roomId = room.id;
  users[userId].inQueue = false;
  saveUsers();
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
  if (users[userId]) {
    users[userId].roomId = null;
    users[userId].inQueue = false;
    saveUsers();
  }
  res.json({ success: true });
});

// ========== DONATIONS (unchanged) ==========
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
  donations[donationId] = { id: donationId, donorId: donor.id, donorName: donor.robloxUsername, receiverId, receiverName: receiver.robloxUsername, gamepassId, amount, timestamp: Date.now() };
  donor.donations.given += amount;
  receiver.donations.received += amount;
  saveDonations(); saveUsers();
  res.json({ success: true, message: `${donor.robloxUsername} donated ${amount} Robux to ${receiver.robloxUsername}!` });
});

app.get('/api/donations', (req, res) => {
  const now = Date.now();
  for (const k in donations) if (now - donations[k].timestamp > 300000) delete donations[k];
  res.json(Object.values(donations));
});

// ========== ADS (unchanged broadcasting logic) ==========
function broadcastAd(ad, is10k = false) {
  const publicRoomIds = Object.keys(rooms).filter(id => rooms[id].type === 'Public');
  if (publicRoomIds.length === 0) return;
  const targetCount = is10k ? publicRoomIds.length : Math.ceil(publicRoomIds.length * 0.75);
  const shuffled = [...publicRoomIds].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, targetCount);
  const advertiser = users[ad.userId];
  if (!advertiser) return;
  selected.forEach(roomId => {
    if (!adBroadcasts[roomId]) adBroadcasts[roomId] = [];
    adBroadcasts[roomId].push({
      board: advertiser.board || [],
      advertiserName: advertiser.customDisplayName || advertiser.robloxDisplayName,
      advertiserId: advertiser.id,
      timestamp: Date.now()
    });
  });
  saveAdBroadcasts();
}

function scheduleBroadcast(ad, delay) {
  setTimeout(() => {
    const currentAd = ads[ad.id];
    if (!currentAd || !currentAd.active || currentAd.showsLeft <= 0) return;
    broadcastAd(currentAd, currentAd.tier === 10000);
    currentAd.showsLeft--;
    saveAds();
    if (currentAd.showsLeft > 0) scheduleBroadcast(currentAd, 10000);
  }, delay);
}

app.post('/api/purchase-ad', authenticateToken, async (req, res) => {
  const { tier } = req.body;
  const user = users[req.user.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (Object.values(ads).some(a => a.userId===user.id && a.active)) return res.status(400).json({ error: 'Delete existing ad first' });
  const gpId = GAMEPASSES[tier];
  if (!gpId) return res.status(400).json({ error: 'Invalid tier' });
  try {
    const check = await axios.get(`https://inventory.roblox.com/v1/users/${user.id}/items/GamePass/${gpId}`, { timeout: 5000 });
    if (!check.data?.data?.length) return res.status(400).json({ error: 'You do not own this gamepass' });
  } catch(e) { return res.status(400).json({ error: 'Verification failed' }); }
  const shows = tier === '5k' ? 1 : 3;
  const tierAmount = tier === '5k' ? 5000 : 10000;
  const adId = crypto.randomBytes(8).toString('hex');
  const newAd = {
    id: adId, userId: user.id, username: user.robloxUsername,
    tier: tierAmount, gamepassId: gpId, showsLeft: shows, active: true,
    purchasedAt: new Date().toISOString()
  };
  ads[adId] = newAd;
  saveAds();
  broadcastAd(newAd, tierAmount === 10000);
  newAd.showsLeft--;
  saveAds();
  if (newAd.showsLeft > 0) scheduleBroadcast(newAd, 10000);
  res.json({ success: true, ad: newAd });
});

app.post('/api/delete-ad', authenticateToken, (req, res) => {
  for (const k in ads) if (ads[k].userId === req.user.id) { delete ads[k]; saveAds(); return res.json({success:true}); }
  res.json({ success: true });
});

app.get('/api/ads', (req, res) => res.json(Object.values(ads).filter(a => a.active && a.showsLeft>0)));

app.get('/api/rooms/:roomId/ad-broadcasts', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  res.json((adBroadcasts[req.params.roomId] || []).filter(b => b.timestamp > since));
});

// ========== LEADERBOARD ==========
app.get('/api/leaderboard', (req, res) => {
  const all = Object.values(users);
  res.json({
    receivers: all.sort((a,b)=>b.donations.received-a.donations.received).slice(0,10).map(u=>({username:u.robloxUsername,amount:u.donations.received})),
    donors: all.sort((a,b)=>b.donations.given-a.donations.given).slice(0,10).map(u=>({username:u.robloxUsername,amount:u.donations.given}))
  });
});

// ========== GUEST ==========
app.post('/api/guest-login', (req, res) => {
  const guestNum = Math.floor(10000 + Math.random() * 90000);
  res.json({ username: `Guest#${guestNum}`, isGuest: true });
});

// ========== DEFAULT ROOMS ==========
if (Object.keys(rooms).length === 0) {
  const defaultRooms = [
    { name: "Chill Donations", desc: "Relax and donate to small creators." },
    { name: "Big Donators", desc: "High donation rooms with active players." },
    { name: "Anime Fans", desc: "A room for anime lovers." }
  ];
  defaultRooms.forEach(r => {
    const roomId = crypto.randomBytes(8).toString('hex');
    rooms[roomId] = {
      id: roomId, name: r.name, desc: r.desc, type: 'Public',
      players: [], queue: [], maxPlayers: 18,
      createdBy: 'system', createdAt: new Date().toISOString()
    };
  });
  saveRooms();
}

// ========== SOCKET.IO for real‑time chat + voice ==========
io.on('connection', (socket) => {
  let currentRoom = null;
  let userId = null;
  let username = 'Guest';

  // Authenticate and join personal room
  socket.on('authenticate', (token) => {
    if (!token) {
      userId = 'guest_' + Math.random().toString(36).substr(2, 9);
      username = 'Guest#' + Math.floor(1000+Math.random()*9000);
    } else {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.id;
        username = decoded.displayName || decoded.username;
      } catch (e) {
        userId = 'invalid';
      }
    }
    socket.emit('authenticated', { userId, username });
  });

  // Join a room's socket channel
  socket.on('join-room', (roomId) => {
    if (currentRoom) socket.leave(currentRoom);
    socket.join(roomId);
    currentRoom = roomId;
    socket.to(roomId).emit('user-joined', { userId, username });
  });

  // Leave current room
  socket.on('leave-room', () => {
    if (currentRoom) {
      socket.to(currentRoom).emit('user-left', { userId, username });
      socket.leave(currentRoom);
      currentRoom = null;
    }
  });

  // Chat message
  socket.on('chat-message', (msg) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit('chat-message', {
      userId,
      username,
      message: msg,
      timestamp: Date.now()
    });
  });

  // Voice data (simple broadcast, no mixing – just relay the audio chunks)
  socket.on('voice-data', (audioChunk) => {
    if (!currentRoom) return;
    // Relay to everyone else in the room
    socket.to(currentRoom).emit('voice-data', {
      userId,
      audio: audioChunk
    });
  });

  // Voice mute status (optional)
  socket.on('voice-mute', (muted) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('voice-mute', { userId, muted });
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      socket.to(currentRoom).emit('user-left', { userId, username });
    }
  });
});

server.listen(PORT, () => console.log(`Passly running on port ${PORT}`));