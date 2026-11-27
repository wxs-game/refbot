/* =====================================================================
   UPGRADER · Telegram Mini App
   1) конфиг и Telegram   2) серверный слой (Supabase RPC)
   3) состояние игрока и защита от race condition
   4) апгрейдер (перенесён из WXS Game)   5) кейсы, профиль, навигация
   ===================================================================== */


/* ---------- 1. конфиг ---------- */
// Публичные значения (publishable key безопасен для клиента: доступ ограничен RPC).
const SUPABASE_URL = 'https://mrtdbhjjtihwbtemqmst.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_F7vwdObPHIBbsEQmw_P1uw_iSS3yNCI';

const tg = window.Telegram && Telegram.WebApp;
if (tg) {
  try {
    tg.ready(); tg.expand();
    tg.setHeaderColor('#07080c'); tg.setBackgroundColor('#07080c');
    tg.disableVerticalSwipes && tg.disableVerticalSwipes();
  } catch (e) {}
}
const tgUser = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];

window.haptic = function (type) {
  type = type || 'light';
  try {
    const hf = tg && tg.HapticFeedback;
    if (hf) {
      if (type === 'success' || type === 'error' || type === 'warning') hf.notificationOccurred(type);
      else if (type === 'select') hf.selectionChanged();
      else hf.impactOccurred(type);
    } else if (navigator.vibrate) navigator.vibrate(type === 'heavy' ? 30 : 12);
  } catch (e) {}
};
const buzz = (t) => window.haptic(t);

function toast(text, cls, ms) {
  const e = $('#toast');
  e.textContent = text; e.className = 'on ' + (cls || '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { e.className = ''; }, ms || 2600);
}
function showMessage(text) { toast(String(text), 'lose', 4200); }
window.showWinPopup = (amount, mult) =>
  toast('Победа! +' + Number(amount).toFixed(2) + ' $' + (mult ? ' (x' + Number(mult).toFixed(2) + ')' : ''), 'win');

/* ---------- 2. серверный слой ---------- */
const NO_TG = 'Откройте игру из Telegram — иначе баланс и ставки недоступны.';
function friendlyError(msg) {
  msg = String(msg || '');
  if (/^AUTH:/.test(msg)) return msg === 'AUTH:expired' ? 'Сессия устарела. Перезапустите мини-приложение.' : 'Не удалось подтвердить аккаунт Telegram (' + msg + ').';
  return msg || 'Ошибка сервера';
}
// Вызов RPC с initData. Возвращает {ok:false,error} вместо исключений.
// Если в аргументах есть p_request — запрос идемпотентен и один раз безопасно повторяется при обрыве сети.
async function crashRpc(fn, args) {
  if (!(tg && tg.initData)) return { ok: false, error: NO_TG };
  const body = JSON.stringify(Object.assign({ p_init: tg.initData }, args || {}));
  const tries = args && args.p_request ? 2 : 1;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
        method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body, signal: AbortSignal.timeout(10000)
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) return { ok: false, error: friendlyError(j && j.message) };
      return j || { ok: false, error: 'Пустой ответ сервера' };
    } catch (e) {
      if (i + 1 >= tries) return { ok: false, error: 'Нет соединения с сервером' };
      await new Promise((r) => setTimeout(r, 600));
    }
  }
}
async function publicRpc(fn, args) {            // функции без авторизации (например list_cases)
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
      method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {}), signal: AbortSignal.timeout(10000)
    });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

/* ---------- 3. состояние игрока ---------- */
let currentBalance = 0, currentTurnover = 0, currentMaxWin = 0, currentTotalWin = 0;
let currentBetsCount = 0, currentWinsCount = 0, currentDeposits = 0, currentWithdrawals = 0;
let playerReady = false, playerData = null;
const MIN_BET = 0.10;

function roundMoney(v) { const n = Number(v); return isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0; }
const fmt = (n) => Number(n || 0).toFixed(2) + ' $';

function setUIBalance(v) {
  currentBalance = parseFloat(v) || 0;
  const t = fmt(currentBalance);
  ['#tBal', '#bal'].forEach((s) => { const e = $(s); if (e) e.textContent = t; });
  const set = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  set('stTurn', fmt(currentTurnover)); set('stBets', currentBetsCount);
  set('stWins', currentWinsCount); set('stMax', 'x' + currentMaxWin.toFixed(2));
}

function snapshotBalanceState() {
  return { balance: currentBalance, turnover: currentTurnover, maxWin: currentMaxWin, totalWin: currentTotalWin,
           betsCount: currentBetsCount, winsCount: currentWinsCount, deposits: currentDeposits, withdrawals: currentWithdrawals };
}
function restoreBalanceState(s) {
  currentTurnover = s.turnover; currentMaxWin = s.maxWin; currentTotalWin = s.totalWin;
  currentBetsCount = s.betsCount; currentWinsCount = s.winsCount;
  currentDeposits = s.deposits; currentWithdrawals = s.withdrawals;
  setUIBalance(s.balance);
}

/* --- защита от гонок ---
   isEconomyLocked  — одна денежная операция за раз (ставка, кейс, продажа, пополнение);
   econEpoch        — номер «эпохи»: растёт при каждом lock/unlock;
   syncPlayer()     — ответ сервера применяется, только если за время запроса не стартовала
                      и не закончилась другая операция, и пришёл самым свежим (syncSeq).
   Сервер дополнительно блокирует строку игрока (FOR UPDATE) и принимает request_id (идемпотентность). */
let isEconomyLocked = false, isBetProcessing = false, econEpoch = 0, syncSeq = 0, syncTimer = 0;
function lockEconomy() { if (isEconomyLocked) return false; isEconomyLocked = true; econEpoch++; return true; }
function unlockEconomy() { isEconomyLocked = false; econEpoch++; queueSync(); }
function queueSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(syncPlayer, ms == null ? 350 : ms); }

async function fetchPlayer() {                  // создаёт игрока и стартовый баланс на сервере при первом входе
  let last = { ok: false, error: 'Нет соединения с сервером' };
  for (let a = 0; a < 3; a++) {
    if (a) await new Promise((r) => setTimeout(r, a * 900));
    last = await crashRpc('ensure_player', {});
    if (last.ok && last.player) return last;
    if (last.error && last.error !== 'Нет соединения с сервером') return last;   // осмысленную ошибку не повторяем
  }
  return last;
}
function applyPlayer(p) {
  playerData = p; playerReady = true;
  currentTurnover = Number(p.turnover) || 0; currentMaxWin = Number(p.max_win) || 0;
  currentTotalWin = Number(p.total_win) || 0; currentBetsCount = Number(p.bets_count) || 0;
  currentWinsCount = Number(p.wins_count) || 0; currentDeposits = Number(p.deposits) || 0;
  currentWithdrawals = Number(p.withdrawals) || 0;
  paintProfile(p);
  setUIBalance(p.balance);
}
async function syncPlayer() {
  if (isEconomyLocked || document.hidden) return;
  const seq = ++syncSeq, ep = econEpoch;
  const r = await fetchPlayer();
  if (seq !== syncSeq || ep !== econEpoch || isEconomyLocked) return;   // устаревший ответ — выбрасываем
  if (r.ok && r.player) applyPlayer(r.player);
}
let bootP = null;
function bootPlayer() {                         // единственный стартовый запрос, даже если вызвали дважды
  if (bootP) return bootP;
  bootP = (async () => {
    const r = await fetchPlayer();
    if (r.ok && r.player) {
      applyPlayer(r.player);
      if (r.is_new) toast('Добро пожаловать! Стартовый баланс: ' + fmt(r.player.balance), 'win', 3200);
    } else showMessage(r.error);
  })();
  return bootP;
}

/* --- общие функции поля ставки (как в оригинале) --- */
function applyBetFactor(input, factor) {
  if (!input) return;
  let c = parseFloat(input.value);
  if (isNaN(c) || c < MIN_BET) c = MIN_BET; else { c = roundMoney(c * factor); if (c < MIN_BET) c = MIN_BET; }
  if (c > currentBalance) c = roundMoney(Math.max(0, currentBalance));
  input.value = c.toFixed(2);
}
function applyBetMax(input) { if (input) input.value = roundMoney(Math.max(0, currentBalance)).toFixed(2); }
function clampBetInputOnBlur(e) {
  const input = e.target;
  if (!input || input.value.trim() === '') return;
  let v = parseFloat(input.value);
  if (isNaN(v) || v <= 0) { input.value = ''; return; }
  v = roundMoney(v);
  if (v > currentBalance) v = roundMoney(Math.max(0, currentBalance));
  input.value = v.toFixed(2);
}
function blockInvalidBetKeys(e) { if (['e', 'E', '+', '-'].includes(e.key)) e.preventDefault(); }

// Заглушки для функций оригинала: страницы переключает нижняя навигация.
const showPage = () => {}, updateNav = () => {};
const broadcastLiveBet = () => null, resolveLiveBetWin = () => {};

/* =========================
   ИГРА «АПГРЕЙДЕР»
========================= */

const UPG_HOUSE_EDGE = 0.05;
const UPG_MIN_CHANCE = 1;
const UPG_MAX_CHANCE = 90;
const UPG_STEP = 5;
const UPG_START = 348;       // где стрелка стоит до запуска
// Профиль вращения снят покадрово (60 fps) с видео-образца:
//   замах назад ≈9° за 0.15 с -> разгон 0.5 с до ≈1150°/с -> ровное вращение -> торможение v ~ (1-s)^p.
//   Всё вращение ≈5.9 с. Торможение каждый раз разное: от резкого (≈1.4 с, p≈1.6)
//   до плавного «как на видео» (4.0 с, p≈2.6).
const UPG_SPIN = {
    windup: 9, windupT: 0.15, hold: 0.03,     // замах: градусы / секунды
    accelT: 0.5,                              // разгон до крейсерской скорости, с
    total: 6.6,                               // от начала замаха до остановки, с (было 5.9 — стрелка стопается дольше)
    vRef: 1150,                               // крейсерская скорость на видео, °/с
    stopMin: 1.9, stopMax: 5.0,               // длина торможения, с (резко ... плавно)
    pMin: 1.9, pMax: 3.0,                     // «мягкость» хвоста торможения (больше — стрелка дольше доползает)
    land: 0.3,                                // пауза после остановки перед результатом, с
    tickDeg: 5, tickEvery: 5, tickGapMs: 50,  // вибрация: деление = 5°, бьём каждые 5 делений (25°), не чаще раза в 50 мс
    step: 1 / 60,                             // шаг дискретизации кейфреймов, с
    trail: [[0.010, .55], [0.021, .38], [0.032, .24], [0.044, .13]]   // [отставание с, прозрачность] призраков следа
};
const UPG_FONT = '"Carlito","Helvetica Neue",Arial,sans-serif';

const upg = { chance: 40, busy: false, result: null, fade: 1, theta: UPG_START, glow: 0, scenes: {}, cv: null, ctx: null, size: 0, raf: 0, fadeRaf: 0 };

function upgCalc(bet, chance) {
    const coef = (1 - UPG_HOUSE_EDGE) * 100 / chance;
    return { payout: roundMoney(Math.floor(bet * coef * 100 + 1e-6) / 100), coef: roundMoney(coef) };
}

function upgMinBet(chance) {
    for (let c = 10; c < 100000; c++) {
        if (upgCalc(c / 100, chance).payout > c / 100) return c / 100;
    }
    return MIN_BET;
}

// Исход броска считает сервер (SQL-функция upgrader_play) — в браузере его нет.

function upgBet() {
    const v = parseFloat(document.getElementById('upgBetInput')?.value);
    return isFinite(v) && v > 0 ? roundMoney(v) : 0;
}

const upgSmooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
const upgPt = (r, deg) => { const a = deg * Math.PI / 180; return [360 + r * Math.sin(a), 360 - r * Math.cos(a)]; };

/* ---------- статичные слои колеса (кэшируются по шансу) ----------
   Раньше каждый кадр перерисовывал ВСЁ: 2 полноразмерные картинки с альфой,
   ~10 текстов (с measureText в цикле) и 120 рисок. Теперь слои раздельные:
     1. base  — колесо, плашка (рисуется только при смене шанса)
     2. hot   — красное свечение сектора (двигаем ТОЛЬКО css-opacity, без перерисовки)
     3. text  — тексты (перерисовываются только когда реально поменялись)
     4. fx    — золотой хвост + стрелка (единственное, что рисуется каждый кадр) */
