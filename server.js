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
const RP_ID = process.env.RP_ID || 'localhost';           // change to your domain in production
const RP_NAME = 'Passly';
const ORIGIN = process.env.ORIGIN || 'http://localhost:3000';  // change to your Render URL

mongoose.connect(MONGO_URI).then(() => console.log('MongoDB connected')).catch(err => console.error(err));

// ----- Schemas (updated: added credentials for passkey) -----
const userSchema = new mongoose.Schema({
  _id: String,
  robloxUsername: String,
  robloxDisplayName: String,
  customDisplayName: String,
  avatarUrl: String,
  profile: {
    showBooth: { type: Boolean, default: true },
    statusDot: { type: String, default: 'online' },
    showRoomId: { type: Boolean, default: true }
  },
  roomId: String,
  inQueue: Boolean,
  donations: { received: Number, given: Number },
  board: [{ id: String, name: String, price: Number }],
  credentials: [{                    // WebAuthn credentials
    id: String,
    publicKey: Buffer,
    counter: Number,
    transports: [String]
  }],
  createdAt: { type: Date, default: Date.now }
});

const roomSchema = new mongoose.Schema({ /* unchanged */ });
const donationSchema = new mongoose.Schema({ /* unchanged */ });
const adSchema = new mongoose.Schema({ /* unchanged */ });
const adBroadcastSchema = new mongoose.Schema({ /* unchanged */ });

const User = mongoose.model('User', userSchema);
const Room = mongoose.model('Room', roomSchema);
const Donation = mongoose.model('Donation', donationSchema);
const Ad = mongoose.model('Ad', adSchema);
const AdBroadcast = mongoose.model('AdBroadcast', adBroadcastSchema);

// In‑memory challenge store
const challengeStore = new Map();

// ... (setInterval for clearing old broadcasts, middlewares, ROBLOX_CONFIG, etc. – same as before) ...

// ========== OAUTH (unchanged) ==========
// ... same as previous MongoDB version ...

// ========== USER API (unchanged) ==========
// ... same as previous MongoDB version ...

// ========== PASSKEY ENDPOINTS ==========

// 1. Start registration (user must be logged in)
app.post('/api/passkey/register-options', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Generate registration options
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: user._id,
      userName: user.robloxUsername || user._id,
      attestationType: 'none',
      excludeCredentials: user.credentials.map(cred => ({
        id: Buffer.from(cred.id, 'base64'),
        type: 'public-key',
        transports: cred.transports
      }))
    });

    // Store challenge temporarily
    challengeStore.set(user._id, options.challenge);

    res.json(options);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Registration options failed' });
  }
});

// 2. Verify registration
app.post('/api/passkey/register-verify', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const challenge = challengeStore.get(user._id);
    if (!challenge) return res.status(400).json({ error: 'Challenge expired' });

    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: false
    });

    if (verification.verified) {
      const { registrationInfo } = verification;
      user.credentials.push({
        id: registrationInfo.credentialID,
        publicKey: Buffer.from(registrationInfo.credentialPublicKey),
        counter: registrationInfo.counter,
        transports: req.body.response.transports || []
      });
      await user.save();
      challengeStore.delete(user._id);
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Verification failed' });
    }
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: 'Registration failed' });
  }
});

// 3. Login options (no auth required)
app.post('/api/passkey/login-options', async (req, res) => {
  try {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'preferred'
    });

    // Store challenge with a random key (we'll need to retrieve it later)
    const loginKey = crypto.randomBytes(16).toString('hex');
    challengeStore.set(loginKey, options.challenge);

    res.json({ ...options, loginKey });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Login options failed' });
  }
});

// 4. Verify login assertion
app.post('/api/passkey/login-verify', async (req, res) => {
  try {
    const { loginKey, ...response } = req.body;
    if (!loginKey) return res.status(400).json({ error: 'Missing login key' });

    const challenge = challengeStore.get(loginKey);
    if (!challenge) return res.status(400).json({ error: 'Challenge expired' });

    // Find the user by credential ID
    const credentialId = response.id;
    const user = await User.findOne({ 'credentials.id': credentialId });
    if (!user) return res.status(400).json({ error: 'No account linked to this passkey' });

    // Verify the authentication
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: credentialId,
        publicKey: Uint8Array.from(user.credentials.find(c => c.id === credentialId).publicKey),
        counter: user.credentials.find(c => c.id === credentialId).counter
      },
      requireUserVerification: false
    });

    if (verification.verified) {
      // Update counter
      const cred = user.credentials.find(c => c.id === credentialId);
      cred.counter = verification.authenticationInfo.newCounter;
      await user.save();

      challengeStore.delete(loginKey);

      // Generate JWT
      const token = jwt.sign(
        { id: user._id, username: user.robloxUsername, displayName: user.customDisplayName || user.robloxDisplayName, avatarUrl: user.avatarUrl },
        JWT_SECRET,
        { expiresIn: '7d' }
      );
      res.json({ success: true, token });
    } else {
      res.status(400).json({ error: 'Authentication failed' });
    }
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: 'Login verification failed' });
  }
});

