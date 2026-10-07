'use strict';
/* 7 Wonders — client web.
   HÔTE : le moteur Python tourne dans son navigateur (Pyodide) ; il garde la partie et envoie à chacun ce qu'il doit voir.
   AMIS : ils se connectent à l'hôte par WebRTC (PeerJS, code de salon) et n'exécutent aucune règle. */
const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js';
const PEERJS = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
const ROMAN = { 1: 'I', 2: 'II', 3: 'III' };
const RC = { B: '#8a5a2b', P: '#9ea3a8', A: '#d2693c', M: '#454b55', V: '#7fd0ee', Y: '#e0cb86', T: '#b06ad6', $: '#f1c40f' };
const SCORE_COLS = ['Militaire', 'Pièces', 'Merveille', 'Civil', 'Commerce', 'Science', 'Guildes', 'Total'];

let ST = null;     // static.json : cartes, cités, couleurs, règles
let bridge = null; // module Python sevenwonders.web (hôte seulement)
const S = { role: null, name: 'Joueur', started: false, peer: null, conn: null, code: '', peers: [], mySeat: 0, seatConn: {}, humanSeats: [], msg: null };
const U = { sel: null, first: null, key: '', plan: null };   // sélection en cours de l'utilisateur

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
const planSum = p => p[0] + p[1] + p[2];

/* ---------------------------------------------------------------- affichage (fonctions pures : données -> HTML) */
const ic = (k, t) => `<span class="ic" style="background:${RC[k]};color:${'PVY$'.includes(k) ? '#000' : '#fff'}">${t == null ? k : t}</span>`;

function costHTML(cost) {
  const c = [...cost], items = [...c.filter(x => x === '$'), ...c.filter(x => x !== '$')];
  return items.length ? items.map(k => ic(k, k === '$' ? '1' : k)).join('') : '<i>Gratuit</i>';
}

function effHTML(e, text) {
  const [k, a] = e;
  if (k === 'prod') return [...a].map(x => ic(x)).join('+');
  if (k === 'opt') return [...a].map(x => ic(x)).join('/');
  if (k === 'pv') return `<span class="pv">${a}</span>`;
  if (k === 'mil') return `<span class="mil">${a}</span>`;
  if (k === 'coin') return ic('$', '+' + a);
  if (k === 'sci') return `<span class="sci">${a === '*' ? '★' : a}</span>`;
  return `<small>${esc(text || '')}</small>`;
}

function cardHTML(name, attrs = '', cls = '') {
  const c = ST.cards[name];
  return `<div class="card ${cls}" ${attrs} title="${esc(c.text)}"><div class="ch ${c.color}" style="background:${ST.colors[c.color]}">${esc(name)}</div>` +
    `<div class="cc">${costHTML(c.cost)}</div><div class="ce">${effHTML(c.eff, c.text)}<br><small>${esc(c.text)}</small></div>` +
    (c.free.length ? `<div class="cf">Gratuit via ${esc(c.free.join(', '))}</div>` : '') + '</div>';
}

function boardHTML(p) {
  const city = ST.cities[p.city];
  const stages = city[p.side].map((s, k) => `<div class="stage ${k < p.stage ? 'done' : ''}"><b>Étape ${k + 1}${k < p.stage ? ' ✔' : ''}</b> ${costHTML(s.cost)} ➜ ` +
    `${s.eff.map(e => effHTML(e, s.text)).join(' ')}<small>${esc(s.text)}</small></div>`).join('');
  const chips = Object.keys(ST.colors).map(col => p.built.filter(n => ST.cards[n].color === col)
    .map(n => `<span class="chip ${col}" style="background:${ST.colors[col]}" title="${esc(ST.cards[n].text)}">${esc(n)}</span>`).join('')).join('');
  return `<h3 style="margin:4px 0">${esc(p.city)} — face ${p.side} ${ic(city.res)}</h3>${stages}<div class="chips">${chips}</div>`;
}

const pname = (V, i) => V.players[i].name || V.players[i].city;
const waitNames = V => V.waiting.map(i => esc(pname(V, i))).join(', ') || '…';

