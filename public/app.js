'use strict';
/* Kabo online — client */

const socket = io({ transports: ['websocket', 'polling'] });
const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
let token = store.get('kabo.token');
if (!token) { token = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('kabo.token', token); }
// testing aid: ?as=x makes this tab a separate player (own token, own saved name/room)
const AS = new URLSearchParams(location.search).get('as') || '';
if (AS) {
  token += '-' + AS;
  for (const k of ['get', 'set', 'del']) { const f = store[k]; store[k] = (key, ...r) => f('as' + AS + '.' + key, ...r); }
}

const urlRoom = (new URLSearchParams(location.search).get('r') || '').toUpperCase();
let S = null;                 // latest state from server
let autoJoining = false;
const ui = {
  sel: new Set(),             // my cards selected for swapping
  swapMine: null, swapOther: null,
  stepKey: '',
  hlSeen: 0, hlIds: new Set(), hlKind: '', hlTimer: null,
  showScores: false, hideResult: false, resultRound: 0,
  chat: [],
  wasMyTurn: false,
  flying: new Set(),          // card ids hidden while their KŠEFT copy flies
};

const EFF = { 7: 'KUK', 8: 'KUK', 9: 'ŠPION', 10: 'ŠPION', 11: 'KŠEFT', 12: 'KŠEFT' };
const EFF_FULL = { peek: 'KUK', spy: 'ŠPION', swap: 'KŠEFT' };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, kind) {
  $toast.textContent = msg;
  $toast.className = 'toast' + (kind ? ' ' + kind : '');
  $toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { $toast.hidden = true; }, 3200);
}

// ---------------- socket ----------------
socket.on('connect', () => {
  setConn(true);
  const code = (S && S.code) || store.get('kabo.room');
  const name = store.get('kabo.name');
  if (code && (S || !urlRoom || urlRoom === code)) {
    autoJoining = !S;
    socket.emit('join', { code, name, token });
  }
});
socket.on('disconnect', () => setConn(false));
socket.on('err', msg => {
  if (autoJoining) { autoJoining = false; store.del('kabo.room'); render(); return; }
  toast(msg);
});
socket.on('kicked', () => { S = null; store.del('kabo.room'); toast('Zakladatel tě z místnosti odebral.', 'info'); render(); });
socket.on('chat', m => {
  ui.chat.push(m);
  if (ui.chat.length > 60) ui.chat.shift();
  render();
});
socket.on('state', st => {
  autoJoining = false;
  const hadGame = !!(S && S.game);
  let swapAnim = null;
  S = st;
  store.set('kabo.room', st.code);
  if (new URLSearchParams(location.search).get('r') !== st.code) history.replaceState(null, '', '?r=' + st.code + (AS ? '&as=' + AS : ''));
  const g = st.game;
  if (g) {
    const key = `${g.round}|${g.phase}|${g.turnPid}|${g.step}`;
    if (key !== ui.stepKey) { ui.stepKey = key; ui.sel.clear(); ui.swapMine = ui.swapOther = null; }
    if (g.highlight && g.highlight.n !== ui.hlSeen) {
      ui.hlSeen = g.highlight.n;
      const { cardIds, kind } = g.highlight;
      if (!hadGame) {
        // just (re)connected: don't replay an old highlight
      } else if (kind === 'swap') {
        const last = g.log[g.log.length - 1];
        if (last) toast('🔀 ' + last.text, 'info');
        swapAnim = captureSwap(cardIds);           // old positions, before re-render
        if (swapAnim) ui.flying = new Set(cardIds);
        else setHl(cardIds, 'swapdone', 6000);
      } else {
        setHl(cardIds, kind, 2700);
      }
    }
    if (g.round !== ui.resultRound) { ui.resultRound = g.round; ui.hideResult = false; }
    const myTurn = g.phase === 'play' && g.turnPid === st.me;
    if (myTurn && !ui.wasMyTurn) { try { navigator.vibrate && navigator.vibrate(120); } catch {} }
    ui.wasMyTurn = myTurn;
    document.title = (myTurn ? '● Jsi na tahu! – ' : '') + 'Kabo online';
  } else {
    document.title = 'Kabo online';
  }
  render();
  if (swapAnim) runSwap(swapAnim);
});