// ========== REST OF THE ROUTES (rooms, donations, ads, leaderboard, guest, socket.io) ==========
// ... copy from the previous MongoDB server.js Part 2 (unchanged) ...
// ========== USER API ==========
app.get('/api/user', authenticateToken, async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const avatarUrl = user.avatarUrl || '';
  const avatarFallback = avatarUrl ? '' : `https://www.roblox.com/bust-thumbnail/image?userId=${user._id}&width=150&height=150&format=png`;
  const activeAd = await Ad.findOne({ userId: user._id, active: true });

  res.json({
    id: user._id,
    robloxUsername: user.robloxUsername || '',
    robloxDisplayName: user.robloxDisplayName || '',
    displayName: user.customDisplayName || user.robloxDisplayName || '',
    avatarUrl,
    avatarFallback,
    profile: user.profile,
    roomId: user.roomId,
    inQueue: user.inQueue,
    donations: user.donations,
    ad: activeAd || null,
    customDisplayName: user.customDisplayName || null,
    board: user.board || []
  });
});

app.post('/api/profile/update', authenticateToken, async (req, res) => {
  const { showBooth, statusDot, showRoomId, customDisplayName } = req.body;
  const update = {};
  if (showBooth !== undefined) update['profile.showBooth'] = showBooth;
  if (statusDot) update['profile.statusDot'] = statusDot;
  if (showRoomId !== undefined) update['profile.showRoomId'] = showRoomId;
  if (customDisplayName !== undefined) update.customDisplayName = customDisplayName.trim().substring(0,20) || null;

  await User.findByIdAndUpdate(req.user.id, { $set: update });
  res.json({ success: true });
});

// ========== SEARCH ==========
app.get('/api/search', async (req, res) => {
  const query = (req.query.username || '').toLowerCase().trim();
  if (!query) return res.status(400).json({ error: 'Username required' });
  const found = await User.findOne({ robloxUsername: new RegExp(`^${query}$`, 'i') });
  if (!found) return res.json({ error: 'User not found' });
  const showBoard = found.profile.showBooth !== false;
  res.json({
    id: found._id,
    robloxUsername: found.robloxUsername,
    displayName: found.customDisplayName || found.robloxDisplayName,
    avatarUrl: found.avatarUrl,
    board: showBoard ? (found.board || []) : []
  });
});