function playersHTML(V) {
  const n = V.players.length, you = V.you, l = (you + 1) % n, r = (you - 1 + n) % n;
  return V.players.map((p, i) => {
    const x = V.extras[i];
    const tag = p.franche ? 'CITÉ FRANCHE' : i === you ? 'VOUS' : i === l ? '◀ voisin gauche' : i === r ? 'voisin droit ▶' : '';
    const counts = {};
    p.built.forEach(c => { const col = ST.cards[c].color; counts[col] = (counts[col] || 0) + 1; });
    const chips = Object.keys(ST.colors).filter(c => counts[c]).map(c => `<span class="cnt" style="background:${ST.colors[c]}" title="${esc(ST.colorNames[c])}">${counts[c]}</span>`).join('');
    const sq = ST.cities[p.city][p.side].map((_, k) => `<i class="sq ${k < p.stage ? 'on' : ''}"></i>`).join('');
    const state = V.phase === 'over' ? '' : V.waiting.includes(i) ? ' ⏳' : V.submitted.includes(i) ? ' ✔' : '';
    return `<div class="pl ${i === you ? 'me' : ''}" data-seat="${i}"><span class="tag">${tag}</span>` +
      `<b>${esc(p.name || p.city)}</b>${p.name ? ` <small>(${esc(p.city)} ${p.side})</small>` : ''}${state}<br>` +
      `${ic('$', p.coins)} 🛡${x.shields} · jetons ${x.mil >= 0 ? '+' : ''}${x.mil} ${[...x.prod].slice(0, 6).map(k => ic(k)).join('')}<br>` +
      `${sq} ${chips}${x.score ? ` <span class="sc">≈ ${x.score.Total} pts</span>` : ''}</div>`;
  }).join('');
}

function headerHTML(V) {
  if (V.over) return 'PARTIE TERMINÉE';
  const way = V.two ? 'variante 2 joueurs' : V.age === 2 ? 'cartes vers la droite' : 'cartes vers la gauche';
  const force = S.role === 'host' ? V.waiting.filter(i => i !== S.mySeat).map(i => `<button class="alt" data-force="${i}">⚡ IA joue pour ${esc(pname(V, i))}</button>`).join('') : '';
  return `ÂGE ${ROMAN[V.age]} · ${V.extra ? '7e carte' : `Tour ${V.turn}/6`} · ${way}${force}`;
}

function logHTML(V) {
  const me = pname(V, V.you);
  return V.log.slice(-60).map(t => `<div class="${t.startsWith('===') ? 'age' : t.startsWith(me + ' :') ? 'me' : ''}">${esc(t)}</div>`).join('');
}

function handList(V) {
  const h = V.players[V.you].hand.slice();
  if (U.first) { const k = h.indexOf(U.first.name); if (k >= 0) h.splice(k, 1); }
  return h;
}

function handHTML(msg) {
  const V = msg.view;
  if (V.over) return '';
  return handList(V).map((n, k) => cardHTML(n, `data-k="${k}"`, k === U.sel ? 'sel' : '')).join('');
}

function planTxt(plans) {
  const t = planSum(plans.reduce((m, p) => planSum(p) < planSum(m) ? p : m));
  return t === 0 ? ' — gratuit' : ` — ${t} pièce(s)${plans.length > 1 ? ' · au choix' : ''}`;
}

