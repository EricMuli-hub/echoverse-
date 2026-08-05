const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.log('MongoDB error:', err));

// Schemas
const UserSchema = new mongoose.Schema({
  email: String,
  password: String,
  name: String,
  isAdmin: { type: Boolean, default: false }
});

const MediaSchema = new mongoose.Schema({
  title: String,
  filename: String,
  type: String,
  url: String,
  downloads: { type: Number, default: 0 },
  price: { type: Number, default: 50 }
});

const CommentSchema = new mongoose.Schema({
  mediaId: String,
  text: String,
  user: String
});

const DownloadSchema = new mongoose.Schema({
  mediaId: String,
  userId: String,
  mpesaNumber: String,
  amount: Number,
  transactionId: String,
  status: { type: String, default: 'pending' }
});

const User = mongoose.model('User', UserSchema);
const Media = mongoose.model('Media', MediaSchema);
const Comment = mongoose.model('Comment', CommentSchema);
const Download = mongoose.model('Download', DownloadSchema);

// Auth middleware
const auth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

const adminOnly = (req, res, next) => {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
  next();
};

// M-Pesa
async function getMpesaToken() {
  const auth = Buffer.from(`${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
    headers: { Authorization: `Basic ${auth}` }
  });
  return res.data.access_token;
}

async function stkPush(phone, amount, ref) {
  const token = await getMpesaToken();
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const password = Buffer.from(`${process.env.SHORTCODE}${process.env.PASSKEY}${timestamp}`).toString('base64');
  const res = await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
    BusinessShortCode: process.env.SHORTCODE,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.round(amount),
    PartyA: phone,
    PartyB: process.env.SHORTCODE,
    PhoneNumber: phone,
    CallBackURL: process.env.CALLBACK_URL,
    AccountReference: ref,
    TransactionDesc: 'EchoVerse Download'
  }, { headers: { Authorization: `Bearer ${token}` } });
  return res.data;
}

// ==================== API ROUTES ====================

// Auth
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: 'Email exists' });
    const hashed = await bcrypt.hash(password, 10);
    const user = new User({ email, password: hashed, name });
    await user.save();
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
    res.json({ token, user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'User not found' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid password' });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
    res.json({ token, user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/auth/me', auth, async (req, res) => {
  res.json({ user: req.user });
});

// Media
app.get('/api/media', async (req, res) => {
  const media = await Media.find().sort({ uploadDate: -1 });
  res.json(media);
});

app.post('/api/media/upload', auth, adminOnly, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { title, type, price } = req.body;
    const media = new Media({
      title: title || req.file.originalname,
      filename: req.file.filename,
      type: type || 'image',
      url: '/uploads/' + req.file.filename,
      price: parseFloat(price) || 50
    });
    await media.save();
    res.json({ success: true, media });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Download
app.post('/api/download/request', auth, async (req, res) => {
  try {
    const { mediaId, mpesaNumber, amount } = req.body;
    const media = await Media.findById(mediaId);
    if (!media) return res.status(404).json({ error: 'Media not found' });
    
    const existing = await Download.findOne({ mediaId, userId: req.user._id, status: 'completed' });
    if (existing) {
      return res.json({ success: true, downloadUrl: media.url });
    }
    
    const cleanNumber = mpesaNumber.replace(/[^0-9]/g, '');
    if (!cleanNumber.startsWith('254') || cleanNumber.length < 11) {
      return res.status(400).json({ error: 'Invalid M-Pesa number' });
    }
    
    const ref = 'ECHO-' + Date.now();
    const stk = await stkPush(cleanNumber, amount || media.price || 50, ref);
    
    const download = new Download({
      mediaId,
      userId: req.user._id,
      mpesaNumber: cleanNumber,
      amount: amount || media.price || 50,
      transactionId: stk.CheckoutRequestID
    });
    await download.save();
    
    res.json({ success: true, checkoutRequestId: stk.CheckoutRequestID });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/mpesa/callback', async (req, res) => {
  try {
    const { Body } = req.body;
    const { CheckoutRequestID, ResultCode } = Body.stkCallback;
    const download = await Download.findOne({ transactionId: CheckoutRequestID });
    if (!download) return res.json({ ResultCode: 0 });
    
    if (ResultCode === 0) {
      download.status = 'completed';
      await download.save();
      await Media.findByIdAndUpdate(download.mediaId, { $inc: { downloads: 1 } });
    } else {
      download.status = 'failed';
      await download.save();
    }
    res.json({ ResultCode: 0 });
  } catch (error) {
    res.json({ ResultCode: 1 });
  }
});

app.get('/api/download/status/:checkoutId', auth, async (req, res) => {
  const download = await Download.findOne({ transactionId: req.params.checkoutId });
  if (!download) return res.status(404).json({ error: 'Not found' });
  if (download.status === 'completed') {
    const media = await Media.findById(download.mediaId);
    return res.json({ status: 'completed', downloadUrl: media.url });
  }
  res.json({ status: download.status });
});

// Comments
app.get('/api/comments/:mediaId', async (req, res) => {
  const comments = await Comment.find({ mediaId: req.params.mediaId }).sort({ createdAt: -1 });
  res.json(comments);
});

app.post('/api/comments', async (req, res) => {
  const { mediaId, text, user } = req.body;
  const comment = new Comment({ mediaId, text, user: user || 'Anonymous' });
  await comment.save();
  res.json({ success: true, comment });
});

// ==================== FRONTEND ====================
app.get('*', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EchoVerse</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { background:#0b0d15; color:#fff; font-family:sans-serif; padding:20px; }
    .container { max-width:1200px; margin:0 auto; }
    h1 { font-size:2.5rem; background:linear-gradient(135deg,#f6d365,#fda085); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
    .auth-bar { display:flex; gap:10px; margin:20px 0; flex-wrap:wrap; }
    .auth-btn { background:transparent; border:1px solid #4a5a7a; padding:8px 20px; border-radius:30px; color:#fff; cursor:pointer; }
    .admin-panel { background:rgba(20,25,45,0.7); border-radius:20px; padding:20px; margin:20px 0; display:none; }
    .upload-grid { display:flex; gap:15px; flex-wrap:wrap; align-items:center; }
    .upload-item { background:rgba(0,0,0,0.3); padding:8px 15px; border-radius:30px; border:1px solid #2d3a5a; }
    .upload-item input { background:#12172e; border:none; padding:5px; border-radius:20px; color:#fff; }
    .btn-upload { background:linear-gradient(135deg,#f6d365,#fda085); border:none; padding:10px 25px; border-radius:30px; font-weight:700; color:#0b0d15; cursor:pointer; }
    .media-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); gap:20px; margin:20px 0; }
    .media-card { background:rgba(16,20,40,0.6); border-radius:20px; overflow:hidden; border:1px solid rgba(255,255,255,0.05); }
    .media-thumb { height:150px; background:#1a1f35; display:flex; align-items:center; justify-content:center; font-size:3rem; color:#f6d365; }
    .media-info { padding:15px; }
    .media-info h4 { margin-bottom:5px; }
    .actions { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
    .actions button { padding:6px 15px; border-radius:30px; border:none; cursor:pointer; font-size:0.8rem; }
    .download-btn { background:linear-gradient(135deg,#f6d365,#fda085); color:#0b0d15; font-weight:600; }
    .pay-btn { background:rgba(253,160,133,0.15); color:#fff; border:1px solid #fda08555 !important; }
    .interact-section { display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-top:30px; }
    @media (max-width:600px) { .interact-section { grid-template-columns:1fr; } }
    .comment-box textarea { width:100%; background:#0f1429; border:1px solid #2d3a5a; border-radius:15px; padding:10px; color:#fff; min-height:80px; }
    .comment-box button { background:#f6d365; border:none; padding:8px 20px; border-radius:30px; font-weight:600; margin-top:8px; cursor:pointer; color:#0b0d15; }
    .contact-info a { color:#fff; text-decoration:none; display:inline-block; background:rgba(255,255,255,0.03); padding:8px 15px; border-radius:30px; border:1px solid #2d3a5a; margin:5px; }
    .modal-overlay { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); display:none; align-items:center; justify-content:center; z-index:999; padding:20px; }
    .modal-box { background:#161c33; border-radius:30px; padding:30px; max-width:400px; width:100%; border:1px solid #f6d36555; }
    .modal-box h2 { color:#f6d365; }
    .modal-box input { width:100%; background:#0f1429; border:1px solid #2d3a5a; border-radius:30px; padding:10px 15px; color:#fff; margin:5px 0; }
    .modal-box .btn-pay { background:linear-gradient(135deg,#f6d365,#fda085); border:none; width:100%; padding:12px; border-radius:30px; font-weight:700; color:#0b0d15; margin-top:15px; cursor:pointer; }
    .modal-box .btn-close { background:transparent; border:1px solid #4a5a7a; color:#b9c8f0; padding:8px; border-radius:30px; margin-top:8px; cursor:pointer; width:100%; }
    .toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:#1a1f35; padding:12px 25px; border-radius:30px; border-left:4px solid #f6d365; display:none; z-index:1000; text-align:center; }
    .toast.show { display:block; }
    .comments-list { margin-top:10px; max-height:150px; overflow-y:auto; }
    .comment-item { background:rgba(255,255,255,0.03); padding:5px 12px; border-radius:10px; margin-bottom:5px; font-size:0.9rem; }
  </style>
</head>
<body>
<div class="container">
  <h1>✦ ECHOVERSE</h1>
  <p style="color:#b9c8f0;">where sound & vision collide</p>

  <div class="auth-bar" id="authBar">
    <button class="auth-btn" id="googleSignup"><i class="fab fa-google"></i> Google</button>
    <button class="auth-btn" id="emailSignup"><i class="fas fa-envelope"></i> Email</button>
    <button class="auth-btn" id="logoutBtn" style="display:none;">Logout</button>
    <span id="userDisplay" style="color:#b9c8f0;display:none;"></span>
  </div>

  <div class="admin-panel" id="adminPanel">
    <h3><i class="fas fa-lock"></i> Admin Upload</h3>
    <div class="upload-grid">
      <div class="upload-item"><input type="file" id="fileInput"></div>
      <button class="btn-upload" id="uploadBtn"><i class="fas fa-upload"></i> Upload</button>
    </div>
  </div>

  <h2 style="color:#f6d365;margin:20px 0;">Latest Drops</h2>
  <div class="media-grid" id="mediaGrid"><div style="text-align:center;padding:30px;color:#5a6a8a;">Loading...</div></div>

  <div class="interact-section">
    <div class="comment-box">
      <h4>Comments</h4>
      <textarea id="commentInput" placeholder="Write comment..."></textarea>
      <button id="postCommentBtn">Post</button>
      <div class="comments-list" id="commentsList"></div>
    </div>
    <div class="contact-info">
      <h4>Contact Eric</h4>
      <a href="https://wa.me/254713868382"><i class="fab fa-whatsapp"></i> WhatsApp</a>
      <a href="mailto:erickmakau19@gmail.com"><i class="fas fa-envelope"></i> Email</a>
    </div>
  </div>
  <div style="text-align:center;margin-top:30px;font-size:0.7rem;color:#3a4a6a;">EchoVerse · 2026</div>
</div>

<div class="modal-overlay" id="mpesaModal">
  <div class="modal-box">
    <h2>M-Pesa Payment</h2>
    <p style="color:#b9c8f0;">Enter M-Pesa number for STK push</p>
    <input type="tel" id="mpesaNumber" placeholder="2547XXXXXXXX" value="254713868382">
    <input type="number" id="mpesaAmount" placeholder="Amount (KES)" value="50">
    <button class="btn-pay" id="mpesaPayBtn">Pay & Download</button>
    <button class="btn-close" id="mpesaCloseBtn">Cancel</button>
    <div id="mpesaStatus" style="margin-top:10px;color:#fda085;text-align:center;"></div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const API_URL = '';
let currentUser = null;
let token = localStorage.getItem('token');
let currentMediaId = null;

async function apiCall(endpoint, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch('/api' + endpoint, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show';
  clearTimeout(t._timeout);
  t._timeout = setTimeout(() => t.className = 'toast', 4000);
}

async function signup(email, password, name) {
  const data = await apiCall('/auth/signup', { method: 'POST', body: JSON.stringify({ email, password, name }) });
  token = data.token;
  localStorage.setItem('token', token);
  currentUser = data.user;
  updateUI();
  showToast('Welcome ' + (currentUser.name || 'User') + '!');
}

async function googleSignup() {
  const name = prompt('Name:', 'Google User');
  const email = prompt('Email:', 'user@gmail.com');
  if (!email) return;
  const data = await apiCall('/auth/signup', { method: 'POST', body: JSON.stringify({ email, name, googleId: 'google_' + Date.now() }) });
  token = data.token;
  localStorage.setItem('token', token);
  currentUser = data.user;
  updateUI();
  showToast('Google signup successful!');
}

function logout() {
  token = null;
  localStorage.removeItem('token');
  currentUser = null;
  updateUI();
  showToast('Logged out');
}

function updateUI() {
  const gBtn = document.getElementById('googleSignup');
  const eBtn = document.getElementById('emailSignup');
  const lBtn = document.getElementById('logoutBtn');
  const uDisplay = document.getElementById('userDisplay');
  const adminPanel = document.getElementById('adminPanel');
  
  if (currentUser) {
    gBtn.style.display = 'none';
    eBtn.style.display = 'none';
    lBtn.style.display = 'inline-block';
    uDisplay.style.display = 'inline-block';
    uDisplay.textContent = '👤 ' + (currentUser.name || currentUser.email);
    adminPanel.style.display = currentUser.isAdmin ? 'block' : 'none';
  } else {
    gBtn.style.display = 'inline-block';
    eBtn.style.display = 'inline-block';
    lBtn.style.display = 'none';
    uDisplay.style.display = 'none';
    adminPanel.style.display = 'none';
  }
}

async function loadMedia() {
  try {
    const media = await apiCall('/media');
    renderMedia(media);
  } catch (e) {
    document.getElementById('mediaGrid').innerHTML = '<div style="text-align:center;padding:30px;color:#f28b82;">Error loading</div>';
  }
}

function renderMedia(items) {
  const grid = document.getElementById('mediaGrid');
  if (!items || !items.length) {
    grid.innerHTML = '<div style="text-align:center;padding:30px;color:#5a6a8a;">No media yet</div>';
    return;
  }
  grid.innerHTML = items.map(item => {
    const icon = item.type === 'video' ? 'fa-film' : item.type === 'audio' ? 'fa-headphones' : 'fa-camera-retro';
    return '<div class="media-card">' +
      '<div class="media-thumb"><i class="fas ' + icon + '"></i></div>' +
      '<div class="media-info">' +
        '<h4>' + item.title + '</h4>' +
        '<p style="font-size:0.8rem;color:#9aa5c9;">Downloads: ' + (item.downloads || 0) + '</p>' +
        '<div class="actions">' +
          '<button class="download-btn" data-id="' + item._id + '"><i class="fas fa-download"></i> Download</button>' +
          '<button class="pay-btn" data-id="' + item._id + '"><i class="fas fa-coins"></i> Pay</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  document.querySelectorAll('.download-btn').forEach(b => {
    b.onclick = () => { if (!currentUser) { showToast('Sign up first'); return; } handleDownload(b.dataset.id); };
  });
  document.querySelectorAll('.pay-btn').forEach(b => {
    b.onclick = () => { if (!currentUser) { showToast('Sign up first'); return; } currentMediaId = b.dataset.id; openMpesa(); };
  });
}

async function handleDownload(id) {
  try {
    showToast('Processing...');
    const res = await apiCall('/download/request', { method: 'POST', body: JSON.stringify({ mediaId: id, mpesaNumber: '254713868382', amount: 50 }) });
    if (res.downloadUrl) {
      showToast('Downloading...');
      window.open(res.downloadUrl, '_blank');
    } else if (res.checkoutRequestId) {
      showToast('STK sent! Check phone.');
      pollStatus(res.checkoutRequestId);
    }
  } catch (e) { showToast(e.message); }
}

async function pollStatus(checkoutId) {
  let tries = 0;
  const interval = setInterval(async () => {
    try {
      const res = await apiCall('/download/status/' + checkoutId);
      if (res.status === 'completed') {
        clearInterval(interval);
        showToast('Download ready!');
        if (res.downloadUrl) window.open(res.downloadUrl, '_blank');
        loadMedia();
      } else if (res.status === 'failed') {
        clearInterval(interval);
        showToast('Payment failed');
      }
      if (++tries > 20) { clearInterval(interval); showToast('Timeout'); }
    } catch (e) {}
  }, 3000);
}

function openMpesa() {
  document.getElementById('mpesaModal').style.display = 'flex';
  document.getElementById('mpesaStatus').textContent = 'Enter number & amount';
}

document.getElementById('mpesaCloseBtn').onclick = () => {
  document.getElementById('mpesaModal').style.display = 'none';
};

document.getElementById('mpesaPayBtn').onclick = async () => {
  const phone = document.getElementById('mpesaNumber').value.trim();
  const amount = parseFloat(document.getElementById('mpesaAmount').value);
  const status = document.getElementById('mpesaStatus');
  
  if (!phone || phone.length < 10) { status.textContent = 'Invalid number'; return; }
  if (!amount || amount < 1) { status.textContent = 'Invalid amount'; return; }
  
  try {
    status.textContent = 'Processing...';
    const res = await apiCall('/download/request', { method: 'POST', body: JSON.stringify({ mediaId: currentMediaId, mpesaNumber: phone, amount }) });
    if (res.downloadUrl) {
      status.textContent = 'Download ready!';
      setTimeout(() => { window.open(res.downloadUrl, '_blank'); closeMpesa(); loadMedia(); }, 1000);
    } else if (res.checkoutRequestId) {
      status.textContent = 'STK sent! Check phone.';
      setTimeout(closeMpesa, 3000);
      pollStatus(res.checkoutRequestId);
    }
  } catch (e) { status.textContent = e.message; }
};

function closeMpesa() {
  document.getElementById('mpesaModal').style.display = 'none';
}

document.getElementById('postCommentBtn').onclick = async () => {
  const text = document.getElementById('commentInput').value.trim();
  if (!text) { showToast('Write a comment'); return; }
  try {
    const media = await apiCall('/media');
    if (media && media.length) {
      await apiCall('/comments', { method: 'POST', body: JSON.stringify({ mediaId: media[0]._id, text, user: currentUser?.name || 'Anonymous' }) });
      document.getElementById('commentInput').value = '';
      showToast('Comment posted');
      loadComments(media[0]._id);
    }
  } catch (e) { showToast(e.message); }
};

async function loadComments(mediaId) {
  try {
    const comments = await apiCall('/comments/' + mediaId);
    const container = document.getElementById('commentsList');
    if (!comments || !comments.length) { container.innerHTML = '<div style="color:#5a6a8a;font-size:0.8rem;">No comments</div>'; return; }
    container.innerHTML = comments.slice(0, 10).map(c => '<div class="comment-item"><strong>' + c.user + '</strong> ' + c.text + '</div>').join('');
  } catch (e) {}
}

document.getElementById('uploadBtn').onclick = async () => {
  const fileInput = document.getElementById('fileInput');
  if (!fileInput.files || !fileInput.files.length) { showToast('Select a file'); return; }
  const file = fileInput.files[0];
  const formData = new FormData();
  formData.append('file', file);
  formData.append('title', prompt('Title:', file.name) || file.name);
  formData.append('type', file.type.startsWith('video') ? 'video' : file.type.startsWith('audio') ? 'audio' : 'image');
  formData.append('price', prompt('Price (KES):', '50') || '50');
  
  try {
    const res = await fetch('/api/media/upload', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token }, body: formData });
    if (!res.ok) throw new Error('Upload failed');
    showToast('Uploaded!');
    fileInput.value = '';
    loadMedia();
  } catch (e) { showToast(e.message); }
};

document.getElementById('googleSignup').onclick = googleSignup;
document.getElementById('emailSignup').onclick = () => {
  const email = prompt('Email:');
  if (!email) return;
  const password = prompt('Password (min 6 chars):');
  if (!password || password.length < 6) { showToast('Password too short'); return; }
  const name = prompt('Name:') || 'User';
  signup(email, password, name);
};
document.getElementById('logoutBtn').onclick = logout;

async function init() {
  if (token) {
    try {
      const data = await apiCall('/auth/me');
      currentUser = data.user;
      updateUI();
    } catch (e) { token = null; localStorage.removeItem('token'); }
  }
  await loadMedia();
  try {
    const media = await apiCall('/media');
    if (media && media.length) loadComments(media[0]._id);
  } catch (e) {}
}

init();
</script>
</body>
</html>
  `);
});

// Start server
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