// ========== PUBLIC BOARD ==========
app.get('/api/user/:userId/board', authenticateToken, async (req, res) => {
  const user = await User.findById(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const showBoard = user.profile.showBooth !== false;
  res.json({
    id: user._id,
    displayName: user.customDisplayName || user.robloxDisplayName,
    avatarUrl: user.avatarUrl,
    board: showBoard ? (user.board || []) : []
  });
});

// ========== BOARD ==========
app.post('/api/board/add', authenticateToken, async (req, res) => {
  const { assetId, price } = req.body;
  if (!assetId || !price) return res.status(400).json({ error: 'Asset ID and Robux amount required' });
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (user.board.some(gp => gp.id === assetId)) return res.status(400).json({ error: 'Gamepass already on board' });

  try {
    const check = await axios.get(`https://inventory.roblox.com/v1/users/${user._id}/items/GamePass/${assetId}`, { timeout: 5000 });
    if (!check.data?.data?.length) return res.status(400).json({ error: 'You do not own this gamepass' });
  } catch (e) { return res.status(400).json({ error: 'Ownership verification failed' }); }

  user.board.push({ id: assetId, name: 'Gamepass', price: parseInt(price) });
  await user.save();
  res.json({ success: true, board: user.board });
});

app.post('/api/board/remove', authenticateToken, async (req, res) => {
  const { assetId } = req.body;
  await User.findByIdAndUpdate(req.user.id, { $pull: { board: { id: assetId } } });
  const user = await User.findById(req.user.id);
  res.json({ success: true, board: user.board });
});

// ========== ROOMS ==========
app.get('/api/rooms', async (req, res) => {
  const rooms = await Room.find({});
  res.json(rooms);
});

app.post('/api/rooms/create', authenticateToken, async (req, res) => {
  const { name, desc, type } = req.body;
  if (!name) return res.status(400).json({ error: 'Room name required' });

  const alreadyInRoom = await Room.findOne({
    $or: [{ createdBy: req.user.id }, { players: req.user.id }]
  });
  if (alreadyInRoom) return res.status(400).json({ error: 'You must leave your current room first.' });

  const roomId = crypto.randomBytes(8).toString('hex');
  await Room.create({
    _id: roomId, name, desc: desc || '', type: type || 'Public',
    players: [req.user.id], queue: [], maxPlayers: 18, createdBy: req.user.id
  });
  await User.findByIdAndUpdate(req.user.id, { roomId, inQueue: false });
  const room = await Room.findById(roomId);
  res.json(room);
});

app.post('/api/rooms/join/:roomId', authenticateToken, async (req, res) => {
  const room = await Room.findById(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const userId = req.user.id;
  const user = await User.findById(userId);

  if (user.roomId && user.roomId !== room._id) {
    const oldRoom = await Room.findById(user.roomId);
    if (oldRoom) {
      oldRoom.players = oldRoom.players.filter(id => id !== userId);
      oldRoom.queue = oldRoom.queue.filter(id => id !== userId);
      if (oldRoom.queue.length && oldRoom.players.length < oldRoom.maxPlayers) {
        oldRoom.players.push(oldRoom.queue.shift());
      }
      await oldRoom.save();
    }
  }

  if (room.players.includes(userId)) {
    await User.findByIdAndUpdate(userId, { roomId: room._id, inQueue: false });
    return res.json({ success: true, room });
  }

  if (room.players.length >= room.maxPlayers) {
    if (!room.queue.includes(userId)) {
      room.queue.push(userId);
      await room.save();
      await User.findByIdAndUpdate(userId, { roomId: room._id, inQueue: true });
      return res.json({ queued: true, position: room.queue.length });
    }
    return res.json({ queued: true, position: room.queue.indexOf(userId) + 1 });
  }

  room.players.push(userId);
  await room.save();
  await User.findByIdAndUpdate(userId, { roomId: room._id, inQueue: false });
  res.json({ success: true, room });
});

app.post('/api/rooms/leave', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const user = await User.findById(userId);
  if (!user || !user.roomId) return res.json({ success: true });

  const room = await Room.findById(user.roomId);
  if (room) {
    room.players = room.players.filter(id => id !== userId);
    room.queue = room.queue.filter(id => id !== userId);
    if (room.queue.length && room.players.length < room.maxPlayers) {
      room.players.push(room.queue.shift());
    }
    await room.save();
  }
  await User.findByIdAndUpdate(userId, { roomId: null, inQueue: false });
  res.json({ success: true });
});

// ========== DONATIONS ==========
app.post('/api/donate', authenticateToken, async (req, res) => {
  const { receiverId, gamepassId, amount } = req.body;
  const donor = await User.findById(req.user.id);
  const receiver = await User.findById(receiverId);
  if (!donor || !receiver) return res.status(404).json({ error: 'User not found' });

  try {
    const check = await axios.get(`https://inventory.roblox.com/v1/users/${donor._id}/items/GamePass/${gamepassId}`, { timeout: 5000 });
    if (!check.data?.data?.length) return res.status(400).json({ error: 'You do not own this gamepass' });
  } catch (e) { return res.status(400).json({ error: 'Verification failed' }); }

  const recent = await Donation.findOne({
    donorId: donor._id, receiverId, gamepassId,
    timestamp: { $gt: new Date(Date.now() - 300000) }
  });
  if (recent) return res.status(400).json({ error: 'Wait 5 minutes' });

  const donationId = crypto.randomBytes(8).toString('hex');
  await Donation.create({
    _id: donationId, donorId: donor._id, donorName: donor.robloxUsername,
    receiverId, receiverName: receiver.robloxUsername, gamepassId, amount, timestamp: new Date()
  });

  donor.donations.given += amount;
  receiver.donations.received += amount;
  await donor.save();
  await receiver.save();

  res.json({ success: true, message: `${donor.robloxUsername} donated ${amount} Robux to ${receiver.robloxUsername}!` });
});

app.get('/api/donations', async (req, res) => {
  const donations = await Donation.find({ timestamp: { $gt: new Date(Date.now() - 300000) } });
  res.json(donations);
});

// ========== ADS ==========
async function broadcastAd(ad) {
  const publicRoomIds = (await Room.find({ type: 'Public' })).map(r => r._id);
  if (publicRoomIds.length === 0) return;

  const targetCount = Math.ceil(publicRoomIds.length * 0.75);
  const shuffled = publicRoomIds.sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, targetCount);

  const advertiser = await User.findById(ad.userId);
  if (!advertiser) return;

  const broadcasts = selected.map(roomId => ({
    roomId,
    board: advertiser.board || [],
    advertiserName: advertiser.customDisplayName || advertiser.robloxDisplayName,
    advertiserId: advertiser._id,
    message: ad.message || '',
    timestamp: new Date()
  }));
  await AdBroadcast.insertMany(broadcasts);
}

