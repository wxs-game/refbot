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
  e.textContent = text;
  try { if (e.showPopover && !e.matches(':popover-open')) e.showPopover(); } catch (_) {}   // поверх модальных окон
  e.className = ''; void e.offsetWidth; e.className = 'on ' + (cls || '');
  clearTimeout(toast.t); clearTimeout(toast.h);
  toast.t = setTimeout(() => {
    e.className = '';
    toast.h = setTimeout(() => { try { e.hidePopover && e.hidePopover(); } catch (_) {} }, 320);
  }, ms || 2600);
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
let shownBalance = 0, balanceAnimation = 0;
let currentBetsCount = 0, currentWinsCount = 0, currentDeposits = 0, currentWithdrawals = 0;
let playerReady = false, playerData = null;
const MIN_BET = 0.10;

function roundMoney(v) { const n = Number(v); return isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0; }
const fmt = (n) => Number(n || 0).toFixed(2) + ' $';

function setUIBalance(v) {
  const next = parseFloat(v) || 0;
  currentBalance = next;
  cancelAnimationFrame(balanceAnimation);
  const from = shownBalance;
  const started = performance.now();
  const duration = Math.min(750, Math.max(260, Math.abs(next - from) * 110));
  const paint = (value) => {
    const t = fmt(value);
    ['#tBal', '#bal'].forEach((s) => { const e = $(s); if (e) e.textContent = t; });
  };
  const step = (now) => {
    const progress = Math.min(1, (now - started) / duration);
    shownBalance = from + (next - from) * (1 - Math.pow(1 - progress, 3));
    paint(shownBalance);
    if (progress < 1) balanceAnimation = requestAnimationFrame(step);
    else { shownBalance = next; paint(next); }
  };
  balanceAnimation = requestAnimationFrame(step);
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
    if (c !== upg.chance) { upg.chance = c; upg.userChance = true; upg.pendingRefresh = true; }
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
    upg.userChance = true;
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
    // Запасные цены в центах (последний срез). Работают, пока нет ни ответа сервера, ни живого флора из сети.
    const FALLBACK_CENTS = Object.fromEntries(`xmasstocking:514, candycane:514, lolpop:514, cookieheart:617, stellarrocket:617, lightsword:720, bowtie:720, moonpendant:823, snowglobe:823, bunnymuffin:1028, finepen:1028, hangingstar:1131, tophat:1234, lovecandle:1337, sakuraflower:1439, recordplayer:1542, lovepotion:1851, cupidcharm:2982, rarebird:3393, toybear:4113, diamondring:4216, genielamp:4524, swisswatch:7403, lootbag:16348, astralshard:17171`.split(',').map((x) => x.trim().split(':')).map(([k, v]) => [k, Number(v)]));
    let pricesLive = false;            // true, когда флор успешно подтянут из интернета
    const listed = new Map();
    let serverCatalog = new Map();     // slug → цена в центах (с сервера)
    let liveOffers = new Map();
    let inventory = [];
    let inventoryLoaded = false, inventoryRevision = 0;
    let lastErr = '', liveReady = false, liveLoad = null, loadedAt = 0, catalogAsked = false, priceReq = null, rateAsked = false;
    let anchorUntil = 0, catalogMin = null, targetSlug = null, view = 'catalog', pending = null, stakeId = null, cashCents = null, itemId = null, busy = false, stakeKey = '';
    const roundKey = 'wxs-gift-round:' + (tgApp?.initDataUnsafe?.user?.id ?? 'anon');
    try { pending = JSON.parse(sessionStorage.getItem(roundKey) || 'null'); } catch { pending = null; }
    targetSlug = pending?.slug || null;

    G.priceCents = (slug) => { const c = centsOf(giftBy(slug)); return Number.isFinite(c) ? c : null; };
    G.refreshPrices = () => { refreshPrices(); fetchRate(); };
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
        if (!pricesLive && FALLBACK_CENTS[g.slug]) return FALLBACK_CENTS[g.slug];
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
            if (Number.isFinite(v) && v > 0.05 && v < 50 && !rateFromServer) { gramUsd = v; paint(); G.onPrices?.(); }
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
            latest.set(slug, { slug, name: singular(name), price, date });
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
                loadedAt = Date.now(); pricesLive = true;
            } catch { /* остаются сохранённые цены */ }
            finally { priceReq = null; paint(); if (dlg.open) renderDialog(); G.onPrices?.(); }
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
                if (slug) listed.set(slug, { slug, name: singular(name) });
            }
            if (dlg.open) renderDialog();
        } catch { catalogAsked = false; }
    }

    // ---------- картинки ----------
    function giftImageSources(g) {
        // API принимает и название коллекции, и slug. Название ставим первым:
        // так новые подарки отображаются сразу, даже если их slug ещё отличается.
        const sources = [g?.name, g?.slug]
            .map((value) => String(value || '').trim())
            .filter(Boolean)
            .map((value) => 'https://api.changes.tg/original/' + encodeURIComponent(value) + '.png?size=256');
        return [...new Set(sources)];
    }

    function imageFor(g, lazy) {          // обычный (не улучшенный) подарок, без фона
        const img = document.createElement('img');
        img.alt = '';
        img.loading = lazy ? 'lazy' : 'eager';
        img.decoding = 'async';
        img.style.opacity = '0'; img.style.transition = 'opacity .3s ease';
        img.addEventListener('load', () => { img.style.opacity = '1'; });
        const sources = giftImageSources(g);
        let sourceIndex = 0;
        img.addEventListener('error', () => {
            sourceIndex += 1;
            if (sources[sourceIndex]) { img.src = sources[sourceIndex]; return; }
            const f = document.createElement('span');
            f.className = 'wxs-gift-fallback';
            f.textContent = '🎁';
            img.replaceWith(f);
        });
        img.src = sources[0] || '';
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
        const right = slotEl(t, 'АПГРЕЙД ДО', () => { if (!upg.busy) openDialog('catalog', t?.cents); });   // каталог только дороже текущей цели
        box.replaceChildren(left, arrow, right);
    }

    // Ставка и шанс связаны через цену подарка: шанс = 95% · ставка / цена
    G.sync = (fromBet) => {
        const t = target();
        const input = $('upgBetInput');
        const st = stakeItem();
        if (st) {
            const v = centsOf(st);
            if (!v) return;
            const derivedOf = (c) => Math.max(UPG_MIN_CHANCE, Math.min(UPG_MAX_CHANCE, Math.round(95 * v / c)));
            if (upg.userChance) {                        // двигали шанс — подбираем подарок, ближайший к нужной цене
                upg.userChance = false;
                const nt = pickTargetFor(v, upg.chance);
                if (nt && nt.slug !== targetSlug) { targetSlug = nt.slug; paint(); }
            }
            const t2 = target();
            if (t2?.cents && !upg.sliding) upg.chance = derivedOf(t2.cents);   // отпустили — шанс «прилипает» к реальному
            if (input) input.value = (v / 100).toFixed(2);
            return;
        }
        upg.userChance = false;
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
        targetSlug = slug;
        paint();
        upgRefresh(true, !stakeItem() && cashCents > 0 ? 'bet' : undefined);
        if (dlg.open) dlg.close();
    }

    function setStake(id) {
        if (id && page.classList.contains('hidden')) window.goUpgrader?.();   // из инвентаря / после кейса — перескакиваем на апгрейдер
        stakeId = id;
        if (id) cashCents = null;
        const st = stakeItem(), t = target();
        if (st && t && centsOf(t) <= centsOf(st)) targetSlug = null;   // цель должна быть дороже своего подарка
        paint();
        upgRefresh(true);
        if (dlg.open) dlg.close();
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
    G.upgradeWith = async (id) => {                      // подарок только что выпал — ждём, пока он появится в инвентаре
        if (!inventory.some((g) => g.id === id)) await refreshLive();
        if (inventory.some((g) => g.id === id)) setStake(id); else openDialog('inventory');
    };
    // цена продажи подарка (в центах) и продажа пачки подарков одним действием
    G.sellEstimate = (slug, fallbackUsd) => { const c = sellCents(giftBy(slug)); return c != null ? c : Math.floor(Math.round((fallbackUsd || 0) * 100) * 87 / 100); };
    G.sellMany = async (ids) => {
        let balance = null; const sold = [];
        for (const id of ids) {
            try { const r = await rpc('gift_upgrade_sell', { p_request: id }); balance = Number(r.balance); sold.push(id); }
            catch (e) { lastErr = e.message || 'sell'; }
        }
        if (balance != null) setUIBalance(balance);
        if (sold.length) { inventoryRevision++; inventory = inventory.filter((g) => !sold.includes(g.id)); paint(); refreshLive(); }
        return { sold, balance };
    };
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

    // апгрейд возможен только на подарки с котировкой сервера; остальные видны, но неактивны
    const upgradable = (slug) => !(serverCatalog.size || liveOffers.size) || serverCatalog.has(slug) || liveOffers.has(slug);
    function card(g, onPick, opts = {}) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'wxs-gift-card' + (opts.selected ? ' is-selected' : '') + (opts.dim ? ' is-dim' : '');
        const frame = document.createElement('span');
        frame.className = 'wxs-gift-img';
        frame.append(imageFor(g, true));
        const name = document.createElement('strong');
        name.textContent = g.name;
        const price = document.createElement('em');
        price.textContent = money(usd(g));
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
        let items = [...all.values()];                       // абсолютно все известные подарки, даже без цены
        const st = stakeItem();
        if (st) { const v = centsOf(st); items = items.filter((g) => centsOf(g) > v); }   // только то, что дороже твоего подарка
        const key = (g) => centsOf(g) ?? 1e12;                  // без цены — в конец
        return items.sort((a, b) => key(a) - key(b) || a.name.localeCompare(b.name));
    }

    // Цена цели = 95% · цена ставки / шанс. Берём ближайший доступный подарок дороже ставки.
    function pickTargetFor(vCents, chance) {
        const want = 95 * vCents / Math.max(1, chance);
        let best = null;
        for (const g of catalogItems()) {
            const c = centsOf(g);
            if (!upgradable(g.slug)) continue;                                  // только подарки с котировкой сервера
            if (!(c > vCents) || c > 95 * vCents) continue;                    // дороже ставки и шанс не меньше 1%
            if (!best || Math.abs(c - want) < Math.abs(centsOf(best) - want)) best = g;
        }
        return best;
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
            if (view === 'catalog') {
                if (!upgradable(g.slug)) return showMessage('Подарок «' + g.name + '» сейчас недоступен для апгрейда. Выберите другой.');
                choose(g.slug);
            }
            else if (view === 'stake') setStake(g.id);
            else { itemId = g.id; view = 'item'; renderDialog(); }
        }, { selected: view === 'catalog' && g.slug === targetSlug, dim: view === 'catalog' && !upgradable(g.slug) })));
        if (view === 'catalog' && catalogMin && Date.now() < anchorUntil && !q) {       // прокрутка к первому подарку дороже цели (вверх — дешёвые)
            const i = filtered.findIndex((g) => centsOf(g) > catalogMin);
            if (i > 0 && list.children[i]) requestAnimationFrame(() => list.children[i]?.scrollIntoView({ block: 'start' }));
        }
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

    function openDialog(v, minCents) {
        view = v;
        catalogMin = v === 'catalog' && minCents > 0 ? minCents : null;   // якорь: каталог открывается на подарках дороже цели
        anchorUntil = catalogMin ? Date.now() + 2500 : 0;
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
    search.addEventListener('input', () => { anchorUntil = 0; renderDialog(); });
    ['touchstart', 'wheel', 'pointerdown'].forEach((ev) => list.addEventListener(ev, () => { anchorUntil = 0; }, { passive: true }));
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
        $('stkOk').hidden = sheetTab === 'gift';             // для подарков ОК не нужен
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
            b.addEventListener('click', () => { window.haptic?.('select'); setStake(g.id); closeSheet(); });
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
    stkAmount.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('stkOk').click(); } });
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
    $('#tName').textContent = name; $('#un').textContent = name + '';
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

