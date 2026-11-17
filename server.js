const express = require('express'), http = require('http'), crypto = require('crypto'), { Server } = require('socket.io');
const { CHO } = require('./questions');
const app = express(), srv = http.createServer(app);
const io = new Server(srv, { pingInterval: 10000, pingTimeout: 25000 });
app.use(express.static('public'));

// ── 설정: 필요하면 숫자만 바꾸세요 ──
const QSEC = 7;                      // 초성 문제당 제한시간(초)
const QUIZ_MAX = 0;                  // 0이면 questions.js 전체 출제, 숫자면 위에서부터 그 개수만 (리허설할 때 5 등으로)
const GOAL_PER_SEC = 6;              // 달리기: 결승선에 닿는 터치 속도(1인당 초당 횟수). 낮추면 더 쉽게 골인
const TEAM_AVG = false;              // false: 팀원 터치 수 "합산" / true: 팀원 "평균" (인원이 다른 팀끼리 공정하게)
const TAP_POINT = 1;                 // 달리기: 터치 1번당 개인 점수
const TEAM_BONUS = [100, 70, 50];    // 달리기: 팀 순위 보너스 (1·2·3등 팀의 참가자 모두에게)
const TEAM_BONUS_REST = 30;          // 달리기: 4등 이하 팀의 보너스

const QS = QUIZ_MAX ? CHO.slice(0, QUIZ_MAX) : CHO;
const S = { phase: 'idle', teams: ['1팀', '2팀', '3팀', '4팀', '5팀'], players: {}, qi: 0, qn: 0, q: null,
  qStart: 0, correct: {}, raceSec: 10, raceStart: 0, raceRes: [], timer: null, gen: 0 };
const norm = s => String(s).replace(/\s/g, '').toLowerCase();
const shown = a => a.filter(x => !x.startsWith('~')).join(' / ');
const list = () => Object.values(S.players);
const ranked = () => list().sort((a, b) => b.score - a.score);
const free = () => ['idle', 'quizRank', 'raceRank'].includes(S.phase);
const teamStats = () => S.teams.map(t => {
  const m = list().filter(p => p.team === t), n = m.length, sum = m.reduce((a, p) => a + p.taps, 0);
  return { team: t, n, taps: n ? Math.round((TEAM_AVG ? sum / n : sum) * 10) / 10 : 0 };
});
const goal = () => {
  const per = S.raceSec * GOAL_PER_SEC;
  return TEAM_AVG ? per : per * Math.max(...S.teams.map(t => list().filter(p => p.team === t).length), 1);
};
const phaseView = () => ({
  phase: S.phase, teams: S.teams, qn: S.qn, sec: QSEC,
  q: ['quiz', 'quizWait'].includes(S.phase) ? { hint: S.q.hint, q: S.q.q } : null,
  left: S.phase === 'quiz' ? Math.max(QSEC * 1000 - (Date.now() - S.qStart), 0) : 0,
});

let pushedAt = 0;
function push(force) {
  const now = Date.now(); if (!force && now - pushedAt < 400) return; pushedAt = now;
  const o = ranked(), inQ = S.phase === 'quiz', hasQ = ['quiz', 'quizWait', 'quizReveal'].includes(S.phase);
  io.to('admin').emit('admin', {
    phase: S.phase, qn: S.qn, qTotal: QS.length, lastQ: S.qi >= QS.length, sec: QSEC, raceSec: S.raceSec, goal: goal(),
    q: hasQ ? { hint: S.q.hint, q: S.q.q, answer: S.phase === 'quizReveal' ? shown(S.q.a) : null } : null,
    left: inQ ? Math.max(QSEC * 1000 - (now - S.qStart), 0) : 0,
    raceLeft: S.phase === 'race' ? Math.max(S.raceSec * 1000 - (now - S.raceStart), 0) : 0,
    correctN: Object.keys(S.correct).length,
    online: o.filter(p => p.sid).length, total: o.length,
    teams: teamStats(),
    board: o.slice(0, 200).map(p => ({ id: p.id, name: p.name, team: p.team, score: p.score, gain: p.score - p.mark, on: !!p.sid })),
    raceTop: list().filter(p => p.taps > 0).sort((a, b) => b.taps - a.taps).slice(0, 8).map(p => ({ name: p.name, team: p.team, taps: p.taps })),
    raceRes: ['raceEnd', 'raceRank'].includes(S.phase) ? S.raceRes : [],
  });
}
setInterval(() => push(true), 1000);