// Колесо БЕЗ красного сектора — от шанса не зависит, строится один раз.
function upgWheel() {
    if (upg.wheel && upg.wheel.width === upg.size) return upg.wheel;
    const S = upg.size / 720, TAU = Math.PI * 2;
    const c = document.createElement('canvas');
    c.width = c.height = upg.size;
    const x = c.getContext('2d');
    x.setTransform(S, 0, 0, S, 0, 0);
    const grad = (y1, y2, a, b) => { const g = x.createLinearGradient(0, y1, 0, y2); g.addColorStop(0, a); g.addColorStop(1, b); return g; };
    const disc = (r, a, b) => { x.beginPath(); x.arc(360, 360, r, 0, TAU); x.fillStyle = grad(360 - r, 360 + r, a, b); x.fill(); };

    // мягкая тень под колесом
    x.save();
    x.shadowColor = 'rgba(0,0,0,0.6)'; x.shadowBlur = 30 * S; x.shadowOffsetY = 14 * S;
    x.fillStyle = '#000'; x.beginPath(); x.arc(360, 360, 286, 0, TAU); x.fill();
    x.restore();

    // внешние риски: через 5°, каждая шестая длиннее
    for (let i = 0; i < 72; i++) {
        const major = i % 6 === 0;
        const [x1, y1] = upgPt(major ? 304 : 308, i * 5);
        const [x2, y2] = upgPt(major ? 328 : 323, i * 5);
        x.strokeStyle = major ? '#58585c' : '#47474b';
        x.lineWidth = major ? 3.8 : 3;
        x.lineCap = 'butt';
        x.beginPath(); x.moveTo(x1, y1); x.lineTo(x2, y2); x.stroke();
    }

    disc(286, '#34343a', '#222226');          // ободок
    disc(282, '#252529', '#202023');          // тёмный диск, где лежит сектор
    x.beginPath(); x.arc(360, 360, 283.5, 0, TAU);
    x.strokeStyle = '#151517'; x.lineWidth = 2; x.stroke();

    disc(183, '#1c1c1f', '#18181b');          // центральный диск
    x.beginPath(); x.arc(360, 360, 183, 0, TAU);
    x.strokeStyle = '#303035'; x.lineWidth = 2.2; x.stroke();

    return (upg.wheel = c);
}

// Путь сектора для ЛЮБОГО (в т.ч. дробного) шанса — нужен для плавной анимации.
function upgSectorPath(x, chance) {
    const half = chance * 1.8, k = Math.PI / 180;
    x.beginPath();
    x.arc(360, 360, 270, (180 - half) * k - Math.PI / 2, (180 + half) * k - Math.PI / 2);
    x.arc(360, 360, 183, (180 + half) * k - Math.PI / 2, (180 - half) * k - Math.PI / 2, true);
    x.closePath();
}