/* ---- названия подарков: Sakura Flowers → Sakura Flower ---- */
function singular(n) {
  let s = String(n || '').trim();
  s = s.replace(/s-in-the-/i, '-in-the-').replace(/Bunnies$/, 'Bunny');
  if (/(ches|shes|xes|sses)$/i.test(s)) return s.slice(0, -2);
  if (/ss$/i.test(s)) return s;
  return /s$/i.test(s) ? s.slice(0, -1) : s;
}
/* ---- кейсы ---- */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const csMoney = (n) => (Math.round((Number(n) || 0) * 100) / 100) + ' $';          // 25 $ · 0.5 $ · 47.9 $
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const CS_COLORS = ['#2fd36b', '#ffd23a', '#2f9bff', '#ff8a2a', '#ff4a5a', '#a35bff', '#22d3c5', '#ff5fb0'];
let casesList = [], csTab = 'paid';
const isFreeCase = (c) => Number(c.cost) === 0 || c.is_free === true || c.free === true;

function normItems(c) {                      // состав берём с сервера (поля читаем с запасом по именам)
  const raw = c.items || c.gifts || c.contents || c.drops || [];
  const a = raw.map((it) => ({
    slug: it.gift_slug || it.slug || '', name: singular(it.name || it.gift_slug || it.slug || ''),
    price: (() => {
      const slug = it.gift_slug || it.slug || '', live = slug && !/^cash/.test(slug) ? window.WXG?.priceCents?.(slug) : null;
      return live != null ? live / 100 : it.price_cents != null ? it.price_cents / 100 : Number(it.price) || 0;
    })(),
    chance: it.chance != null ? Number(it.chance) : null, weight: Number(it.weight) || 0
  }));
  const sw = a.reduce((s, x) => s + x.weight, 0);
  a.forEach((x) => { if (x.chance == null && sw > 0) x.chance = x.weight / sw * 100; });
  return a.sort((p, q) => q.price - p.price);
}
const isCash = (it) => /^cash/.test((it && it.slug) || '');
/* денежный дроп: sticker.tgs (gzip-Lottie) из корня; файл читаем один раз и кэшируем */
let moneyData = null;
function loadMoney() {
  return moneyData || (moneyData = fetch("sticker.tgs").then((r) => { if (!r.ok) throw 0; return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).json(); }));
}
function cashAnim(play) {
  const box = document.createElement('span');
  box.style.cssText = 'display:block;width:100%;height:100%';
  const fail = () => { box.textContent = '💵'; box.style.cssText += ';display:grid;place-items:center;font-size:30px'; };
  if (!window.lottie || !window.DecompressionStream) { fail(); return box; }
  loadMoney().then((data) => {
    const a = lottie.loadAnimation({ container: box, renderer: 'svg', loop: !!play, autoplay: !!play && !REDUCED, animationData: JSON.parse(JSON.stringify(data)) });
    if (!play || REDUCED) a.addEventListener('DOMLoaded', () => a.goToAndStop(Math.floor(a.totalFrames / 2), true));
  }).catch(fail);
  return box;
}
const giftImageSourcesByName = (it) => [it?.name, it?.slug]
  .map((value) => String(value || '').trim())
  .filter(Boolean)
  .map((value) => 'https://api.changes.tg/original/' + encodeURIComponent(value) + '.png?size=256')
  .filter((value, index, all) => all.indexOf(value) === index);
