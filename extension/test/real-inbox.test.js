// Regression set from a real inbox (Sept–Oct 2026): subject + preview text, personal
// addresses replaced. `expected: null` rows are code-adjacent emails that must NOT yield a
// code (security alerts, MFA reminders, newsletters that say "code", customer IDs).
const test = require('node:test');
const assert = require('node:assert');
const OTP = require('../lib/extract.js');
const rows = require('./fixtures/real-inbox.json');

for (const r of rows) {
  test(`${r.senderDomain}: ${r.subject}`, () => {
    const got = OTP.extractCode(r.subject, r.body);
    assert.equal(got ? got.code : null, r.expected);
  });
}

test('real senders match their own sites, not each other', () => {
  const email = (fromDomain) => ({ fromDomain, fromName: '', subject: '', dkimDomains: [], linkDomains: [], dmarcFail: false });
  assert.equal(OTP.domainMatch(email('mylogin.norton.com'), 'my.norton.com'), 'strong');
  assert.equal(OTP.domainMatch(email('signin.autodesk.com'), 'accounts.autodesk.com'), 'strong');
  // Known gap: Microsoft signs in on live.com but mails from microsoft.com, so it gets the ⚠ one-click path.
  assert.equal(OTP.domainMatch(email('accountprotection.microsoft.com'), 'login.live.com'), 'none');
  assert.equal(OTP.domainMatch(email('walmart.com'), 'chewy.com'), 'none');
});
