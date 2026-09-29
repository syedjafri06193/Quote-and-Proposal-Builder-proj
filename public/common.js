/* Shared helpers for the builder and admin pages. No framework, no build step. */
const S = {
  user: localStorage.getItem('qb.user') || 'alice',
  users: [],
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-User': S.user },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const e = new Error(data?.error?.message || res.statusText);
    e.details = data?.error?.details;
    e.code = data?.error?.code;
    throw e;
  }
  return data;
}

let toastTimer;
function toast(msg, err = false, details) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.className = 'toast' + (err ? ' err' : '');
  const list = Array.isArray(details) ? details : details?.reapprovers ? [] : [];
  el.innerHTML = esc(msg) + (list.length ? '<ul style="margin:6px 0 0 16px;padding:0">' + list.slice(0, 8).map((d) => `<li>${esc(d)}</li>`).join('') + '</ul>' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), err ? 9000 : 3500);
}

async function run(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, true, e.details);
    throw e;
  }
}

const money = (m) => (m && m.amount !== undefined ? fmtAmount(m) : '—');
function fmtAmount(m) {
  const sym = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' }[m.currency] ?? m.currency + ' ';
  const minUnits = { JPY: 0, KWD: 3 }[m.currency] ?? 2;
  let [i, f = ''] = String(m.amount).replace('-', '').split('.');
  f = f.replace(/0+$/, '');
  if (f.length < minUnits) f = f.padEnd(minUnits, '0');
  const neg = String(m.amount).startsWith('-');
  return (neg ? '−' : '') + sym + i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : '');
}
const pct = (bp) => (bp % 100 ? (bp / 100).toFixed(2).replace(/0$/, '') : String(bp / 100)) + '%';
const userName = (id) => S.users.find((u) => u.id === id)?.name ?? id;
const when = (iso) => (iso ? iso.replace('T', ' ').slice(0, 16) : '');

async function initUserSwitcher(onChange) {
  S.users = await api('GET', '/api/users');
  const sel = document.getElementById('user');
  sel.innerHTML = S.users.map((u) => `<option value="${u.id}">${esc(u.name)} — ${esc(u.roles.join(', '))}</option>`).join('');
  sel.value = S.user;
  sel.onchange = () => {
    S.user = sel.value;
    localStorage.setItem('qb.user', S.user);
    onChange();
  };
}
