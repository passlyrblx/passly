const express = require('express');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'passly-jwt-secret-2024';

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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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

// In‑memory state store
const oauthStates = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, time] of oauthStates) {
    if (now - time > 600000) oauthStates.delete(key);
  }
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

  if (!state || !oauthStates.has(state)) {
    return res.status(403).send(`<h1>Invalid State</h1><a href="/">Go back</a>`);
  }
  oauthStates.delete(state);
  if (!code) return res.redirect('/?error=no_code');

  try {
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
    // Roblox userinfo: name = username, nickname = display name, picture = avatar URL
    const robloxUsername = rb.name || 'Player';
    const robloxDisplayName = rb.nickname || robloxUsername;
    const avatarUrl = rb.picture || '';

    if (!users[rb.sub]) {
      users[rb.sub] = {
        id: rb.sub,
        robloxUsername: robloxUsername,
        robloxDisplayName: robloxDisplayName,
        customDisplayName: null,   // user can set a custom name
        avatarUrl: avatarUrl,
        profile: { showBooth: true, statusDot: 'online', showRoomId: true },
        roomId: null,
        inQueue: false,
        donations: { received: 0, given: 0 },
        createdAt: new Date().toISOString()
      };
    } else {
      // Update the Roblox data on each login
      users[rb.sub].robloxUsername = robloxUsername;
      users[rb.sub].robloxDisplayName = robloxDisplayName;
      users[rb.sub].avatarUrl = avatarUrl;
    }
    saveUsers();

    // Determine display name for JWT (custom if set, else Roblox display name)
    const displayName = users[rb.sub].customDisplayName || users[rb.sub].robloxDisplayName;
    const tokenPayload = {
      id: rb.sub,
      username: users[rb.sub].robloxUsername,
      displayName: displayName,
      avatarUrl: avatarUrl
    };
    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

    res.redirect(`/dashboard#token=${token}`);
  } catch (err) {
    console.error('[OAUTH] Error:', err.response?.data || err.message);
    res.send(`<h1>OAuth Error</h1><pre>${JSON.stringify(err.response?.data || err.message)}</pre><a href="/">Try again</a>`);
  }
});

// ========== USER API (returns full user data) ==========
app.get('/api/user', authenticateToken, (req, res) => {
  const user = users[req.user.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const ad = Object.values(ads).find(a => a.userId === user.id && a.active);
  // Send display name (custom or Roblox)
  const displayName = user.customDisplayName || user.robloxDisplayName;
  res.json({
    id: user.id,
    robloxUsername: user.robloxUsername,
    robloxDisplayName: user.robloxDisplayName,
    displayName: displayName,
    avatarUrl: user.avatarUrl,
    profile: user.profile,
    roomId: user.roomId,
    inQueue: user.inQueue,
    donations: user.donations,
    ad: ad || null,
    customDisplayName: user.customDisplayName
  });
});

// Update profile – includes setting a custom display name
app.post('/api/profile/update', authenticateToken, (req, res) => {
  const user = users[req.user.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { showBooth, statusDot, showRoomId, customDisplayName } = req.body;
  if (showBooth !== undefined) user.profile.showBooth = showBooth;
  if (statusDot) user.profile.statusDot = statusDot;
  if (showRoomId !== undefined) user.profile.showRoomId = showRoomId;
  if (customDisplayName !== undefined) {
    // Trim and limit length
    user.customDisplayName = customDisplayName.trim().substring(0, 20) || null;
  }
  saveUsers();
  res.json({ success: true });
});

// ========== ROOMS / DONATIONS / ADS / LEADERBOARD (unchanged) ==========
// (include the same routes as before – I'll give them in the next message if needed)

app.listen(PORT, () => console.log(`Passly running on port ${PORT}`));