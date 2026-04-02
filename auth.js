const SESSION_DURATION = 30 * 60 * 1000; // 30 minutes
const MAX_ATTEMPTS     = 3;
const LOCKOUT_TIME     = 30 * 1000; // 30 seconds

// --- Helpers ---

function sanitize(str) {
  return str.replace(/[<>"'`]/g, '');
}

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data     = encoder.encode(password + 'md_salt_2024');
  const hashBuf  = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function showError(msg) {
  const el = document.getElementById('error-msg');
  if (el) el.textContent = msg;
}

function showSuccess(msg) {
  const el = document.getElementById('error-msg');
  if (el) { el.textContent = msg; el.style.color = '#16a34a'; }
}

// --- Session check (call on every protected page) ---
function checkSession() {
  const session = JSON.parse(localStorage.getItem('md_session'));
  if (!session) return false;
  if (Date.now() - session.loginTime > SESSION_DURATION) {
    localStorage.removeItem('md_session');
    return false;
  }
  return session;
}

// --- Password strength ---
function getPasswordStrength(password) {
  let score = 0;
  if (password.length >= 8)              score++;
  if (/[A-Z]/.test(password))           score++;
  if (/[0-9]/.test(password))           score++;
  if (/[^A-Za-z0-9]/.test(password))    score++;
  return score; // 0-4
}

function updateStrengthBar(password) {
  const bar   = document.getElementById('strength-bar');
  const label = document.getElementById('strength-label');
  if (!bar) return;
  const score  = getPasswordStrength(password);
  const levels = ['', 'Weak', 'Fair', 'Good', 'Strong'];
  const colors = ['', '#ef4444', '#f97316', '#eab308', '#16a34a'];
  const widths = ['0%', '25%', '50%', '75%', '100%'];
  bar.style.width      = widths[score];
  bar.style.background = colors[score];
  label.textContent    = score > 0 ? levels[score] : '';
  label.style.color    = colors[score];
}

// --- Brute force tracking ---
function getLoginAttempts(email) {
  return JSON.parse(localStorage.getItem('md_attempts_' + email) || '{"count":0,"time":0}');
}

function recordFailedAttempt(email) {
  const data = getLoginAttempts(email);
  data.count++;
  data.time = Date.now();
  localStorage.setItem('md_attempts_' + email, JSON.stringify(data));
}

function resetAttempts(email) {
  localStorage.removeItem('md_attempts_' + email);
}

function isLockedOut(email) {
  const data = getLoginAttempts(email);
  if (data.count >= MAX_ATTEMPTS) {
    const elapsed = Date.now() - data.time;
    if (elapsed < LOCKOUT_TIME) {
      const remaining = Math.ceil((LOCKOUT_TIME - elapsed) / 1000);
      return remaining;
    }
    resetAttempts(email);
  }
  return false;
}

// --- SIGNUP ---
const signupForm = document.getElementById('signup-form');
if (signupForm) {
  const pwdInput = document.getElementById('password');
  if (pwdInput) {
    pwdInput.addEventListener('input', () => updateStrengthBar(pwdInput.value));
  }

  signupForm.addEventListener('submit', async e => {
    e.preventDefault();
    const name     = sanitize(document.getElementById('name').value.trim());
    const email    = sanitize(document.getElementById('email').value.trim().toLowerCase());
    const password = document.getElementById('password').value;

    if (!name || !email || !password) return showError('All fields are required.');
    if (getPasswordStrength(password) < 2) return showError('Password too weak. Add uppercase, numbers or symbols.');

    const users = JSON.parse(localStorage.getItem('md_users') || '[]');
    if (users.find(u => u.email === email)) return showError('Email already registered. Please log in.');

    const hashed = await hashPassword(password);
    users.push({ name, email, password: hashed });
    localStorage.setItem('md_users', JSON.stringify(users));
    localStorage.setItem('md_session', JSON.stringify({ name, email, loginTime: Date.now() }));
    window.location.href = 'index.html';
  });
}

// --- LOGIN ---
const loginForm = document.getElementById('login-form');
if (loginForm) {
  loginForm.addEventListener('submit', async e => {
    e.preventDefault();
    const email    = sanitize(document.getElementById('email').value.trim().toLowerCase());
    const password = document.getElementById('password').value;

    // Check lockout
    const lockRemaining = isLockedOut(email);
    if (lockRemaining) return showError(`Too many attempts. Try again in ${lockRemaining}s.`);

    const users  = JSON.parse(localStorage.getItem('md_users') || '[]');
    const hashed = await hashPassword(password);
    const user   = users.find(u => u.email === email && u.password === hashed);

    if (!user) {
      recordFailedAttempt(email);
      const attempts = getLoginAttempts(email);
      const left     = MAX_ATTEMPTS - attempts.count;
      if (left <= 0) return showError(`Account locked for ${LOCKOUT_TIME / 1000}s due to too many attempts.`);
      return showError(`Invalid email or password. ${left} attempt${left > 1 ? 's' : ''} left.`);
    }

    resetAttempts(email);
    localStorage.setItem('md_session', JSON.stringify({ name: user.name, email, loginTime: Date.now() }));
    window.location.href = 'index.html';
  });
}