function setHl(ids, kind, ms) {
  ui.hlIds = new Set(ids);
  ui.hlKind = kind;
  clearTimeout(ui.hlTimer);
  ui.hlTimer = setTimeout(() => { ui.hlIds = new Set(); render(); }, ms);
}

// ---------- KŠEFT animation: the two cards fly slowly to each other's place ----------
function captureSwap(ids) {
  if (document.hidden || ids.length !== 2) return null;
  const old = {};
  for (const id of ids) {
    const el = $app.querySelector(`.hand [data-cid="${id}"]`);
    if (!el) return null;
    old[id] = { rect: el.getBoundingClientRect(), html: el.outerHTML };
  }
  return { ids, old };
}

function runSwap({ ids, old }) {
  const clones = [];
  const runs = ids.map(id => {
    const el = $app.querySelector(`.hand [data-cid="${id}"]`);
    const o = old[id];
    if (!el) return null;
    const n = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.innerHTML = o.html;
    const c = box.firstElementChild;
    c.className = c.className.replace(/\b(clickable|selected|flying-hidden|flash-\w+)\b/g, '');
    c.classList.add('flyer');
    c.removeAttribute('data-act');
    Object.assign(c.style, {
      left: o.rect.left + 'px', top: o.rect.top + 'px',
      width: o.rect.width + 'px', height: o.rect.height + 'px',
    });
    c.style.setProperty('--cw', o.rect.width + 'px');
    c.style.setProperty('--ch', o.rect.height + 'px');
    document.body.appendChild(c);
    clones.push(c);
    const dx = n.left - o.rect.left, dy = n.top - o.rect.top;
    const sx = n.width / o.rect.width, sy = n.height / o.rect.height;
    const lift = Math.min(60, 20 + Math.abs(dx) * 0.1);
    return c.animate([
      { transform: 'translate(0, 0) scale(1)' },
      { transform: 'translate(0, -12px) scale(1.18)', offset: 0.25 },
      { transform: `translate(${dx / 2}px, ${dy / 2 - lift}px) scale(${(1.18 + sx) / 2 + 0.1})`, offset: 0.6 },
      { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
    ], { duration: 2200, easing: 'ease-in-out', fill: 'forwards' }).finished;
  }).filter(Boolean);
  const done = () => {
    clones.forEach(c => c.remove());
    ui.flying = new Set();
    setHl(ids, 'swapdone', 6000);
    render();
  };
  Promise.all(runs).then(done, done);
}

function setConn(ok) {
  let el = document.getElementById('conn');
  if (ok) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'conn'; el.className = 'conn'; document.body.appendChild(el); }
  el.textContent = 'Spojení přerušeno — připojuji znovu…';
}
// keep a sleeping free-tier server awake while someone has the page open
setInterval(() => { fetch('/ping').catch(() => {}); }, 4 * 60 * 1000);

const act = (type, extra = {}) => socket.emit('act', { type, ...extra });

// ---------------- rendering helpers ----------------
function valClass(v) {
  if (v === 0) return 'v0';
  if (v <= 3) return 'vlow';
  if (v <= 6) return 'vmid';
  if (v <= 8) return 'vpeek';
  if (v <= 10) return 'vspy';
  if (v <= 12) return 'vswap';
  return 'v13';
}