app.post('/api/purchase-ad', authenticateToken, async (req, res) => {
  const { tier, message } = req.body;
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const existingAd = await Ad.findOne({ userId: user._id, active: true });
  if (existingAd) return res.status(400).json({ error: 'Delete existing ad first' });

  const gpId = GAMEPASSES[tier];
  if (!gpId) return res.status(400).json({ error: 'Invalid tier' });

  try {
    const check = await axios.get(`https://inventory.roblox.com/v1/users/${user._id}/items/GamePass/${gpId}`, { timeout: 5000 });
    if (!check.data?.data?.length) return res.status(400).json({ error: 'You do not own this gamepass' });
  } catch (e) { return res.status(400).json({ error: 'Verification failed' }); }

  const tierAmount = tier === '5k' ? 5000 : 10000;
  const adId = crypto.randomBytes(8).toString('hex');
  const newAd = await Ad.create({
    _id: adId, userId: user._id, username: user.robloxUsername,
    tier: tierAmount, gamepassId: gpId, broadcastsLeft: 1,
    showsLeft: tier === '5k' ? 1 : 3, active: true,
    message: message?.trim().substring(0, 200) || '', purchasedAt: new Date()
  });

  await broadcastAd(newAd);
  newAd.broadcastsLeft = 0;
  await newAd.save();

  res.json({ success: true, ad: newAd });
});

app.post('/api/delete-ad', authenticateToken, async (req, res) => {
  await Ad.deleteMany({ userId: req.user.id, active: true });
  res.json({ success: true });
});

app.get('/api/ads', async (req, res) => {
  const activeAds = await Ad.find({ active: true, showsLeft: { $gt: 0 } });
  res.json(activeAds);
});

app.get('/api/rooms/:roomId/ad-broadcasts', async (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const broadcasts = await AdBroadcast.find({
    roomId: req.params.roomId,
    timestamp: { $gt: new Date(since) }
  });
  res.json(broadcasts);
});

// ========== LEADERBOARD ==========
app.get('/api/leaderboard', async (req, res) => {
  const period = req.query.period || 'total';
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const oneWeek = 7 * oneDay;

  let dateFilter = {};
  if (period === 'daily') dateFilter = { timestamp: { $gte: new Date(now - oneDay) } };
  else if (period === 'weekly') dateFilter = { timestamp: { $gte: new Date(now - oneWeek) } };

  const donations = await Donation.find(dateFilter);
  const receivedMap = {}, givenMap = {};
  donations.forEach(d => {
    const { receiverId, receiverName, donorId, donorName, amount } = d;
    if (!receivedMap[receiverId]) receivedMap[receiverId] = { username: receiverName, amount: 0 };
    receivedMap[receiverId].amount += amount;
    if (!givenMap[donorId]) givenMap[donorId] = { username: donorName, amount: 0 };
    givenMap[donorId].amount += amount;
  });

  const receivers = Object.values(receivedMap).sort((a,b) => b.amount - a.amount).slice(0,10);
  const donors = Object.values(givenMap).sort((a,b) => b.amount - a.amount).slice(0,10);
  res.json({ receivers, donors });
});

// ========== PASSKEY ENDPOINTS ==========
app.post('/api/passkey/register-options', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: user._id,
      userName: user.robloxUsername || user._id,
      attestationType: 'none',
      excludeCredentials: user.credentials.map(cred => ({
        id: Buffer.from(cred.id, 'base64'),
        type: 'public-key',
        transports: cred.transports
      }))
    });

    challengeStore.set(user._id, options.challenge);
    res.json(options);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Registration options failed' });
  }
});

