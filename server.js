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
const io = socketIo(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'passly-jwt-secret-2024';

if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'));

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
setInterval(() => { for (const [key, time] of oauthStates) if (Date.now() - time > 600000) oauthStates.delete(key); }, 60000);

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
app.get('/auth/roblox', (req, res) => { /* ... same ... */ });
app.get('/auth/roblox/callback', async (req, res) => { /* ... same ... */ });
// (Full OAuth blocks included in the actual file, omitted here for brevity but unchanged)

// ========== USER API (unchanged) ==========
app.get('/api/user', authenticateToken, (req, res) => { /* ... same ... */ });
app.post('/api/profile/update', authenticateToken, (req, res) => { /* ... same ... */ });

// ========== SEARCH ==========
app.get('/api/search', (req, res) => {
  const query = (req.query.username || '').toLowerCase().trim();
  if (!query) return res.status(400).json({ error: 'Username required' });

  const found = Object.values(users).find(u => u.robloxUsername && u.robloxUsername.toLowerCase() === query);
  if (!found) return res.json({ error: 'User not found' });

  const showBoard = found.profile?.showBooth !== false;
  res.json({
    id: found.id,
    robloxUsername: found.robloxUsername,
    displayName: found.customDisplayName || found.robloxDisplayName,
    avatarUrl: found.avatarUrl,
    board: showBoard ? (found.board || []) : []
  });
});

// ========== BOARD (unchanged) ==========
app.post('/api/board/add', authenticateToken, async (req, res) => { /* ... same ... */ });
app.post('/api/board/remove', authenticateToken, (req, res) => { /* ... same ... */ });

// ========== ROOMS (unchanged) ==========
app.get('/api/rooms', (req, res) => res.json(Object.values(rooms)));
app.post('/api/rooms/create', authenticateToken, (req, res) => { /* ... same ... */ });
app.post('/api/rooms/join/:roomId', authenticateToken, (req, res) => { /* ... same ... */ });
app.post('/api/rooms/leave', authenticateToken, (req, res) => { /* ... same ... */ });

// ========== DONATIONS (unchanged) ==========
app.post('/api/donate', authenticateToken, async (req, res) => { /* ... same ... */ });
app.get('/api/donations', (req, res) => { /* ... same ... */ });

// ========== ADS (updated) ==========
function broadcastAd(ad) {
  const publicRoomIds = Object.keys(rooms).filter(id => rooms[id].type === 'Public');
  if (publicRoomIds.length === 0) return;
  const targetCount = Math.ceil(publicRoomIds.length * 0.75); // 75% for both tiers
  const shuffled = [...publicRoomIds].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, targetCount);

  const advertiser = users[ad.userId];
  if (!advertiser) return;

  const messageText = ad.message ? `<p style="margin-top:5px; font-style:italic;">"${ad.message}"</p>` : '';

  selected.forEach(roomId => {
    if (!adBroadcasts[roomId]) adBroadcasts[roomId] = [];
    adBroadcasts[roomId].push({
      board: advertiser.board || [],
      advertiserName: advertiser.customDisplayName || advertiser.robloxDisplayName,
      advertiserId: advertiser.id,
      message: ad.message || '',
      timestamp: Date.now()
    });
  });
  saveAdBroadcasts();
}

app.post('/api/purchase-ad', authenticateToken, async (req, res) => {
  const { tier, message } = req.body;
  const user = users[req.user.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (Object.values(ads).some(a => a.userId===user.id && a.active)) return res.status(400).json({ error: 'Delete existing ad first' });

  const gpId = GAMEPASSES[tier];
  if (!gpId) return res.status(400).json({ error: 'Invalid tier' });

  try {
    const check = await axios.get(`https://inventory.roblox.com/v1/users/${user.id}/items/GamePass/${gpId}`, { timeout: 5000 });
    if (!check.data?.data?.length) return res.status(400).json({ error: 'You do not own this gamepass' });
  } catch(e) { return res.status(400).json({ error: 'Verification failed' }); }

  const tierAmount = tier === '5k' ? 5000 : 10000;
  const adId = crypto.randomBytes(8).toString('hex');
  const newAd = {
    id: adId,
    userId: user.id,
    username: user.robloxUsername,
    tier: tierAmount,
    gamepassId: gpId,
    broadcastsLeft: 1,           // always 1 chat broadcast
    showsLeft: tier === '5k' ? 1 : 3,   // clouds on dashboard
    active: true,
    message: message?.trim().substring(0, 200) || '',
    purchasedAt: new Date().toISOString()
  };
  ads[adId] = newAd;
  saveAds();

  // Send the single broadcast immediately
  broadcastAd(newAd);
  newAd.broadcastsLeft = 0;
  saveAds();

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

// ========== LEADERBOARD (unchanged) ==========
app.get('/api/leaderboard', (req, res) => { /* ... same ... */ });

// ========== GUEST (unchanged) ==========
app.post('/api/guest-login', (req, res) => { /* ... same ... */ });

// ========== DEFAULT ROOMS (unchanged) ==========
if (Object.keys(rooms).length === 0) { /* ... same ... */ }

// ========== SOCKET.IO (unchanged) ==========
io.on('connection', (socket) => { /* ... same ... */ });

server.listen(PORT, () => console.log(`Passly running on port ${PORT}`));