const express = require('express'), http = require('http'), crypto = require('crypto'), { Server } = require('socket.io');
const { CHO } = require('./questions');
const app = express(), srv = http.createServer(app);
const io = new Server(srv, { pingInterval: 10000, pingTimeout: 25000 });
app.use(express.static('public'));

// ── 설정: 필요하면 숫자만 바꾸세요 ──
const QSEC = 7;                                        // 초성 문제당 제한시간(초)
const RACE_POINTS = i => Math.max(100 - i * 3, 10);    // 달리기 순위별 점수: 1등 100점, 이후 3점씩 감소, 최소 10점

const S = { phase: 'idle', teams: ['1팀', '2팀', '3팀', '4팀', '5팀'], players: {}, deck: [], qn: 0, q: null,
  qStart: 0, correct: {}, raceSec: 10, raceStart: 0, timer: null, gen: 0 };
const norm = s => String(s).replace(/\s/g, '').toLowerCase();
const shown = a => a.filter(x => !x.startsWith('~')).join(' / ');
const list = () => Object.values(S.players);
const ranked = () => { const o = list().sort((a, b) => b.score - a.score); o.forEach((p, i) => p.rank = i + 1); return o; };
const free = () => ['idle', 'quizEnd', 'raceEnd'].includes(S.phase);
const shuffle = a => a.map(x => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(p => p[1]);
const teamStats = () => S.teams.map(t => {
  const m = list().filter(p => p.team === t), n = m.length;
  return { team: t, n, score: n ? Math.round(m.reduce((a, p) => a + p.score, 0) / n) : 0,
    taps: n ? Math.round(m.reduce((a, p) => a + p.taps, 0) / n * 10) / 10 : 0 };
});
const phaseView = () => ({
  phase: S.phase, teams: S.teams, qn: S.qn, sec: QSEC,
  q: S.phase === 'quiz' ? { hint: S.q.hint, q: S.q.q } : null,
  left: S.phase === 'quiz' ? Math.max(QSEC * 1000 - (Date.now() - S.qStart), 0) : 0,
});

let pushedAt = 0;
function push(force) {
  const now = Date.now(); if (!force && now - pushedAt < 400) return; pushedAt = now;
  const o = ranked(), inQ = S.phase === 'quiz', hasQ = inQ || S.phase === 'quizEnd';
  io.to('admin').emit('admin', {
    phase: S.phase, qn: S.qn, sec: QSEC, raceSec: S.raceSec,
    q: hasQ ? { hint: S.q.hint, q: S.q.q, answer: inQ ? null : shown(S.q.a) } : null,
    left: inQ ? Math.max(QSEC * 1000 - (now - S.qStart), 0) : 0,
    raceLeft: S.phase === 'race' ? Math.max(S.raceSec * 1000 - (now - S.raceStart), 0) : 0,
    correctN: Object.keys(S.correct).length,
    online: o.filter(p => p.sid).length, total: o.length,
    teams: teamStats(),
    board: o.slice(0, 200).map(p => ({ id: p.id, name: p.name, team: p.team, score: p.score, on: !!p.sid })),
    raceTop: list().filter(p => p.taps > 0).sort((a, b) => b.taps - a.taps).slice(0, 8).map(p => ({ name: p.name, team: p.team, taps: p.taps })),
  });
}
setInterval(() => push(true), 1000);

function nextQ() {
  if (!free()) return;
  if (!S.deck.length) S.deck = shuffle(CHO);
  const c = S.deck.pop();
  S.q = { hint: c[0], q: c[1], a: c[2] }; S.qn++; S.correct = {}; S.qStart = Date.now(); S.phase = 'quiz';
  const g = ++S.gen;
  io.emit('phase', phaseView()); push(true);
  clearTimeout(S.timer); S.timer = setTimeout(() => { if (g === S.gen) endQ(); }, QSEC * 1000);
}
function endQ() {
  S.phase = 'quizEnd';
  const o = ranked(), answer = shown(S.q.a);
  o.forEach(p => p.sid && io.to(p.sid).emit('reveal', { answer, gained: S.correct[p.id] || 0, score: p.score, rank: p.rank, total: o.length }));
  push(true);
}
function startRace(sec) {
  if (!free()) return;
  S.raceSec = [10, 15, 20, 30].includes(sec) ? sec : 10;
  list().forEach(p => { p.taps = 0; p.last = 0; });
  const g = ++S.gen;
  S.phase = 'raceCount'; io.emit('phase', phaseView()); push(true);
  [3, 2, 1].forEach((n, i) => setTimeout(() => { if (g === S.gen) io.emit('count', n); }, i * 1000));
  clearTimeout(S.timer);
  S.timer = setTimeout(() => {
    if (g !== S.gen) return;
    S.phase = 'race'; S.raceStart = Date.now(); io.emit('phase', phaseView()); push(true);
    S.timer = setTimeout(() => { if (g === S.gen) endRace(); }, S.raceSec * 1000);
  }, 3000);
}
function endRace() {
  S.phase = 'raceEnd';
  const order = list().filter(p => p.taps > 0).sort((a, b) => b.taps - a.taps), gain = {};
  order.forEach((p, i) => { gain[p.id] = RACE_POINTS(i); p.score += gain[p.id]; });
  const o = ranked();
  o.forEach(p => p.sid && io.to(p.sid).emit('raceEnd', {
    taps: p.taps, gained: gain[p.id] || 0, raceRank: order.findIndex(x => x.id === p.id) + 1,
    score: p.score, rank: p.rank, total: o.length }));
  push(true);
}
function stop() { S.gen++; clearTimeout(S.timer); S.phase = 'idle'; io.emit('phase', phaseView()); push(true); }

const fails = {};
io.on('connection', s => {
  let me = null;
  s.emit('phase', phaseView());

  s.on('hello', (d, cb) => {
    d = d || {};
    const id = String(d.id || '').slice(0, 40); if (!id) return;
    let p = S.players[id];
    if (!p) {
      const name = String(d.name || '').trim().slice(0, 8);
      if (!name) return cb({ err: '이름을 입력해 주세요.' });
      if (!S.teams.includes(d.team)) return cb({ err: '팀을 골라 주세요.' });
      p = S.players[id] = { id, name, team: d.team, score: 0, taps: 0, last: 0 };
    }
    p.sid = s.id; me = p;
    cb({ ok: 1, name: p.name, team: p.team, score: p.score });
    s.emit('phase', phaseView());
    push();
  });
  s.on('answer', (t, cb) => {
    if (!me || S.phase !== 'quiz' || S.correct[me.id] || typeof cb !== 'function') return;
    const el = Date.now() - S.qStart; if (el > QSEC * 1000 + 300) return;
    if (!S.q.a.some(a => norm(a.replace(/^~/, '')) === norm(t))) return cb(false);
    const g = 50 + Math.round(50 * Math.max(QSEC * 1000 - el, 0) / (QSEC * 1000));
    me.score += g; S.correct[me.id] = g; cb(g); push();
  });
  s.on('tap', n => {
    if (!me || S.phase !== 'race') return;
    const now = Date.now(), max = Math.ceil((now - (me.last || now - 300)) / 66);
    me.last = now; me.taps += Math.max(0, Math.min(Number(n) | 0, max, 30)); push();
  });
  s.on('disconnect', () => { if (me && me.sid === s.id) { me.sid = null; push(); } });

  s.on('auth', (pw, cb) => {
    const want = process.env.ADMIN_PASSWORD;
    if (!want) return cb({ err: '서버에 ADMIN_PASSWORD가 설정되지 않았어요.' });
    const key = String(s.handshake.headers['x-forwarded-for'] || s.handshake.address || '').split(',')[0].trim();
    const f = fails[key] = fails[key] || { n: 0, t: Date.now() };
    if (Date.now() - f.t > 6e5) { f.n = 0; f.t = Date.now(); }
    if (f.n >= 10) return cb({ err: '시도가 너무 많아요. 10분 뒤에 다시 해 주세요.' });
    const h = x => crypto.createHash('sha256').update(String(x)).digest();
    if (!crypto.timingSafeEqual(h(pw), h(want))) { f.n++; return cb({ err: '비밀번호가 맞지 않아요.' }); }
    s.isAdmin = true; s.join('admin'); cb({ ok: 1 }); push(true);
  });
  const A = (ev, fn) => s.on(ev, (...a) => { if (s.isAdmin) fn(...a); });
  A('nextQ', nextQ);
  A('race', sec => startRace(Number(sec)));
  A('stop', stop);
  A('teams', str => {
    const t = [...new Set(String(str).split(/[,\n]/).map(x => x.trim().slice(0, 8)).filter(Boolean))].slice(0, 12);
    if (!t.length) return;
    S.teams = t;
    list().forEach(p => { if (!t.includes(p.team)) { p.team = t[0]; p.sid && io.to(p.sid).emit('profile', { team: p.team }); } });
    io.emit('phase', phaseView()); push(true);
  });
  A('resetScores', () => { list().forEach(p => { p.score = 0; p.taps = 0; }); S.qn = 0; push(true); });
  A('kick', id => { const p = S.players[id]; if (p) { p.sid && io.to(p.sid).emit('kicked'); delete S.players[id]; push(true); } });
  A('resetAll', () => { list().forEach(p => p.sid && io.to(p.sid).emit('kicked')); S.players = {}; S.qn = 0; stop(); });
});

srv.listen(process.env.PORT || 3000, () => console.log('열렸어요 → http://localhost:' + (process.env.PORT || 3000)));