// Красный сектор + тонкое кольцо по внутреннему краю (рисуется поверх колеса)
function upgPaintSector(x, chance, fast, lose) {
    const half = chance * 1.8, k = Math.PI / 180, TAU = Math.PI * 2;
    const begin = (180 - half) * k - Math.PI / 2, end = (180 + half) * k - Math.PI / 2;
    const S = upg.size / 720;
    const g = x.createLinearGradient(0, 246, 0, 632);
    if (lose) {
        g.addColorStop(0, '#8f8789'); g.addColorStop(.40, '#9a8184'); g.addColorStop(.62, '#a9575c');
        g.addColorStop(.82, '#b93a41'); g.addColorStop(1, '#c4252d');
    } else {
        g.addColorStop(0, '#ffe41f'); g.addColorStop(.40, '#ffd80d'); g.addColorStop(.60, '#ffb613');
        g.addColorStop(.80, '#ff8520'); g.addColorStop(1, '#ff3a22');
    }
    x.save();
    if (!fast) { x.shadowColor = lose ? 'rgba(210,50,60,.4)' : 'rgba(255,198,0,.55)'; x.shadowBlur = 24 * S; }
    else {
        // свечение не гаснет при движении слайдера: дешёвая замена размытой тени — несколько мягких обводок
        x.save();
        upgSectorPath(x, chance);
        x.lineJoin = 'round';
        const gc = lose ? '210,50,60' : '255,198,0';
        for (const [w, a] of [[34, .05], [24, .07], [15, .1], [8, .14], [3, .18]]) {
            x.lineWidth = w; x.strokeStyle = `rgba(${gc},${a})`; x.stroke();
        }
        x.restore();
    }
    upgSectorPath(x, chance); x.fillStyle = g; x.fill();
    x.restore();
    // тёмное гало от центрального диска
    x.save();
    upgSectorPath(x, chance); x.clip();
    const rg = x.createRadialGradient(360, 360, 183, 360, 360, 216);
    rg.addColorStop(0, 'rgba(0,0,0,.8)'); rg.addColorStop(.45, 'rgba(0,0,0,.36)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = rg; x.fillRect(0, 0, 720, 720);
    x.restore();
    x.beginPath(); x.arc(360, 360, 183, 0, TAU);
    x.strokeStyle = '#2c2c31'; x.lineWidth = 2; x.stroke();
    // тонкое золотое кольцо на ободке
    const rg2 = x.createLinearGradient(0, 246, 0, 632);
    if (lose) { rg2.addColorStop(0, '#a29a9c'); rg2.addColorStop(.55, '#b8484e'); rg2.addColorStop(1, '#c8323a'); }
    else { rg2.addColorStop(0, '#ffd21f'); rg2.addColorStop(.55, '#ffb21c'); rg2.addColorStop(1, '#ff8a1a'); }
    x.save();
    if (!fast) { x.shadowColor = lose ? 'rgba(200,50,58,.5)' : 'rgba(255,165,0,.6)'; x.shadowBlur = 8 * S; }
    x.beginPath(); x.arc(360, 360, 284.5, begin, end);
    x.strokeStyle = rg2; x.lineWidth = 3.6; x.lineCap = 'round'; x.stroke();
    x.restore();
}

// Слой проигрыша: то же колесо, но сектор красно-серый. Проявляется через css-opacity.
function upgPaintLose(chance) {
    const h = upg.loseCtx;
    if (!h) return;
    const S = upg.size / 720;
    h.setTransform(1, 0, 0, 1, 0, 0);
    h.clearRect(0, 0, upg.size, upg.size);
    h.drawImage(upgWheel(), 0, 0);
    h.setTransform(S, 0, 0, S, 0, 0);
    upgPaintSector(h, chance, false, true);
    upg.loseChance = chance;
}

// Слой свечения. Центр (r < 183) вырезан, чтобы ореол не залезал на центральный диск.
function upgPaintHot(x, S, chance) {
    x.setTransform(S, 0, 0, S, 0, 0);
    x.save();
    x.beginPath(); x.rect(0, 0, 720, 720); x.arc(360, 360, 183, 0, Math.PI * 2, true); x.clip('evenodd');
    x.save(); x.shadowColor = 'rgba(255,190,20,1)'; x.shadowBlur = 30 * S; x.fillStyle = '#ffc01a';
    upgSectorPath(x, chance); x.fill(); x.restore();
    const g = x.createLinearGradient(0, 246, 0, 632);
    g.addColorStop(0, '#fff27a'); g.addColorStop(.4, '#ffe433'); g.addColorStop(.62, '#ffbd22'); g.addColorStop(.82, '#ff9028'); g.addColorStop(1, '#ff4a2a');
    upgSectorPath(x, chance); x.fillStyle = g; x.fill();
    x.restore();
    // то же тёмное гало у центрального диска, что и на самом секторе —
    // иначе яркая заливка «съедает» его и кольцо выглядит расширившимся к центру
    x.save();
    upgSectorPath(x, chance); x.clip();
    const rg = x.createRadialGradient(360, 360, 183, 360, 360, 216);
    rg.addColorStop(0, 'rgba(0,0,0,.8)'); rg.addColorStop(.45, 'rgba(0,0,0,.36)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = rg; x.fillRect(0, 0, 720, 720);
    x.restore();
}

// Готовое свечение для «устоявшегося» шанса (кэш) — чтобы во время вращения ничего не строить.
function upgHotSprite(chance) {
    const key = chance + ':' + upg.size;
    if (!upg.scenes[key]) {
        if (Object.keys(upg.scenes).length >= 8) upg.scenes = {};
        const c = document.createElement('canvas');
        c.width = c.height = upg.size;
        upgPaintHot(c.getContext('2d'), upg.size / 720, chance);
        upg.scenes[key] = c;
    }
    return upg.scenes[key];
}

// Плавный «рост/убывание» сектора к новому шансу (по времени, не по кадрам)
function upgChanceAnim() {
    if (upg.chRaf) return;
    let last = performance.now();
    const step = (now) => {
        upg.chRaf = 0;
        if (upg.sliding) return;                       // палец ведёт слайдер сам
        if (upg.busy) { upg.shown = upg.chance; upgPaintSlider(upg.shown); upgDraw(); return; }
        const dt = Math.min(64, now - last); last = now;
        const diff = upg.chance - upg.shown;
        if (Math.abs(diff) < 0.04) {
            upg.shown = upg.chance;
            upgSyncSlider();
            upgDraw();
            setTimeout(() => { if (!upg.busy && upg.ctx) upgHotSprite(upg.chance); }, 80);   // заранее готовим свечение
            return;
        }
        upg.shown += diff * (1 - Math.exp(-dt / 70));
        upgPaintSlider(upg.shown);
        upgDraw();
        upg.chRaf = requestAnimationFrame(step);
    };
    upg.chRaf = requestAnimationFrame(step);
}

/* ---------- текст (ширины кэшируются — measureText в кадре был очень дорогим) ---------- */
const upgWCache = new Map();
function upgMeasure(x, font, text) {
    const key = font + '|' + text;
    let w = upgWCache.get(key);
    if (w === undefined) {
        x.font = font; w = x.measureText(text).width;
        if (upgWCache.size > 400) upgWCache.clear();
        upgWCache.set(key, w);
    }
    return w;
}

function upgSpaced(x, text, cx, cy, size, color, sp) {
    const font = `700 ${size}px ${UPG_FONT}`;
    x.font = font; x.fillStyle = color; x.textBaseline = 'middle'; x.textAlign = 'left';
    const chars = [...text], ws = chars.map(ch => upgMeasure(x, font, ch));
    let cur = cx - (ws.reduce((a, b) => a + b, 0) + sp * (chars.length - 1)) / 2;
    chars.forEach((ch, i) => { x.fillText(ch, cur, cy); cur += ws[i] + sp; });
}

const upgFitCache = new Map();
function upgFit(x, text, cx, cy, size, maxW, color) {
    const ck = text + '|' + size + '|' + maxW;
    let s = upgFitCache.get(ck);
    if (s === undefined) {
        s = size;
        while (s > 10 && upgMeasure(x, `700 ${s}px ${UPG_FONT}`, text) > maxW) s--;
        if (upgFitCache.size > 400) upgFitCache.clear();
        upgFitCache.set(ck, s);
    }
    x.fillStyle = color; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = `700 ${s}px ${UPG_FONT}`;
    x.fillText(text, cx, cy);
}

function upgDraw() {
    const base = upg.ctx;
    if (!base) return;
    const S = upg.size / 720, chance = upg.chance;

    // во время вращения ставку из DOM не читаем (она заблокирована)
    if (!upg.busy || upg.betC == null) upg.betC = upgBet() || MIN_BET;
    const bet = upg.betC;

    // 1) колесо + сектор (перерисовка только пока сектор реально меняется)
    const shown = upg.shown;
    const fast = !!(upg.sliding || Math.abs(upg.chance - shown) > 0.04);
    const sKey = shown.toFixed(2) + ':' + upg.size + (fast ? 'f' : '');
    if (upg.sceneKey !== sKey) {
        base.setTransform(1, 0, 0, 1, 0, 0);
        base.clearRect(0, 0, upg.size, upg.size);
        base.drawImage(upgWheel(), 0, 0);
        base.setTransform(S, 0, 0, S, 0, 0);
        upgPaintSector(base, shown, fast);
        upg.sceneKey = sKey;
    }

    // 2) свечение — прозрачность слоя (GPU); сам слой перерисовываем лишь если оно видно
    const g = Math.max(0, Math.min(1, upg.glow));
    const gv = g < 0.01 ? 0 : Math.round(g * 1000) / 1000;
    if (gv > 0 && upg.hotKey !== sKey) {
        const h = upg.hotCtx;
        h.setTransform(1, 0, 0, 1, 0, 0);
        h.clearRect(0, 0, upg.size, upg.size);
        if (shown === chance) h.drawImage(upgHotSprite(chance), 0, 0);
        else upgPaintHot(h, S, shown);
        upg.hotKey = sKey;
    }
    if (upg.glowVal !== gv) { upg.hotCv.style.opacity = gv; upg.glowVal = gv; }

    // 3) тексты — только если что-то изменилось
    const disp = Math.round(shown);
    const tKey = disp + '|' + chance + '|' + bet + '|' + (upg.result || '') + '|' + (upg.result ? Math.round(upg.fade * 200) : 0) + '|' + upg.size + '|' + upg.resultPayout + '|' + (window.WXG?.key || '');
    if (upg.textKey !== tKey) {
        upg.textKey = tKey;
        const gross = upgCalc(bet, chance).payout;
        const payout = upg.result && Number.isFinite(upg.resultPayout)
            ? upg.resultPayout : gross;
        const outcome = upg.result;
        upg.centerValue.textContent = outcome === 'win' ? 'ПОБЕДА' : outcome === 'lose' ? 'МИМО' : `${disp}%`;
        upg.centerCoef.textContent = outcome === 'win' ? `+${payout.toFixed(2)} $` : `x${upgCalc(bet, chance).coef.toFixed(2)}`;
        upg.centerCaption.textContent = outcome === 'win' ? 'ЗАЧИСЛЕНО НА БАЛАНС' : outcome === 'lose' ? 'ПОПРОБУЙ ЕЩЁ' : 'ШАНС ПОБЕДЫ';
        upg.center.classList.toggle('is-result', !!outcome);
        upg.center.classList.toggle('is-win', outcome === 'win');
        if (window.WXG?.on) WXG.center(outcome);
    }

    if (!upg.spinAnimation) upgSetRotorAngle(upg.theta);
}

/* ---------- анимация вращения ---------- */
function upgPickTarget(lo, hi) {
    // Равномерно по всей зоне, без подтяжки к краям (никаких «почти докатилось / почти перекатилось»).
    // Отступ от границы оставляем, чтобы по стрелке сразу было понятно: победа или проигрыш.
    const len = hi - lo, m = Math.min(6, len * 0.3);
    const t = lo + m + Math.random() * (len - 2 * m);
    return ((t % 360) + 360) % 360;
}

function upgSetRotorAngle(degrees) {
    upg.theta = degrees;
    if (upg.rotor) upg.rotor.style.transform = `translateZ(0) rotate(${degrees}deg)`;
}

// Профиль вращения: угол (градусы от стартовой позиции) в момент t (секунды от начала замаха).
// Скорость везде непрерывна -> никаких рывков: замах -> smoothstep-разгон -> ровно -> (1-s)^p до нуля.
function upgBuildProfile(rem) {
    const C = UPG_SPIN, W = C.windup, k = Math.random();
    const Ta = C.accelT, t0 = C.windupT + C.hold;
    const Td = C.stopMin + k * (C.stopMax - C.stopMin);           // резко ... плавно
    const p = C.pMin + k * (C.pMax - C.pMin) + (Math.random() - .5) * .3;
    const Tc = Math.max(.2, C.total - t0 - Ta - Td);              // ровное вращение добирает до ≈5.9 с
    const eff = Ta / 2 + Tc + Td / (p + 1);                       // «эффективное» время на vmax
    const n = Math.max(3, Math.round((C.vRef * eff - W - rem) / 360));   // целых оборотов
    const delta = n * 360 + rem;                                  // итоговый поворот от старта
    const vmax = (delta + W) / eff;
    const tA = t0, tC = tA + Ta, tD = tC + Tc, tEnd = tD + Td;
    const sm = (x) => x * x * (3 - 2 * x);
    const a1 = -W + vmax * Ta / 2;
    const angle = (t) => {
        if (t <= 0) return 0;
        if (t < C.windupT) return -W * sm(t / C.windupT);
        if (t < tA) return -W;
        if (t < tC) { const x = (t - tA) / Ta; return -W + vmax * Ta * (x * x * x - x * x * x * x / 2); }
        if (t < tD) return a1 + vmax * (t - tC);
        if (t < tEnd) { const s = (t - tD) / Td; return a1 + vmax * Tc + vmax * Td * (1 - Math.pow(1 - s, p + 1)) / (p + 1); }
        return delta;
    };
    const speed = (t) => {                                        // °/с — для яркости следа
        if (t <= tA || t >= tEnd) return 0;
        if (t < tC) return vmax * sm((t - tA) / Ta);
        if (t < tD) return vmax;
        return vmax * Math.pow(1 - (t - tD) / Td, p);
    };
    return { angle, speed, delta, end: tEnd, vmax, stop: Td, p };
}

function upgAnimate(win, chance) {
    cancelAnimationFrame(upg.fadeRaf);
    cancelAnimationFrame(upg.chRaf);
    upg.chRaf = 0;
    const half = chance * 1.8;
    const [lo, hi] = win ? [180 - half, 180 + half] : [180 + half, 540 - half];
    const start = ((upg.theta % 360) + 360) % 360;
    const target = upgPickTarget(lo, hi);
    const rem = (target - start + 360) % 360;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const C = UPG_SPIN;
    const prof = upgBuildProfile(rem);
    const final = start + prof.delta;
    const spinSec = reduced ? 0.3 : prof.end;
    const totalMs = Math.round((spinSec + (reduced ? .08 : C.land)) * 1000);
    upg.shown = chance;
    upg.betC = null;
    upg.result = null;
    upg.glow = 0;
    upg.fade = 1;
    upg.stack.classList.remove('is-win', 'is-lose');
    upg.stack.classList.add('is-spinning');
    upgDraw();
    upgSetRotorAngle(start);

    return new Promise(resolve => {
        let done = false;
        let fallbackFrame = 0;
        let safetyTimer;
        let hapticRaf = 0;
        let stopFired = false;

        // Вибрация «стоп» — в момент, когда стрелка остановилась (раньше, чем покажется результат)
        const fireStop = () => {
            if (stopFired) return;
            stopFired = true;
            window.haptic?.('heavy');
        };
        // Тики во время вращения: каждые tickEvery делений (по tickDeg градусов).
        // Идём по тому же профилю угла, что и анимация, поэтому на торможении тики сами редеют.
        const startHaptics = () => {
            if (reduced) return;
            const stepDeg = C.tickDeg * C.tickEvery;
            const began = performance.now();
            const clock = () => {
                const a = upg.spinAnimation;
                return a && typeof a.currentTime === 'number' ? a.currentTime / 1000 : (performance.now() - began) / 1000;
            };
            let lastIdx = Math.floor(start / stepDeg);
            let lastAt = 0;
            const loop = () => {
                if (done) return;
                const t = clock();
                if (t >= spinSec) { fireStop(); return; }
                const idx = Math.floor((start + prof.angle(t)) / stepDeg);
                if (idx > lastIdx) {
                    lastIdx = idx;
                    const now = performance.now();
                    if (now - lastAt >= C.tickGapMs) { lastAt = now; window.haptic?.('light'); }
                }
                hapticRaf = requestAnimationFrame(loop);
            };
            hapticRaf = requestAnimationFrame(loop);
        };
        const stopGhosts = () => {
            for (const g of upg.ghosts || []) {
                if (g.anim) { g.anim.cancel(); g.anim = null; }
                g.el.style.opacity = '0';
            }
        };
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(safetyTimer);
            cancelAnimationFrame(fallbackFrame);
            cancelAnimationFrame(hapticRaf);
            fireStop();
            upgSetRotorAngle(final);
            if (upg.spinAnimation) {
                upg.spinAnimation.cancel();
                upg.spinAnimation = null;
            }
            stopGhosts();
            upg.result = win ? 'win' : 'lose';
            if (!win) upgPaintLose(chance);
            upg.glow = win ? 1 : 0;
            upg.stack.classList.remove('is-spinning');
            upg.stack.classList.add(win ? 'is-win' : 'is-lose');
            upgDraw();
            resolve();
        };

        // Вращение ведёт композитор браузера (WAAPI): кадры не зависят от JS и не «срываются».
        // Кривая заранее разложена на плотные линейные кейфреймы (шаг 1/60 с),
        // поэтому скорость меняется плавно, а не ступеньками.
        startHaptics();
        if (typeof upg.rotor.animate === 'function') {
            const rot = (d) => `translateZ(0) rotate(${(start + d).toFixed(3)}deg)`;
            let frames;
            if (reduced) {
                frames = [{ transform: rot(0), offset: 0 }, { transform: rot(prof.delta), offset: 1 }];
            } else {
                frames = [];
                const stepN = Math.ceil(spinSec / C.step);
                for (let i = 0; i <= stepN; i++) {
                    const t = Math.min(spinSec, i * C.step);
                    frames.push({ transform: rot(prof.angle(t)), offset: t / (totalMs / 1000) });
                }
                frames.push({ transform: rot(prof.delta), offset: 1 });
            }
            try {
                upg.spinAnimation = upg.rotor.animate(frames, { duration: totalMs, fill: 'forwards', easing: 'linear' });
                upg.spinAnimation.finished.then(finish, finish);
                // След из «призраков» стрелки: те же кейфреймы, только с отставанием по времени.
                // Чем быстрее вращение — тем длиннее и ярче след; при медленном торможении он сам сливается со стрелкой.
                if (!reduced) {
                    (upg.ghosts || []).forEach((g, gi) => {
                        const [lag, alpha] = C.trail[gi];
                        const gf = frames.map((f) => {
                            const t = f.offset * totalMs / 1000;
                            const v = prof.speed(Math.max(0, t - lag));
                            return { transform: f.transform, opacity: +(alpha * Math.min(1, v / 520)).toFixed(3), offset: f.offset };
                        });
                        try { g.anim = g.el.animate(gf, { duration: totalMs, delay: lag * 1000, fill: 'both', easing: 'linear' }); }
                        catch (_) { g.anim = null; }
                    });
                }
            } catch (_) {
                startFallback();
            }
        } else {
            startFallback();
        }

        function startFallback() {
            const began = performance.now();
            const step = now => {
                if (done) return;
                const t = (now - began) / 1000;
                upgSetRotorAngle(reduced ? start + prof.delta * Math.min(1, t / .3) : start + prof.angle(t));
                if (t * 1000 >= totalMs) finish(); else fallbackFrame = requestAnimationFrame(step);
            };
            fallbackFrame = requestAnimationFrame(step);
        }
        safetyTimer = setTimeout(finish, totalMs + 500);
    });
}


/* ---------- интерфейс ---------- */
function upgInit() {
    if (upg.cv) return;
    const cv = document.getElementById('upgCanvas');
    if (!cv) return;
    upg.cv = cv;
    upg.size = Math.round(Math.max(240, Math.min(420, cv.getBoundingClientRect().width || 360)) * Math.min(window.devicePixelRatio || 1, 2));
    cv.width = cv.height = upg.size;
    upg.ctx = cv.getContext('2d');

    // Статичные слои колеса и отдельная стрелка для композиторной анимации.
    // Позиционирование слоёв задаём инлайн-стилями: без них (если CSS
    // .upg-stack/.upg-layer не подхватился) канвасы идут друг под другом,
    // текст/стрелка уезжают за экран, а кнопки ставки оказываются на несколько
    // экранов ниже — со стороны выглядит как «апгрейдер не работает».
    const stack = document.createElement('div');
    stack.className = 'upg-stack';
    stack.style.position = 'relative';
    stack.style.width = '100%';
    stack.style.maxWidth = '420px';
    stack.style.margin = '0 auto';
    stack.style.aspectRatio = '1 / 1';
    cv.parentNode.insertBefore(stack, cv);
    stack.appendChild(cv);
    const layerStyle = (c) => {
        c.style.position = 'absolute';
        c.style.left = '0';
        c.style.top = '0';
        c.style.width = '100%';
        c.style.height = '100%';
        c.style.display = 'block';
        c.style.maxWidth = 'none';
        c.style.margin = '0';
    };
    cv.classList.add('upg-layer');
    layerStyle(cv);
    const mk = (name) => {
        const c = document.createElement('canvas');
        c.width = c.height = upg.size;
        c.className = 'upg-layer upg-layer-' + name;
        c.setAttribute('aria-hidden', 'true');
        layerStyle(c);
        c.style.pointerEvents = 'none';
        stack.appendChild(c);
        return c;
    };
    upg.hotCv = mk('hot'); upg.hotCv.style.opacity = '0'; upg.hotCtx = upg.hotCv.getContext('2d');
    upg.loseCv = mk('lose'); upg.loseCtx = upg.loseCv.getContext('2d');
    upg.stack = stack;
    const center = document.createElement('div');
    center.className = 'upg-center';
    center.innerHTML = `<svg class="upg-emblem" viewBox="0 0 64 58" aria-hidden="true"><path d="M32 25 56 40V55L32 40 8 55V40Z" fill="#7f670d"/><path d="M32 0 64 20V38L32 18 0 38V20Z" fill="#ffd80d"/></svg><strong class="upg-center-value"></strong><span class="upg-center-coef"></span><small class="upg-center-caption"></small>`;
    stack.appendChild(center);
    upg.center = center;
    upg.centerValue = center.querySelector('.upg-center-value');
    upg.centerCoef = center.querySelector('.upg-center-coef');
    upg.centerCaption = center.querySelector('.upg-center-caption');
    const rotor = document.createElement('div');
    rotor.className = 'upg-rotor';
    rotor.setAttribute('aria-hidden','true');
    const arrowSvg = (sfx) => `<svg viewBox="0 0 720 720"><defs><linearGradient id="upg-arrow-gold${sfx}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe45a"/><stop offset=".55" stop-color="#ffcf1a"/><stop offset="1" stop-color="#ffc000"/></linearGradient></defs><g transform="translate(360 151) scale(.225) rotate(12.9) translate(-358 -570)"><path d="M130 277 262 250 362 568Z" fill="#a67c10" fill-opacity=".55"/><path d="M433 205 346 232 358 570Z" fill="#a67c10" fill-opacity=".5"/><path d="M243 68 312 277 353 226 358 572 207 257 268 283Z" fill="url(#upg-arrow-gold${sfx})"/><path d="M312 277 353 226 358 572 318 330Z" fill="#f2b300"/><path d="M244 70 276 270 358 570 320 330Z" fill="#fff6ae" fill-opacity=".85"/></g></svg>`;
    rotor.innerHTML = arrowSvg('');
    // призраки стрелки для следа при вращении: лежат под основной стрелкой, без тяжёлого drop-shadow
    upg.ghosts = UPG_SPIN.trail.map((_, gi) => {
        const el = document.createElement('div');
        el.className = 'upg-rotor upg-ghost';
        el.setAttribute('aria-hidden', 'true');
        el.style.opacity = '0';
        el.innerHTML = arrowSvg('-g' + gi);
        stack.appendChild(el);
        return { el, anim: null };
    });
    stack.appendChild(rotor);
    upg.rotor = rotor;
    if (typeof ResizeObserver !== 'undefined') {
        upg.resizeObserver = new ResizeObserver(entries => {
            const width = entries[0].contentRect.width;
            const size = Math.round(Math.max(240, Math.min(420,width)) * Math.min(window.devicePixelRatio || 1,2));
            if (!width || size === upg.size) return;
            upg.size = size;
            for (const layer of [upg.cv, upg.hotCv, upg.loseCv]) layer.width = layer.height = size;
            upg.wheel = null; upg.scenes = {};
            upg.sceneKey = upg.textKey = upg.hotKey = null;
            upgDraw();
            if (upg.stack.classList.contains('is-lose')) upgPaintLose(upg.loseChance || upg.chance);
        });
        upg.resizeObserver.observe(stack);
    }
    upg.sceneKey = null; upg.textKey = null; upg.hotKey = null; upg.glowVal = -1; upg.betC = null;
    upg.shown = upg.chance; upg.chRaf = 0;
    upgBindSlider();
}

// Слайдер на pointer-событиях: палец ведёт ползунок напрямую, браузер ничего не перехватывает.
function upgBindSlider() {
    if (upg.sliderBound) return;
    const ctl = document.querySelector('.upg-slider-control');
    if (!ctl) return;
    upg.sliderBound = true;
    let pid = null, offset = 0;
    const span = () => { const r = ctl.getBoundingClientRect(); return { left: r.left + 18, w: Math.max(1, r.width - 36) }; };
    const valueAt = (clientX) => {
        const { left, w } = span();
        const p = Math.max(0, Math.min(1, (clientX + offset - left) / w));
        return UPG_MIN_CHANCE + p * (UPG_MAX_CHANCE - UPG_MIN_CHANCE);
    };
    ctl.addEventListener('pointerdown', (e) => {
        if (upg.busy || pid !== null) return;
        pid = e.pointerId;
        try { ctl.setPointerCapture(pid); } catch (_) {}
        const { left, w } = span();
        const thumbX = left + (upg.shown - UPG_MIN_CHANCE) / (UPG_MAX_CHANCE - UPG_MIN_CHANCE) * w;
        offset = Math.abs(e.clientX - thumbX) <= 32 ? thumbX - e.clientX : 0;
        ctl.classList.add('is-drag');
        upgSliderInput(valueAt(e.clientX));
        e.preventDefault();
    });
    ctl.addEventListener('pointermove', (e) => {
        if (e.pointerId !== pid) return;
        upgSliderInput(valueAt(e.clientX));
        e.preventDefault();
    });
    const end = (e) => {
        if (e.pointerId !== pid) return;
        pid = null;
        try { ctl.releasePointerCapture(e.pointerId); } catch (_) {}
        ctl.classList.remove('is-drag');
        upgSliderEnd();
    };
    ctl.addEventListener('pointerup', end);
    ctl.addEventListener('pointercancel', end);
    ctl.addEventListener('lostpointercapture', end);
}

function upgRefresh(resetResult = true, src) {
    if (window.WXG?.on) WXG.sync(src === 'bet');   // режим подарков: ставка и шанс связаны через цену подарка
    if (resetResult) upgFadeOut();     // стрелка остаётся где упала, свечение гаснет плавно
    document.querySelectorAll('.upg-chance-row .pct-btn').forEach(b =>
        b.classList.toggle('active', Number(b.dataset.chance) === upg.chance));
    const chanceInput = document.getElementById('upgChanceInput');
    if (chanceInput && document.activeElement !== chanceInput) chanceInput.value = upg.chance;

    upgSyncSlider();
    const bet = upgBet() || MIN_BET;
    const { payout, coef } = upgCalc(bet, upg.chance);
    const info = document.getElementById('upgInfo');
    if (info) {
        // строка «Коэффициент … · при победе …» убрана навсегда; остаётся только предупреждение о минимальной ставке
        info.textContent = payout > bet
            ? ''
            : `При шансе ${upg.chance}% минимальная ставка — ${upgMinBet(upg.chance).toFixed(2)} $`;
    }
    if (resetResult) upgHideResultText();
    upgDraw();
    if (upg.shown !== upg.chance && !upg.sliding) upgChanceAnim();      // сектор плавно догоняет новый шанс
}

// Плавно гасит свечение кольца и итог прошлого раунда (без резкого сброса)
function upgFadeOut() {
    cancelAnimationFrame(upg.fadeRaf);
    if (upg.busy) return;
    upg.result = null;
    upg.fade = 1;
    upg.glow = 0;
    upg.stack?.classList.remove('is-win','is-lose');
}

// Визуал слайдера (заливка + ползунок) двигаем дробным значением — без «ступенек»
function upgPaintSlider(v) {
    const ctl = upg.sliderCtl || (upg.sliderCtl = document.querySelector('.upg-slider-control'));
    if (!ctl) return;
    const p = Math.max(0, Math.min(1, (v - UPG_MIN_CHANCE) / (UPG_MAX_CHANCE - UPG_MIN_CHANCE)));
    ctl.style.setProperty('--upg-progress', (p * 100).toFixed(3) + '%');
    ctl.style.setProperty('--upg-p', p.toFixed(4));
    const out = upg.sliderOut || (upg.sliderOut = document.getElementById('upgChanceValue'));
    const txt = Math.round(v) + '%';
    if (out && out.textContent !== txt) out.textContent = txt;
}

function upgSyncSlider() {
    const slider = document.getElementById('upgChanceSlider');
    if (!slider) return;
    slider.disabled = upg.busy;
    slider.setAttribute('aria-valuetext', `${upg.chance}%`);
    if (!upg.sliding && upg.shown === upg.chance) {
        slider.value = String(upg.chance);
        upgPaintSlider(upg.chance);
    }
    document.getElementById('upgStateLabel').textContent = upg.busy ? 'ВРАЩЕНИЕ' : 'ГОТОВ К АПГРЕЙДУ';
}

// Слайдер: во время движения пальца ничего не округляем и не пересобираем —
// ползунок и сектор идут за значением ровно, тяжёлая часть — раз в кадр.
function upgSliderInput(v) {
    if (upg.busy) return;
    const raw = Math.max(UPG_MIN_CHANCE, Math.min(UPG_MAX_CHANCE, parseFloat(v)));
    if (!isFinite(raw)) return;
    upg.sliding = true;
    cancelAnimationFrame(upg.chRaf); upg.chRaf = 0;
    upgPaintSlider(raw);
    const c = Math.round(raw);
    if (c !== upg.chance) { upg.chance = c; upg.pendingRefresh = true; }
    upg.shown = raw;
    if (!upg.sliderRaf) upg.sliderRaf = requestAnimationFrame(() => {
        upg.sliderRaf = 0;
        if (upg.pendingRefresh) { upg.pendingRefresh = false; upgRefresh(true); } else upgDraw();
    });
}

// Отпустили — ползунок мягко «доезжает» до целого процента
function upgSliderEnd() {
    if (!upg.sliding) return;
    upg.sliding = false;
    cancelAnimationFrame(upg.sliderRaf); upg.sliderRaf = 0;
    upg.pendingRefresh = false;
    if (upg.busy) return;
    upgRefresh(true);
}

function upgSliderKey(e) {
    const d = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -5, PageUp: 5 }[e.key];
    if (d) { e.preventDefault(); upgAdjustChance(d); }
    else if (e.key === 'Home') { e.preventDefault(); upgSetChance(UPG_MIN_CHANCE); }
    else if (e.key === 'End') { e.preventDefault(); upgSetChance(UPG_MAX_CHANCE); }
}