const giftImg = (it, lazy, play) => {                // оригинальный подарок: без фона, не улучшенный
  if (isCash(it)) return cashAnim(play);                                                                              // денежный дроп → money.tgs
  const img = document.createElement('img');
  img.alt = ''; img.loading = lazy ? 'lazy' : 'eager'; img.decoding = 'async';
  img.style.opacity = '0'; img.style.transition = 'opacity .3s ease';
  img.addEventListener('load', () => { img.style.opacity = '1'; });
  const sources = giftImageSourcesByName(it);
  let sourceIndex = 0;
  img.addEventListener('error', () => {
    sourceIndex += 1;
    if (sources[sourceIndex]) { img.src = sources[sourceIndex]; return; }
    const f = document.createElement('span'); f.className = 'wxs-gift-fallback'; f.textContent = '🎁'; img.replaceWith(f);
  });
  img.src = sources[0] || '';
  return img;
};

/* ---- список кейсов: Платные / Бесплатные ---- */
function caseCard(c, i) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'cs-card'; b.dataset.c = c.id;
  b.style.setProperty('--c1', CS_COLORS[(casesList.indexOf(c) + CS_COLORS.length) % CS_COLORS.length]);
  b.style.setProperty('--i', Math.min(i, 8));
  const chip = document.createElement('span'); chip.className = 'cs-chip';
  chip.textContent = isFreeCase(c) ? 'Бесплатно' : csMoney(c.cost);
  const art = document.createElement('span'); art.className = 'cs-art';
  const top = normItems(c).filter((x) => !isCash(x)).slice(0, 3);   // на обложке только подарки
  if (top.length) top.forEach((it, k) => { const w = document.createElement('i'); w.className = 'p' + k; w.append(giftImg(it, true)); art.append(w); });
  else { const e = document.createElement('em'); e.className = 'cs-emoji'; e.textContent = c.emoji || '🎁'; art.append(e); }
  b.append(chip, art);
  if (c.is_new || c.new || c.badge === 'new') { const r = document.createElement('u'); r.className = 'cs-new'; r.textContent = 'NEW'; b.append(r); }
  b.setAttribute('aria-label', c.name + ', ' + chip.textContent);
  return b;
}
function renderCases(swap) {
  const box = $('#cases');
  if (!casesList.length) { box.innerHTML = '<div class="empty">Не удалось загрузить кейсы. Переключите вкладку, чтобы повторить.</div>'; return; }
  const list = casesList.filter((c) => isFreeCase(c) === (csTab === 'free'));
  if (!list.length) { box.innerHTML = '<div class="empty">' + (csTab === 'free' ? 'Бесплатных кейсов пока нет.' : 'Платных кейсов пока нет.') + '</div>'; return; }
  const frag = document.createDocumentFragment();
  list.forEach((c, i) => frag.append(caseCard(c, i)));
  box.replaceChildren(frag);
  if (swap) { box.classList.remove('swap'); void box.offsetWidth; box.classList.add('swap'); }
}
async function loadCases() {
  let list = null;
  for (let i = 0; i < 3 && !(Array.isArray(list) && list.length); i++) {   // до 3 попыток, чтобы кейсы не пропадали при сбое сети
    list = await publicRpc('list_cases');
    if (!(Array.isArray(list) && list.length)) await new Promise((r) => setTimeout(r, 500));
  }
  if (Array.isArray(list) && list.length) casesList = list;
  if (casesList.length !== 10) console.warn('list_cases вернул кейсов: ' + casesList.length + ' (ожидалось 10) — проверьте таблицу кейсов в Supabase');
  renderCases(true);
  window.WXG?.refreshPrices?.();                    // подтянуть свежие цены подарков из сети
}
$('#csTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || b.dataset.k === csTab) return;
  csTab = b.dataset.k; buzz('select');
  $$('#csTabs button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderCases(true);
});