function actionsHTML(msg) {
  const V = msg.view, o = msg.options;
  if (V.over) return '';
  if (!o.waiting) return `<p class="hint">${V.submitted.includes(V.you) ? '✔ Coup envoyé. ' : ''}En attente de : ${waitNames(V)}</p>`;
  if (o.phase === 'recup') return '<p class="hint">Halicarnasse : choisissez une carte de la défausse.</p>';
  const city = U.first ? 2 : V.you;
  if (U.sel === null) {
    return `<p class="hint">${o.phase === 'extra' ? 'Pouvoir de Babylone : jouez votre 7e carte. ' : o.plays === 2 ? (U.first ? 'Maintenant la carte de la CITÉ FRANCHE (Échap : annuler).' : 'Vous avez la carte Cité franche : choisissez d\'abord la carte de VOTRE cité, puis celle de la Cité franche.') : 'Cliquez sur une carte de votre main.'}</p>`;
  }
  const name = handList(V)[U.sel];
  const e = o.cards.find(c => c.city === city && c.name === name);
  if (!e) return '<p class="hint">Choix indisponible.</p>';
  const b = (act, label, plans) => `<button data-act="${act}" ${plans ? '' : 'disabled'}>${label}${plans ? planTxt(plans) : ' — impossible'}</button>`;
  return `<p class="hint">${city === 2 ? 'Cité franche — ' : ''}<b>${esc(name)}</b>${e.forced ? ' (chaînage obligatoire)' : ''}</p><div class="acts">` +
    b('build', 'Construire', e.build) + b('wonder', 'Merveille', e.wonder) + (e.free ? b('free', 'Gratuit (pouvoir)', e.free) : '') +
    `<button data-act="discard" class="red" ${e.discard ? '' : 'disabled'}>Défausser (+3 pièces)</button></div>`;
}

function rankingHTML(msg) {
  const rows = msg.ranking, V = msg.view;
  const tie = rows.length > 1 && rows[0].score.Total === rows[1].score.Total && rows[0].coins === rows[1].coins;
  const head = `<tr><th>#</th><th>Joueur</th>${SCORE_COLS.map(c => `<th>${c}</th>`).join('')}</tr>`;
  const body = rows.map((r, i) => `<tr${r.seat === V.you ? ' style="color:var(--gold)"' : ''}><td>${i + 1}</td><td>${esc(r.name)}<br><small>${esc(r.city)}</small></td>${SCORE_COLS.map(c => `<td>${r.score[c] ?? 0}</td>`).join('')}</tr>`).join('');
  return `<h2 style="color:var(--gold)">${tie ? 'Égalité parfaite !' : 'Vainqueur : ' + esc(rows[0].name)}</h2><table>${head}${body}</table>` +
    '<p style="font-size:12px">Égalité de points : le plus de pièces gagne.</p><button data-go="home">Retour au menu</button>';
}

function recupHTML(msg) {
  return '<h3 style="color:var(--gold)">Halicarnasse : construisez gratuitement une carte de la défausse</h3><div style="display:flex;flex-wrap:wrap;gap:8px">' +
    msg.options.recup.map(n => cardHTML(n, `data-recup="${esc(n)}"`)).join('') + '</div>';
}

/* ---------------------------------------------------------------- fenêtre modale et écrans */
function modal(html) { $('#modalin').innerHTML = html; $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; $('#modalin').innerHTML = ''; }
function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 4500); }
function show(id) { document.querySelectorAll('.screen').forEach(s => { s.hidden = s.id !== id; }); }

function renderGame(msg) {
  S.msg = msg;
  const V = msg.view, o = msg.options;
  const key = [V.age, V.turn, V.phase, o.waiting, o.plays || 0].join();
  if (key !== U.key) { U.key = key; U.sel = null; U.first = null; }
  $('#hdr').innerHTML = headerHTML(V);
  $('#players').innerHTML = playersHTML(V);
  $('#myboard').innerHTML = boardHTML(V.players[V.you]);
  const log = $('#log'); log.innerHTML = logHTML(V); log.scrollTop = log.scrollHeight;
  $('#hand').innerHTML = handHTML(msg);
  $('#actions').innerHTML = actionsHTML(msg);
  if (msg.ranking) modal(rankingHTML(msg));
  else if (o.waiting && o.phase === 'recup') modal(recupHTML(msg));
  else if (!U.plan) closeModal();
}