let upgResTimer = 0;
function upgHideResultText() {
    const res = document.getElementById('upgResult');
    if (!res || !res.textContent) return;
    res.style.transition = 'opacity .35s ease';
    res.style.opacity = '0';
    clearTimeout(upgResTimer);
    upgResTimer = setTimeout(() => { res.textContent = ''; res.className = 'upg-result'; }, 360);
}

function openUpgrader() {
    showPage('upgraderPage');
    updateNav('games');
    upgInit();
    window.WXG?.paint();
    if (!upg.busy) {
        upgRefresh(true);
        window.WXG?.refresh();
    }
}

function upgSetChance(c) {
    if (upg.busy) return;
    c = parseInt(c, 10);
    if (!isFinite(c)) return;
    upg.chance = Math.max(UPG_MIN_CHANCE, Math.min(UPG_MAX_CHANCE, c));
    upgRefresh(true);
}

function upgAdjustChance(delta) { upgSetChance(upg.chance + delta); }

function upgBetFactor(f) {
    if (upg.busy) return;
    applyBetFactor(document.getElementById('upgBetInput'), f);
    upgRefresh(true, 'bet');
}

function upgBetMax() {
    if (upg.busy) return;
    applyBetMax(document.getElementById('upgBetInput'));
    upgRefresh(true, 'bet');
}

