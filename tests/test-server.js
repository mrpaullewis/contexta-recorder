/**
 * Simple test server that mimics NHS booking flow patterns:
 * - Login with session cookie
 * - CSRF tokens (per-page, hidden inputs)
 * - Radio inputs with dynamic values
 * - Hidden fields with GUIDs
 * - POST → 302 → GET redirect pattern
 * - Help page (linked from nav, not part of main flow)
 */
import http from 'http';
import crypto from 'crypto';

let sessionTokens = {};
const activeSessions = {};  // cookieValue → { user, loggedInAt }

function csrf() { return 'CfDJ8_' + crypto.randomBytes(40).toString('base64url'); }
function guid() { return crypto.randomUUID(); }
function sessionId() { return crypto.randomBytes(24).toString('hex'); }

// Parse cookies from request header
function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k] = v.join('=');
  });
  return cookies;
}

// Check if request has a valid session
function isLoggedIn(req) {
  const cookies = parseCookies(req);
  return cookies.NHSSession && activeSessions[cookies.NHSSession];
}

// Get logged-in user info
function getUser(req) {
  const cookies = parseCookies(req);
  return activeSessions[cookies.NHSSession] || null;
}

// Middleware: redirect to login if not authenticated
function requireAuth(req, res) {
  if (!isLoggedIn(req)) {
    res.writeHead(302, { Location: '/login?returnUrl=' + encodeURIComponent(req.url) });
    res.end();
    return false;
  }
  return true;
}

// Valid test credentials
const TEST_USERS = [
  { username: 'testuser@nhs.net', password: 'Password1!', name: 'Test User' },
  { username: 'admin@nhs.net', password: 'Admin123!', name: 'Admin User' },
];

const SITES = [
  { id: guid(), name: 'Well Bispham - All Hallows Road' },
  { id: guid(), name: 'Blackpool Victoria Hospital' },
  { id: guid(), name: 'Lytham Primary Care Centre' },
];

const DATES = [
  '4/1/2026 12:00:00 AM',
  '4/2/2026 12:00:00 AM',
  '4/3/2026 12:00:00 AM',
];

const HOURS = ['8', '9', '10', '11', '12'];
const SLOTS = ['800|00:10:00|0', '810|00:10:00|0', '820|00:10:00|0'];

function page(title, heading, bodyContent, user) {
  // Pad the <head> to be large (like NHS pages) so CSRF token is past 4KB
  const padding = '    <!-- analytics, CSS, JS preloads -->\n'.repeat(80);
  const userNav = user
    ? `<span>Logged in as <strong>${user.name}</strong></span> | <a href="/logout">Sign out</a>`
    : `<a href="/login">Sign in</a>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/assets/main.css">
    <script src="/assets/main.js" defer></script>
${padding}
    <title>${title} - Test Booking - NHS</title>
</head>
<body>
    <header role="banner">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 16px;">
        <div><strong>Test Booking</strong> | <a href="/help">Help</a> | <a href="/help/accessibility">Accessibility</a></div>
        <div>${userNav}</div>
      </div>
    </header>
    <main id="main-content" role="main">
        <h1>${heading}</h1>
        ${bodyContent}
    </main>
    <footer role="contentinfo">
      <div style="padding:8px 16px;font-size:0.8em;color:#666;">
        <a href="/help">Help</a> | <a href="/help/privacy">Privacy policy</a> | <a href="/help/terms">Terms and conditions</a>
      </div>
    </footer>
</body>
</html>`;
}

function radioField(name, options) {
  return options.map((opt, i) =>
    `<input name="${name}" type="radio" value="${opt.value}" id="radio_${name}_${i}">
     <label for="radio_${name}_${i}">${opt.label}</label>`
  ).join('\n');
}

