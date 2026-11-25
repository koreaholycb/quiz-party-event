const express = require('express'), http = require('http'), crypto = require('crypto'), path = require('path'), { Server } = require('socket.io');
const { CHO } = require('./questions');
const fs = require('fs');
// 이미지 게임 폴더: image-game/quiz.js 가 있으면 그 폴더를, 폴더가 한 겹 더 들어가 있으면(image-game/image-game) 안쪽 폴더를 써요
const IMG_ROOT = [path.join(__dirname, 'image-game'), path.join(__dirname, 'image-game', 'image-game')]
  .find(d => fs.existsSync(path.join(d, 'quiz.js'))) || path.join(__dirname, 'image-game');
const { IMGS } = require(path.join(IMG_ROOT, 'quiz.js'));   // 이미지 게임 문제 목록
console.log('이미지 게임 폴더:', IMG_ROOT);
// 사진 파일 찾기: quiz.js 에 q01 처럼 확장자 없이 적어도, q01.jpg / .png / .webp … 중 올린 사진을 알아서 찾아요.
// 진짜 사진이 있으면 그걸 쓰고, 없으면 리허설용 예시 그림(.svg)을 써요.
const IMG_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'svg'];
function imgFile(name) {
  const files = fs.readdirSync(IMG_ROOT), base = String(name).replace(/\.(jpe?g|png|webp|gif|avif|svg)$/i, '').toLowerCase();
  if (files.includes(name)) return name;
  for (const e of IMG_EXTS) { const f = files.find(x => x.toLowerCase() === base + '.' + e); if (f) return f; }
  return name;
}
let _p = 0, _r = 0;
const IMG_LABELS = IMGS.map(c => c.practice ? `연습 ${++_p}` : `문제 ${++_r}`);
const PRACTICE_N = IMGS.filter(c => c.practice).length;
const IMG_TODO = IMGS.map((c, i) => ({ label: IMG_LABELS[i], f: imgFile(c.img) }))
  .filter(x => !fs.existsSync(path.join(IMG_ROOT, x.f)) || /\.svg$/i.test(x.f)).map(x => x.label);   // 아직 진짜 사진이 없는 문제 (서버가 켜질 때 한 번 확인)
console.log(IMG_TODO.length ? '⚠ 아직 진짜 사진이 없는 이미지 문제: ' + IMG_TODO.join(', ') : '이미지 게임: 모든 문제에 사진이 있어요');
const app = express(), srv = http.createServer(app);
const io = new Server(srv, { pingInterval: 10000, pingTimeout: 25000 });
app.use(express.static('public'));
// image-game 폴더의 "이미지 파일만" 공개해요. 문제 목록(quiz.js, 정답이 들어 있어요)은 내려받을 수 없어요.
app.use('/image-game', (req, res, next) => /\.(jpe?g|png|gif|webp|avif|svg)$/i.test(req.path) ? next() : res.sendStatus(404), express.static(IMG_ROOT));

// ── 설정: 필요하면 숫자만 바꾸세요 (모든 게임은 개인전이에요) ──
const QSEC = 15;                     // 초성 문제당 제한시간(초)
const QUIZ_MAX = 0;                  // 0이면 questions.js 전체 출제, 숫자면 위에서부터 그 개수만 (리허설할 때 5 등으로)
const QUIZ_FIRST_ONLY = false;       // 초성 퀴즈도 "최초 정답자 1명만 점수"로 하려면 true
const QUIZ_BASE = 50;                // 초성: 정답을 맞히면 받는 기본 점수
const QUIZ_SPEED_MAX = 30;           // 초성: 가장 빨리 맞힌 1등이 받는 추가 점수
const QUIZ_SPEED_STEP = 1;           // 초성: 한 명 늦을 때마다 줄어드는 추가 점수 (0점까지)
const IMG_ON_PHONE = false;          // 이미지 퀴즈: false면 관리자(큰) 화면에만 이미지 표시, true면 참가자 폰에도 표시
const IMG_OFFLINE = false;           // true: 정답을 현장에서 말로 맞히고 관리자가 점수를 직접 줘요 / false: 폰에서 입력
const IMG_POINTS = 80;               // 이미지 퀴즈: 가장 먼저 맞힌 1명이 받는 점수 (초성 1등 점수 50+30과 같게)
const IMG_DIR = '/image-game/';
const VERSION = 'v8';                // 화면 구석에 표시돼요 (올린 파일이 제대로 적용됐는지 확인용)
const RACE_SEC = 15;                 // 달리기는 15초 고정
const RACE_HIDE = 5;                 // 달리기 시작 후 이 시간(초) 동안은 관리자 화면에 아무것도 보여주지 않아요
const TAP_POINT = 1;                 // 달리기: 터치 1번당 점수 (터치 횟수에 비례, 등수 보너스는 없어요)