function cardHTML(c, o = {}) {
  const cls = ['card'];
  const known = c.v !== undefined && c.v !== null;
  let inner = '';
  if (known) {
    cls.push('front', valClass(c.v));
    inner = `<span class="corner">${c.v}</span><span class="num">${c.v}</span>` + (EFF[c.v] ? `<span class="eff">${EFF[c.v]}</span>` : '');
    if (o.markUp && c.up) cls.push('up-mark');
    if (c.peeked) cls.push('secret');
    if (c.remembered) cls.push('remembered');
  } else {
    cls.push('back');
  }
  if (o.clickable) cls.push('clickable');
  if (o.selected) cls.push('selected');
  if (o.dim) cls.push('dim');
  if (c.id && ui.hlIds.has(c.id)) cls.push('flash-' + ui.hlKind);
  if (c.id && ui.flying.has(c.id)) cls.push('flying-hidden');
  let attrs = o.act ? ` data-act="${o.act}" data-id="${esc(c.id || '')}"` : '';
  if (c.id) attrs += ` data-cid="${esc(c.id)}"`;
  const title = known ? (c.peeked ? 'Vidíš jen ty' : c.remembered ? 'Pamatuješ si (nápověda)' : c.up ? 'Lícem nahoru — vidí všichni' : '') : '';
  return `<div class="${cls.join(' ')}"${attrs}${title ? ` title="${title}"` : ''}>${inner}</div>`;
}

// keep input focus/value across re-renders
function render() {
  const active = document.activeElement && document.activeElement.id;
  const vals = {};
  $app.querySelectorAll('input[id]').forEach(i => { vals[i.id] = i.type === 'checkbox' ? null : i.value; });
  const logEl = $app.querySelector('.log'); const chatEl = $app.querySelector('.chatlog');
  const logAtBottom = !logEl || logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 30;
  const chatAtBottom = !chatEl || chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 30;

  if (!S) $app.innerHTML = homeHTML();
  else if (!S.game) $app.innerHTML = lobbyHTML();
  else $app.innerHTML = gameHTML();

  for (const [id, v] of Object.entries(vals)) {
    const el = document.getElementById(id);
    if (el && v !== null && el.type !== 'checkbox') el.value = v;
  }
  if (active) { const el = document.getElementById(active); if (el) { el.focus(); if (el.setSelectionRange && el.value) { const n = el.value.length; el.setSelectionRange(n, n); } } }
  const l2 = $app.querySelector('.log'); if (l2 && logAtBottom) l2.scrollTop = l2.scrollHeight;
  const c2 = $app.querySelector('.chatlog'); if (c2 && chatAtBottom) c2.scrollTop = c2.scrollHeight;
}

// ---------------- home ----------------
function homeHTML() {
  const name = store.get('kabo.name') || '';
  return `
  <div class="logo"><h1>KAB<span class="moon"></span></h1><p>Online verze pro kamarády</p></div>
  <div class="box stack">
    <label for="name">Tvoje jméno</label>
    <input type="text" id="name" maxlength="16" placeholder="např. Lukáš" value="${esc(name)}" autocomplete="nickname">
    <h2 style="margin-top:18px">Připojit se ke hře</h2>
    <div class="row" style="flex-wrap:nowrap">
      <input type="text" id="code" maxlength="4" placeholder="KÓD" value="${esc(urlRoom)}" style="text-transform:uppercase;letter-spacing:.2em;font-weight:700">
      <button class="primary" data-act="join" style="flex:none">Připojit</button>
    </div>
    <div style="text-align:center;margin:14px 0 4px" class="muted">— nebo —</div>
    <button data-act="create" style="width:100%">Založit novou hru</button>
  </div>
  <div class="box">
    <h2>Jak to funguje</h2>
    <p class="muted" style="margin:0;font-size:14px;line-height:1.5">Jeden z vás založí hru a pošle ostatním odkaz nebo 4písmenný kód. Každý vidí jen svoje karty (a jen ty, na které se smí podívat). Když vám spadne spojení, stačí stránku otevřít znovu — vrátíte se na své místo.</p>
  </div>`;
}

