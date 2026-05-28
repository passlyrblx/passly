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
app.use(express.static('public'));
app.use(session({
  secret: crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Trust proxy for Render
app.set('trust proxy', 1);

// Store for captchas and users (use MongoDB in production)
const captchaStore = new Map();
const users = new Map();

// Roblox OAuth config
const ROBLOX_CONFIG = {
  clientId: process.env.ROBLOX_CLIENT_ID,
  clientSecret: process.env.ROBLOX_CLIENT_SECRET,
  redirectUri: process.env.ROBLOX_REDIRECT_URI,
  authUrl: 'https://apis.roblox.com/oauth/v1/authorize',
  tokenUrl: 'https://apis.roblox.com/oauth/v1/token',
  userInfoUrl: 'https://apis.roblox.com/oauth/v1/userinfo'
};

// Gamepass IDs
const GAMEPASSES = {
  '5k': process.env.GAMEPASS_5K,
  '10k': process.env.GAMEPASS_10K
};

// Captcha generation
function generateCaptcha() {
  const num1 = Math.floor(Math.random() * 10) + 1;
  const num2 = Math.floor(Math.random() * 10) + 1;
  const answer = num1 + num2;
  const id = crypto.randomBytes(16).toString('hex');
  
  captchaStore.set(id, {
    answer: answer,
    expires: Date.now() + 5 * 60 * 1000
  });
  
  return {
    id: id,
    question: `What is ${num1} + ${num2}?`
  };
}

// Serve HTML pages
app.get('/', (req, res) => {
  if (req.session.user) {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  } else {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.get('/dashboard', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/rooms', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'rooms.html'));
});

app.get('/leaderboard', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'leaderboard.html'));
});

app.get('/profile', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

// API Routes
app.get('/api/captcha', (req, res) => {
  const captcha = generateCaptcha();
  res.json(captcha);
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
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'Wrong answer' });
  }
});

app.get('/api/check-captcha', (req, res) => {
  if (req.session.captchaVerified && req.session.lastCaptchaTime) {
    const thirtyMinutes = 30 * 60 * 1000;
    if (Date.now() - req.session.lastCaptchaTime < thirtyMinutes) {
      return res.json({ valid: true });
    }
  }
  res.json({ valid: false });
});

// Roblox OAuth
app.get('/auth/roblox', (req, res) => {
  if (!req.session.captchaVerified) {
    return res.redirect('/?error=captcha');
  }
  
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  
  const params = new URLSearchParams({
    client_id: ROBLOX_CONFIG.clientId,
    redirect_uri: ROBLOX_CONFIG.redirectUri,
    response_type: 'code',
    scope: 'openid profile',
    state: state
  });
  
  res.redirect(`${ROBLOX_CONFIG.authUrl}?${params}`);
});

app.get('/auth/roblox/callback', async (req, res) => {
  const { code, state } = req.query;
  
  if (state !== req.session.oauthState) {
    return res.status(403).send('Invalid state parameter');
  }
  
  try {
    const tokenResponse = await axios.post(ROBLOX_CONFIG.tokenUrl, {
      client_id: ROBLOX_CONFIG.clientId,
      client_secret: ROBLOX_CONFIG.clientSecret,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: ROBLOX_CONFIG.redirectUri
    });
    
    const accessToken = tokenResponse.data.access_token;
    
    const userResponse = await axios.get(ROBLOX_CONFIG.userInfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    
    const robloxUser = userResponse.data;
    
    let user = users.get(robloxUser.sub);
    if (!user) {
      user = {
        id: robloxUser.sub,
        username: robloxUser.preferred_username || robloxUser.name,
        displayName: robloxUser.name,
        avatarUrl: robloxUser.picture || '',
        profile: {
          showBooth: true,
          statusDot: 'online',
          showRoomId: true
        },
        roomId: null,
        donations: { received: 0, given: 0 },
        ad: null,
        createdAt: new Date()
      };
      users.set(robloxUser.sub, user);
    } else {
      user.username = robloxUser.preferred_username || robloxUser.name;
      user.displayName = robloxUser.name;
      user.avatarUrl = robloxUser.picture || '';
    }
    
    req.session.user = {
      id: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl
    };
    
    res.redirect('/dashboard');
    
  } catch (error) {
    console.error('OAuth error:', error.response?.data || error.message);
    res.status(500).send('Authentication failed. Please try again.');
  }
});

app.get('/api/user', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  const user = users.get(req.session.user.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const safeUser = {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    profile: user.profile,
    roomId: user.roomId,
    donations: user.donations,
    ad: user.ad
  };
  
  res.json(safeUser);
});

app.post('/api/purchase-ad', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  const { tier } = req.body;
  const user = users.get(req.session.user.id);
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  if (user.ad && user.ad.active) {
    return res.status(400).json({ error: 'You already have an active ad. Delete it first.' });
  }
  
  const gamepassId = GAMEPASSES[tier];
  if (!gamepassId) {
    return res.status(400).json({ error: 'Invalid tier' });
  }
  
  try {
    const ownsResponse = await axios.get(
      `https://inventory.roblox.com/v1/users/${user.id}/items/GamePass/${gamepassId}`
    );
    
    if (!ownsResponse.data.data || ownsResponse.data.data.length === 0) {
      return res.status(400).json({ error: 'You do not own this gamepass' });
    }
  } catch (error) {
    return res.status(400).json({ error: 'Could not verify ownership. Try again.' });
  }
  
  const shows = tier === '5k' ? 1 : 3;
  user.ad = {
    tier: parseInt(tier.replace('k', '000')),
    gamepassId: gamepassId,
    showsLeft: shows,
    active: true,
    purchasedAt: new Date()
  };
  
  users.set(user.id, user);
  res.json({ success: true, ad: user.ad });
});

app.post('/api/delete-ad', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  const user = users.get(req.session.user.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  user.ad = null;
  users.set(user.id, user);
  res.json({ success: true });
});

app.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Passly running on port ${PORT}`);
});