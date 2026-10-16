// Content script: spots "enter the code we emailed you" fields, asks the
// service worker to watch Gmail, and fills the code it gets back.
(() => {
  'use strict';
  if (window.__emailCodeAutofill) return;
  window.__emailCodeAutofill = true;

  const STRONG = /(\bone.?time|\botp\b|verification|verify|security.?code|auth(entication)?.?code|\b2fa\b|\bmfa\b|totp|passcode|login.?code|sign.?in.?code|confirm(ation)?.?code|access.?code|email.?code)/i;
  const WEAK = /(\bcode\b|\bpin\b|token|digit)/i;
  const EXCLUDE = /(backup|recovery|promo|coupon|discount|gift|voucher|zip|postal|card|cvv|cvc|security.?question|phone|search|referral|invite|captcha|country|area)/i;
  const PAGE_HINT = /((sent|emailed|e-mailed|we.?ve sent|we just sent|enter the|check your).{0,80}(code|verification|inbox|email))|(code.{0,40}(sent|emailed) to)/i;

  let session = null; // { field, group, port, since, candidate, chip, state }
  const dismissed = new WeakSet(); // fields the user closed the chip on

  // ---------- Field detection ----------

  function describe(el) {
    const label = el.labels && el.labels.length ? [...el.labels].map((l) => l.textContent).join(' ') : '';
    const aria = el.getAttribute('aria-labelledby');
    const ariaText = aria ? aria.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' ') : '';
    return [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.className, el.getAttribute('data-testid'), label, ariaText]
      .filter((x) => typeof x === 'string' && x).join(' | ');
  }

  function visible(el) {
    if (el.disabled || el.readOnly) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  }

  function pageHint() {
    const text = (document.body && document.body.innerText || '').slice(0, 5000);
    return PAGE_HINT.test(text);
  }

  // Groups of 4–8 single-character inputs that share a parent = split code boxes.
  // One input per digit. Recognized by maxlength=1, or, since many sites leave that off,
  // by shape: 4–8 narrow inputs of the same width on one row.
  const boxWidth = (i) => i.getBoundingClientRect().width;
  const isBoxLike = (i) => i.maxLength === 1 || (boxWidth(i) > 0 && boxWidth(i) < 72);

  function findSplitGroup(el) {
    if (!isBoxLike(el)) return null;
    const top = el.getBoundingClientRect().top;
    const w = boxWidth(el);
    let parent = el.parentElement;
    for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
      const boxes = [...parent.querySelectorAll('input')].filter((i) => visible(i) && ['text', 'tel', 'number', 'password', ''].includes(i.type) &&
        (el.maxLength === 1 ? i.maxLength === 1 : Math.abs(boxWidth(i) - w) < 4 && Math.abs(i.getBoundingClientRect().top - top) < 8));
      if (boxes.length >= 4 && boxes.length <= 8) return boxes;
      if (boxes.length > 8) return null;
    }
    return null;
  }

  function score(el, hint) {
    if (!(el instanceof HTMLInputElement)) return -1;
    if (!['text', 'tel', 'number', 'password', ''].includes(el.type)) return -1;
    if (!visible(el)) return -1;
    const desc = describe(el);
    if (EXCLUDE.test(desc)) return -1;
    let s = 0;
    if ((el.autocomplete || '').includes('one-time-code')) s += 100;
    if (STRONG.test(desc)) s += 60;
    else if (WEAK.test(desc)) s += 25;
    if (el.inputMode === 'numeric' || /\\d|\[0-9\]/.test(el.pattern || '')) s += 15;
    if (el.maxLength >= 4 && el.maxLength <= 8) s += 15;
    if (el.type === 'password' && s < 100) s -= 40; // only trust password-type when explicitly marked
    if (hint) s += 35;
    if (findSplitGroup(el)) s += 40;
    return s;
  }

  function scan() {
    if (session && document.contains(session.field)) return;
    if (session) endSession();
    const hint = pageHint();
    let best = null;
    for (const el of document.querySelectorAll('input')) {
      const s = score(el, hint);
      if (s >= 60 && !dismissed.has(el) && (!best || s > best.s)) best = { el, s };
    }
    if (best) startSession(best.el);
  }

  // ---------- Session with the service worker ----------

  function startSession(field) {
    const group = findSplitGroup(field);
    const port = chrome.runtime.connect({ name: 'otp-wait' });
    session = { field: group ? group[0] : field, group, port, since: Date.now(), candidate: null, chip: null, state: 'waiting' };
    const s = session;
    port.onMessage.addListener((msg) => onWorkerMessage(s, msg));
    port.onDisconnect.addListener(() => { s.port = null; clearInterval(s.ping); });
    port.postMessage({ type: 'start', since: s.since });
    // Messages on an open port keep the MV3 worker alive while we wait.
    s.ping = setInterval(() => s.port && s.port.postMessage({ type: 'ping' }), 20000);
    renderChip(s);
  }

  function dismiss() {
    if (session) (session.group || [session.field]).forEach((f) => dismissed.add(f));
    endSession();
  }

  function endSession() {
    if (!session) return;
    clearInterval(session.ping);
    if (session.port) { try { session.port.postMessage({ type: 'stop' }); session.port.disconnect(); } catch (e) {} }
    if (session.chip) session.chip.host.remove();
    session = null;
  }

  function onWorkerMessage(s, msg) {
    if (s !== session) return;
    if (msg.type === 'candidate') {
      s.candidate = msg;
      s.state = msg.code ? 'ready' : 'link';
      renderChip(s);
      if (msg.autoFill && fieldIsEmpty(s)) fill(s);
    } else if (msg.type === 'timeout') {
      s.state = 'timeout'; renderChip(s);
    } else if (msg.type === 'error') {
      s.state = 'error'; s.error = msg.error; renderChip(s);
    }
  }

  function fieldIsEmpty(s) {
    return s.group ? s.group.every((b) => !b.value) : !s.field.value;
  }

  // ---------- Insertion ----------

  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

  function setValue(el, value) {
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: value.slice(-1) || 'Unidentified' }));
    nativeSetter.call(el, value); // bypasses React's value tracker so onChange fires
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: value.slice(-1) || 'Unidentified' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fillSplit(boxes, code) {
    // Many split widgets distribute a pasted code themselves; try that first.
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', code);
      boxes[0].focus();
      boxes[0].dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    } catch (e) {}
    const filled = boxes.map((b) => b.value).join('');
    if (filled === code.slice(0, boxes.length)) return;
    boxes.forEach((b, i) => setValue(b, code[i] || ''));
  }

  function fill(s) {
    const c = s.candidate;
    if (!c || !c.code) return;
    const code = c.code;
    if (s.group && code.length === s.group.length) fillSplit(s.group, code);
    else setValue(s.field, code);
    s.state = 'filled';
    renderChip(s);
    if (c.autoSubmit) setTimeout(() => submit(s.field), 300);
    if (s.port) s.port.postMessage({ type: 'stop' });
    setTimeout(() => { if (session === s && s.chip) s.chip.host.remove(); }, 2500);
  }

  function submit(field) {
    const form = field.form || field.closest('form');
    const btn = (form || document).querySelector('button[type=submit], input[type=submit], button:not([type])');
    if (btn && visible(btn)) btn.click();
    else if (form && form.requestSubmit) form.requestSubmit();
  }

  async function copyCode(s) {
    try { await navigator.clipboard.writeText(s.candidate.code); s.state = 'copied'; renderChip(s); } catch (e) {}
  }

  // ---------- Chip UI ----------

  function ago(ts) {
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    return sec < 60 ? sec + 's ago' : Math.round(sec / 60) + 'm ago';
  }

  const CSS = `
    :host { all: initial; position: fixed; z-index: 2147483647; }
    .chip { font: 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; align-items: center; gap: 8px;
      background: #1c1c1e; color: #f2f2f7; border-radius: 10px; padding: 7px 8px 7px 11px; box-shadow: 0 6px 24px rgba(0,0,0,.28); max-width: 360px; }
    .code { font: 600 15px/1 ui-monospace, Menlo, monospace; letter-spacing: 2px; }
    .meta { color: #a1a1aa; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .warn { color: #fbbf24; }
    button { all: unset; cursor: pointer; background: #0a84ff; color: #fff; font-weight: 600; font-size: 12px; padding: 5px 10px; border-radius: 7px; }
    button.ghost { background: transparent; color: #a1a1aa; padding: 5px 6px; }
    button:focus-visible { outline: 2px solid #64d2ff; }
    .spin { width: 12px; height: 12px; border: 2px solid #52525b; border-top-color: #0a84ff; border-radius: 50%; animation: s .8s linear infinite; }
    @keyframes s { to { transform: rotate(360deg); } }
    @media (prefers-color-scheme: light) { .chip { background: #fff; color: #18181b; border: 1px solid #e4e4e7; } .meta { color: #71717a; } .warn { color: #b45309; } }
  `;

  function renderChip(s) {
    if (!s.chip) {
      const host = document.createElement('email-code-autofill');
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>${CSS}</style><div class="chip"></div>`;
      document.documentElement.appendChild(host);
      s.chip = { host, box: root.querySelector('.chip') };
      const place = () => {
        if (!document.contains(s.field)) return;
        const r = (s.group ? s.group[s.group.length - 1] : s.field).getBoundingClientRect();
        const left = Math.min(r.left, window.innerWidth - 370);
        host.style.left = Math.max(8, left) + 'px';
        host.style.top = (r.bottom + 6 + 44 > window.innerHeight ? r.top - 46 : r.bottom + 6) + 'px';
      };
      s.chip.place = place;
      window.addEventListener('scroll', place, true);
      window.addEventListener('resize', place);
    }
    const box = s.chip.box;
    const c = s.candidate;
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const btn = (label, fn, cls) => { const b = el('button', cls, label); b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); }); return b; };
    box.replaceChildren();

    if (s.state === 'waiting') {
      box.append(el('div', 'spin'), el('span', 'meta', 'Waiting for email code…'), btn('✕', dismiss, 'ghost'));
    } else if (s.state === 'ready' || s.state === 'copied') {
      const meta = el('span', 'meta' + (c.match === 'none' ? ' warn' : ''),
        c.match === 'none' ? `⚠ ${c.sender} · not this site` : `${c.sender} · ${ago(c.receivedAt)}`);
      meta.title = `From ${c.senderDomain}, ${ago(c.receivedAt)}` + (c.match === 'none' ? ' — the sender doesn’t match this site' : '');
      box.append(el('span', 'code', c.code), meta,
        btn('Fill', () => fill(s)),
        btn(s.state === 'copied' ? 'Copied' : 'Copy', () => copyCode(s), 'ghost'),
        btn('✕', dismiss, 'ghost'));
    } else if (s.state === 'link') {
      box.append(el('span', 'meta' + (c.match === 'none' ? ' warn' : ''), `Sign-in link from ${c.sender}`));
      if (c.link) box.append(btn('Open link', () => { location.assign(c.link); }));
      box.append(btn('✕', dismiss, 'ghost'));
    } else if (s.state === 'filled') {
      box.append(el('span', 'meta', `✓ Filled code from ${c.sender}`));
    } else if (s.state === 'timeout') {
      box.append(el('span', 'meta', 'No code email yet'), btn('Retry', () => { endSession(); scan(); }), btn('✕', dismiss, 'ghost'));
    } else if (s.state === 'error') {
      box.append(el('span', 'meta warn', s.error), btn('✕', dismiss, 'ghost'));
    }
    s.chip.place();
  }

  // ---------- Wiring ----------

  let pending = null;
  const schedule = () => { clearTimeout(pending); pending = setTimeout(scan, 300); };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
  document.addEventListener('focusin', (e) => {
    if (session || !(e.target instanceof HTMLInputElement) || dismissed.has(e.target)) return;
    if (score(e.target, pageHint()) >= 60) startSession(e.target);
  }, true);
  scan();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'fill-now') return;
    if (!session) {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement) startSession(el); // shortcut forces a session on the focused field
      return;
    }
    if (session.candidate && session.candidate.code) fill(session);
  });
})();