function upgOnBetInput() {
    if (upg.busy) return;
    upgRefresh(true, 'bet');
}

function upgOnChanceInput(commit) {
    if (upg.busy) return;
    const input = document.getElementById('upgChanceInput');
    const v = parseInt(input.value, 10);
    if (isFinite(v) && (commit || (v >= UPG_MIN_CHANCE && v <= UPG_MAX_CHANCE))) {
        upg.chance = Math.max(UPG_MIN_CHANCE, Math.min(UPG_MAX_CHANCE, v));
        upgRefresh(true);
    }
    if (commit) input.value = upg.chance;
}

function upgRelease(label = 'ИГРАТЬ') {
    upg.busy = false;
    isBetProcessing = false;
    unlockEconomy();
    const btn = document.getElementById('upgPlayBtn');
    if (btn) { btn.disabled = false; btn.textContent = label; btn.removeAttribute('aria-busy'); }
    document.getElementById('upgraderPage')?.classList.remove('upg-locked');
    document.body.classList.remove('upg-spinning');
    upgSyncSlider();
    upgSyncBetInput();
}

// Ставку, бросок и выплату делает Supabase (upgrader_play), клиент только показывает итог
async function upgApi(bet, chance) {
    return crashRpc('upgrader_play', { p_bet: bet, p_chance: chance, p_request: crypto.randomUUID() });
}

async function playUpgrader() {
    if (window.WXG?.on) return WXG.play();
    if (upg.busy || isBetProcessing || isEconomyLocked) return;
    const bet = upgBet(), chance = upg.chance;
    if (bet < MIN_BET) return showMessage('Минимальная ставка — 0.10 $!');
    if (bet > currentBalance) return showMessage('Недостаточно средств на балансе!');
    const { payout, coef } = upgCalc(bet, chance);
    if (payout <= bet) return showMessage(`При шансе ${chance}% минимальная ставка — ${upgMinBet(chance).toFixed(2)} $. Увеличьте ставку или уменьшите шанс.`);
    if (!lockEconomy()) return;

    upg.busy = true;
    isBetProcessing = true;
    upgSyncSlider();
    upgSyncBetInput();

    const btn = document.getElementById('upgPlayBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Вращение...'; btn.setAttribute('aria-busy', 'true'); }
    document.getElementById('upgraderPage')?.classList.add('upg-locked');
    document.body.classList.add('upg-spinning');

    try {
        const snapshot = snapshotBalanceState();
        currentTurnover = roundMoney(currentTurnover + bet); currentBetsCount++;
        setUIBalance(roundMoney(currentBalance - bet));

        const srv = await upgApi(bet, chance);
        if (!srv || !srv.ok) {
            restoreBalanceState(snapshot);
            showMessage((srv && srv.error) || 'Не удалось сыграть. Проверьте соединение и попробуйте снова.');
            return;
        }
        const win = !!srv.win;
        const credited = win ? roundMoney(srv.payout) : 0;
        upg.resultPayout = credited;
        const srvCoef = Number(srv.coef);
        // на экране сначала показываем баланс после списания ставки,
        // а выигрыш раскрываем, когда колесо остановилось
        setUIBalance(roundMoney(Number(srv.balance) - credited));

        if (win) {
            currentTotalWin = roundMoney(currentTotalWin + credited);
            currentWinsCount++;
            if (srvCoef > currentMaxWin) currentMaxWin = srvCoef;
        }

        const liveBet = broadcastLiveBet(bet, 'Апгрейдер');
        const res = document.getElementById('upgResult');
        upgHideResultText();      // старый итог плавно гаснет, кольцо и стрелка — внутри upgAnimate
        await upgAnimate(win, chance);

        setUIBalance(Number(srv.balance));
        liveBet?.then(id => resolveLiveBetWin(id, bet, credited));

        window.haptic(credited > 0 ? 'success' : 'error');
        if (credited > 0) window.showWinPopup?.(credited, srvCoef);
        if (res) {
            clearTimeout(upgResTimer);
            res.style.opacity = '1';
            res.textContent = credited > 0 ? `Победа! +${credited.toFixed(2)} $ (x${srvCoef.toFixed(2)})` : 'Не повезло. Попробуйте ещё раз';
            res.className = 'upg-result ' + (credited > 0 ? 'win' : 'lose');
        }
    } finally {
        upgRelease();
    }
}


function upgSyncBetInput() {
    const input = document.getElementById('upgBetInput');
    if (input) input.disabled = upg.busy;
}


