const FIELDS = {
  domainMatching: true, autoFill: true, autoSubmit: false, lookbackSeconds: 120,
  aiFallback: false, anthropicKey: '', aiModel: 'claude-opus-5-5',
};

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

async function load() {
  const s = { ...FIELDS, ...(await chrome.storage.local.get(Object.keys(FIELDS))) };
  for (const [k, def] of Object.entries(FIELDS)) {
    const el = $(k);
    if (typeof def === 'boolean') el.checked = s[k];
    else el.value = s[k];
    el.addEventListener('change', () => {
      const v = typeof def === 'boolean' ? el.checked : typeof def === 'number' ? Number(el.value) : el.value.trim();
      chrome.storage.local.set({ [k]: v });
    });
  }
  refreshStatus();
  renderAudit();
}

function showStatus(r, note) {
  const ok = r && r.ok;
  $('gmailDot').className = 'dot ' + (ok ? 'on' : r && r.error ? 'err' : 'off');
  $('gmailStatus').textContent = note || (ok ? 'Connected as ' + r.email : r && r.error ? 'Error: ' + r.error : 'Not connected');
  $('gmailDetail').textContent = ok
    ? `Verified with a live Gmail read ${r.checkedAt ? new Date(r.checkedAt).toLocaleTimeString() : 'just now'} · ${Number(r.messagesTotal || 0).toLocaleString()} messages visible`
    : '';
  $('connect').hidden = ok;
  $('disconnect').hidden = !ok;
}

async function refreshStatus() {
  const { connection } = await chrome.storage.local.get('connection');
  if (connection) showStatus(connection, 'Checking…');
  showStatus(await send({ type: 'status' }));
}

$('connect').addEventListener('click', async () => {
  showStatus(null, 'Connecting…');
  showStatus(await send({ type: 'connect' }));
});

$('disconnect').addEventListener('click', async () => {
  await send({ type: 'disconnect' });
  refreshStatus();
});

$('test').addEventListener('click', async () => {
  const out = $('testOut');
  out.textContent = 'Searching…';
  const r = await send({ type: 'test', site: $('testSite').value.trim(), minutes: Number($('testMinutes').value) });
  if (!r.ok) { out.textContent = 'Error: ' + r.error; return; }
  if (!r.results.length) { out.textContent = 'No code or sign-in emails in that window.'; return; }
  const table = document.createElement('table');
  table.innerHTML = '<tr><th>When</th><th>Sender</th><th>Subject</th><th>Code / link</th><th>Match</th></tr>';
  for (const x of r.results) {
    const tr = table.insertRow();
    [new Date(x.receivedAt).toLocaleTimeString(), x.sender, x.subject,
      x.code ? `${x.code} (${x.confidence})` : (x.link ? 'link' : ''), x.match]
      .forEach((v) => { tr.insertCell().textContent = v; });
  }
  out.replaceChildren(table);
});

async function renderAudit() {
  const { audit = [] } = await chrome.storage.local.get('audit');
  if (!audit.length) { $('audit').textContent = ''; return; }
  const table = document.createElement('table');
  table.innerHTML = '<tr><th>When</th><th>Site</th><th>Sender</th><th>Match</th><th>Kind</th></tr>';
  for (const a of audit.slice(0, 20)) {
    const tr = table.insertRow();
    [new Date(a.at).toLocaleString(), a.site, a.sender, a.match, a.kind + (a.confidence === 'ai' ? ' (AI)' : '')]
      .forEach((v) => { tr.insertCell().textContent = v; });
  }
  $('audit').replaceChildren(table);
}

load();