// ---------------- lobby ----------------
function lobbyHTML() {
  const isHost = S.hostId === S.me;
  const link = location.origin + '/?r=' + S.code;
  const players = S.players.map(p => `
    <li><span class="dot ${p.connected ? '' : 'off'}"></span>
      <span>${esc(p.name)}${p.id === S.me ? ' <span class="muted">(ty)</span>' : ''}</span>
      ${p.id === S.hostId ? '<span class="badge">zakladatel</span>' : ''}
      <span class="spacer"></span>
      ${isHost && p.id !== S.me ? `<button class="small" data-act="kick" data-id="${p.id}">Odebrat</button>` : ''}
    </li>`).join('');
  return `
  <div class="logo"><h1 style="font-size:40px">KAB<span class="moon" style="width:30px;height:30px"></span></h1></div>
  <div class="box stack">
    <div class="muted" style="text-align:center">Kód místnosti</div>
    <div class="code-big">${S.code}</div>
    <div class="row" style="justify-content:center">
      <button class="small" data-act="copy" data-link="${esc(link)}">📋 Kopírovat odkaz</button>
      ${navigator.share ? `<button class="small" data-act="share" data-link="${esc(link)}">Sdílet…</button>` : ''}
    </div>
  </div>
  <div class="box">
    <h2>Hráči (${S.players.length}/6)</h2>
    <ul class="players-list">${players}</ul>
    <div style="margin-top:14px">
      <label class="check"><input type="checkbox" data-act="memoryAid" ${S.settings.memoryAid ? 'checked' : ''} ${isHost ? '' : 'disabled'}>
        <span>Nápověda paměti<br><span class="muted" style="font-size:12px">Karty, které jsi už viděl(a), zůstanou poloprůhledně odkryté. Podle pravidel si je máte pamatovat — doporučeno vypnuté.</span></span></label>
    </div>
    <div style="margin-top:12px">
      <label class="check"><input type="checkbox" data-act="discardFaceDown" ${S.settings.discardFaceDown !== false ? 'checked' : ''} ${isHost ? '' : 'disabled'}>
        <span>Karta z odhazovací hromádky se pokládá lícem dolů<br><span class="muted" style="font-size:12px">Ostatní si ji musí zapamatovat. Vypnuto = oficiální pravidlo (lícem nahoru).</span></span></label>
    </div>
    <div class="row" style="margin-top:16px">
      ${isHost
        ? `<button class="primary" data-act="start" ${S.players.length < 2 ? 'disabled' : ''} style="flex:1">${S.players.length < 2 ? 'Čekáme na hráče…' : 'Začít hru'}</button>`
        : `<div class="muted" style="flex:1">Čekáme, až zakladatel spustí hru…</div>`}
      <button data-act="leave">Odejít</button>
    </div>
  </div>`;
}