// ============================================================
// АПГРЕЙДЕР ПОДАРКАМИ — тот же интерфейс, что и у апгрейдера на $:
// то же колесо, слайдер и панель ставки. В центре колеса — выбранный подарок
// (пока не выбран — значок «выбрать подарок»), цены везде в $.
// Ставка: $ с баланса или свой подарок из инвентаря. Подарок из инвентаря
// можно продать (−13% от цены). Раунд считает сервер, клиент только показывает итог.
// ============================================================
(function () {
    'use strict';
    const page = document.getElementById('upgraderPage');
    if (!page) return;
    const $ = (id) => document.getElementById(id);
    const tgApp = window.Telegram?.WebApp;
    const G = window.WXG = { on: true, key: '', sync() {}, center() {}, play() {} };

    // ---------- цены ----------
    // Цена в игре = 97% от флора. Курс GRAM→$ и цены приходят с сервера (gift_upgrade_state);
    // запасные значения нужны, только пока сервер не ответил.
    const DISCOUNT = 0.97, GRAM_USD_FALLBACK = 1.06;
    let gramUsd = GRAM_USD_FALLBACK, rateFromServer = false;
    const snapshot = [
        ['xmasstocking', 'Xmas Stocking', 5], ['candycane', 'Candy Cane', 5], ['lolpop', 'Lol Pop', 5],
        ['cookieheart', 'Cookie Heart', 6], ['stellarrocket', 'Stellar Rocket', 6],
        ['lightsword', 'Light Sword', 7], ['bowtie', 'Bow Tie', 7],
        ['moonpendant', 'Moon Pendant', 8], ['snowglobe', 'Snow Globe', 8],
        ['bunnymuffin', 'Bunny Muffin', 10], ['finepen', 'Fine Pen', 10],
        ['hangingstar', 'Hanging Star', 11], ['tophat', 'Top Hat', 12],
        ['lovecandle', 'Love Candle', 13], ['sakuraflower', 'Sakura Flower', 14],
        ['recordplayer', 'Record Player', 15], ['lovepotion', 'Love Potion', 18],
        ['cupidcharm', 'Cupid Charm', 29], ['rarebird', 'Rare Bird', 33],
        ['toybear', 'Toy Bear', 40], ['diamondring', 'Diamond Ring', 41],
        ['genielamp', 'Genie Lamp', 44], ['swisswatch', 'Swiss Watch', 72],
        ['lootbag', 'Loot Bag', 159], ['astralshard', 'Astral Shard', 167]
    ];
    let prices = new Map(snapshot.map(([slug, name, price]) => [slug, { slug, name, price }]));
    const listed = new Map();
    let serverCatalog = new Map();     // slug → цена в центах (с сервера)
    let liveOffers = new Map();
    let inventory = [];
    let inventoryLoaded = false, inventoryRevision = 0;
    let lastErr = '', liveReady = false, liveLoad = null, loadedAt = 0, catalogAsked = false, priceReq = null, rateAsked = false;
    let targetSlug = null, view = 'catalog', pending = null, stakeId = null, cashCents = null, itemId = null, busy = false, stakeKey = '';
    const roundKey = 'wxs-gift-round:' + (tgApp?.initDataUnsafe?.user?.id ?? 'anon');
    try { pending = JSON.parse(sessionStorage.getItem(roundKey) || 'null'); } catch { pending = null; }
    targetSlug = pending?.slug || null;

    const pretty = (slug) => slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : '';
    const giftBy = (slug) => prices.get(slug) || listed.get(slug) || { slug, name: pretty(slug) };
    const offerOf = (slug) => {
        const o = liveOffers.get(slug);
        return o && Date.parse(o.expires_at) > Date.now() ? o : null;
    };
    const centsOf = (g) => {
        const o = offerOf(g.slug);
        if (o) return o.price_cents;
        const c = serverCatalog.get(g.slug);
        if (c) return c;
        return Number.isFinite(g.price) ? Math.max(100, Math.round(g.price * gramUsd * DISCOUNT * 100)) : null;
    };
    const usd = (g) => { const c = centsOf(g); return c == null ? null : c / 100; };
    const money = (v) => v == null ? '—' : (Math.round(v * 100) / 100).toFixed(2) + ' $';
    const moneyC = (c) => c == null ? '—' : money(c / 100);
    const stakeFor = (cents, chance) => Math.max(1, Math.ceil(cents * chance / 95));
    const sellCents = (g) => { const c = centsOf(g); return c == null ? null : Math.floor(c * 87 / 100); };
    const stakeItem = () => inventory.find((i) => i.id === stakeId) || null;
    const inventoryItem = (id, slug) => ({ ...giftBy(slug), id });

    function target() {
        if (!targetSlug) return null;
        const g = giftBy(targetSlug);
        const offer = offerOf(targetSlug);
        const cents = centsOf(g);
        return { ...g, offer, usd: cents == null ? null : cents / 100, cents };
    }

    async function fetchRate() {
        if (rateAsked || rateFromServer) return;
        rateAsked = true;
        try {
            const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd', { signal: AbortSignal.timeout(5000) });
            const v = (await r.json())?.['the-open-network']?.usd;
            if (Number.isFinite(v) && v > 0.05 && v < 50 && !rateFromServer) { gramUsd = v; paint(); }
        } catch { /* остаётся запасной курс */ }
    }

    // ---------- сервер ----------
    async function rpc(name, args = {}) {
        const response = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + name, {
            method: 'POST',
            headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ p_init: tg?.initData || '', ...args }),
            signal: AbortSignal.timeout(8000)
        });
        const data = await response.json();
        if (!response.ok) {
            const e = new Error(data.message || 'request_failed');
            e.retry = response.status >= 500 || response.status === 401 || response.status === 429 || /^AUTH:/.test(e.message);
            throw e;
        }
        return data;
    }

    function refreshLive() {
        if (liveLoad) return liveLoad;
        const revision = inventoryRevision;
        liveLoad = (async () => {
            try {
                const state = await rpc('gift_upgrade_state');
                if (!Array.isArray(state?.pending_gifts)) throw new Error('invalid_inventory');
                liveOffers = new Map();
                for (const o of state.offers || []) if (!liveOffers.has(o.gift_slug)) liveOffers.set(o.gift_slug, o);
                serverCatalog = new Map((state.catalog || []).map((c) => [c.slug, Number(c.price_cents)]));
                const rate = Number(state.rate);
                if (rate > 0.05 && rate < 50) { gramUsd = rate; rateFromServer = true; }
                if (revision === inventoryRevision) {
                    inventory = state.pending_gifts.map((g) => inventoryItem(g.request_id, g.gift_slug));
                    inventoryLoaded = true;
                    if (stakeId && !stakeItem()) stakeId = null;
                }
                liveReady = true;
                lastErr = '';
            } catch (e) { liveReady = false; lastErr = String(e?.message || e || 'ошибка'); }
            finally { liveLoad = null; paint(); if (dlg.open) renderDialog(); }
        })();
        if (dlg.open && view !== 'catalog' && view !== 'item') renderDialog();
        return liveLoad;
    }

    function refreshAfterInventoryChange(removedId, wonGift) {
        inventoryRevision++;
        inventory = inventory.filter((g) => g.id !== removedId && g.id !== wonGift?.id);
        if (wonGift) inventory.unshift(wonGift);
        if (removedId && stakeId === removedId) stakeId = null;
        const refresh = liveLoad ? liveLoad.then(refreshLive) : refreshLive();
        paint();
        if (dlg.open) renderDialog();
        return refresh;
    }

    function parsePrices(csv) {
        const [header, ...lines] = csv.trim().split(/\r?\n/);
        const cols = header.replace(/^\uFEFF/, '').split(',');
        const di = cols.indexOf('date'), si = cols.indexOf('collection_slug'), ni = cols.indexOf('collection_name'), pi = cols.indexOf('floor_gram');
        if ([di, si, ni, pi].includes(-1)) throw new Error('format');
        const latest = new Map();
        for (const line of lines) {
            const cells = line.match(/(?:^|,)(?:"(?:[^"]|"")*"|[^,]*)/g)?.map((cell, i) => {
                const v = i ? cell.slice(1) : cell;
                return v.startsWith('"') ? v.slice(1, -1).replaceAll('""', '"') : v;
            });
            if (!cells) continue;
            const date = cells[di], slug = cells[si]?.toLowerCase().replace(/[^a-z0-9]/g, ''), name = cells[ni], price = Number(cells[pi]);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !slug || !name || !(price > 0)) continue;
            if ((latest.get(slug)?.date ?? '') > date) continue;
            latest.set(slug, { slug, name, price, date });
        }
        if (!latest.size) throw new Error('empty');
        return latest;
    }

    function refreshPrices() {
        if (priceReq || Date.now() - loadedAt < 15 * 60000) return;
        priceReq = (async () => {
            try {
                const r = await fetch('https://tggifts.com/data/floors-daily.csv', { signal: AbortSignal.timeout(6500) });
                if (!r.ok) throw new Error('http');
                const latest = parsePrices(await r.text());
                const newest = [...latest.values()].reduce((d, g) => g.date > d ? g.date : d, '');
                prices = new Map([...latest].filter(([, g]) => g.date === newest));
                loadedAt = Date.now();
            } catch { /* остаются сохранённые цены */ }
            finally { priceReq = null; paint(); if (dlg.open) renderDialog(); }
        })();
    }

    async function refreshCatalog() {
        if (catalogAsked) return;
        catalogAsked = true;
        try {
            const r = await fetch('https://api.changes.tg/gifts', { signal: AbortSignal.timeout(6500) });
            if (!r.ok) throw new Error('http');
            const body = await r.json();
            const names = Array.isArray(body) ? body : body.gifts;
            if (!Array.isArray(names)) throw new Error('format');
            for (const entry of names) {
                const name = typeof entry === 'string' ? entry : entry?.name;
                const slug = name?.toLowerCase().replace(/[^a-z0-9]/g, '');
                if (slug) listed.set(slug, { slug, name });
            }
            if (dlg.open) renderDialog();
        } catch { catalogAsked = false; }
    }

    // ---------- картинки ----------
    function imageFor(g, lazy) {
        const img = document.createElement('img');
        img.alt = '';
        img.loading = lazy ? 'lazy' : 'eager';
        img.decoding = 'async';
        img.addEventListener('error', () => {
            img.addEventListener('error', () => {
                const f = document.createElement('span');
                f.className = 'wxs-gift-fallback';
                f.textContent = '🎁';
                img.replaceWith(f);
            }, { once: true });
            img.src = 'https://api.changes.tg/original/' + encodeURIComponent(g.slug) + '.png?size=256';
        }, { once: true });
        img.src = 'https://nft.fragment.com/gift/' + encodeURIComponent(g.slug) + '-1.large.jpg';
        return img;
    }

    // ---------- центр колеса ----------
    const PICK_SVG = '<svg class="wxs-gift-svg" viewBox="0 0 96 96" aria-hidden="true"><rect x="4" y="4" width="88" height="88" rx="18" fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="9 8" stroke-linecap="round"/><path d="M48 36C33 39 25 32 29 25c4-8 14-6 19 11Zm0 0c15 3 23-4 19-11-4-8-14-6-19 11Z" fill="none" stroke="currentColor" stroke-width="5.7" stroke-linejoin="round"/><path d="M22 36h52a5 5 0 0 1 5 5v7a5 5 0 0 1-5 5H22a5 5 0 0 1-5-5v-7a5 5 0 0 1 5-5Zm0 22h52v15a8 8 0 0 1-8 8H30a8 8 0 0 1-8-8Z" fill="currentColor"/><path d="M48 40v44" stroke="var(--wxs-hole,#1b1b20)" stroke-width="7" stroke-linecap="round"/></svg>';
    let artSlug = null;

    function ensureCenter() {
        if (!upg.center) return null;
        let pick = upg.center.querySelector('.wxs-gift-pick');
        if (!pick) {
            pick = document.createElement('button');
            pick.type = 'button';
            pick.className = 'wxs-gift-pick';
            pick.setAttribute('aria-label', 'Выбрать подарок');
            pick.innerHTML = PICK_SVG + '<span class="wxs-gift-art"></span>';
            pick.addEventListener('click', () => { if (G.on && !upg.busy) openDialog('catalog'); });
            upg.center.appendChild(pick);
        }
        return pick;
    }

    function paint() {
        const pick = ensureCenter();
        const t = target();
        if (pick) {
            const slot = pick.querySelector('.wxs-gift-art');
            if ((t?.slug || null) !== artSlug) {
                artSlug = t?.slug || null;
                slot.replaceChildren(...(t ? [imageFor(t)] : []));
            }
        }
        upg.center?.classList.toggle('gift-empty', !t);
        $('wxsGiftCount').textContent = inventoryLoaded || inventory.length ? inventory.length : '—';
        paintStake();
        G.key = (t?.slug || '') + ':' + (t?.cents ?? '') + ':' + (stakeId || '') + ':' + (cashCents || '') + ':' + (liveReady ? 1 : 0);
        upg.textKey = null;
        if (upg.ctx) upgDraw();
    }

    // Две карточки: «ТВОЯ СТАВКА» → «АПГРЕЙД ДО»
    const TETHER_SVG = '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#26A17B"/><rect x="8" y="8" width="16" height="3.6" rx="1.2" fill="#fff"/><rect x="14.2" y="8" width="3.6" height="16.5" rx="1.2" fill="#fff"/><ellipse cx="16" cy="15.4" rx="8.6" ry="2.6" fill="none" stroke="#fff" stroke-width="1.8"/></svg>';

    function slotRaw(caption, imgNode, nameText, priceText, onClick, isEmpty) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'wxs-stake-slot' + (isEmpty ? ' is-empty' : '');
        const cap = document.createElement('small');
        cap.textContent = caption;
        const img = document.createElement('span');
        img.className = 'wxs-stake-img';
        if (imgNode) img.append(imgNode); else img.textContent = '＋';
        const name = document.createElement('strong');
        name.textContent = nameText;
        const price = document.createElement('em');
        price.textContent = priceText || '';
        b.append(cap, img, name, price);
        b.addEventListener('click', onClick);
        return b;
    }
    function slotEl(g, caption, onClick) {
        return g ? slotRaw(caption, imageFor(g, true), g.name, money(usd(g)), onClick, false)
                 : slotRaw(caption, null, 'Выбрать', '', onClick, true);
    }
    function cashSlot(onClick) {
        const holder = document.createElement('span');
        holder.className = 'wxs-tether';
        holder.innerHTML = TETHER_SVG;
        return slotRaw('ТВОЯ СТАВКА', holder, 'Баланс', money(cashCents / 100), onClick, false);
    }

    function paintStake() {
        const box = $('wxsStakeBox');
        if (!box) return;
        const st = stakeItem(), t = target();
        page.classList.toggle('gift-stake', !!st);
        const key = [st?.id, st?.slug, st ? centsOf(st) : '', st ? '' : cashCents, t?.slug, t?.cents].join('|');
        if (key === stakeKey && box.childElementCount) return;      // ничего не изменилось — не перерисовываем картинки
        stakeKey = key;
        const arrow = document.createElement('span');
        arrow.className = 'wxs-stake-arrow';
        arrow.textContent = '→';
        const mine = () => { if (!upg.busy && !isEconomyLocked) openSheet(); };
        const left = st ? slotEl(st, 'ТВОЯ СТАВКА', mine) : cashCents > 0 ? cashSlot(mine) : slotEl(null, 'ТВОЯ СТАВКА', mine);
        const right = slotEl(t, 'АПГРЕЙД ДО', () => { if (!upg.busy) openDialog('catalog'); });
        box.replaceChildren(left, arrow, right);
    }

    // Ставка и шанс связаны через цену подарка: шанс = 95% · ставка / цена
    G.sync = (fromBet) => {
        const t = target();
        const input = $('upgBetInput');
        const st = stakeItem();
        if (st) {
            const v = centsOf(st);
            if (v && t?.cents) upg.chance = Math.max(UPG_MIN_CHANCE, Math.min(UPG_MAX_CHANCE, Math.round(95 * v / t.cents)));
            if (v && input) input.value = (v / 100).toFixed(2);
            return;
        }
        if (!t?.cents) return;
        const clampChance = (v) => Math.max(UPG_MIN_CHANCE, Math.min(UPG_MAX_CHANCE, v));
        if (fromBet) {
            let b = Math.round((parseFloat(input.value) || 0) * 100);
            if (b > 0) {
                const top = stakeFor(t.cents, UPG_MAX_CHANCE);
                if (cashCents != null && b > top) {         // ставка больше, чем нужно для шанса 90% — режем до максимума
                    b = cashCents = top;
                    input.value = (top / 100).toFixed(2);
                    paintStake();
                }
                upg.chance = clampChance(Math.round(95 * b / t.cents));
            }
        } else if (cashCents != null) {                  // двигаем шанс слайдером — ставка пересчитывается
            const derived = clampChance(Math.round(95 * cashCents / t.cents));
            if (derived !== upg.chance) {                // шанс не менялся — выбранную сумму не трогаем
                cashCents = stakeFor(t.cents, upg.chance);
                input.value = (cashCents / 100).toFixed(2);
                paintStake();
            }
        }
    };

    G.center = (outcome) => {
        const t = target();
        upg.center.classList.toggle('gift-empty', !t);
        if (!t) return;
        if (outcome === 'win') {
            upg.centerCoef.textContent = t.name;
            upg.centerCaption.textContent = 'В ИНВЕНТАРЕ';
        } else if (!outcome && t.usd && upg.betC > 0) {
            upg.centerCoef.textContent = 'x' + (t.usd / upg.betC).toFixed(2);
        }
    };

    function choose(slug) {
        if (liveReady && liveOffers.size && !liveOffers.has(slug)) {
            showMessage('Этот подарок сейчас недоступен для апгрейда. Выберите другой.');
            return;
        }
        targetSlug = slug;
        paint();
        upgRefresh(true, !stakeItem() && cashCents > 0 ? 'bet' : undefined);
        if (dlg.open) dlg.close();
    }

    function setStake(id) {
        stakeId = id;
        if (id) cashCents = null;
        const st = stakeItem(), t = target();
        if (st && t && centsOf(t) <= centsOf(st)) targetSlug = null;   // цель должна быть дороже своего подарка
        paint();
        upgRefresh(true);
        if (dlg.open) dlg.close();
        if (st && !targetSlug) openDialog('catalog');
    }

    // ---------- раунд ----------
    function storePending(round) {
        pending = round;
        try { round ? sessionStorage.setItem(roundKey, JSON.stringify(round)) : sessionStorage.removeItem(roundKey); } catch {}
    }

    const ERR = {
        insufficient_balance: 'Недостаточно средств на балансе!',
        gift_not_found: 'Этот подарок уже недоступен.',
        gift_unavailable: 'Подарок сейчас недоступен. Обновите цену и попробуйте ещё раз.',
        invalid_gift_stake: 'Эта ставка не подходит для выбранного подарка.'
    };

    G.refresh = () => { if (G.on) refreshLive(); };
    G.refreshAlways = () => refreshLive();
    G.imageFor = imageFor; G.giftBy = giftBy; G.money = money;
    G.openInventory = () => openDialog('inventory');
    G.count = () => inventory.length;
    G.paint = () => paint();
    G.play = async () => {
        if (upg.busy || isBetProcessing || isEconomyLocked) return;
        const resume = pending?.round ? pending : null;
        let t = target();
        if (!resume && !stakeItem() && !(cashCents > 0)) return openSheet();
        if (!resume && !t) return openDialog('catalog');
        if (!resume && (!t.offer || !liveReady)) {
            await refreshLive();
            if (!G.on || upg.busy || page.classList.contains('hidden')) return;
            t = target();
        }
        if (!resume && !t?.offer) {
            if (lastErr) return showMessage('Не удалось загрузить цену подарка. Попробуйте ещё раз.\n\nСервер: ' + lastErr);
            const nm = t?.name || targetSlug;
            targetSlug = null;           // на этот подарок сервер не даёт котировку — сбрасываем выбор
            paint();
            upgRefresh(true);
            showMessage('Подарок «' + nm + '» сейчас недоступен для апгрейда. Выберите другой.');
            return openDialog('catalog');
        }

        const st = stakeItem();
        let fn = 'gift_upgrade_play', body, cash = false;
        if (resume) {
            fn = resume.fn || 'gift_upgrade_play';
            body = resume.round;
        } else if (st) {
            const v = centsOf(st);
            if (!v || v >= t.offer.price_cents) return showMessage('Выбери подарок, который дороже твоего.');
            if (Math.floor(9500 * v / t.offer.price_cents) < 100) return showMessage('Твой подарок слишком дешёвый для этого апгрейда.');
            fn = 'gift_upgrade_play_gift';
            body = { p_request: crypto.randomUUID(), p_quote: t.offer.id, p_stake_round: st.id };
        } else {
            let stake = cashCents || 0;
            stake = Math.min(stake, stakeFor(t.offer.price_cents, UPG_MAX_CHANCE));
            if (!(stake > 0)) return showMessage('Введите ставку.');
            if (Math.floor(9500 * stake / t.offer.price_cents) < 100) return showMessage('Ставка слишком мала для этого подарка.');
            if (stake / 100 > currentBalance + 1e-9) return showMessage('Недостаточно средств на балансе!');
            body = { p_request: crypto.randomUUID(), p_quote: t.offer.id, p_stake_cents: stake };
            cash = true;
        }
        if (!lockEconomy()) return;

        upg.busy = true;
        isBetProcessing = true;
        upgSyncSlider();
        const btn = $('upgPlayBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Вращение...'; btn.setAttribute('aria-busy', 'true'); }
        page.classList.add('upg-locked');
        document.body.classList.add('upg-spinning');

        try {
            const snap = snapshotBalanceState();
            storePending({ round: body, slug: resume ? resume.slug : t.slug, fn });
            if (cash && !resume) setUIBalance(roundMoney(currentBalance - body.p_stake_cents / 100));
            let s;
            try {
                s = await rpc(fn, body);
            } catch (e) {
                if (e.retry === false) storePending(null);
                restoreBalanceState(snap);
                refreshLive();
                showMessage(pending ? 'Не удалось подтвердить результат. Нажмите ещё раз, чтобы проверить ставку.'
                    : ERR[e.message] || 'Ставка не принята. Проверьте наличие подарка и баланс.');
                return;
            }
            storePending(null);
            const won = !!s.won;
            if (s.gift_slug) targetSlug = s.gift_slug;
            upg.resultPayout = 0;
            setUIBalance(Number(s.balance));
            try {
                await upgAnimate(won, upg.chance);
                window.haptic?.(won ? 'success' : 'error');
            } finally {
                const gift = won && s.gift_slug ? inventoryItem(s.request_id || body.p_request, s.gift_slug) : null;
                if (gift || body.p_stake_round) refreshAfterInventoryChange(body.p_stake_round, gift);
                else refreshLive();
            }
        } finally {
            upgRelease(pending ? 'ПРОВЕРИТЬ СТАВКУ' : 'ИГРАТЬ');
        }
    };

    // ---------- каталог, инвентарь, карточка подарка ----------
    const dlg = $('wxsGiftDialog'), list = $('wxsGiftList'), search = $('wxsGiftSearch'), empty = $('wxsGiftEmpty'), itemBox = $('wxsGiftItem'), back = $('wxsGiftBack'), retry = $('wxsGiftRetry');

    function card(g, onPick, opts = {}) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'wxs-gift-card' + (opts.selected ? ' is-selected' : '');
        const frame = document.createElement('span');
        frame.className = 'wxs-gift-img';
        frame.append(imageFor(g, true));
        const name = document.createElement('strong');
        name.textContent = g.name;
        const price = document.createElement('em');
        price.textContent = money(usd(g));
        if (view === 'catalog' && liveReady && liveOffers.size && !liveOffers.has(g.slug)) {
            b.classList.add('is-unquoted');
            price.textContent = money(usd(g)) + ' · скоро';
        }
        b.append(frame, name, price);
        b.addEventListener('click', onPick);
        return b;
    }

    function catalogItems() {
        const all = new Map();
        for (const g of listed.values()) all.set(g.slug, g);
        for (const g of prices.values()) all.set(g.slug, { ...all.get(g.slug), ...g });
        for (const slug of serverCatalog.keys()) if (!all.has(slug)) all.set(slug, giftBy(slug));
        for (const slug of liveOffers.keys()) if (!all.has(slug)) all.set(slug, giftBy(slug));
        let items = [...all.values()].filter((g) => centsOf(g) != null);
        const st = stakeItem();
        if (st) { const v = centsOf(st); items = items.filter((g) => centsOf(g) > v); }   // только то, что дороже твоего подарка
        return items.sort((a, b) => centsOf(a) - centsOf(b) || a.name.localeCompare(b.name));
    }

    function renderItem() {
        const item = inventory.find((i) => i.id === itemId);
        if (!item) { view = 'inventory'; return renderDialog(); }
        const sell = sellCents(item);
        const img = document.createElement('div');
        img.className = 'wxs-item-img';
        img.append(imageFor(item, false));
        const name = document.createElement('h3');
        name.textContent = item.name;
        const price = document.createElement('div');
        price.className = 'wxs-item-price';
        price.textContent = money(usd(item));
        const up = document.createElement('button');
        up.type = 'button';
        up.className = 'wxs-item-btn is-gold';
        up.textContent = 'Апгрейднуть';
        up.addEventListener('click', () => setStake(item.id));
        const sl = document.createElement('button');
        sl.type = 'button';
        sl.className = 'wxs-item-btn';
        sl.textContent = 'Продать за ' + moneyC(sell);
        sl.disabled = sell == null;
        sl.addEventListener('click', async () => {
            if (busy) return;
            const ok = await new Promise((res) => tgApp?.showConfirm
                ? tgApp.showConfirm('Продать ' + item.name + ' за ' + moneyC(sell) + '?', res) : res(true));
            if (!ok || upg.busy) return;
            if (!lockEconomy()) return;
            busy = true; sl.disabled = up.disabled = true;
            try {
                const r = await rpc('gift_upgrade_sell', { p_request: item.id });
                setUIBalance(Number(r.balance));
                window.haptic?.('success');
                view = 'inventory';
                await refreshAfterInventoryChange(item.id);
            } catch (e) {
                showMessage(ERR[e.message] || 'Не удалось продать подарок. Попробуйте ещё раз.');
                await refreshLive();
                sl.disabled = up.disabled = false;
            } finally { busy = false; unlockEconomy(); }
            renderDialog();
        });
        itemBox.replaceChildren(img, name, price, up, sl);
    }

    function renderDialog() {
        const sub = $('wxsGiftSub');
        const isItem = view === 'item';
        const isInventory = view === 'inventory' || view === 'stake';
        const inventoryStatus = isInventory && (liveLoad && !inventoryLoaded ? 'Загружаем подарки…'
            : lastErr && !liveLoad ? 'Не удалось обновить инвентарь' : '');
        retry.hidden = !isInventory || !lastErr || !!liveLoad;
        itemBox.hidden = !isItem;
        back.hidden = !isItem;
        list.hidden = isItem;
        search.hidden = isItem || (view !== 'catalog' && !visibleInventory().length);
        if (isItem) {
            $('wxsGiftTitle').textContent = 'Подарок';
            sub.textContent = '';
            empty.hidden = true;
            return renderItem();
        }
        const q = search.value.trim().toLocaleLowerCase();
        let items;
        if (view === 'catalog') {
            $('wxsGiftTitle').textContent = 'Каталог подарков';
            sub.textContent = '';
            items = catalogItems();
        } else {
            items = visibleInventory();
            $('wxsGiftTitle').textContent = view === 'stake' ? 'Твой подарок' : 'Инвентарь';
            const total = items.reduce((s, g) => s + (usd(g) || 0), 0);
            const summary = items.length && view === 'inventory' ? 'Всего ' + items.length + ' · на ' + money(total) : '';
            sub.textContent = [summary, inventoryStatus].filter(Boolean).join(' · ');
        }
        const filtered = items.filter((g) => g.name.toLocaleLowerCase().includes(q));
        list.replaceChildren(...filtered.map((g) => card(g, () => {
            if (view === 'catalog') choose(g.slug);
            else if (view === 'stake') setStake(g.id);
            else { itemId = g.id; view = 'item'; renderDialog(); }
        }, { selected: view === 'catalog' && g.slug === targetSlug })));
        empty.hidden = filtered.length > 0 || (isInventory && !items.length && (!inventoryLoaded || !!liveLoad || !!lastErr));
        empty.innerHTML = q && items.length ? '<span>🔍</span><p>Ничего не найдено</p>' : '<span>🎁</span><p>' +
            (view === 'catalog' ? 'Подарков пока нет' : view === 'stake' && inventory.length ? 'Нет подходящих подарков' : 'Инвентарь пуст') + '</p>';
    }

    // для выбора своего подарка: только те, что дешевле цели
    function visibleInventory() {
        if (view !== 'stake') return inventory;
        const t = target();
        return t?.cents ? inventory.filter((g) => centsOf(g) < t.cents) : inventory;
    }

    function openDialog(v) {
        view = v;
        search.value = '';
        renderDialog();
        if (!dlg.open) dlg.showModal();
        refreshLive();
        if (v === 'catalog') { refreshPrices(); refreshCatalog(); fetchRate(); }
    }

    $('wxsGiftClose').addEventListener('click', () => dlg.close());
    retry.addEventListener('click', refreshLive);
    back.addEventListener('click', () => openDialog('inventory'));
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    search.addEventListener('input', renderDialog);
    $('wxsGiftInventory').addEventListener('click', () => openDialog('inventory'));
    // ---------- шторка «ТВОЯ СТАВКА»: Баланс | Подарки ----------
    const sheet = $('stkSheet'), stkPanel = $('stkPanel'), stkAmount = $('stkAmount'), stkHint = $('stkHint');
    const stkTabs = [...sheet.querySelectorAll('[data-stk-tab]')];
    let sheetTab = 'cash', sheetGift = null, sheetTimer = 0;

    function sheetTargetCents() { return target()?.cents || null; }

    function updateHint() {
        const t = sheetTargetCents();
        const v = parseFloat(stkAmount.value);
        let text = 'Доступно: ' + money(currentBalance);
        if (t && isFinite(v) && v > 0) {
            const bp = Math.min(9000, Math.floor(9500 * Math.round(v * 100) / t));
            text += bp < 100 ? ' · ставка слишком мала' : ' · шанс ≈ ' + (bp / 100).toFixed(bp % 100 ? 2 : 0) + '%';
        }
        stkHint.textContent = text;
    }

    function renderSheet() {
        stkTabs.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.stkTab === sheetTab)));
        $('stkCash').hidden = sheetTab !== 'cash';
        $('stkGifts').hidden = sheetTab !== 'gift';
        if (sheetTab === 'cash') return updateHint();
        const t = sheetTargetCents();
        const items = inventory.filter((g) => !t || centsOf(g) < t);
        const listEl = $('stkGiftList'), emptyEl = $('stkGiftEmpty');
        listEl.replaceChildren(...items.map((g) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'wxs-gift-card' + (g.id === sheetGift ? ' is-selected' : '');
            const frame = document.createElement('span');
            frame.className = 'wxs-gift-img';
            frame.append(imageFor(g, true));
            const name = document.createElement('strong');
            name.textContent = g.name;
            const price = document.createElement('em');
            price.textContent = money(usd(g));
            b.append(frame, name, price);
            b.addEventListener('click', () => { sheetGift = g.id; window.haptic?.('select'); renderSheet(); });
            return b;
        }));
        emptyEl.hidden = items.length > 0;
        emptyEl.textContent = !inventory.length ? (liveLoad && !inventoryLoaded ? 'Загружаем подарки…' : 'В инвентаре пока нет подарков')
            : 'Нет подарков дешевле выбранного апгрейда';
    }

    function openSheet() {
        if (upg.busy || isEconomyLocked) return;
        clearTimeout(sheetTimer);
        sheetTab = stakeItem() ? 'gift' : 'cash';
        sheetGift = stakeId;
        stkAmount.value = cashCents > 0 ? (cashCents / 100).toFixed(2) : '';
        stkPanel.style.transform = '';
        renderSheet();
        sheet.hidden = false;
        void sheet.offsetWidth;                          // запускаем анимацию выезда
        sheet.classList.add('open');
        refreshLive().then(() => { if (!sheet.hidden) renderSheet(); });
    }
    function closeSheet() {
        sheet.classList.remove('open');
        stkPanel.style.transform = '';
        try { stkAmount.blur(); } catch {}
        clearTimeout(sheetTimer);
        sheetTimer = setTimeout(() => { if (!sheet.classList.contains('open')) sheet.hidden = true; }, 280);
    }
    G.openSheet = openSheet;

    stkTabs.forEach((b) => b.addEventListener('click', () => { sheetTab = b.dataset.stkTab; window.haptic?.('select'); renderSheet(); }));
    stkAmount.addEventListener('input', () => {
        let v = stkAmount.value.replace(',', '.').replace(/[^\d.]/g, '');
        const i = v.indexOf('.');
        if (i >= 0) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, '').slice(0, 2);
        if (v !== stkAmount.value) stkAmount.value = v;
        updateHint();
    });
    sheet.querySelector('.stk-back').addEventListener('click', closeSheet);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) closeSheet(); });

    // свайп вниз по язычку закрывает шторку
    (function dragToClose() {
        const head = sheet.querySelector('.stk-head');
        let y0 = null, dy = 0;
        head.addEventListener('pointerdown', (e) => { y0 = e.clientY; dy = 0; head.setPointerCapture(e.pointerId); stkPanel.classList.add('dragging'); });
        head.addEventListener('pointermove', (e) => {
            if (y0 == null) return;
            dy = Math.max(0, e.clientY - y0);
            stkPanel.style.transform = 'translateY(' + dy + 'px)';
        });
        const end = () => {
            if (y0 == null) return;
            y0 = null;
            stkPanel.classList.remove('dragging');
            if (dy > 80) closeSheet(); else stkPanel.style.transform = '';
        };
        head.addEventListener('pointerup', end);
        head.addEventListener('pointercancel', end);
    })();

    $('stkOk').addEventListener('click', () => {
        if (upg.busy || isEconomyLocked) return closeSheet();
        if (sheetTab === 'gift') {
            if (!sheetGift) return showMessage('Выберите подарок из инвентаря.');
            if (!inventory.some((g) => g.id === sheetGift)) { sheetGift = null; renderSheet(); return showMessage('Этот подарок уже недоступен.'); }
            setStake(sheetGift);
            return closeSheet();
        }
        let cents = Math.round((parseFloat(stkAmount.value) || 0) * 100);
        if (!(cents >= 10)) return showMessage('Минимальная ставка — 0.10 $.');
        if (cents / 100 > currentBalance + 1e-9) return showMessage('Недостаточно средств на балансе!');
        const t = target();
        if (t?.cents) {
            const maxStake = stakeFor(t.cents, UPG_MAX_CHANCE);
            if (cents > maxStake) {
                cents = maxStake;
                toast('Ставка уменьшена до ' + money(cents / 100) + ' — максимальный шанс 90%', '', 3200);
            }
            if (Math.floor(9500 * cents / t.cents) < 100) return showMessage('Ставка слишком мала для этого подарка.');
        }
        stakeId = null;
        cashCents = cents;
        $('upgBetInput').value = (cents / 100).toFixed(2);
        paint();
        upgRefresh(true, 'bet');
        closeSheet();
    });

    // ---------- старт: режим один — апгрейд подарка ----------
    page.classList.add('gift-mode');
    $('wxsGiftInventory').hidden = false;
    $('upgPlayBtn').textContent = pending ? 'ПРОВЕРИТЬ СТАВКУ' : 'ИГРАТЬ';
    clearInterval(G.timer);
    // цены и котировки на сервере обновляются раз в час — подтягиваем, пока открыт апгрейдер
    G.timer = setInterval(() => {
        if (!document.hidden && !upg.busy && !page.classList.contains('hidden')) refreshLive();
    }, 60000);
    paint();
})();
/* =====================================================================
   5. профиль, кейсы, навигация
   ===================================================================== */