// ── 초성 게임: questions.js 위에서 아래 순서대로 출제 ──
function startQuiz() {
  if (!free() || !QS.length) return;
  S.qi = 0; S.qn = 0; list().forEach(p => p.mark = p.score);
  ask();
}
function ask() {
  const c = QS[S.qi++];
  S.q = { hint: c[0], q: c[1], a: c[2] }; S.qn++; S.correct = {}; S.qStart = Date.now(); S.phase = 'quiz';
  const g = ++S.gen;
  io.emit('phase', phaseView()); push(true);
  clearTimeout(S.timer); S.timer = setTimeout(() => { if (g === S.gen) endQ(); }, QSEC * 1000);
}
function endQ() {   // 7초 종료: 정답은 아직 공개하지 않고, 관리자가 "정답 확인"을 누를 때까지 기다려요
  S.phase = 'quizWait';
  io.emit('phase', phaseView()); push(true);
}
function revealQ() {   // 관리자가 "정답 확인"을 누르면 참가자 폰과 관리자 화면에 동시에 공개
  if (S.phase !== 'quizWait') return;
  S.phase = 'quizReveal';
  const answer = shown(S.q.a);
  list().forEach(p => p.sid && io.to(p.sid).emit('reveal', { answer, ok: !!S.correct[p.id] }));
  push(true);
}
function next() {   // 다음 문제. 마지막 문제였다면 순위 발표로 넘어가요
  if (S.phase !== 'quizReveal') return;
  if (S.qi >= QS.length) return rank();
  ask();
}
function rank() {   // 게임이 끝났을 때 관리자 화면에 순위 발표
  if (S.phase === 'quizReveal') S.phase = 'quizRank';
  else if (S.phase === 'raceEnd') S.phase = 'raceRank';
  else return;
  io.emit('phase', phaseView()); push(true);
}

// ── 달리기: 팀별 터치 수를 합산해 팀 캐릭터가 달려요 ──
function startRace(sec) {
  if (!free()) return;
  S.raceSec = [10, 15, 20, 30].includes(sec) ? sec : 10;
  list().forEach(p => { p.taps = 0; p.last = 0; p.mark = p.score; });
  S.raceRes = [];
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
  const ts = teamStats().filter(t => t.n && t.taps > 0).sort((a, b) => b.taps - a.taps), bonus = {};
  ts.forEach((t, i) => bonus[t.team] = i < TEAM_BONUS.length ? TEAM_BONUS[i] : TEAM_BONUS_REST);
  // 개인 점수 = 내 터치 수 × TAP_POINT + 우리 팀 순위 보너스 (터치를 1번 이상 한 사람만)
  list().forEach(p => { if (p.taps > 0) p.score += Math.round(p.taps * TAP_POINT) + (bonus[p.team] || 0); });
  S.raceRes = ts.map(t => ({ team: t.team, taps: t.taps, bonus: bonus[t.team] }));
  list().forEach(p => p.sid && io.to(p.sid).emit('raceEnd', {}));
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
      p = S.players[id] = { id, name, team: d.team, score: 0, mark: 0, taps: 0, last: 0 };
    }
    p.sid = s.id; me = p;
    cb({ ok: 1, name: p.name, team: p.team });
    s.emit('phase', phaseView());
    push();
  });
  s.on('answer', (t, cb) => {
    if (!me || typeof cb !== 'function' || S.correct[me.id]) return;
    const el = Date.now() - S.qStart;
    if (S.phase !== 'quiz' || el > QSEC * 1000 + 300) return cb('late');
    if (!S.q.a.some(a => norm(a.replace(/^~/, '')) === norm(t))) return cb(false);
    const g = 50 + Math.round(50 * Math.max(QSEC * 1000 - el, 0) / (QSEC * 1000));
    me.score += g; S.correct[me.id] = g; cb(true); push();   // 점수는 관리자 화면에만 보여요
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
  A('startQuiz', startQuiz);
  A('reveal', revealQ);
  A('next', next);
  A('rank', rank);
  A('race', sec => startRace(Number(sec)));
  A('stop', stop);
  A('teams', str => {
    const t = [...new Set(String(str).split(/[,\n]/).map(x => x.trim().slice(0, 8)).filter(Boolean))].slice(0, 12);
    if (!t.length) return;
    S.teams = t;
    list().forEach(p => { if (!t.includes(p.team)) { p.team = t[0]; p.sid && io.to(p.sid).emit('profile', { team: p.team }); } });
    io.emit('phase', phaseView()); push(true);
  });
  A('resetScores', () => { list().forEach(p => { p.score = 0; p.mark = 0; p.taps = 0; }); S.qn = 0; S.qi = 0; push(true); });
  A('kick', id => { const p = S.players[id]; if (p) { p.sid && io.to(p.sid).emit('kicked'); delete S.players[id]; push(true); } });
  A('resetAll', () => { list().forEach(p => p.sid && io.to(p.sid).emit('kicked')); S.players = {}; S.qn = 0; S.qi = 0; stop(); });
});

srv.listen(process.env.PORT || 3000, () => console.log('열렸어요 → http://localhost:' + (process.env.PORT || 3000)));