/* ---- аккуратное закрытие шторок (с анимацией) ---- */
function closeSheet(d) {
  if (!d.open || d.classList.contains('closing')) return;
  d.classList.add('closing');
  let done = false;
  const fin = () => { if (done) return; done = true; d.classList.remove('closing'); if (d.open) d.close(); };
  d.addEventListener('animationend', (e) => { if (e.target === d) fin(); });
  setTimeout(fin, 340);
}
/* ---- свайп вниз закрывает шторку: палец ведёт её 1:1, отпускание — по скорости и расстоянию.
        handleOnly: тянуть можно только за язычок сверху (экран кейса), контент просто скроллится ---- */
function enableSwipeClose(d, handleOnly) {
  let y0 = 0, lastY = 0, dy = 0, drag = false, armed = false, sc = null, raf = 0, hist = [];
  const scrollerOf = (el) => {
    for (; el && el !== d.parentElement; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el;
      if (el === d) break;
    }
    return null;
  };
  const paint = () => { raf = 0; d.style.transform = 'translate3d(0,' + dy + 'px,0)'; };
  const reset = () => { d.style.transition = ''; d.style.transform = ''; d.style.willChange = ''; d.classList.remove('swiped'); };
  d.addEventListener('touchstart', (e) => {
    armed = false; drag = false;
    if (e.touches.length !== 1 || d.classList.contains('closing') || d.classList.contains('swiped')) return;
    if (handleOnly && (!e.target.closest || !e.target.closest('.wxs-sheet-grip'))) return;
    if (d.id === 'caseView' && cv.busy) return;
    armed = true; y0 = lastY = e.touches[0].clientY; dy = 0;
    hist = [{ y: y0, t: performance.now() }];
    sc = handleOnly ? null : scrollerOf(e.target);
    d.style.transition = '';
  }, { passive: true });
  d.addEventListener('touchmove', (e) => {
    if (!armed || e.touches.length !== 1) return;
    const y = e.touches[0].clientY, now = performance.now();
    if (!drag) {
      const dd = y - y0;
      if (handleOnly ? Math.abs(dd) < 3 : (dd < 8 || (sc && sc.scrollTop > 0))) return;
      drag = true; y0 = y;                                   // старт без скачка: отсчёт от текущей точки
      d.style.transition = 'none'; d.style.willChange = 'transform';
    }
    lastY = y; dy = Math.max(0, y - y0);
    hist.push({ y, t: now }); while (hist.length > 2 && now - hist[0].t > 120) hist.shift();
    if (!raf) raf = requestAnimationFrame(paint);
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
  const end = () => {
    if (!armed) return;
    armed = false;
    if (!drag) return;
    drag = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    d.style.transform = 'translate3d(0,' + dy + 'px,0)';
    const now = performance.now(), o = hist[0] || { y: lastY, t: now - 16 };
    const v = (lastY - o.y) / Math.max(16, now - o.t);       // px/мс
    const h = d.getBoundingClientRect().height || 600;
    void d.offsetHeight;
    if (dy > h * 0.3 || (v > 0.5 && dy > 20)) {
      d.classList.add('swiped');
      const dur = Math.max(0.16, Math.min(0.34, (h - dy) / Math.max(v, 1.0) / 1000));
      d.style.transition = 'transform ' + dur.toFixed(2) + 's cubic-bezier(.25,.7,.35,1)';
      d.style.transform = 'translate3d(0,100%,0)';
      buzz('light');
      setTimeout(() => { if (d.open) d.close(); reset(); }, dur * 1000 + 40);
    } else {
      d.style.transition = 'transform .32s cubic-bezier(.22,.9,.3,1)';
      d.style.transform = 'translate3d(0,0,0)';
      setTimeout(reset, 340);
    }
  };
  d.addEventListener('touchend', end);
  d.addEventListener('touchcancel', end);
}
$$('dialog.wxs-sheet').forEach((d) => enableSwipeClose(d, d.id === 'caseView'));
const outside = (d, e) => { const r = d.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };

/* ---- конфетти ---- */
function confetti() {
  if (REDUCED) return;
  const el = $('#confetti'), cvs = $('#confettiCv'), ctx = cvs.getContext('2d');
  const dpr = Math.min(devicePixelRatio || 1, 2), W = innerWidth, H = innerHeight;
  cvs.width = W * dpr; cvs.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  try { if (!el.matches(':popover-open')) el.showPopover(); } catch (_) {}
  const cols = ['#3b82f6', '#ffd23a', '#ff4a5a', '#2fd36b', '#a35bff', '#ff8a2a', '#22d3c5'];
  const ps = Array.from({ length: 90 }, (_, i) => ({
    x: W * (.2 + Math.random() * .6), y: H * .66, vx: (Math.random() - .5) * 9, vy: -(7 + Math.random() * 10),
    g: .34 + Math.random() * .1, r: Math.random() * 6.28, vr: (Math.random() - .5) * .35,
    w: 5 + Math.random() * 6, h: 3 + Math.random() * 5, c: cols[i % cols.length], life: 0, max: 80 + Math.random() * 50
  }));
  cancelAnimationFrame(confetti.raf);
  let last = performance.now();
  const step = (now) => {
    const k = Math.min(2.5, (now - last) / 16.67); last = now;
    ctx.clearRect(0, 0, W, H);
    let alive = 0;
    for (const p of ps) {
      p.life += k; if (p.life > p.max) continue; alive++;
      p.vy += p.g * k; p.vx *= Math.pow(.992, k); p.x += p.vx * k; p.y += p.vy * k; p.r += p.vr * k;
      ctx.save(); ctx.globalAlpha = Math.max(0, Math.min(1, (p.max - p.life) / 25));
      ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
    }
    if (alive) confetti.raf = requestAnimationFrame(step);
    else { ctx.clearRect(0, 0, W, H); try { el.hidePopover(); } catch (_) {} }
  };
  confetti.raf = requestAnimationFrame(step);
}

/* ---- экран кейса: барабаны, 1/2/3, открытие за $ ---- */
const cvDlg = $('#caseView'), cvReels = $('#cvReels'), cvGo = $('#cvGo');
const GAP = 8, IDLE = 8, IDLE_C = 3, FILL = 24;
let cv = { c: null, n: 1, busy: false, pool: [], rows: [], iw: 110, rowW: 320, dirty: false };
const rnd = (a) => a[Math.floor(Math.random() * a.length)];
function pickWeighted(items) {
  const w = items.map((x) => (x.chance != null ? x.chance : x.weight) || 0), sum = w.reduce((s, x) => s + x, 0);
  if (!(sum > 0)) return rnd(items);
  let r = Math.random() * sum;
  for (let i = 0; i < items.length; i++) { r -= w[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
}
function tile(it, play) {
  const b = document.createElement('div'); b.className = 'cv-it';
  const p = document.createElement('span'); p.className = 'cv-p'; p.textContent = it.price ? csMoney(it.price) : '';
  const im = document.createElement('span'); im.className = 'cv-im'; im.append(giftImg(it, false, play));
  b.append(p, im); return b;
}
const centerX = (idx, jit) => cv.rowW / 2 - (idx * (cv.iw + GAP) + cv.iw / 2) + (jit || 0);
const setX = (el, x) => { el.style.transform = 'translate3d(' + x + 'px,0,0)'; };

function buildRows() {
  cvReels.replaceChildren();
  cv.rows = [0, 1, 2].map((i) => {
    const el = document.createElement('div'); el.className = 'cv-row'; el.style.setProperty('--i', i);
    const track = document.createElement('div'); track.className = 'cv-track';
    el.append(track); cvReels.append(el);
    return { el, track, items: [] };
  });
}
function measure() {
  cv.rowW = cvReels.clientWidth || 320;
  cv.iw = Math.round(cv.rowW * 0.335);
  cvReels.style.setProperty('--iw', cv.iw + 'px');
}
function fillIdle(i) {
  const r = cv.rows[i];
  r.items = Array.from({ length: IDLE }, () => rnd(cv.pool));
  r.track.replaceChildren(...r.items.map(tile));
  r.el.classList.remove('done');
  setX(r.track, centerX(IDLE_C));
}
function idleAll() { cv.rows.forEach((_, i) => fillIdle(i)); cv.dirty = false; }
function syncRows() {
  cvReels.style.setProperty('--n', cv.n);
  cv.rows.forEach((r, i) => r.el.classList.toggle('off', i >= cv.n));
  $('#cvQty').style.setProperty('--k', cv.n - 1);
  $$('#cvQty button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.n === cv.n)));
  syncGo();
}
function syncGo() {
  const c = cv.c; if (!c) return;
  cvGo.classList.toggle('busy', cv.busy); cvGo.disabled = cv.busy;
  cvDlg.classList.toggle('is-busy', cv.busy);
  if (cv.busy) { cvGo.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5"/></svg>'; cvGo.setAttribute('aria-label', 'Идёт открытие'); return; }
  cvGo.removeAttribute('aria-label');
  cvGo.textContent = isFreeCase(c) ? 'Открыть бесплатно' : 'Открыть за ' + csMoney(c.cost * cv.n);
}
function openCase(c) {
  cv = { c, n: 1, busy: false, pool: normItems(c), rows: [], iw: 110, rowW: 320, dirty: false };
  if (!cv.pool.length) cv.pool = [{ slug: '', name: '', price: 0, chance: null, weight: 1 }];
  $('#cvTitle').textContent = c.name;
  const items = normItems(c);
  $('#cvGrid').replaceChildren(...items.map((it) => tile(it, true)));
  $('#cvEmpty').hidden = items.length > 0;
  $('#cvScroll').scrollTop = 0;
  cvReels.style.transition = 'none';
  if (!cvDlg.open) cvDlg.showModal();
  buildRows(); measure(); idleAll(); syncRows();
  requestAnimationFrame(() => requestAnimationFrame(() => { cvReels.style.transition = ''; }));
}
$('#cases').addEventListener('click', (e) => {
  const b = e.target.closest('[data-c]'); if (!b) return;
  const c = casesList.find((x) => String(x.id) === b.dataset.c); if (!c) return;
  buzz('light'); openCase(c);
});
$('#cvQty').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || cv.busy || +b.dataset.n === cv.n) return;
  cv.n = +b.dataset.n; buzz('select');
  if (cv.dirty) idleAll();
  syncRows();
});
$('#cvClose').onclick = () => { if (!cv.busy) closeSheet(cvDlg); };
cvDlg.addEventListener('click', (e) => { if (!cv.busy && e.target === cvDlg && outside(cvDlg, e)) closeSheet(cvDlg); });
cvDlg.addEventListener('cancel', (e) => { e.preventDefault(); if (!cv.busy) closeSheet(cvDlg); });
addEventListener('resize', () => { if (cvDlg.open && !cv.busy) { measure(); idleAll(); } });

function spinRow(i, win, delay) {                    // один барабан: выигрыш лежит на фиксированной позиции ленты
  const r = cv.rows[i], W = IDLE + FILL;
  const extra = [];
  for (let k = IDLE; k < W; k++) extra.push(rnd(cv.pool));
  extra.push(win); for (let k = 0; k < 4; k++) extra.push(rnd(cv.pool));
  r.track.append(...extra.map(tile));                // первые IDLE плиток уже на экране — рывка нет
  const from = centerX(IDLE_C), to = centerX(W, (Math.random() - .5) * cv.iw * .5);
  const dur = REDUCED ? 500 : 4200 + i * 420;
  const anim = r.track.animate(
    [{ transform: 'translate3d(' + from + 'px,0,0)' }, { transform: 'translate3d(' + to + 'px,0,0)' }],
    { duration: dur, delay: REDUCED ? 0 : delay, easing: 'cubic-bezier(.14,.62,.08,1)', fill: 'both' });
  return anim.finished.then(() => {
    setX(r.track, to); anim.cancel();
    r.track.children[W].classList.add('win'); r.el.classList.add('done');
  });
}
async function runSpin(wins) {
  cv.dirty = true;
  buzz('medium');
  await Promise.all(wins.map((w, i) => spinRow(i, w, i * 140)));
  buzz('success');
}
cvGo.addEventListener('click', async () => {
  if (cv.busy) return;
  const c = cv.c, n = cv.n;
  if (cv.dirty) { idleAll(); await new Promise((r) => requestAnimationFrame(r)); }
  if (c.cost * n > currentBalance + 1e-9) return showMessage('Недостаточно средств для открытия кейса.');
  if (!lockEconomy()) return toast('Подождите, идёт другая операция');
  cv.busy = true; syncGo(); buzz('medium');
  $('#cvScroll').scrollTo({ top: 0, behavior: 'smooth' });
  let balance = null; const got = [];
  try {
    for (let i = 0; i < n; i++) {                    // каждый кейс — отдельный идемпотентный запрос
      let r; try { r = await crashRpc('case_open', { p_case: c.id, p_request: crypto.randomUUID() }); } catch (e) { r = { ok: false, error: 'Ошибка сети' }; }
      if (!r || !r.ok) { showMessage((r && r.error) || 'Не удалось открыть кейс'); break; }
      balance = r.balance; got.push(r);
    }
    if (got.length) {
      const wins = got.map((r) => ({ slug: r.gift_slug, name: r.name || (window.WXG ? WXG.giftBy(r.gift_slug).name : r.gift_slug), price: Number(r.price) || 0, id: r.item_id }));
      await runSpin(wins);
      if (balance != null) setUIBalance(balance);     // баланс обновляется только после прокрута
      await new Promise((r) => setTimeout(r, 450));
      showReward(wins);
    } else if (balance != null) setUIBalance(balance);
  } finally { cv.busy = false; unlockEconomy(); syncGo(); if (window.WXG && got.length) WXG.refreshAlways(); }
});

/* ---- «Поздравляем!» ---- */
const rwDlg = $('#reward');
function showReward(wins) {
  $('#rwList').replaceChildren(...wins.map((w, i) => {
    const row = document.createElement('div'); row.className = 'rwd-row'; row.style.setProperty('--i', i); if (w.id) row.dataset.id = w.id;
    const im = document.createElement('span'); im.className = 'rwd-img'; im.append(giftImg(w, false, true));
    const nm = document.createElement('b'); nm.className = 'rwd-nm';
    const v = document.createElement('i'); v.className = 'rwd-pr';
    if (isCash(w)) nm.textContent = (Math.round((Number(w.price) || 0) * 100) / 100) + '$';     // деньги: «0.1$», справа ничего
    else { nm.textContent = singular(w.name || ''); v.textContent = csMoney(w.price); }
    row.append(im, nm, v);
    return row;
  }));
  rwWins = wins.filter((w) => !isCash(w) && w.id && window.WXG);              // деньги уже на балансе — продаются только подарки
  rwSellTotal = rwWins.reduce((s, w) => s + WXG.sellEstimate(w.slug, w.price), 0);
  rwSell.hidden = !rwWins.length; rwSell.disabled = false; rwInvBtn.hidden = !rwWins.length;   // выпали только $ → кнопки «В инвентарь» нет
  rwUp.hidden = !(rwWins.length === 1 && window.WXG?.upgradeWith);
  rwSell.textContent = 'Продать ' + (rwWins.length > 1 ? 'всё ' : '') + 'за ' + csMoney(rwSellTotal / 100);
  if (!rwDlg.open) rwDlg.showModal();
  buzz('heavy'); confetti();
}
const rwSell = $('#rwSell'), rwInvBtn = $('#rwInv'), rwUp = $('#rwUp'); let rwWins = [], rwSellTotal = 0;
rwSell.onclick = async () => {
  if (rwSell.disabled || !rwWins.length) return;
  if (!lockEconomy()) return toast('Подождите, идёт другая операция');
  rwSell.disabled = true;
  const before = currentBalance;
  try {
    const r = await WXG.sellMany(rwWins.map((w) => w.id));
    if (r.sold.length) {
      buzz('success');
      $$('#rwList .rwd-row').forEach((row, i) => { if (r.sold.includes(row.dataset.id)) row.style.opacity = '.4'; });
    }
    if (r.sold.length === rwWins.length) { rwSell.hidden = true; rwInvBtn.hidden = true; rwUp.hidden = true; }
    else { rwWins = rwWins.filter((w) => !r.sold.includes(w.id)); rwSell.disabled = false; showMessage('Не всё удалось продать — остальное лежит в инвентаре.'); }
  } finally { unlockEconomy(); }
};
rwDlg.addEventListener('close', () => { if (cvDlg.open) { idleAll(); } });
$('#rwClose').onclick = () => closeSheet(rwDlg);
rwUp.onclick = () => {                              // после кейса: сразу на апгрейдер с этим подарком в ставке
  const id = rwWins.length === 1 ? rwWins[0].id : null; if (!id) return;
  closeSheet(rwDlg); closeSheet(cvDlg); setTimeout(() => WXG.upgradeWith(id), 260);
};
$('#rwInv').onclick = () => { closeSheet(rwDlg); closeSheet(cvDlg); setTimeout(() => WXG.openInventory(), 260); };
rwDlg.addEventListener('click', (e) => { if (e.target === rwDlg && outside(rwDlg, e)) closeSheet(rwDlg); });
rwDlg.addEventListener('cancel', (e) => { e.preventDefault(); closeSheet(rwDlg); });

/* ---- профиль ---- */
$('#openInv').onclick = () => WXG.openInventory();
/* ---- пополнение: xRocket / CryptoBot / TON (TonConnect). Деньги считает ТОЛЬКО сервер ---- */
const PAY_URL = SUPABASE_URL + '/functions/v1/payments';
const APP_URL = 'https://wxs-game.github.io/refbot';
// Новый URL намеренно сбрасывает кэш старого манифеста («Refbot») в TonConnect.
const TONCONNECT_MANIFEST_URL = APP_URL + '/tonconnect-manifest.json?v=rocketup-20261127-4';
async function payApi(action, args) {
  if (!(tg && tg.initData)) return { ok: false, error: NO_TG };
  try {
    const r = await fetch(PAY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify(Object.assign({ action, init: tg.initData }, args || {})), signal: AbortSignal.timeout(15000) });
    return (await r.json()) || { ok: false, error: 'Пустой ответ сервера' };
  } catch (e) { return { ok: false, error: 'Нет соединения с сервером' }; }
}
const seenDep = (() => {                                       // чтобы «Баланс пополнен» показывался один раз на инвойс
  let s = []; try { s = JSON.parse(localStorage.getItem('upg_seen_dep') || '[]'); } catch (e) {}
  return { has: (id) => s.includes(id), add: (id) => { s.push(id); s = s.slice(-60); try { localStorage.setItem('upg_seen_dep', JSON.stringify(s)); } catch (e) {} } };
})();
let payWatchTimer = 0, payWatchUntil = 0;
async function paySync() {                                     // сервер сам перепроверяет провайдеров/блокчейн и зачисляет ровно один раз
  const r = await payApi('sync');
  if (!r.ok) return r;
  // Это баланс, который вернул сервер уже после проверки оплаты.
  // Обновляем сразу, не дожидаясь следующей загрузки профиля.
  if (Number.isFinite(Number(r.balance_cents))) setUIBalance(Number(r.balance_cents) / 100);
  let fresh = 0;
  for (const c of r.credited || []) if (!seenDep.has(c.id)) { seenDep.add(c.id); fresh += c.usd; }
  if (fresh > 0) {
    buzz('success');
    toast('✓ ПОПОЛНЕНИЕ ЗАЧИСЛЕНО\n+' + fresh.toFixed(2) + ' $', 'win deposit', 4200);
    queueSync(0);
  }
  return r;
}
function payWatch(minutes) {
  payWatchUntil = Math.max(payWatchUntil, Date.now() + minutes * 60000);
  clearTimeout(payWatchTimer);
  const tick = async () => {
    const r = await paySync();
    if (r && r.ok && (r.pending || []).length && Date.now() < payWatchUntil) payWatchTimer = setTimeout(tick, 3500);
  };
  payWatchTimer = setTimeout(tick, 2500);
}
window.paySync = paySync;
// Возврат из CryptoBot/xRocket часто останавливает таймеры мини-приложения.
// Поэтому сразу перепроверяем все счета, как только пользователь вернулся.
document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(paySync, 500); });
window.addEventListener('pageshow', () => setTimeout(paySync, 1200));