// ---------------- game ----------------
function gameHTML() {
  const g = S.game, me = S.me;
  const myTurn = g.phase === 'play' && g.turnPid === me;
  const idx = g.order.indexOf(me);
  const opps = idx >= 0 ? [...g.order.slice(idx + 1), ...g.order.slice(0, idx)] : g.order;
  const connected = Object.fromEntries(S.players.map(p => [p.id, p.connected]));
  const N = id => esc(g.names[id] || '?');

  // what can be clicked
  const myCardAct = c => {
    if (g.phase === 'peek' && !g.peekReady[me] && g.peekChosen < 2 && c.v === undefined) return 'peekCard';
    if (!myTurn) return null;
    if (g.step === 'drawn') return 'selCard';
    if (g.step === 'effect' && g.effect === 'peek' && !c.up) return 'effCard';
    if (g.step === 'effect' && g.effect === 'swap') return 'swapMine';
    return null;
  };
  const oppCardAct = c => {
    if (!myTurn || g.step !== 'effect') return null;
    if (g.effect === 'spy' && !c.up) return 'effCard';
    if (g.effect === 'swap') return 'swapOther';
    return null;
  };

  const badges = pid => {
    let b = '';
    if (g.phase === 'play' && g.turnPid === pid) b += '<span class="badge">na tahu</span>';
    if (g.kaboBy === pid) b += '<span class="badge kabo">KABO</span>';
    if (g.phase === 'peek' && g.peekReady[pid]) b += '<span class="badge ready">✓</span>';
    if (connected[pid] === false) b += '<span class="badge off">offline</span>';
    return b;
  };
  const ended = g.phase === 'roundEnd' || g.phase === 'gameEnd';

  const oppHTML = opps.map(pid => {
    const cards = g.hands[pid].map(c => {
      const a = oppCardAct(c);
      return cardHTML(c, { act: a, clickable: !!a, markUp: !ended, selected: ui.swapOther === c.id });
    }).join('');
    return `<div class="opp ${g.turnPid === pid ? 'turn' : ''}">
      <div class="pname"><span>${N(pid)}</span>${badges(pid)}<span class="total">${g.totals[pid]} b.</span></div>
      <div class="hand">${cards}</div></div>`;
  }).join('');

  const myCards = (g.hands[me] || []).map(c => {
    const a = myCardAct(c);
    return cardHTML(c, {
      act: a, clickable: !!a, markUp: !ended,
      selected: ui.sel.has(c.id) || ui.swapMine === c.id,
    });
  }).join('');

  // center table
  const canDraw = myTurn && g.step === 'choose';
  const deckCard = g.deckCount
    ? `<div class="card back ${canDraw ? 'clickable' : ''}" ${canDraw ? 'data-act="drawDeck"' : ''}></div>`
    : `<div class="empty-slot">prázdný</div>`;
  const discardCard = g.discardTop
    ? cardHTML(g.discardTop, { act: canDraw ? 'drawDiscard' : null, clickable: canDraw })
    : `<div class="empty-slot">prázdná</div>`;
  let drawnHTML = '';
  if (g.drawn) {
    drawnHTML = `<div class="pile drawn-wrap">${cardHTML({ id: g.drawn.id, v: g.drawn.v })}<span>${g.turnPid === me ? 'tvoje karta' : 'drží ' + N(g.turnPid)}</span></div>`;
  }

  // status + actions
  let msg = '', btns = '';
  const turnName = `<b>${N(g.turnPid)}</b>`;
  if (g.phase === 'peek') {
    if (!g.peekReady[me]) {
      msg = g.peekChosen < 2
        ? `Kolo ${g.round}: klikni na <b>${2 - g.peekChosen}</b> ${g.peekChosen === 1 ? 'další svou kartu' : 'své karty'} a zapamatuj si je. Pak už je neuvidíš!`
        : 'Zapamatuj si je a potvrď. Jakmile potvrdíš, karty se otočí zpět.';
      btns = `<button class="primary" data-act="peekDone" ${g.peekChosen < 2 ? 'disabled' : ''}>Zapamatováno ✓</button>`;
    } else {
      const waiting = g.order.filter(p => !g.peekReady[p]).map(N).join(', ');
      msg = `Čekáme, až se podívají: ${waiting}`;
    }
  } else if (g.phase === 'play') {
    if (myTurn) {
      if (g.step === 'choose') {
        msg = '<b>Jsi na tahu!</b> Lízni z balíčku, vezmi kartu z odhazovací hromádky, nebo zvolej Kabo.';
        btns = `<button class="primary" data-act="drawDeck">Líznout z balíčku</button>
                <button data-act="drawDiscard" ${g.discardTop ? '' : 'disabled'}>Vzít ${g.discardTop ? g.discardTop.v : ''} z hromádky</button>
                ${g.kaboBy ? '' : '<button class="kabo" data-act="kabo">KABO!</button>'}`;
      } else if (g.step === 'drawn') {
        const v = g.drawn.v;
        const n = ui.sel.size;
        const eff = EFF[v];
        msg = g.drawn.from === 'deck'
          ? `Lízl(a) jsi <b>${v}</b>. Klikni na svou kartu (nebo víc karet se <b>stejnou</b> hodnotou), za kterou ji vyměníš — nebo ji odhoď${eff ? ` a použij efekt <b>${eff}</b>` : ''}.`
          : `Vzal(a) jsi <b>${v}</b>. Klikni na svou kartu (nebo víc karet se <b>stejnou</b> hodnotou), za kterou ji vyměníš. Položí se lícem ${g.settings.discardFaceDown ? 'dolů' : 'nahoru'}.`;
        btns = `<button class="primary" data-act="doSwap" ${n ? '' : 'disabled'}>Vyměnit${n > 1 ? ` ${n} karty` : ''}</button>`
          + (g.drawn.from === 'deck'
            ? `<button data-act="discard">Odhodit${eff ? ' + ' + eff : ''}</button>`
            : `<button data-act="undoDiscard">Vrátit zpět</button>`);
        if (n > 1) msg += `<br><span class="muted">${n < 5 ? `Vybrány ${n} karty` : `Vybráno ${n} karet`} —pokud nebudou stejné, zůstanou lícem nahoru${n >= 3 ? ' a dostaneš trestnou kartu' : ''}.</span>`;
      } else if (g.step === 'effect') {
        if (g.effect === 'peek') msg = '<b>KUK:</b> klikni na svou kartu ležící lícem dolů a podívej se na ni.';
        if (g.effect === 'spy') msg = '<b>ŠPION:</b> klikni na kartu soupeře ležící lícem dolů.';
        if (g.effect === 'swap') {
          msg = '<b>KŠEFT:</b> vyber jednu svou kartu a jednu kartu soupeře — vymění se naslepo.';
          btns = `<button class="primary" data-act="doTrade" ${ui.swapMine && ui.swapOther ? '' : 'disabled'}>Vyměnit</button>`;
        }
        btns += '<button data-act="skipEffect">Nepoužít efekt</button>';
      } else if (g.step === 'effectResult') {
        msg = 'Zapamatuj si kartu (zeleně orámovaná) a pokračuj.';
        btns = '<button class="primary" data-act="ack">Zapamatováno ✓</button>';
      }
    } else {
      if (g.step === 'choose') msg = `Na tahu je ${turnName}.`;
      else if (g.step === 'drawn') msg = g.drawn.from === 'deck' ? `${turnName} si lízl(a) kartu a rozmýšlí se…` : `${turnName} si vzal(a) ${g.drawn.v} z hromádky a vybírá, co vymění…`;
      else if (g.step === 'effect') msg = `${turnName} používá efekt <b>${EFF_FULL[g.effect]}</b>…`;
      else if (g.step === 'effectResult') msg = `${turnName} si prohlíží kartu…`;
    }
  } else if (ended) {
    msg = g.phase === 'gameEnd' ? `🏆 Konec hry — vítězí <b>${N(g.winnerId)}</b>!` : `Konec kola ${g.round}.`;
    btns = '<button data-act="showResult">Zobrazit výsledky</button>';
  }

  const kaboBanner = g.kaboBy && g.phase === 'play'
    ? `<div class="kabo-banner">📣 ${N(g.kaboBy)} zvolal(a) KABO! Zbývá ${g.turnsLeft} ${g.turnsLeft === 1 ? 'tah' : g.turnsLeft < 5 ? 'tahy' : 'tahů'}.</div>` : '';

  const log = g.log.map(l => `<div>${esc(l.text)}</div>`).join('');
  const chat = ui.chat.map(m => `<div><b>${esc(m.name)}:</b> ${esc(m.text)}</div>`).join('') || '<div class="muted">Zatím nic.</div>';

  return `
  <div class="topbar">
    <span class="brand">KABO</span>
    <span class="chip">Místnost <b>${S.code}</b></span>
    <span class="chip">Kolo <b>${g.round}</b></span>
    <span class="chip">Balíček <b>${g.deckCount}</b></span>
    <span class="spacer"></span>
    <button class="small" data-act="scores">Skóre</button>
  </div>
  <div class="opponents ${opps.length === 1 ? 'one' : ''}">${oppHTML}</div>
  ${kaboBanner}
  <div class="table">
    <div class="pile">${deckCard}<span>balíček</span></div>
    <div class="pile">${discardCard}<span>odhazovací</span></div>
    ${drawnHTML}
  </div>
  <div class="status"><div class="msg">${msg}</div><div class="actions">${btns}</div></div>
  <div class="me ${myTurn ? 'turn' : ''}">
    <div class="pname"><span>${N(me)} (ty)</span>${badges(me)}<span class="total">${g.totals[me]} b.</span></div>
    <div class="hand">${myCards}</div>
  </div>
  <div class="bottom">
    <div class="panel"><h3>Průběh</h3><div class="log">${log}</div></div>
    <div class="panel"><h3>Chat</h3><div class="chatlog">${chat}</div>
      <form class="row" data-form="chat" style="flex-wrap:nowrap"><input type="text" id="chatInput" maxlength="200" placeholder="Napiš zprávu…" autocomplete="off"><button class="small" type="submit" style="min-height:44px">Poslat</button></form>
    </div>
  </div>
  ${ended && !ui.hideResult ? resultHTML() : ''}
  ${ui.showScores ? scoresHTML() : ''}`;
}