const initialOf = (name) => (String(name || '?').trim()[0] || '?').toUpperCase();
function setAvatar(el, url, name) {
  if (!el) return;
  el.replaceChildren();
  const fallback = () => { el.replaceChildren(document.createTextNode(initialOf(name))); };
  if (!url) return fallback();
  const img = new Image();
  img.alt = ''; img.referrerPolicy = 'no-referrer';
  img.onerror = fallback;
  img.src = url;
  el.appendChild(img);
}
let lastProfileKey = '';
function paintProfile(p) {
  const name = p.nickname || p.first_name || 'Игрок';
  const key = [name, p.username, p.photo_url, p.is_premium].join('|');
  if (key !== lastProfileKey) {                    // не перерисовываем аватар без нужды
    lastProfileKey = key;
    setAvatar($('#tAv'), p.photo_url, name); setAvatar($('#av'), p.photo_url, name);
    $('#tName').textContent = name; $('#un').textContent = name + (p.is_premium ? ' ★' : '');
    $('#uh').textContent = (p.username ? '@' + p.username + ' · ' : '') + 'ID ' + p.telegram_id;
  }
}
// До ответа сервера показываем то, что Telegram уже передал в initDataUnsafe
(function paintFromTelegram() {
  if (!tgUser) { $('#uh').textContent = 'Гость · откройте игру из Telegram'; return; }
  paintProfile({
    nickname: [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' '), first_name: tgUser.first_name,
    username: tgUser.username || '', photo_url: tgUser.photo_url || '', is_premium: !!tgUser.is_premium,
    telegram_id: tgUser.id
  });
})();