/* ---------------------------------------------------------------- choix de l'utilisateur */
const H = { askPlan: plans => new Promise(res => {   // (remplaçable dans les tests)
  U.plan = res;
  modal('<h3 style="color:var(--gold)">Comment payer ?</h3>' + plans.map((p, i) =>
    `<button data-plan="${i}" class="gold">${p[1]} au voisin de gauche, ${p[2]} au voisin de droite${p[0] ? `, ${p[0]} à la banque` : ''} (total ${planSum(p)})</button><br>`).join('') +
    '<button data-plan="-1" class="red">Annuler</button>');
  U.planList = plans;
}) };

async function choose(act) {
  const msg = S.msg, V = msg.view, o = msg.options, city = U.first ? 2 : V.you;
  const name = handList(V)[U.sel];
  const e = o.cards.find(c => c.city === city && c.name === name);
  if (!e) return;
  let plan = null;
  if (act === 'free') plan = [0, 0, 0];
  else if (act !== 'discard') {
    const plans = e[act];
    plan = plans.length === 1 ? plans[0] : await H.askPlan(plans);
    U.plan = null;
    if (!plan) { renderGame(S.msg); return; }
  }
  const a = { city, name, act, plan };
  if ((U.first ? 2 : 1) < (o.plays || 1)) { U.first = a; U.sel = null; renderGame(msg); return; }  // 2e carte : Cité franche
  if (o.phase === 'extra') send({ t: 'extra', act, plan });
  else send({ t: 'submit', acts: (U.first ? [U.first] : []).concat([a]) });
}

function send(m) {
  if (S.role === 'host') hostHandle(S.mySeat, m);
  else if (S.conn && S.conn.open) S.conn.send(m);
  else toast('Connexion perdue avec l\'hôte.');
}

/* ---------------------------------------------------------------- hôte : moteur Python (Pyodide) */
const loadScript = url => new Promise((ok, ko) => { const s = document.createElement('script'); s.src = url; s.onload = ok; s.onerror = () => ko(new Error('Chargement impossible : ' + url)); document.head.appendChild(s); });
const py_ = (fn, arg) => bridge[fn](JSON.stringify(arg));

async function loadEngine() {
  if (bridge) return;
  $('#boot').textContent = 'Chargement du moteur Python (quelques secondes, une seule fois)…';
  await loadScript(PYODIDE);
  const py = await loadPyodide();
  const bundle = await (await fetch('bundle.json')).json();
  for (const [path, text] of Object.entries(bundle)) {
    const full = '/app/' + path;
    py.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
    py.FS.writeFile(full, text);
  }
  py.runPython("import sys; sys.path.insert(0, '/app')");
  bridge = py.pyimport('sevenwonders.web');
  $('#boot').textContent = '';
}

function hostHandle(seat, m) {
  let r;
  try {
    if (m.t === 'submit') r = py_('submit_turn', { seat, acts: m.acts });
    else if (m.t === 'recup') r = py_('submit_recup', { seat, name: m.name });
    else if (m.t === 'extra') r = py_('submit_extra', { seat, act: m.act, plan: m.plan });
    else if (m.t === 'force' && seat === S.mySeat) r = py_('force_ai', { seat: m.seat });
    else return;
  } catch (err) { toast('Erreur du moteur : ' + (err && err.message || err)); return; }
  const res = JSON.parse(r);
  if (res.error) { if (seat === S.mySeat) toast(res.error); else notify(seat, { t: 'error', msg: res.error }); return; }
  afterChange();
}

const notify = (seat, m) => { const c = S.seatConn[seat]; if (c && c.open) c.send(m); };

function pushState(seat) {
  const msg = JSON.parse(py_('pack', { seat }));
  if (seat === S.mySeat) renderGame(msg); else notify(seat, { t: 'state', msg });
}
function afterChange() { S.humanSeats.forEach(pushState); }

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function uniqueNames(list) {
  const seen = {};
  list.forEach(s => { const base = s.name; seen[base] = (seen[base] || 0) + 1; if (seen[base] > 1) s.name = base + ' ' + seen[base]; });
}