function resultHTML() {
  const g = S.game, r = g.roundResult;
  if (!r) return '';
  const isHost = S.hostId === S.me;
  const rows = g.order.map(pid => `
    <tr class="${g.phase === 'gameEnd' && pid === g.winnerId ? 'win' : ''}">
      <td>${esc(g.names[pid])}${pid === r.kaboBy ? ' <span class="badge kabo">KABO</span>' : ''}<div class="result-hand">${g.hands[pid].map(c => cardHTML(c)).join('')}</div></td>
      <td>${r.sums[pid]}</td>
      <td><b>${r.scores[pid]}</b>${r.notes[pid] ? `<div class="note">${esc(r.notes[pid])}</div>` : ''}</td>
      <td><b>${g.totals[pid]}</b></td>
    </tr>`).join('');
  const head = g.phase === 'gameEnd'
    ? `🏆 Vítězí ${esc(g.names[g.winnerId])}!`
    : `Konec kola ${g.round}`;
  const btn = g.phase === 'gameEnd'
    ? (isHost ? '<button class="primary" data-act="toLobby">Nová hra</button>' : '<span class="muted">Novou hru spustí zakladatel.</span>')
    : '<button class="primary" data-act="nextRound">Další kolo</button>';
  return `<div class="overlay"><div class="modal">
    <h2>${head}</h2>
    ${r.kamikaze ? `<p><b>KAMIKAZE!</b> ${esc(g.names[r.kamikaze])} má dvě 12 a dvě 13 — ostatní dostávají 50.</p>` : ''}
    <table class="scores"><thead><tr><th>Hráč</th><th>Součet</th><th>Body</th><th>Celkem</th></tr></thead><tbody>${rows}</tbody></table>
    ${g.phase !== 'gameEnd' ? `<p class="note">Další kolo začíná ${esc(g.names[g.starterPid])}. Hra končí, když někdo přesáhne 100 bodů.</p>` : ''}
    <div class="actions">${btn}<button data-act="hideResult">Prohlédnout stůl</button></div>
  </div></div>`;
}