const routes = {

  // ── Login Flow ──────────────────────────────────────────────

  'GET /': (req, res) => {
    if (isLoggedIn(req)) {
      res.writeHead(302, { Location: '/start' });
    } else {
      res.writeHead(302, { Location: '/login' });
    }
    res.end();
  },

  'GET /login': (req, res) => {
    const token = csrf();
    sessionTokens['login'] = token;
    const returnUrl = new URL(req.url, 'http://localhost').searchParams.get('returnUrl') || '/start';
    const error = new URL(req.url, 'http://localhost').searchParams.get('error');
    const errorHtml = error === '1'
      ? '<div role="alert" style="color:#d4351c;border:2px solid #d4351c;padding:12px;margin-bottom:16px;"><strong>There is a problem</strong><p>Email address or password is incorrect</p></div>'
      : '';
    res.end(page(
      'Sign in',
      'Sign in to the vaccination service',
      `${errorHtml}
      <form method="POST" action="/login">
        <div style="margin-bottom:12px;">
          <label for="email">Email address</label><br>
          <input type="email" name="email" id="email" required style="width:300px;padding:6px;">
        </div>
        <div style="margin-bottom:12px;">
          <label for="password">Password</label><br>
          <input type="password" name="password" id="password" required style="width:300px;padding:6px;">
          <div style="font-size:0.85em;margin-top:4px;"><a href="/help/forgotten-password">Forgotten your password?</a></div>
        </div>
        <input type="hidden" name="returnUrl" value="${returnUrl}">
        <input type="hidden" name="__RequestVerificationToken" value="${token}">
        <button type="submit" style="padding:8px 24px;">Sign in</button>
      </form>
      <p style="margin-top:16px;">Don't have an account? <a href="/register">Create an account</a></p>`,
      null
    ));
  },

  'POST /login': (req, res) => {
    const params = new URLSearchParams(req.body);
    const email = params.get('email');
    const password = params.get('password');
    const returnUrl = params.get('returnUrl') || '/start';

    const user = TEST_USERS.find(u => u.username === email && u.password === password);
    if (user) {
      const sid = sessionId();
      activeSessions[sid] = { name: user.name, email: user.username, loggedInAt: new Date().toISOString() };
      res.writeHead(302, {
        Location: returnUrl,
        'Set-Cookie': `NHSSession=${sid}; Path=/; HttpOnly`,
      });
    } else {
      res.writeHead(302, { Location: '/login?error=1&returnUrl=' + encodeURIComponent(returnUrl) });
    }
    res.end();
  },

  'GET /logout': (req, res) => {
    const cookies = parseCookies(req);
    if (cookies.NHSSession) delete activeSessions[cookies.NHSSession];
    res.writeHead(302, {
      Location: '/login',
      'Set-Cookie': 'NHSSession=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    });
    res.end();
  },

  'GET /register': (req, res) => {
    const token = csrf();
    sessionTokens['register'] = token;
    res.end(page(
      'Create an account',
      'Create an account',
      `<form method="POST" action="/register">
        <div style="margin-bottom:12px;">
          <label for="reg-name">Full name</label><br>
          <input type="text" name="fullName" id="reg-name" required style="width:300px;padding:6px;">
        </div>
        <div style="margin-bottom:12px;">
          <label for="reg-email">Email address</label><br>
          <input type="email" name="email" id="reg-email" required style="width:300px;padding:6px;">
        </div>
        <div style="margin-bottom:12px;">
          <label for="reg-password">Password</label><br>
          <input type="password" name="password" id="reg-password" required style="width:300px;padding:6px;">
          <div style="font-size:0.85em;color:#505a5f;margin-top:4px;">Must be at least 8 characters</div>
        </div>
        <div style="margin-bottom:12px;">
          <label for="reg-phone">Phone number (optional)</label><br>
          <input type="tel" name="phone" id="reg-phone" style="width:300px;padding:6px;">
        </div>
        <input type="hidden" name="__RequestVerificationToken" value="${token}">
        <button type="submit" style="padding:8px 24px;">Create account</button>
      </form>`,
      null
    ));
  },

  'POST /register': (req, res) => {
    // Accept any registration, create a session
    const params = new URLSearchParams(req.body);
    const name = params.get('fullName') || 'New User';
    const email = params.get('email');
    const sid = sessionId();
    activeSessions[sid] = { name, email, loggedInAt: new Date().toISOString() };
    res.writeHead(302, {
      Location: '/start',
      'Set-Cookie': `NHSSession=${sid}; Path=/; HttpOnly`,
    });
    res.end();
  },

  // ── Help Pages (not part of main flow) ──────────────────────

  'GET /help': (req, res) => {
    res.end(page('Help', 'Help and support', `
      <ul>
        <li><a href="/help/how-to-book">How to book a vaccination</a></li>
        <li><a href="/help/accessibility">Accessibility statement</a></li>
        <li><a href="/help/privacy">Privacy policy</a></li>
        <li><a href="/help/terms">Terms and conditions</a></li>
        <li><a href="/help/forgotten-password">Forgotten your password</a></li>
        <li><a href="/help/contact">Contact us</a></li>
      </ul>
      <p><a href="/start">Back to booking</a></p>`, getUser(req)));
  },

  'GET /help/how-to-book': (req, res) => {
    res.end(page('How to book', 'How to book a vaccination', `
      <ol>
        <li>Sign in or create an account</li>
        <li>Tell us who you are booking for</li>
        <li>Enter your name</li>
        <li>Choose a vaccination centre near you</li>
        <li>Pick a date and time</li>
        <li>Confirm your appointment</li>
      </ol>
      <p><a href="/help">Back to help</a></p>`, getUser(req)));
  },

  'GET /help/accessibility': (req, res) => {
    res.end(page('Accessibility', 'Accessibility statement', `
      <p>This website is run by NHS England. We want as many people as possible to be able to use this website.</p>
      <h2>How accessible this website is</h2>
      <p>We know some parts of this website are not fully accessible. We are working to fix these issues.</p>
      <p><a href="/help">Back to help</a></p>`, getUser(req)));
  },

  'GET /help/privacy': (req, res) => {
    res.end(page('Privacy policy', 'Privacy policy', `
      <p>This privacy policy explains how we use your personal information when you use the vaccination booking service.</p>
      <h2>What data we collect</h2>
      <p>We collect your name, email address, and vaccination preferences to manage your booking.</p>
      <p><a href="/help">Back to help</a></p>`, getUser(req)));
  },

  'GET /help/terms': (req, res) => {
    res.end(page('Terms and conditions', 'Terms and conditions', `
      <p>By using this service, you agree to these terms and conditions.</p>
      <p><a href="/help">Back to help</a></p>`, getUser(req)));
  },

  'GET /help/forgotten-password': (req, res) => {
    const token = csrf();
    sessionTokens['forgot'] = token;
    res.end(page('Forgotten password', 'Reset your password', `
      <p>Enter your email address and we will send you a link to reset your password.</p>
      <form method="POST" action="/help/forgotten-password">
        <div style="margin-bottom:12px;">
          <label for="reset-email">Email address</label><br>
          <input type="email" name="email" id="reset-email" required style="width:300px;padding:6px;">
        </div>
        <input type="hidden" name="__RequestVerificationToken" value="${token}">
        <button type="submit" style="padding:8px 24px;">Send reset link</button>
      </form>`, null));
  },

  'POST /help/forgotten-password': (req, res) => {
    res.writeHead(302, { Location: '/help/forgotten-password-sent' });
    res.end();
  },

  'GET /help/forgotten-password-sent': (req, res) => {
    res.end(page('Check your email', 'Check your email', `
      <p>If the email address you entered is registered, we have sent a link to reset your password.</p>
      <p><a href="/login">Back to sign in</a></p>`, null));
  },

  'GET /help/contact': (req, res) => {
    res.end(page('Contact us', 'Contact us', `
      <p>Call us on <strong>119</strong> (free from mobiles and landlines)</p>
      <p>Lines are open 7am to 11pm, 7 days a week.</p>
      <p><a href="/help">Back to help</a></p>`, getUser(req)));
  },

  // ── Booking Flow (requires login) ──────────────────────────

  '/start': (req, res) => {
    if (!requireAuth(req, res)) return;
    res.writeHead(302, { Location: '/booking-question' });
    res.end();
  },

  'GET /booking-question': (req, res) => {
    if (!requireAuth(req, res)) return;
    const token = csrf();
    sessionTokens['booking-question'] = token;
    res.end(page(
      'Are you booking for yourself?',
      'Are you booking for yourself or someone else?',
      `<form method="POST" action="/booking-question">
        ${radioField('SelectedOption', [
          { value: 'Myself', label: 'Book for myself' },
          { value: 'SomeoneElse', label: 'Book for someone else' },
        ])}
        <input type="hidden" name="__RequestVerificationToken" value="${token}">
        <button type="submit">Continue</button>
      </form>`,
      getUser(req)
    ));
  },
  'POST /booking-question': (req, res) => {
    res.writeHead(302, { Location: '/enter-name' });
    res.end();
  },

  'GET /enter-name': (req, res) => {
    if (!requireAuth(req, res)) return;
    const token = csrf();
    sessionTokens['enter-name'] = token;
    res.end(page(
      'What is your name?',
      'What is your name?',
      `<form method="POST" action="/enter-name">
        <label for="Firstname">First name</label>
        <input type="text" name="Firstname" id="Firstname">
        <label for="Surname">Last name</label>
        <input type="text" name="Surname" id="Surname">
        <input type="hidden" name="__RequestVerificationToken" value="${token}">
        <button type="submit">Continue</button>
      </form>`,
      getUser(req)
    ));
  },
  'POST /enter-name': (req, res) => {
    res.writeHead(302, { Location: '/choose-site' });
    res.end();
  },

  'GET /choose-site': (req, res) => {
    if (!requireAuth(req, res)) return;
    const token = csrf();
    sessionTokens['choose-site'] = token;
    const siteForms = SITES.map(s =>
      `<form method="POST" action="/choose-site">
        <input type="hidden" name="selectedSiteId" value="${s.id}">
        <input type="hidden" name="__RequestVerificationToken" value="${token}">
        <button type="submit">${s.name}</button>
      </form>`
    ).join('\n');
    res.end(page('Choose a vaccination centre', 'Sites near FY2 0AN', siteForms, getUser(req)));
  },
  'POST /choose-site': (req, res) => {
    res.writeHead(302, { Location: '/choose-date' });
    res.end();
  },

  'GET /choose-date': (req, res) => {
    if (!requireAuth(req, res)) return;
    const token = csrf();
    sessionTokens['choose-date'] = token;
    res.end(page(
      'Choose a date',
      'Choose a date',
      `<form method="POST" action="/choose-date">
        ${radioField('DateData', DATES.map(d => ({ value: d, label: d })))}
        <input type="hidden" name="__RequestVerificationToken" value="${token}">
        <button type="submit">Continue</button>
      </form>`,
      getUser(req)
    ));
  },
  'POST /choose-date': (req, res) => {
    res.writeHead(302, { Location: '/choose-time' });
    res.end();
  },

  'GET /choose-time': (req, res) => {
    if (!requireAuth(req, res)) return;
    const token = csrf();
    sessionTokens['choose-time'] = token;
    res.end(page(
      'Choose a time range',
      'Choose a time range',
      `<form method="POST" action="/choose-time">
        ${radioField('selectedHour', HOURS.map(h => ({ value: h, label: h + ':00' })))}
        <input type="hidden" name="__RequestVerificationToken" value="${token}">
        <button type="submit">Continue</button>
      </form>`,
      getUser(req)
    ));
  },
  'POST /choose-time': (req, res) => {
    res.writeHead(302, { Location: '/choose-appointment' });
    res.end();
  },

  'GET /choose-appointment': (req, res) => {
    if (!requireAuth(req, res)) return;
    const token = csrf();
    sessionTokens['choose-appointment'] = token;
    res.end(page(
      'Choose an appointment',
      'Choose an appointment time',
      `<form method="POST" action="/choose-appointment">
        ${radioField('SelectedAppointmentData', SLOTS.map(s => ({ value: s, label: s.split('|')[0] })))}
        <input type="hidden" name="__RequestVerificationToken" value="${token}">
        <button type="submit">Continue</button>
      </form>`,
      getUser(req)
    ));
  },
  'POST /choose-appointment': (req, res) => {
    res.writeHead(302, { Location: '/booking-complete' });
    res.end();
  },

  'GET /booking-complete': (req, res) => {
    if (!requireAuth(req, res)) return;
    const user = getUser(req);
    res.end(page(
      'Booking complete',
      'Booking complete',
      `<p>Thank you, <strong>${user ? user.name : 'Guest'}</strong>.</p>
      <p>Your booking reference is: <strong>REF-${Date.now()}</strong></p>
      <p>We have sent a confirmation to <strong>${user ? user.email : ''}</strong>.</p>
      <p><a href="/start">Book another appointment</a> | <a href="/logout">Sign out</a></p>`,
      user
    ));
  },
};

const server = http.createServer((req, res) => {
  const method = req.method;
  const path = req.url.split('?')[0];

  // Try method-specific route first, then generic
  const handler = routes[`${method} ${path}`] || routes[path];
  if (handler) {
    // Read POST body before handling
    if (method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => { req.body = body; handler(req, res); });
    } else {
      handler(req, res);
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const PORT = process.env.TEST_PORT || 3847;
server.listen(PORT, () => console.log(`Test server on http://localhost:${PORT}`));
export default server;