function hostStart() {
  const nAi = +$('#nai').value, level = +$('#level').value;
  const seats = [{ name: S.name, human: true, who: 'me' }, ...S.peers.map(p => ({ name: p.name, human: true, who: p }))];
  for (let i = 0; i < nAi; i++) seats.push({ name: 'IA ' + (i + 1), human: false });
  if (seats.length < 2 || seats.length > 7) return toast('Il faut entre 2 et 7 joueurs au total (vous + amis + IA).');
  if ($('#shuffle').checked) shuffle(seats);
  uniqueNames(seats);
  const res = JSON.parse(py_('start', { seats: seats.map(s => ({ name: s.name, human: s.human })), level }));
  if (res.error) return toast(res.error);
  S.humanSeats = []; S.seatConn = {}; S.started = true;
  seats.forEach((s, i) => {
    if (s.human) S.humanSeats.push(i);
    if (s.who === 'me') S.mySeat = i; else if (s.who) { s.who.seat = i; S.seatConn[i] = s.who.conn; }
  });
  show('game'); afterChange();
}

/* ---------------------------------------------------------------- salon et réseau (PeerJS) */
const genCode = () => Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

function lobbyNames() { return [S.name, ...S.peers.map(p => p.name)]; }
function renderLobby(names) {
  $('#names').innerHTML = (names || lobbyNames()).map((n, i) => `<div>${i === 0 ? '👑 ' : '• '}${esc(n)}</div>`).join('');
  const host = S.role === 'host';
  $('#hostopts').hidden = !host; $('#waitmsg').hidden = host; $('#codebox').hidden = !S.code;
  if (S.code) { $('#code').textContent = S.code; $('#link').textContent = location.href.split('#')[0] + '#' + S.code; }
  if (host && !$('#nai').options.length) for (let i = 0; i <= 6; i++) $('#nai').add(new Option(i, i, false, i === 2));
}
function broadcastLobby() { S.peers.forEach(p => p.conn.open && p.conn.send({ t: 'lobby', names: lobbyNames() })); renderLobby(); }

function openHostPeer() {
  return new Promise((resolve, reject) => {
    const attempt = n => {
      const code = genCode(), peer = new Peer('sw7-' + code);
      peer.on('open', () => { S.peer = peer; S.code = code; peer.on('connection', onIncoming); peer.on('disconnected', () => peer.reconnect()); resolve(code); });
      peer.on('error', err => { if (err.type === 'unavailable-id' && n < 5) attempt(n + 1); else reject(err); });
    };
    attempt(0);
  });
}

function onIncoming(conn) {
  const p = { conn, name: 'Ami', seat: null, joined: false };
  conn.on('data', m => {
    if (m.t === 'hello') {
      if (S.started || S.peers.length >= 6) { conn.send({ t: 'error', msg: 'Partie complète ou déjà commencée.' }); setTimeout(() => conn.close(), 400); return; }
      p.name = String(m.name || 'Ami').slice(0, 16); if (!p.joined) { p.joined = true; S.peers.push(p); }
      broadcastLobby();
    } else if (p.seat !== null) hostHandle(p.seat, m);
  });
  conn.on('close', () => {
    if (!p.joined) return;
    if (S.started && p.seat !== null) { py_('replace_ai', { seat: p.seat }); S.humanSeats = S.humanSeats.filter(s => s !== p.seat); toast(p.name + ' a quitté : une IA le remplace.'); afterChange(); }
    else { S.peers = S.peers.filter(x => x !== p); broadcastLobby(); }
  });
}

async function joinRoom(code) {
  await loadScript(PEERJS);
  const peer = new Peer(); S.peer = peer; S.role = 'client';
  const fail = msg => { leave(); toast(msg); };
  const timer = setTimeout(() => fail('Impossible de rejoindre : vérifiez le code.'), 15000);
  peer.on('error', err => { clearTimeout(timer); fail(err.type === 'peer-unavailable' ? 'Code introuvable.' : 'Erreur réseau : ' + err.type); });
  peer.on('open', () => {
    const conn = peer.connect('sw7-' + code, { reliable: true }); S.conn = conn;
    conn.on('open', () => { clearTimeout(timer); conn.send({ t: 'hello', name: S.name }); });
    conn.on('data', m => {
      if (m.t === 'lobby') { show('lobby'); renderLobby(m.names); }
      else if (m.t === 'state') { if (!S.started) { S.started = true; show('game'); } renderGame(m.msg); }
      else if (m.t === 'error') toast(m.msg);
    });
    conn.on('close', () => { if (S.role === 'client') { toast('Connexion perdue avec l\'hôte.'); leave(); } });
  });
}