/* TonConnect */
let tcui = null;
function tonUI() {
  if (tcui) return tcui;
  if (!window.TON_CONNECT_UI) return null;
  // Оставляем управление слоем самому TonConnect: так его скрытый контейнер
  // не перехватывает касания после отмены или возврата из кошелька.
  tcui = new TON_CONNECT_UI.TonConnectUI({ manifestUrl: TONCONNECT_MANIFEST_URL });
  tcui.onStatusChange((wallet) => {
    if (wallet) {
      try { localStorage.setItem('rocketup_ton_connected', '1'); } catch (_) {}
      toast('Кошелёк подключён', 'win', 2400);
    }
  });
  return tcui;
}
async function restoreTonConnection(ui) {
  // После возврата из кошелька SDK восстанавливает сессию асинхронно.
  // Без ожидания приложение ошибочно просило подключиться повторно.
  if (!ui || !ui.connectionRestored) return;
  await Promise.race([
    Promise.resolve(ui.connectionRestored).catch(() => null),
    new Promise((resolve) => setTimeout(resolve, 4500)),
  ]);
}
function commentBoc(text) {                                    // BOC одной ячейки: 32 бита 0 + UTF-8 комментарий
  const t = new TextEncoder().encode(text), len = 4 + t.length;
  if (len > 127) throw new Error('comment too long');
  const b = [0xb5, 0xee, 0x9c, 0x72, 0x01, 0x01, 0x01, 0x01, 0x00, 2 + len, 0x00, 0x00, len * 2, 0, 0, 0, 0, ...t];
  return btoa(String.fromCharCode(...b));
}
function openPayLink(url) {
  if (/^https:\/\/t\.me\//.test(url) && tg && tg.openTelegramLink) tg.openTelegramLink(url);
  else if (tg && tg.openLink) tg.openLink(url); else window.open(url, '_blank');
}

(function topupSheet() {
  const sheet = $('#tpSheet'), panel = $('#tpPanel'), input = $('#tpInput'), payBtn = $('#tpPay');
  const FALLBACK = (bg, t) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="${bg}"/><text x="24" y="30" text-anchor="middle" font-size="13" font-weight="800" fill="#fff" font-family="Arial">${t}</text></svg>`);
  const IMG = (f, bg, t) => `<img src="${f}?v=2" alt="" draggable="false" onerror="this.onerror=null;this.src='${FALLBACK(bg, t)}'">`;
  const GRAM = IMG('gram.png', '#3b82f6', 'TON');
  const USD = '<b class="tp-usd">$</b>';
  const AMOUNTS = [0.5, 1, 2, 5, 10, 25];
  const minAmount = (provider) => provider === 'ton' ? 0.1 : 0.05;
  const minLabel = (provider) => provider === 'ton' ? '0.1 TON' : '0.05 $';
  const METHODS = [
    { id: 'ton', name: 'TON', ico: IMG('gram.png', '#3b82f6', 'TON'), amts: AMOUNTS, cur: GRAM, rate: 0 },   // rate — живой курс с сервера
    { id: 'xrocket', name: 'xRocket', ico: IMG('xrocket.png', '#7c5cff', 'xR'), amts: AMOUNTS, cur: USD, rate: 1 },
    { id: 'cryptobot', name: 'CryptoBot', ico: IMG('cryptobot.png', '#2fa5e8', 'CB'), amts: AMOUNTS, cur: USD, rate: 1 },
  ];
  const CHK = '<span class="tp-chk"><svg viewBox="0 0 12 12"><path d="M2 6.5l3 3 5-6"/></svg></span>';
  let m = METHODS[0], amount = m.amts[1], timer = 0, payBusy = false;
  const num = (v) => (Math.round(v * 100) / 100).toString();
  const toUsd = (a) => Math.floor((a || 0) * m.rate * 100 + 1e-9) / 100;    // как на сервере: вниз до цента

  function paintAmount() {
    $('#tpFrom').innerHTML = m.cur + '<span>' + (amount ? num(amount) : '0') + '</span>';
    $('#tpTo').innerHTML = '<span>' + (m.rate > 0 ? toUsd(amount).toFixed(2) : '…') + '</span><b class="tp-usd">$</b>';
    $$('#tpAmts .tp-amt').forEach((b) => b.classList.toggle('on', Number(b.dataset.a) === amount && !input.value));
  }
  function render() {
    $('#tpMethods').innerHTML = METHODS.map((x) =>
      `<button type="button" class="tp-m${x === m ? ' on' : ''}" data-id="${x.id}">${CHK}<span class="tp-mi">${x.ico}</span><strong>${x.name}</strong></button>`).join('');
    $('#tpAmts').innerHTML = m.amts.map((a) => `<button type="button" class="tp-amt" data-a="${a}">${m.cur}<span>${num(a)}</span></button>`).join('');
    $('#tpInCur').innerHTML = m.cur;
    input.placeholder = 'Минимум ' + minLabel(m.id);
    paintAmount();
  }
  async function loadRate() {
    const r = await payApi('rates');
    if (r.ok && r.ton_usd > 0) { METHODS[0].rate = r.ton_usd; paintAmount(); }
  }
  function open() {
    clearTimeout(timer);
    input.value = ''; m = METHODS[0]; amount = m.amts[1];
    panel.style.transform = '';
    render(); loadRate();
    sheet.hidden = false; void sheet.offsetWidth; sheet.classList.add('open');
  }
  function close(immediate) {
    sheet.classList.remove('open'); panel.style.transform = '';
    try { input.blur(); } catch {}
    clearTimeout(timer);
    if (immediate) sheet.hidden = true;
    else timer = setTimeout(() => { if (!sheet.classList.contains('open')) sheet.hidden = true; }, 280);
  }
  $('#tpOpen').onclick = () => { buzz('select'); open(); };
  sheet.querySelector('.tp-back').addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) close(); });
  $('#tpMethods').addEventListener('click', (e) => {
    const b = e.target.closest('.tp-m'); if (!b) return;
    m = METHODS.find((x) => x.id === b.dataset.id); amount = m.amts[1]; input.value = ''; buzz('select'); render();
  });
  $('#tpAmts').addEventListener('click', (e) => {
    const b = e.target.closest('.tp-amt'); if (!b) return;
    amount = Number(b.dataset.a); input.value = ''; buzz('select'); paintAmount();
  });
  input.addEventListener('input', () => {
    let v = input.value.replace(',', '.').replace(/[^\d.]/g, '');
    const i = v.indexOf('.');
    if (i >= 0) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, '').slice(0, 2);
    if (v !== input.value) input.value = v;
    amount = parseFloat(v) || 0; paintAmount();
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); payBtn.click(); } });
  $('#tpSupport').onclick = () => toast('Поддержка пока не подключена');

  payBtn.onclick = async () => {
    if (payBusy) return;                                       // двойной тап = один счёт
    if (!(amount >= minAmount(m.id))) return showMessage('Минимальная сумма — ' + minLabel(m.id));
    let ui = null;
    if (m.id === 'ton') {
      ui = tonUI();
      if (!ui) return showMessage('TonConnect не загрузился. Обновите страницу.');
      await restoreTonConnection(ui);
      if (!ui.connected) {
        close(true);
        setTimeout(() => ui.openModal().catch(() => showMessage('Не удалось открыть TonConnect. Попробуйте ещё раз.')), 50);
        return toast('Подключите кошелёк и нажмите «Пополнить» ещё раз');
      }
    }
    payBusy = true; payBtn.disabled = true; buzz('medium');
    try {
      const rid = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^\w-]/g, '');
      let r = await payApi('create', { provider: m.id, amount, request_id: rid });
      if (!r.ok && /соединения/.test(r.error || '')) r = await payApi('create', { provider: m.id, amount, request_id: rid });  // тот же request_id → тот же счёт
      if (!r.ok) return showMessage(r.error);
      const inv = r.invoice;
      if (inv.provider === 'ton') {
        const t = inv.ton;
        close(); payWatch(15);
        try {
          await ui.sendTransaction({ validUntil: Math.min(t.valid_until, Math.floor(Date.now() / 1000) + 600),
            messages: [{ address: t.address, amount: t.amount_nano, payload: commentBoc(t.comment) }] });
          toast('Перевод отправлен. Ждём подтверждения сети…', '', 3600);
        } catch (e) { showMessage('Платёж отменён'); }
      } else {
        if (!inv.pay_url) return showMessage('Не удалось получить ссылку на оплату');
        close(); openPayLink(inv.pay_url); payWatch(60);
      }
    } finally { payBusy = false; payBtn.disabled = false; }
  };
  // свайп вниз по язычку закрывает шторку
  const head = sheet.querySelector('.tp-head'); let y0 = null, dy = 0;
  head.addEventListener('pointerdown', (e) => { y0 = e.clientY; dy = 0; head.setPointerCapture(e.pointerId); panel.classList.add('dragging'); });
  head.addEventListener('pointermove', (e) => { if (y0 == null) return; dy = Math.max(0, e.clientY - y0); panel.style.transform = `translateY(${dy}px)`; });
  const end = () => { if (y0 == null) return; y0 = null; panel.classList.remove('dragging'); if (dy > 90) close(); else panel.style.transform = ''; };
  head.addEventListener('pointerup', end); head.addEventListener('pointercancel', end);
})();

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
window.goUpgrader = () => { const i = tabs.findIndex((t) => t.dataset.t === 'up'); if (i < 0) return; cur = i; hoverIdx = i; place(cur); show(cur); };
function nearest(x) {
  let b = 0, d = Infinity;
  tabs.forEach((t, i) => { const r = t.getBoundingClientRect(), dd = Math.abs(x - (r.left + r.width / 2)); if (dd < d) { d = dd; b = i; } });
  return b;
}
function followPill(x) {                          // пилюля того же размера, что вкладка, едет за пальцем и не выходит за края
  const n = nav.getBoundingClientRect(), g = geo(0), w = Math.max(0, g.w - 8);
  const c = Math.max(w / 2 + 4, Math.min(n.width - w / 2 - 4, x - n.left));
  pill.style.width = w + 'px'; pill.style.left = (c - w / 2) + 'px';
  const abs = n.left + c;                         // центр пилюли в координатах экрана
  tabs.forEach((t) => {                           // вкладки под пилюлей подсвечиваем, чтобы подписи читались
    const r = t.getBoundingClientRect();
    t.classList.toggle('under', Math.abs(r.left + r.width / 2 - abs) < r.width * 0.75);
  });
  return abs;
}
function navFinish(e, cancelled) {                // единая точка завершения: вызывается один раз
  if (!navDown) return;
  const d = navDown; navDown = null;
  nav.classList.remove('hold'); pill.classList.remove('drag', 'catchup');
  tabs.forEach((t) => t.classList.remove('under'));
  clearTimeout(navFinish.t);
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
  if (!navDown.moved && Math.abs(e.clientX - navDown.x0) > 8) {
    navDown.moved = true;
    pill.classList.add('drag', 'catchup');         // первые 140 мс пилюля плавно «догоняет» палец, без прыжка
    clearTimeout(navFinish.t);
    navFinish.t = setTimeout(() => pill.classList.remove('catchup'), 140);
  }
  if (navDown.moved) {
    const i = nearest(followPill(e.clientX));
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
document.addEventListener('visibilitychange', () => { if (document.hidden) navFinish(null, true); else { queueSync(200); paySync(); } });

/* ---- старт ---- */
if (!tg || !tg.initData) setTimeout(() => showMessage(NO_TG), 600);
pill.style.transition = 'none';          // первый показ без «выезда» пилюли из угла
place(cur);
show(cur);
requestAnimationFrame(() => requestAnimationFrame(() => { pill.style.transition = ''; }));                                        // открывает апгрейдер
if (window.WXG) WXG.onPrices = () => { if (casesList.length) renderCases(false); };
loadCases();
bootPlayer().then(() => { if (window.WXG) WXG.refreshAlways(); paySync(); });

/* поле ввода в шторке не прячется под клавиатурой (iOS) */
if (window.visualViewport) {
  const kb = () => { const v = visualViewport; document.documentElement.style.setProperty('--kb', Math.max(0, innerHeight - v.height - v.offsetTop) + 'px'); };
  visualViewport.addEventListener('resize', kb); visualViewport.addEventListener('scroll', kb);
}
