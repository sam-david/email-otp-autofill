// Pure helpers: Gmail message parsing, code / magic-link extraction, and
// sender-to-site domain matching. Loaded by the service worker via
// importScripts and by Node for tests, so no browser-only APIs here.
(function (root) {
  'use strict';

  const KEYWORD_RE = /\b(code|otp|one[- ]?time|verification|verify|passcode|security|sign[- ]?in|log[- ]?in|2fa|two[- ]factor|mfa|confirm|authenticat\w*|pin)\b/i;

  // A code token: 4–8 chars, must contain a digit (so "below"/"there" never match),
  // or the "123 456" / "123-456" split form.
  const TOKEN = '(\\d{3}[- ]\\d{3}|(?=[A-Z0-9]*\\d)[A-Z0-9]{4,8})';

  const ANCHORED = [
    new RegExp('\\bG-(\\d{6})\\b'),
    new RegExp('(?:code|otp|passcode|pin|password|token)\\b[^\\n\\dA-Z]{0,25}?(?:is|:|=|-)\\s*' + TOKEN + '\\b', 'i'),
    new RegExp('\\b' + TOKEN + '\\s+is\\s+your\\b', 'i'),
    new RegExp('(?:enter|use|type)\\s+(?:the\\s+)?(?:following\\s+)?(?:code|otp)?\\s*:?\\s*' + TOKEN + '\\b', 'i'),
    // Code alone on the line after the label; pipes allow table-layout emails ("| Code: |\n| 850481 |").
    new RegExp('(?:code|otp|passcode)\\b[^\\n]{0,40}\\n[\\s|]*' + TOKEN + '[ \\t|]*(?:\\n|$)', 'i'),
  ];

  const SECOND_LEVEL = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz',
    'co.jp', 'ne.jp', 'co.in', 'com.br', 'com.mx', 'co.za', 'com.cn', 'com.sg', 'com.tr',
    'com.hk', 'co.kr', 'com.ar', 'com.co', 'co.il', 'com.tw',
  ]);

  function registrableDomain(host) {
    if (!host) return '';
    host = String(host).toLowerCase().trim().replace(/^\.+|\.+$/g, '');
    if (/^\d+(\.\d+){3}$/.test(host) || host.includes(':')) return host;
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    const last2 = parts.slice(-2).join('.');
    return SECOND_LEVEL.has(last2) ? parts.slice(-3).join('.') : last2;
  }

  function decodeEntities(s) {
    return s
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&zwnj;|&#8204;|&#x200c;/gi, '')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
  }

  function htmlToText(html) {
    return decodeEntities(String(html)
      .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|tr|td|th|h\d|li|table|span)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '))
      .replace(/[​-‍﻿͏]/g, '')
      .replace(/[ \t ]+/g, ' ')
      .replace(/ *\n[ \n]*/g, '\n')
      .trim();
  }

  // ---- Gmail message parsing ----

  function b64urlDecode(data) {
    const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  }

  function walkParts(part, out) {
    if (!part) return;
    const type = (part.mimeType || '').toLowerCase();
    if (part.body && part.body.data) {
      if (type === 'text/plain') out.plain.push(b64urlDecode(part.body.data));
      else if (type === 'text/html') out.html.push(b64urlDecode(part.body.data));
    }
    (part.parts || []).forEach((p) => walkParts(p, out));
  }

  function header(headers, name) {
    const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
    return h ? h.value : '';
  }

  function linksFromHtml(html) {
    const links = [];
    const re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html))) {
      const href = decodeEntities(m[1]).trim();
      if (!/^https:\/\//i.test(href)) continue;
      links.push({ href, text: htmlToText(m[2]).replace(/\s+/g, ' ').trim() });
    }
    return links;
  }

  // Turns a Gmail API message (format=full) into the flat shape the rest of the code uses.
  function parseGmailMessage(msg) {
    const headers = (msg.payload && msg.payload.headers) || [];
    const from = header(headers, 'From');
    const addr = (from.match(/<([^>]+)>/) || [, from])[1].trim();
    const fromName = from.replace(/<[^>]+>/, '').replace(/"/g, '').trim();
    const fromDomain = (addr.split('@')[1] || '').toLowerCase();
    const authResults = headers.filter((h) => h.name.toLowerCase() === 'authentication-results').map((h) => h.value).join('\n');
    const dkimDomains = [];
    headers.filter((h) => h.name.toLowerCase() === 'dkim-signature').forEach((h) => {
      const d = h.value.match(/\bd=([^;\s]+)/);
      if (d) dkimDomains.push(d[1].toLowerCase());
    });
    (authResults.match(/dkim=pass[^;]*?header\.(?:d|i)=@?([^\s;]+)/gi) || []).forEach((s) => {
      dkimDomains.push(s.replace(/.*header\.(?:d|i)=@?/i, '').toLowerCase());
    });

    const parts = { plain: [], html: [] };
    walkParts(msg.payload, parts);
    const html = parts.html.join('\n');
    const text = parts.plain.length ? parts.plain.join('\n') : htmlToText(html);
    const links = html ? linksFromHtml(html) : (text.match(/https:\/\/[^\s<>"')]+/g) || []).map((href) => ({ href, text: '' }));
    const linkDomains = [...new Set(links.map((l) => { try { return new URL(l.href).hostname; } catch (e) { return ''; } }).filter(Boolean))];

    return {
      id: msg.id,
      receivedAt: Number(msg.internalDate) || Date.now(),
      subject: header(headers, 'Subject'),
      fromName, fromAddress: addr, fromDomain,
      dmarcFail: /dmarc=fail/i.test(authResults),
      dkimDomains, linkDomains, links, text, html,
    };
  }

  // ---- Extraction ----

  const BLOCK_BEFORE = /(\$|€|£|¥|#|order|invoice|ref(erence)?|ticket|account|acct|zip|suite|apt|no\.|number|phone|call|tel|fax|ext\.?|id)[ \t]*[:.#]?[ \t]*$/i; // same line only

  function isPlausible(token, before, after) {
    const t = token.replace(/[- ]/g, '');
    if (t.length < 4 || t.length > 8) return false;
    if (/^(19|20)\d{2}$/.test(t)) return false; // a year
    if (/^\d+$/.test(t) && /^(\d)\1+$/.test(t)) return false; // 0000, 111111
    if (/^[,.:/-]\d/.test(after) || /\d[,.:/-]$/.test(before)) return false; // part of a larger number/time/date
    if (/^\s*%/.test(after)) return false;
    if (BLOCK_BEFORE.test(before)) return false;
    return true;
  }

  // "1600 Amphitheatre Parkway", "2100 Market St": footer addresses, the commonest look-alike.
  const STREET_RE = /\b\d{1,6}\s+(?:[A-Z][\w'.-]*\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Parkway|Pkwy|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Place|Pl|Court|Ct|Square|Sq|Highway|Hwy|Plaza|Terrace|Circle)\b\.?/g;

  // Words that say "this email carries a code". The broad KEYWORD_RE (security, sign in,
  // confirm…) is fine as a gate for anchored patterns but too loose for the guessing fallback:
  // every security alert would qualify.
  const CODE_KW_RE = /\b(code|otp|one[- ]?time|verification|passcode|pin|2fa|mfa)\b/i;

  function stripNoise(s) {
    return s
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ')
      .replace(/\+?\d{1,3}[ .-]?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}/g, ' ') // phone numbers
      .replace(STREET_RE, ' ')
      .replace(/\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g, ' '); // "CA 94043"
  }

  // Returns { code, confidence: 'high' | 'medium' } or null.
  function extractCode(subject, body) {
    const sources = [stripNoise(subject || ''), stripNoise(body || '')];
    const all = sources.join('\n');
    if (!KEYWORD_RE.test(all)) return null;

    for (const src of sources) {
      for (const re of ANCHORED) {
        const m = src.match(re);
        if (!m) continue;
        const token = m[1];
        const idx = m.index + m[0].lastIndexOf(token);
        if (isPlausible(token, src.slice(Math.max(0, idx - 12), idx), src.slice(idx + token.length, idx + token.length + 3))) {
          return { code: token.replace(/[- ]/g, ''), confidence: 'high' };
        }
      }
    }

    // Fallback: standalone tokens, scored by distance to the nearest keyword.
    const tokenRe = /(?<![\w-])(\d{4,8}|(?=[A-Z]*\d)(?=\d*[A-Z])[A-Z0-9]{6,8})(?![\w-])/g;
    const kwRe = new RegExp(CODE_KW_RE.source, 'gi');
    let best = null;
    sources.forEach((src, si) => {
      const kwPos = [];
      let k;
      while ((k = kwRe.exec(src))) kwPos.push(k.index);
      let m;
      while ((m = tokenRe.exec(src))) {
        const token = m[1];
        if (!isPlausible(token, src.slice(Math.max(0, m.index - 12), m.index), src.slice(m.index + token.length, m.index + token.length + 3))) continue;
        const dist = kwPos.length ? Math.min(...kwPos.map((p) => Math.abs(p - m.index))) : 1e6;
        let score = -dist;
        if (token.length === 6) score += 40;
        if (si === 0) score += 30; // subject line
        if (!best || score > best.score) best = { code: token, score, dist };
      }
    });
    if (best && best.dist < 200) return { code: best.code, confidence: 'medium' };
    return null;
  }

  const LINK_TEXT_RE = /\b(sign|log)\s?in\b|verify|confirm|magic link|continue|access your|activate|authenticate/i;

  function extractMagicLink(email) {
    const hit = email.links.find((l) => LINK_TEXT_RE.test(l.text) && !/unsubscribe|privacy|help|support|terms/i.test(l.text + l.href));
    return hit ? hit.href : null;
  }

  // ---- Matching ----

  // 'strong': sender (or its DKIM signer) is the site's registrable domain.
  // 'medium': links or brand name point at the site (covers SendGrid/Auth0-style senders).
  // 'none':   no evidence the email belongs to this site.
  function domainMatch(email, hosts) {
    const sites = [...new Set((Array.isArray(hosts) ? hosts : [hosts]).map(registrableDomain).filter(Boolean))];
    if (!sites.length || email.dmarcFail) return 'none';
    const from = registrableDomain(email.fromDomain);
    if (sites.includes(from)) return 'strong';
    if (email.dkimDomains.some((d) => sites.includes(registrableDomain(d)))) return 'strong';
    if (email.linkDomains.some((d) => sites.includes(registrableDomain(d)))) return 'medium';
    const hay = (email.fromName + ' ' + email.subject + ' ' + from).toLowerCase();
    if (sites.some((s) => { const brand = s.split('.')[0]; return brand.length >= 3 && new RegExp('\\b' + brand + '\\b').test(hay); })) return 'medium';
    return 'none';
  }

  const api = { registrableDomain, htmlToText, parseGmailMessage, extractCode, extractMagicLink, domainMatch, KEYWORD_RE };
  root.OTP = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