const QS = QUIZ_MAX ? CHO.slice(0, QUIZ_MAX) : CHO;
const S = { phase: 'idle', players: {}, qi: 0, qn: 0, q: null, qStart: 0, correct: {}, winner: null, awards: [],
  ii: 0, ik: 0, iq: null, raceStart: 0, raceRes: [], timer: null, gen: 0 };
const norm = s => String(s).replace(/\s/g, '').toLowerCase();
const shown = a => a.filter(x => !x.startsWith('~')).join(' / ');
const list = () => Object.values(S.players);
const ranked = () => list().sort((a, b) => b.score - a.score);
const free = () => ['idle', 'quizRank', 'raceRank', 'imgRank'].includes(S.phase);
const top5 = () => list().filter(p => p.taps > 0).sort((a, b) => b.taps - a.taps).slice(0, 5);
const IMG_PH = ['img', 'imgWon', 'imgReveal'];
const imgNo = () => S.iq && S.iq.practice ? S.ik : S.ik - PRACTICE_N;   // 연습 문제는 1·2번, 본 문제는 1~20번으로 세요
const phaseView = () => ({
  v: VERSION, phase: S.phase, qn: IMG_PH.includes(S.phase) ? imgNo() : S.qn, sec: QSEC,
  q: ['quiz', 'quizWait'].includes(S.phase) ? { hint: S.q.hint, q: S.q.q }
    : ['img', 'imgWon'].includes(S.phase) ? { img: IMG_ON_PHONE ? IMG_DIR + S.iq.img : null, offline: IMG_OFFLINE, k: S.ik, practice: !!S.iq.practice } : null,
  left: S.phase === 'quiz' ? Math.max(QSEC * 1000 - (Date.now() - S.qStart), 0) : 0,
});

