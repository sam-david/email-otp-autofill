# Email Code Autofill

Chrome extension. When a site says "we sent a code to your email", it watches Gmail, finds the code that site just sent, and fills it in, including split 6-box inputs. It also offers sign-in (magic) links.

- **Domain matching (on by default, toggle in options):** auto-fills only when the sender, or its DKIM signer, is the site you're on. Codes from other senders still appear with a ⚠ and need one click. With matching off, the newest code always fills.
- **AI fallback (off by default):** when the built-in rules find no code in a verification-looking email, or only guess at one, it asks Claude, whose answer (including "no code") wins. The returned code is used only if it appears word-for-word in the email.
- **No backend:** Gmail is read directly from the extension with read-only scope. The token and email bodies stay in the service worker; pages only ever receive the code.
- **Shortcut:** `Alt+Shift+O` fills the waiting code, or starts watching on the focused field.

## Setup (one time, ~5 min)

The extension ID is pinned by the `key` in `manifest.json`: **`inbgmldgibmeeolfolnhjgnankmjgdpf`**.

The client ID in `manifest.json` belongs to the author's Google Cloud project and only works for its test users, so create your own:

1. In [Google Cloud Console](https://console.cloud.google.com/), create or pick a project.
   - **Enable** the Gmail API.
   - **OAuth consent screen:** choose *Internal* if you're on Workspace, otherwise *External* in *Testing*, and add your Gmail address as a test user. Add the scope `.../auth/gmail.readonly`.
   - **Credentials** → *Create OAuth client ID* → type **Chrome Extension**. Item ID: `inbgmldgibmeeolfolnhjgnankmjgdpf`.
2. Paste the client ID into `manifest.json` → `oauth2.client_id`.
3. Go to `chrome://extensions`, turn on Developer mode, then *Load unpacked* → this folder.
4. Click the toolbar icon to open the options page → **Connect Gmail**.
5. Optional: under *Test against your inbox*, enter a site and click **Find codes** to see what it would pick from recent mail.

`getAuthToken` uses the Google account Chrome is signed into. In *Testing* mode Google may ask you to re-consent weekly.

## Files

| File | Role |
|---|---|
| `content.js` | Detects code fields (`autocomplete=one-time-code`, names/labels, "we sent a code" page text, split boxes), shows the chip, fills them in a React-safe way |
| `background.js` | Gmail polling (every 2 s while a field is waiting, up to 5 min), candidate choice, fill policy, AI fallback, audit log |
| `lib/extract.js` | Code / magic-link extraction and sender↔site matching (pure, unit-tested) |
| `options.html/js` | Settings, Gmail connect/disconnect, inbox test, recent activity |

## Tests

```sh
node --test test/*.test.js test/*.test.mjs   # 38 tests
```

- `extract.test.js`: code extraction and sender/site matching, hand-written cases.
- `real-inbox.test.js`: 20 real emails (subject + preview, addresses scrubbed) in `fixtures/real-inbox.json`, including code-adjacent emails that must yield nothing.
- `browser.test.mjs`: headless Chrome fills `fixture.html` and `widgets.html`, covering single fields, auto-submit, split boxes, input-otp (shadcn/ui), react-otp-input, boxes that block paste, and boxes without `maxlength=1`. It checks the value the app itself received, not just what's on screen. Needs Chrome, and network access for the React widgets.

`test/fixture.html` runs `content.js` against a fake worker. Open it with `?mode=single|split|splitpaste&match=strong|none&auto=1|0&submit=1`.

## Live test (real Gmail, no real site needed)

1. Serve the fake verify page: `python3 -m http.server 8765 --bind 127.0.0.1` from `../test-site/`, and open `http://127.0.0.1:8765`. The chip should say "Waiting for email code…".
2. Email your Gmail a code **from a different account** (mail you send yourself is labeled Sent, which the extension skips), e.g. subject "Your verification code is 482913".
3. Within a few seconds the chip shows the code with "⚠ … not this site" (the sender's domain isn't 127.0.0.1); **Fill** puts it in the field. With *Domain matching* off in options, it fills without the click.

Verified 2026-10-14: code shown ~8 s after sending, filled, form submitted.