function scoresHTML() {
  const g = S.game;
  const head = g.order.map(p => `<th>${esc(g.names[p])}</th>`).join('');
  const rows = g.history.map(h => `<tr><td>Kolo ${h.round}</td>${g.order.map(p => `<td>${h.scores[p]}</td>`).join('')}</tr>`).join('');
  const tot = `<tr><td><b>Celkem</b></td>${g.order.map(p => `<td><b>${g.totals[p]}</b>${g.usedReset[p] ? '<div class="note">odpis použit</div>' : ''}</td>`).join('')}</tr>`;
  return `<div class="overlay" data-act="closeScores"><div class="modal" data-stop="1">
    <h2>Skóre</h2>
    <table class="scores"><thead><tr><th></th>${head}</tr></thead><tbody>${rows || ''}${tot}</tbody></table>
    <p class="note">Hra končí, když někdo přesáhne 100 bodů. Kdo má přesně 100, spadne jednou za hru na 50.</p>
    <div class="actions"><button data-act="closeScores">Zavřít</button></div>
  </div></div>`;
}

// ---------------- input ----------------
function nameValue() {
  const el = document.getElementById('name');
  const n = (el ? el.value : store.get('kabo.name') || '').trim();
  if (n) store.set('kabo.name', n);
  return n;
}