/* ---- кейсы ---- */
let casesList = [];
async function loadCases() {
  const list = await publicRpc('list_cases');
  if (Array.isArray(list) && list.length) casesList = list;
  const box = $('#cases');
  if (!casesList.length) { box.innerHTML = '<div class="empty">Не удалось загрузить кейсы. Потяните вкладку ещё раз.</div>'; return; }
  box.innerHTML = casesList.map((c) =>
    `<div class="card case"><div class="em">${c.emoji}</div><b>${c.name}</b><i class="price">${fmt(c.cost)}</i>` +
    `<button class="btn" data-c="${c.id}">Открыть</button></div>`).join('');
}
$('#cases').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-c]');
  if (!b || b.disabled) return;
  const c = casesList.find((x) => x.id === b.dataset.c);
  if (!c) return;
  if (!lockEconomy()) return toast('Подождите, идёт другая операция');
  b.disabled = true; buzz('medium');
  try {
    const r = await crashRpc('case_open', { p_case: c.id, p_request: crypto.randomUUID() });
    if (!r.ok) return showMessage(r.error);
    setUIBalance(r.balance);
    showReward(r);
    if (window.WXG) WXG.refreshAlways();
  } finally { b.disabled = false; unlockEconomy(); }
});
function showReward(r) {
  const g = WXG.giftBy(r.gift_slug);
  const art = $('#rwArt'); art.replaceChildren(WXG.imageFor({ slug: r.gift_slug, name: r.name }, false));
  $('#rwName').textContent = r.name || g.name; $('#rwPrice').textContent = fmt(r.price);
  const d = $('#reward'); if (!d.open) d.showModal();
  buzz('heavy');
}
$('#rwClose').onclick = () => $('#reward').close();
$('#rwInv').onclick = () => { $('#reward').close(); WXG.openInventory(); };
$('#reward').addEventListener('click', (e) => { if (e.target.id === 'reward') e.target.close(); });

/* ---- профиль ---- */
$('#openInv').onclick = () => WXG.openInventory();
$('#topup').onclick = async () => {
  if (!lockEconomy()) return;
  try {
    const r = await crashRpc('demo_topup', {});
    if (!r.ok) return showMessage(r.error);
    setUIBalance(r.balance); toast('+' + fmt(r.added), 'win'); buzz('success');
  } finally { unlockEconomy(); }
};

/* ---- нижняя панель ---- */
const PAGES = { cases: 'p-cases', up: 'upgraderPage', prof: 'p-prof' };
const nav = $('#nav'), pill = $('#pill'), tabs = $$('.tab');
let cur = 1, hoverIdx = 1, navDown = null;
const geo = (i) => { const r = tabs[i].getBoundingClientRect(), n = nav.getBoundingClientRect(); return { l: r.left - n.left, w: r.width }; };
function place(i, grow) {
  const g = geo(i), base = Math.max(0, g.w - 8), w = base * (grow || 1);
  pill.style.width = w + 'px';
  pill.style.left = (g.l + 4 - (w - base) / 2) + 'px';
}
function markTabs(i) { tabs.forEach((t, k) => t.classList.toggle('on', k === i)); }
function show(i) {
  const t = tabs[i].dataset.t;
  markTabs(i);
  $$('.page').forEach((p) => { const on = p.id === PAGES[t]; p.classList.toggle('on', on); p.classList.toggle('hidden', !on); });
  if (t === 'up') openUpgrader();                // инициализирует колесо, подгружает подарки
  if (t === 'cases' && !casesList.length) loadCases();
  if (t === 'prof') { $('#giftCount').textContent = window.WXG ? WXG.count() : '—'; if (window.WXG) WXG.refreshAlways(); queueSync(0); }
}
function nearest(x) {
  let b = 0, d = Infinity;
  tabs.forEach((t, i) => { const r = t.getBoundingClientRect(), dd = Math.abs(x - (r.left + r.width / 2)); if (dd < d) { d = dd; b = i; } });
  return b;
}
function followPill(x) {                          // пилюля едет за пальцем, но не выходит за края панели
  const n = nav.getBoundingClientRect(), g = geo(0), w = Math.max(0, g.w - 8) * 1.06;
  const c = Math.max(w / 2 + 4, Math.min(n.width - w / 2 - 4, x - n.left));
  pill.style.width = w + 'px'; pill.style.left = (c - w / 2) + 'px';
}
function navFinish(e, cancelled) {                // единая точка завершения: вызывается один раз
  if (!navDown) return;
  const d = navDown; navDown = null;
  nav.classList.remove('hold'); pill.classList.remove('drag');
  try { nav.releasePointerCapture(d.id); } catch (err) {}
  const i = cancelled || !e ? cur : nearest(e.clientX);
  if (i !== cur) { cur = i; place(cur); show(cur); buzz('light'); }
  else { place(cur); markTabs(cur); }
  hoverIdx = cur;
}
nav.addEventListener('pointerdown', (e) => {
  if (navDown) return;
  navDown = { id: e.pointerId, x0: e.clientX, moved: false };
  try { nav.setPointerCapture(e.pointerId); } catch (err) {}
  nav.classList.add('hold'); buzz('medium');
});
nav.addEventListener('pointermove', (e) => {
  if (!navDown || e.pointerId !== navDown.id) return;
  if (!navDown.moved && Math.abs(e.clientX - navDown.x0) > 8) { navDown.moved = true; pill.classList.add('drag'); }
  if (navDown.moved) {
    followPill(e.clientX);
    const i = nearest(e.clientX);
    if (i !== hoverIdx) { hoverIdx = i; markTabs(i); buzz('select'); }
  }
});
nav.addEventListener('pointerup', (e) => navFinish(e, false));
nav.addEventListener('pointercancel', () => navFinish(null, true));
nav.addEventListener('lostpointercapture', () => navFinish(null, true));
nav.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('blur', () => navFinish(null, true));
if (window.ResizeObserver) new ResizeObserver(() => { if (!navDown) place(cur); }).observe(nav);
addEventListener('resize', () => { if (!navDown) place(cur); });
document.addEventListener('visibilitychange', () => { if (document.hidden) navFinish(null, true); else queueSync(200); });

/* ---- старт ---- */
if (!tg || !tg.initData) setTimeout(() => showMessage(NO_TG), 600);
place(cur);
show(cur);                                        // открывает апгрейдер
loadCases();
bootPlayer().then(() => { if (window.WXG) WXG.refreshAlways(); });
