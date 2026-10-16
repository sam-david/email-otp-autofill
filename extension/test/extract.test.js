const test = require('node:test');
const assert = require('node:assert');
const OTP = require('../lib/extract.js');

const code = (subject, body) => (OTP.extractCode(subject, body) || {}).code || null;

test('anchored phrasings', () => {
  assert.equal(code('Your GitHub launch code', 'Here is your GitHub launch code: 41927083\nContinue signing in.'), '41927083');
  assert.equal(code('Slack confirmation code: 482-913', ''), '482913');
  assert.equal(code('', 'Your verification code is 739201. It expires in 10 minutes.'), '739201');
  assert.equal(code('739201 is your Instagram code', ''), '739201');
  assert.equal(code('G-582013 is your Google verification code', ''), '582013');
  assert.equal(code('Sign in to Notion', 'Enter this code to sign in:\n\nKXQ7P2\n\nIf you did not request this, ignore it.'), 'KXQ7P2');
  assert.equal(code('Your one-time passcode', 'Use the following code: 552 019'), '552019');
});

test('ignores look-alike numbers', () => {
  assert.equal(code('Your order #482913 has shipped', 'Thanks for your order. Total $1234.00. Call 1-800-555-1234.'), null);
  assert.equal(code('Weekly newsletter', 'See what happened in 2026 at our conference.'), null);
  // Year and phone number present, real code elsewhere.
  assert.equal(code('Verify your email', '© 2026 Acme Inc. Questions? Call (415) 555-0199.\nYour verification code: 318274'), '318274');
});

test('fallback picks the token nearest a keyword', () => {
  const body = 'Hi Sam,\n\nSomeone tried to log in to your account.\n\n  918273  \n\nThis code expires in 15 minutes.\n\nAcme, 2100 Market St, San Francisco CA 94114';
  assert.equal(code('Login attempt', body), '918273');
});

test('no code in account notices (real Google security alert)', () => {
  const body = 'You allowed Chat Email access to some of your Google Account data\n\nyou@example.com\n\n' +
    'If you didn\u2019t allow Chat Email access to some of your Google Account data,\nsomeone else may be trying to access your Google Account data.\n\n' +
    'Take a moment now to check your account activity and secure your account.\nCheck activity\n' +
    'You can also see security activity at\nhttps://myaccount.google.com/notifications\n' +
    '\u00a9 2026 Google LLC, 1600 Amphitheatre Parkway, Mountain View, CA 94043, USA';
  assert.equal(code('Security alert', body), null);
  // The address no longer competes with a real code either.
  assert.equal(code('Your sign-in code', 'Use 482913 to sign in.\n\u00a9 Acme, 1600 Market Street, CA 94105'), '482913');
});

test('real-world layouts (shapes from Chewy, Amex)', () => {
  assert.equal(code('Enter this code to sign in', 'Use your one-time code where it was requested.\n\n \n\n512907\n \n\nOr call 1-800-672-4399.\nFree Shipping\non Orders $49+'), '512907');
  const amex = OTP.extractCode('Your one-time verification code', '| One-Time Verification Code: |\n| 850481 |\n\n| \u00a92026 American Express. |\n| SSF0CTA033 |');
  assert.deepEqual(amex, { code: '850481', confidence: 'high' });
});

test('html emails', () => {
  const html = '<html><head><style>.x{color:red}</style></head><body><table><tr><td>Your Stripe verification code</td></tr><tr><td><strong style="letter-spacing:4px">604 318</strong></td></tr></table><p>&copy; 2026 Stripe</p></body></html>';
  assert.equal(code('Stripe verification code', OTP.htmlToText(html)), '604318');
});

test('registrable domain', () => {
  assert.equal(OTP.registrableDomain('accounts.google.com'), 'google.com');
  assert.equal(OTP.registrableDomain('login.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(OTP.registrableDomain('github.com'), 'github.com');
});

function gmailMsg({ from, subject, html, text, headers = [] }) {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
  const parts = [];
  if (text) parts.push({ mimeType: 'text/plain', body: { data: b64(text) } });
  if (html) parts.push({ mimeType: 'text/html', body: { data: b64(html) } });
  return {
    id: 'm1', internalDate: String(Date.now()),
    payload: {
      mimeType: 'multipart/alternative',
      headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, ...headers],
      parts,
    },
  };
}

test('parse + domain matching', () => {
  const direct = OTP.parseGmailMessage(gmailMsg({ from: 'GitHub <noreply@github.com>', subject: '[GitHub] Sign in code', text: 'Code: 123987' }));
  assert.equal(OTP.domainMatch(direct, 'github.com'), 'strong');
  assert.equal(OTP.domainMatch(direct, 'github-login.evil.com'), 'none');

  const subdomain = OTP.parseGmailMessage(gmailMsg({ from: 'Acme <no-reply@mail.acme.io>', subject: 'Code', text: 'Code: 123987' }));
  assert.equal(OTP.domainMatch(subdomain, 'app.acme.io'), 'strong');

  const viaEsp = OTP.parseGmailMessage(gmailMsg({
    from: 'Linear <notifications@sendgrid.net>', subject: 'Your Linear login code',
    html: '<p>Your code is <b>551203</b></p><a href="https://linear.app/login?x=1">Sign in to Linear</a>',
  }));
  assert.equal(OTP.domainMatch(viaEsp, 'linear.app'), 'medium');
  assert.equal(OTP.extractMagicLink(viaEsp), 'https://linear.app/login?x=1');

  const dkim = OTP.parseGmailMessage(gmailMsg({
    from: 'Bank <alerts@bank-mailer.com>', subject: 'Code', text: 'Code: 551203',
    headers: [{ name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@mybank.com; spf=pass; dmarc=pass' }],
  }));
  assert.equal(OTP.domainMatch(dkim, 'www.mybank.com'), 'strong');

  const spoof = OTP.parseGmailMessage(gmailMsg({
    from: 'GitHub <noreply@github.com>', subject: 'Code', text: 'Code: 551203',
    headers: [{ name: 'Authentication-Results', value: 'mx.google.com; dkim=fail; dmarc=fail (p=REJECT)' }],
  }));
  assert.equal(OTP.domainMatch(spoof, 'github.com'), 'none');
});