let pushedAt = 0;
function push(force) {
  const now = Date.now(); if (!force && now - pushedAt < 400) return; pushedAt = now;
  const o = ranked(), inQ = S.phase === 'quiz', hasQ = ['quiz', 'quizWait', 'quizReveal'].includes(S.phase), isImg = IMG_PH.includes(S.phase);
  const elapsed = S.phase === 'race' ? now - S.raceStart : 0;
  const showTop = S.phase === 'raceEnd' || (S.phase === 'race' && elapsed >= RACE_HIDE * 1000);   // 처음 5초는 서버에서도 보내지 않아요
  io.to('admin').emit('admin', {
    v: VERSION, phase: S.phase, qn: isImg ? imgNo() : S.qn, qTotal: isImg ? IMGS.length - PRACTICE_N : QS.length, lastQ: isImg ? S.ii >= IMGS.length : S.qi >= QS.length,
    sec: QSEC, raceSec: RACE_SEC, raceHide: RACE_HIDE,
    q: hasQ ? { hint: S.q.hint, q: S.q.q, answer: S.phase === 'quizReveal' ? shown(S.q.a) : null }
      : isImg ? { img: IMG_DIR + S.iq.img, answer: S.phase === 'imgReveal' ? shown(S.iq.a) : null } : null,
    left: inQ ? Math.max(QSEC * 1000 - (now - S.qStart), 0) : 0,
    raceLeft: S.phase === 'race' ? Math.max(RACE_SEC * 1000 - elapsed, 0) : 0,
    raceElapsed: elapsed,
    correctN: Object.keys(S.correct).length, winner: S.winner, firstOnly: isImg ? true : QUIZ_FIRST_ONLY,
    offline: IMG_OFFLINE, awards: isImg ? S.awards : [], practice: isImg && !!S.iq.practice, imgTodo: IMG_TODO,
    online: o.filter(p => p.sid).length, total: o.length,
    board: o.slice(0, 200).map(p => ({ id: p.id, name: p.name, score: p.score, gain: p.score - p.mark, on: !!p.sid })),
    raceTop: showTop ? top5().map(p => ({ id: p.id, name: p.name, taps: p.taps })) : [],
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
  S.q = { hint: c[0], q: c[1], a: c[2] }; S.qn++; S.correct = {}; S.winner = null; S.qStart = Date.now(); S.phase = 'quiz';
  const g = ++S.gen;
  io.emit('phase', phaseView()); push(true);
  clearTimeout(S.timer); S.timer = setTimeout(() => { if (g === S.gen) endQ(); }, QSEC * 1000);
}
function endQ() {   // 제한시간 종료: 정답은 아직 공개하지 않고, 관리자가 "정답 확인"을 누를 때까지 기다려요
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
  else if (S.phase === 'imgReveal') S.phase = 'imgRank';
  else return;
  io.emit('phase', phaseView()); push(true);
}

// ── 이미지 퀴즈: 제한시간 없음. 가장 먼저 맞힌 1명이 나오면 모든 화면이 바뀌고, 관리자가 "정답 공개" → "다음 문제" ──
function imgNext() {
  if (free()) return startImg();
  if (S.phase === 'img' || S.phase === 'imgWon') return revealImg();
  if (S.phase === 'imgReveal') return S.ii >= IMGS.length ? rank() : askImg();
}
function startImg() {
  if (!IMGS.length) return;
  S.ii = 0; S.ik = 0; list().forEach(p => p.mark = p.score);
  askImg();
}
function askImg() {
  const c = IMGS[S.ii++];
  S.iq = { img: imgFile(c.img), a: c.a, practice: !!c.practice }; S.ik++; S.correct = {}; S.winner = null; S.awards = []; S.qStart = Date.now(); S.phase = 'img';
  S.gen++; clearTimeout(S.timer);
  io.emit('phase', phaseView()); push(true);
  const nx = IMGS[S.ii];   // 다음 이미지를 폰이 미리 받아 두면 공개할 때 바로 보여요
  if (nx && IMG_ON_PHONE) io.emit('preload', IMG_DIR + imgFile(nx.img));
}
function revealImg() {
  S.phase = 'imgReveal';
  const answer = shown(S.iq.a);
  list().forEach(p => p.sid && io.to(p.sid).emit('reveal', { answer, ok: null }));   // 정답자 본인에게도 알리지 않아요 (큰 화면에서만 공개)
  push(true);
}

// ── 달리기: 15초 고정, 개인전. 관리자 화면에는 처음 5초는 아무것도 없고, 그 뒤부터 1~5등만 보여요 ──
function startRace() {
  if (!free()) return;
  list().forEach(p => { p.taps = 0; p.last = 0; p.mark = p.score; });
  S.raceRes = [];
  const g = ++S.gen;
  S.phase = 'raceCount'; io.emit('phase', phaseView()); push(true);
  [3, 2, 1].forEach((n, i) => setTimeout(() => { if (g === S.gen) io.emit('count', n); }, i * 1000));
  clearTimeout(S.timer);
  S.timer = setTimeout(() => {
    if (g !== S.gen) return;
    S.phase = 'race'; S.raceStart = Date.now(); io.emit('phase', phaseView()); push(true);
    S.timer = setTimeout(() => { if (g === S.gen) endRace(); }, RACE_SEC * 1000);
  }, 3000);
}
function endRace() {
  S.phase = 'raceEnd';
  const order = list().filter(p => p.taps > 0).sort((a, b) => b.taps - a.taps);
  // 개인 점수 = 내 터치 수 × TAP_POINT (터치 횟수에 비례)
  order.forEach(p => { p.score += Math.round(p.taps * TAP_POINT); });
  S.raceRes = order.slice(0, 5).map(p => ({ name: p.name, taps: p.taps, pts: Math.round(p.taps * TAP_POINT) }));
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
      p = S.players[id] = { id, name, score: 0, mark: 0, taps: 0, last: 0 };
    }
    p.sid = s.id; me = p;
    cb({ ok: 1, name: p.name });
    s.emit('phase', phaseView());
    push();
  });
  s.on('answer', (t, cb) => {
    if (!me || typeof cb !== 'function' || S.correct[me.id]) return;
    const inImg = S.phase === 'img', el = Date.now() - S.qStart;
    if (S.phase === 'imgWon') return cb('taken');                  // 이미 정답자가 나온 이미지 문제
    if (inImg && IMG_OFFLINE) return cb('late');                   // 현장 정답 방식에서는 폰 입력을 받지 않아요
    if (!inImg && (S.phase !== 'quiz' || el > QSEC * 1000 + 300)) return cb('late');
    const cur = inImg ? S.iq : S.q;
    if (!cur.a.some(a => norm(a.replace(/^~/, '')) === norm(t))) return cb(false);
    if (!inImg && QUIZ_FIRST_ONLY && S.winner) return cb(false);   // 초성 퀴즈 최초 정답자 방식(선택)
    const g = inImg ? (S.iq.practice ? 0 : IMG_POINTS) : QUIZ_BASE + Math.max(QUIZ_SPEED_MAX - Object.keys(S.correct).length * QUIZ_SPEED_STEP, 0);   // 기본 점수 + 빨리 맞힌 순서 추가 점수
    if (!S.winner) S.winner = me.name;
    me.score += g; S.correct[me.id] = g; cb(true);                 // 점수는 관리자 화면에만 보여요
    if (inImg) { S.phase = 'imgWon'; io.emit('phase', phaseView()); push(true); }   // 모든 화면에 "정답자가 나왔어요"
    else push();
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
  A('imgNext', imgNext);
  A('race', () => startRace());
  A('stop', stop);
  A('award', (id, pts) => {   // 관리자가 직접 점수 주기 (이미지 게임 중에만)
    const p = S.players[id]; pts = Math.round(Number(pts));
    if (!p || !Number.isFinite(pts) || !pts || Math.abs(pts) > 1000 || !IMG_PH.includes(S.phase)) return;
    p.score += pts; S.awards.push({ id, name: p.name, pts }); push(true);
  });
  A('unaward', i => {   // 잘못 준 점수 취소
    const a = S.awards[i]; if (!a) return;
    const p = S.players[a.id]; if (p) p.score -= a.pts;
    S.awards.splice(i, 1); push(true);
  });
  A('resetScores', () => { list().forEach(p => { p.score = 0; p.mark = 0; p.taps = 0; }); S.qn = 0; S.qi = 0; push(true); });
  A('kick', id => { const p = S.players[id]; if (p) { p.sid && io.to(p.sid).emit('kicked'); delete S.players[id]; push(true); } });
  A('resetAll', () => { list().forEach(p => p.sid && io.to(p.sid).emit('kicked')); S.players = {}; S.qn = 0; S.qi = 0; stop(); });
});

srv.listen(process.env.PORT || 3000, () => console.log('열렸어요 → http://localhost:' + (process.env.PORT || 3000)));