function leave() {
  try { if (S.conn) S.conn.close(); if (S.peer) S.peer.destroy(); } catch (e) { /* ignoré */ }
  Object.assign(S, { role: null, started: false, peer: null, conn: null, code: '', peers: [], seatConn: {}, humanSeats: [], msg: null });
  U.sel = U.first = null; U.key = '';
  closeModal(); show('home');
}

/* ---------------------------------------------------------------- événements */
async function onClick(ev) {
  const t = ev.target, q = sel => t.closest(sel);
  let el;
  if ((el = q('[data-go]'))) return go(el.dataset.go);
  if ((el = q('[data-k]'))) { U.sel = +el.dataset.k; return renderGame(S.msg); }
  if ((el = q('[data-act]'))) return choose(el.dataset.act);
  if ((el = q('[data-plan]'))) { const i = +el.dataset.plan, res = U.plan; U.plan = null; closeModal(); return res && res(i >= 0 ? U.planList[i] : null); }
  if ((el = q('[data-recup]'))) return send({ t: 'recup', name: el.dataset.recup });
  if ((el = q('[data-force]'))) return send({ t: 'force', seat: +el.dataset.force });
  if ((el = q('.pl[data-seat]'))) { const p = S.msg.view.players[+el.dataset.seat]; return modal(boardHTML(p) + '<button data-close>Fermer</button>'); }
  if (q('[data-close]')) closeModal();
}

async function go(what) {
  S.name = ($('#name').value.trim() || 'Joueur').slice(0, 16); localStorage.setItem('sw7name', S.name);
  if (!ST) return toast(location.protocol === 'file:' ? 'Lancez le site avec lancer_site.bat (voir LISEZMOI_WEB.txt) : le navigateur bloque l\'ouverture directe du fichier.' : 'Données du jeu non chargées : rechargez la page.');
  try {
    if (what === 'rules') { $('#rulestxt').textContent = ST.rules; return show('rules'); }
    if (what === 'home') return leave();
    if (what === 'solo' || what === 'host') {
      await loadEngine(); S.role = 'host'; S.code = '';
      if (what === 'host') { $('#boot').textContent = 'Création du salon…'; await loadScript(PEERJS); await openHostPeer(); $('#boot').textContent = ''; }
      show('lobby'); renderLobby();
    }
    if (what === 'join') {
      const code = $('#joincode').value.trim().toUpperCase();
      if (code.length !== 5) return toast('Entrez le code à 5 caractères.');
      await joinRoom(code);
    }
    if (what === 'start') hostStart();
  } catch (err) { $('#boot').textContent = ''; toast('Erreur : ' + (err && err.message || err)); }
}

async function init() {
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && U.first && S.msg) { U.first = null; U.sel = null; renderGame(S.msg); } });
  $('#name').value = localStorage.getItem('sw7name') || '';
  if (location.hash.length === 6) $('#joincode').value = location.hash.slice(1);
  try { ST = await (await fetch('static.json')).json(); }
  catch (e) { $('#boot').textContent = location.protocol === 'file:' ? 'Ouvrez le jeu avec un serveur (voir LISEZMOI_WEB.txt), pas en double-cliquant sur le fichier.' : 'Impossible de charger static.json.'; }
}

if (typeof document !== 'undefined') init();
if (typeof module !== 'undefined') module.exports = { cardHTML, boardHTML, playersHTML, headerHTML, logHTML, handHTML, actionsHTML, rankingHTML, recupHTML, costHTML, effHTML, planTxt, renderGame, choose, hostHandle, S, U, H, setStatic: s => { ST = s; }, setBridge: b => { bridge = b; } };