app.post('/api/passkey/register-verify', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const challenge = challengeStore.get(user._id);
    if (!challenge) return res.status(400).json({ error: 'Challenge expired' });

    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: false
    });

    if (verification.verified) {
      const { registrationInfo } = verification;
      user.credentials.push({
        id: registrationInfo.credentialID,
        publicKey: Buffer.from(registrationInfo.credentialPublicKey),
        counter: registrationInfo.counter,
        transports: req.body.response.transports || []
      });
      await user.save();
      challengeStore.delete(user._id);
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Verification failed' });
    }
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: 'Registration failed' });
  }
});

app.post('/api/passkey/login-options', async (req, res) => {
  try {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'preferred'
    });

    const loginKey = crypto.randomBytes(16).toString('hex');
    challengeStore.set(loginKey, options.challenge);
    res.json({ ...options, loginKey });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Login options failed' });
  }
});

app.post('/api/passkey/login-verify', async (req, res) => {
  try {
    const { loginKey, ...response } = req.body;
    if (!loginKey) return res.status(400).json({ error: 'Missing login key' });

    const challenge = challengeStore.get(loginKey);
    if (!challenge) return res.status(400).json({ error: 'Challenge expired' });

    const user = await User.findOne({ 'credentials.id': response.id });
    if (!user) return res.status(400).json({ error: 'No account linked to this passkey' });

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: response.id,
        publicKey: new Uint8Array(user.credentials.find(c => c.id === response.id).publicKey),
        counter: user.credentials.find(c => c.id === response.id).counter
      },
      requireUserVerification: false
    });

    if (verification.verified) {
      const cred = user.credentials.find(c => c.id === response.id);
      cred.counter = verification.authenticationInfo.newCounter;
      await user.save();
      challengeStore.delete(loginKey);

      const token = jwt.sign(
        { id: user._id, username: user.robloxUsername, displayName: user.customDisplayName || user.robloxDisplayName, avatarUrl: user.avatarUrl },
        JWT_SECRET,
        { expiresIn: '7d' }
      );
      res.json({ success: true, token });
    } else {
      res.status(400).json({ error: 'Authentication failed' });
    }
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: 'Login verification failed' });
  }
});

// ========== GUEST LOGIN ==========
app.post('/api/guest-login', async (req, res) => {
  const guestNum = Math.floor(10000 + Math.random() * 90000);
  const guestId = 'guest_' + Date.now() + '_' + guestNum;
  const guestUsername = `Guest#${guestNum}`;

  await User.findOneAndUpdate(
    { _id: guestId },
    { $set: { robloxUsername: guestUsername, robloxDisplayName: guestUsername } },
    { upsert: true, new: true }
  );

  const guestUser = { id: guestId, username: guestUsername, displayName: guestUsername, isGuest: true };
  const token = jwt.sign(guestUser, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username: guestUsername, isGuest: true });
});

// ========== DEFAULT ROOMS ==========
(async () => {
  const count = await Room.countDocuments();
  if (count === 0) {
    const defaultRooms = [
      { name: "Chill Donations", desc: "Relax and donate to small creators." },
      { name: "Big Donators", desc: "High donation rooms with active players." },
      { name: "Anime Fans", desc: "A room for anime lovers." }
    ];
    for (const r of defaultRooms) {
      const roomId = crypto.randomBytes(8).toString('hex');
      await Room.create({
        _id: roomId, name: r.name, desc: r.desc, type: 'Public',
        players: [], queue: [], maxPlayers: 18, createdBy: 'system'
      });
    }
    console.log('Default rooms created.');
  }
})();

// ========== SOCKET.IO ==========
io.on('connection', (socket) => {
  let currentRoom = null;
  let userId = null;
  let username = 'Guest';

  socket.on('authenticate', (token) => {
    if (!token) {
      userId = 'guest_' + Math.random().toString(36).substr(2,9);
      username = 'Guest#' + Math.floor(1000+Math.random()*9000);
    } else {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.id;
        username = decoded.displayName || decoded.username;
      } catch (e) { userId = 'invalid'; }
    }
    socket.emit('authenticated', { userId, username });
  });

  socket.on('join-room', (roomId) => {
    if (currentRoom) socket.leave(currentRoom);
    socket.join(roomId);
    currentRoom = roomId;
    socket.to(roomId).emit('user-joined', { userId, username });
  });

  socket.on('leave-room', () => {
    if (currentRoom) {
      socket.to(currentRoom).emit('user-left', { userId, username });
      socket.leave(currentRoom);
      currentRoom = null;
    }
  });

  socket.on('chat-message', (msg) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit('chat-message', { userId, username, message: msg, timestamp: Date.now() });
  });

  socket.on('voice-data', (audioChunk) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('voice-data', { userId, audio: audioChunk });
  });

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