$app.addEventListener('submit', e => {
  e.preventDefault();
  if (e.target.dataset.form === 'chat') {
    const inp = document.getElementById('chatInput');
    if (inp.value.trim()) socket.emit('chat', { text: inp.value });
    inp.value = '';
  }
});

$app.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'code') $app.querySelector('[data-act="join"]').click();
});

$app.addEventListener('change', e => {
  if (e.target.dataset.act === 'memoryAid') socket.emit('settings', { memoryAid: e.target.checked });
  if (e.target.dataset.act === 'discardFaceDown') socket.emit('settings', { discardFaceDown: e.target.checked });
});

$app.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.dataset.act === 'closeScores' && e.target.closest('[data-stop]') && !e.target.closest('button')) return;
  const a = el.dataset.act, id = el.dataset.id;
  const g = S && S.game;
  switch (a) {
    case 'create': {
      const name = nameValue();
      if (!name) return toast('Nejdřív zadej jméno.');
      socket.emit('create', { name, token });
      break;
    }
    case 'join': {
      const name = nameValue();
      const code = (document.getElementById('code').value || '').trim().toUpperCase();
      if (!name) return toast('Nejdřív zadej jméno.');
      if (code.length !== 4) return toast('Kód má 4 písmena.');
      socket.emit('join', { code, name, token });
      break;
    }
    case 'copy':
      navigator.clipboard.writeText(el.dataset.link).then(() => toast('Odkaz zkopírován.', 'info'), () => toast(el.dataset.link, 'info'));
      break;
    case 'share':
      navigator.share({ title: 'Kabo', text: 'Pojď hrát Kabo!', url: el.dataset.link }).catch(() => {});
      break;
    case 'kick': socket.emit('kick', { pid: id }); break;
    case 'start': socket.emit('start'); break;
    case 'leave': socket.emit('leave'); S = null; store.del('kabo.room'); history.replaceState(null, '', AS ? '?as=' + AS : '/'); render(); break;
    case 'toLobby': socket.emit('toLobby'); break;
    case 'nextRound': socket.emit('nextRound'); break;
    case 'peekCard': act('peekChoose', { cardId: id }); break;
    case 'peekDone': act('peekDone'); break;
    case 'drawDeck': act('drawDeck'); break;
    case 'drawDiscard': act('drawDiscard'); break;
    case 'undoDiscard': act('undoDiscard'); break;
    case 'kabo':
      if (confirm('Opravdu zvolat KABO? Ostatní budou mít ještě po jednom tahu.')) act('kabo');
      break;
    case 'discard': act('discard'); break;
    case 'selCard':
      if (ui.sel.has(id)) ui.sel.delete(id); else ui.sel.add(id);
      render();
      break;
    case 'doSwap': {
      if (!ui.sel.size) return;
      act('swap', { cardIds: [...ui.sel] });
      break;
    }
    case 'effCard': act('effect', { cardId: id }); break;
    case 'swapMine': ui.swapMine = ui.swapMine === id ? null : id; render(); break;
    case 'swapOther': ui.swapOther = ui.swapOther === id ? null : id; render(); break;
    case 'doTrade': act('effect', { myCardId: ui.swapMine, otherCardId: ui.swapOther }); break;
    case 'skipEffect': act('skipEffect'); break;
    case 'ack': act('ack'); break;
    case 'scores': ui.showScores = true; render(); break;
    case 'closeScores': ui.showScores = false; render(); break;
    case 'showResult': ui.hideResult = false; render(); break;
    case 'hideResult': ui.hideResult = true; render(); break;
  }
});

render();
