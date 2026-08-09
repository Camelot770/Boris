'use strict';

/* =====================================================================
   Управленческий контур — платёжные документы, накладные, регистры.
   Спецификация: конфигурационные карты Б. (см. раздел «Спецификация»).
   Хранение: localStorage, ключ boris-uchet-v1.
   ===================================================================== */

/* ============================ Иконки ============================ */
/* Рисованные линейные пиктограммы (24×24, обводка currentColor) — вместо эмодзи. */
const ICON_PATHS = {
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  deal: '<path d="M3 8h13l-3-3M21 16H8l3 3"/>',
  card: '<rect x="3" y="6" width="18" height="12" rx="1"/><path d="M3 10.5h18"/>',
  box: '<path d="M12 3l8 4v10l-8 4-8-4V7z"/><path d="M4 7l8 4 8-4M12 11v10"/>',
  chart: '<path d="M4 4v16h16"/><path d="M7.5 14l3.5-4.5 3 2.5 4.5-5.5"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="1"/><path d="M3 10.5h18M16.5 14.5h1.5"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9h18M9.5 9v11M15 9v11"/>',
  ledger: '<path d="M6 3h13v18H6a2 2 0 01-2-2V5a2 2 0 012-2z"/><path d="M9 3v18M12.5 8h4M12.5 12h4"/>',
  book: '<path d="M5 4a2 2 0 012-2h12v20H7a2 2 0 01-2-2z"/><path d="M5 18h14"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="1"/><path d="M3 9.5h18M8 3v4M16 3v4"/>',
  check: '<path d="M4.5 12.5l4.5 4.5L20 6"/>',
  banknote: '<rect x="2" y="6" width="20" height="12" rx="1"/><circle cx="12" cy="12" r="2.5"/><path d="M5.5 9v6M18.5 9v6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  empty: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9h18M8 14h8"/>',
};
const ic = (name, size = 18) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ICON_PATHS.empty}</svg>`;

/* ============================ Утилиты ============================ */

const $ = (sel) => document.querySelector(sel);

const uuid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }));

const toISO = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayISO = () => toISO(new Date());
const addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + Number(n));
  return toISO(d);
};
const diffDays = (a, b) => Math.round((new Date(a + 'T00:00:00') - new Date(b + 'T00:00:00')) / 864e5);
const fmtDate = (iso) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString('ru-RU') : '—');
const fmtMoney = (n) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' ₽';
const fmtMoneySign = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmtMoney(Math.abs(n));
const sum = (arr) => arr.reduce((s, x) => s + x, 0);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortId = (id) => (id ? id.slice(0, 8) : '—');

/* ============================ Состояние ============================ */

const LS_KEY = 'boris-uchet-v1';

let state = loadState();
ensureCollections();

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && Array.isArray(s.deals)) return s;
    }
  } catch (e) { /* повреждённые данные — начинаем с чистого листа */ }
  return { deals: [], payments: [], waybills: [], journal: [] };
}

/* Ленивая инициализация коллекций, добавленных позже первой версии */
function ensureCollections() {
  if (!Array.isArray(state.items)) state.items = [];
  if (!Array.isArray(state.otherPayments)) state.otherPayments = [];
}

/* Живые остатки на сегодня: cashOpening / stockOpening (null → расчёт из документов) */
function getSettings() {
  if (!state.settings || typeof state.settings !== 'object') state.settings = { cashOpening: null, stockOpening: null };
  return state.settings;
}

function save() {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
}

/* Словари */
const DEAL_KIND = {
  sale: { label: 'Продажа', payKind: 'in', wbKind: 'out', payLabel: 'Входящий (клиент платит нам)', wbLabel: 'Расходная (отгрузка со склада)' },
  purchase: { label: 'Закупка', payKind: 'out', wbKind: 'in', payLabel: 'Исходящий (мы платим поставщику)', wbLabel: 'Приходная (приёмка на склад)' },
};
const PAY_KIND = { in: 'Входящий', out: 'Исходящий' };
const WB_KIND = { in: 'Приходная', out: 'Расходная' };

const dealById = (id) => state.deals.find((d) => d.id === id);
const itemById = (id) => state.items.find((i) => i.id === id);

/* Категории прочих платежей (вне сделок) и приоритеты по умолчанию */
/* Терминология подразделов платёжной ведомости — по письму Б. от 06.08:
   1. Обязательные (налоги, зарплата, коммунальные) · 2. Первоочередные
   (основные поставщики) · 3. Не первоочередные (в т.ч. дискреционные) */
const OTHER_CATEGORIES = {
  taxes: { label: 'Налоги', prio: 'critical' },
  salary: { label: 'Зарплата', prio: 'critical' },
  utilities: { label: 'Коммунальные платежи', prio: 'critical' },
  rent: { label: 'Аренда', prio: 'primary' },
  admin: { label: 'Адм.-хоз. расходы', prio: 'primary' },
  dividends: { label: 'Дивиденды', prio: 'discretionary' },
  other: { label: 'Прочее', prio: 'flexible' },
};
const PRIORITIES = {
  critical: { label: 'обязательный', cls: 'badge-red', order: 0 },
  primary: { label: 'первоочередной', cls: 'badge-amber', order: 1 },
  flexible: { label: 'не первоочередной', cls: 'badge-green', order: 2 },
  discretionary: { label: 'дискреционный', cls: 'badge-grey', order: 3 },
};

/* Ближайшая дата договорного графика («5,20» — дни месяца) начиная с from.
   Юридический блок: обязательства, которые ещё не возникли документами. */
function nextScheduleDate(scheduleDays, from) {
  const days = String(scheduleDays || '').split(/[,;\s]+/)
    .map((x) => parseInt(x, 10)).filter((n) => n >= 1 && n <= 31);
  if (!days.length) return null;
  const [fy, fm, fd] = from.split('-').map(Number);
  for (let off = 0; off < 3; off++) {
    const total = fm - 1 + off;
    const y = fy + Math.floor(total / 12), m = (total % 12) + 1;
    const last = new Date(y, m, 0).getDate();
    for (const d of [...days].sort((a, b) => a - b)) {
      const day = Math.min(d, last);
      if (off === 0 && day < fd) continue;
      return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  return null;
}

/* Вхождения прочего платежа в горизонте (повторяющиеся разворачиваются на лету).
   Ежемесячные считаются от базовой даты с зажимом дня месяца (31-е → 28/30-е),
   без дрейфа при переходе через короткие месяцы. */
function otherPaymentOccurrences(p, from, to) {
  if (p.done) return [];
  const out = [];
  if (p.recurring === 'monthly') {
    // индексы месяцев считаются от окна [from, to], а не перебором от базовой
    // даты — сколь угодно старая серия не «истекает»
    const [by, bm, bd] = p.date.split('-').map(Number);
    const [fy, fm] = from.split('-').map(Number);
    const [ty, tm] = to.split('-').map(Number);
    const startIdx = Math.max(0, (fy - by) * 12 + (fm - bm) - 1);
    const endIdx = Math.max(startIdx, (ty - by) * 12 + (tm - bm) + 1);
    for (let i = startIdx; i <= endIdx; i++) {
      const total = bm - 1 + i;
      const y = by + Math.floor(total / 12), m = (total % 12) + 1;
      const last = new Date(y, m, 0).getDate();
      const d = `${y}-${String(m).padStart(2, '0')}-${String(Math.min(bd, last)).padStart(2, '0')}`;
      if (d > to) break;
      if (d >= from) out.push(d);
    }
  } else if (p.date >= from && p.date <= to) {
    out.push(p.date);
  } else if (p.date < from) {
    out.push(from); // просроченный разовый платёж — ожидается немедленно
  }
  return out;
}
const dealTitle = (d) => (d ? `${d.name} · ${d.counterparty}` : 'сделка удалена');

const postedPayments = (dealId) =>
  state.payments.filter((p) => p.posted && p.dealId === dealId);
const postedRealWaybills = (dealId) =>
  state.waybills.filter((w) => w.posted && w.isReal && w.dealId === dealId);

/* Автонумерация документов */
function nextNum(list, prefix) {
  let mx = 0;
  for (const doc of list) {
    const m = String(doc.num || '').match(/(\d+)\s*$/);
    if (m) mx = Math.max(mx, parseInt(m[1], 10));
  }
  return `${prefix}-${mx + 1}`;
}

/* =====================================================================
   Регистры (вычисляются по проведённым документам).

   Материальные обязательства: план из платёжек (Date_Material_Execution_Plan),
   факт из реальных накладных (Date_Material_Execution_Fact). Сопоставление FIFO.

   Денежные обязательства: план из реальных накладных (Date_Payment_Execution_Plan),
   факт из платёжек (Date_Payment_Execution). Сопоставление FIFO.
   ===================================================================== */

/* FIFO-сопоставление: quotas [{date, amount}] закрываются facts [{date, amount, ref}].
   Возвращает { late: [{quotaDate, factDate, amount, ref}], open: [{date, left}] }. */
function fifoMatch(quotas, facts) {
  const q = quotas
    .filter((x) => x.date)
    .map((x) => ({ date: x.date, left: x.amount, ref: x.ref, key: x.key }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const late = [];
  const sortedFacts = [...facts].sort((a, b) => a.date.localeCompare(b.date));
  for (const f of sortedFacts) {
    let rest = f.amount;
    while (rest > 0.004 && q.length) {
      const head = q[0];
      const take = Math.min(rest, head.left);
      if (f.date > head.date) {
        late.push({ quotaDate: head.date, factDate: f.date, amount: take, ref: f.ref, factKey: f.key, quotaRef: head.ref });
      }
      head.left -= take;
      rest -= take;
      if (head.left <= 0.004) q.shift();
    }
  }
  return { late, open: q.filter((x) => x.left > 0.004).map((x) => ({ date: x.date, left: x.left, ref: x.ref, key: x.key })) };
}

/* Материальный контур сделки */
function materialRegister(deal) {
  const quotas = postedPayments(deal.id)
    .filter((p) => p.dateMaterialPlan)
    .map((p) => ({ date: p.dateMaterialPlan, amount: p.amount, ref: p.num, key: p.id }));
  const facts = postedRealWaybills(deal.id)
    .map((w) => ({ date: w.dateMaterialFact, amount: w.amount, ref: w.num, key: w.id }));
  return fifoMatch(quotas, facts);
}

/* Денежный контур сделки */
function moneyRegister(deal) {
  const quotas = postedRealWaybills(deal.id)
    .filter((w) => w.datePaymentPlan)
    .map((w) => ({ date: w.datePaymentPlan, amount: w.amount, ref: w.num, key: w.id }));
  const facts = postedPayments(deal.id)
    .map((p) => ({ date: p.datePaymentExecution, amount: p.amount, ref: p.num }));
  return fifoMatch(quotas, facts);
}

/* Агрегаты сделки для матрицы ресурсов */
function dealAggregates(deal) {
  const paid = sum(postedPayments(deal.id).map((p) => p.amount));
  const moved = sum(postedRealWaybills(deal.id).map((w) => w.amount));
  const isSale = deal.kind === 'sale';

  // Денежный след: продажи — приток, закупки — отток
  const moneyFact = isSale ? paid : -paid;
  // Плановые деньги: незакрытые денежные обязательства из накладных
  const moneyOpen = sum(moneyRegister(deal).open.map((o) => o.left));
  const moneyPlan = isSale ? moneyOpen : -moneyOpen;
  // Материальный след: закупки — приход ТМЦ, продажи — расход
  const tmcFact = isSale ? -moved : moved;
  // Плановые ТМЦ: незакрытые материальные обязательства из платёжек
  const tmcOpen = sum(materialRegister(deal).open.map((o) => o.left));
  const tmcPlan = isSale ? -tmcOpen : tmcOpen;

  // Задолженности
  let receivable = 0, payable = 0;
  if (isSale) {
    receivable = Math.max(0, moved - paid);          // отгрузили, не оплатили
    payable = Math.max(0, paid - moved);              // аванс полученный
  } else {
    receivable = Math.max(0, paid - moved);           // аванс выданный поставщику
    payable = Math.max(0, moved - paid);              // получили, не оплатили
  }
  return { paid, moved, moneyFact, moneyPlan, tmcFact, tmcPlan, receivable, payable };
}

/* =====================================================================
   Красные флаги
   ===================================================================== */

function computeFlags() {
  const flags = [];
  const today = todayISO();
  for (const deal of state.deals) {
    const isSale = deal.kind === 'sale';
    const matWorkplace = isSale ? 'Продавец' : 'Снабженец';
    const mat = materialRegister(deal);

    // Факт позже плана (накладная опоздала)
    for (const l of mat.late) {
      flags.push({
        severity: 'red', workplace: matWorkplace, dealId: deal.id,
        text: `Накладная ${l.ref}: ${isSale ? 'отгрузка' : 'поставка'} ${fmtDate(l.factDate)} — позже плана ${fmtDate(l.quotaDate)} (на ${diffDays(l.factDate, l.quotaDate)} дн.)`,
        date: l.factDate, kind: 'material',
      });
    }
    // План наступил, ТМЦ не перемещены
    for (const o of mat.open) {
      if (o.date < today) {
        flags.push({
          severity: 'red', workplace: matWorkplace, dealId: deal.id,
          text: `Срыв срока по платёжке ${o.ref}: к ${fmtDate(o.date)} не ${isSale ? 'отгружено' : 'поставлено'} ТМЦ на ${fmtMoney(o.left)} (просрочка ${diffDays(today, o.date)} дн.)`,
          date: o.date, kind: 'material',
        });
      }
    }

    const mon = moneyRegister(deal);
    const monWorkplace = isSale ? 'Продавец' : 'Бухгалтер';
    for (const o of mon.open) {
      if (o.date < today) {
        flags.push({
          severity: 'red', workplace: monWorkplace, dealId: deal.id,
          text: isSale
            ? `Просроченная дебиторка: ${deal.counterparty} должен ${fmtMoney(o.left)} с ${fmtDate(o.date)} (накладная ${o.ref}, просрочка ${diffDays(today, o.date)} дн.)`
            : `Просрочена оплата поставщику ${deal.counterparty}: ${fmtMoney(o.left)} к ${fmtDate(o.date)} (накладная ${o.ref})`,
          date: o.date, kind: 'money',
        });
      } else if (diffDays(o.date, today) <= 7) {
        flags.push({
          severity: 'amber', workplace: 'Бухгалтер', dealId: deal.id,
          text: isSale
            ? `Скоро срок оплаты от ${deal.counterparty}: ${fmtMoney(o.left)} к ${fmtDate(o.date)} — напомнить дебитору`
            : `Скоро выплата поставщику ${deal.counterparty}: ${fmtMoney(o.left)} к ${fmtDate(o.date)}`,
          date: o.date, kind: 'money',
        });
      }
    }
  }
  flags.sort((a, b) => (a.severity === b.severity ? a.date.localeCompare(b.date) : a.severity === 'red' ? -1 : 1));
  return flags;
}

/* Денежные события для календаря и графика CashFlow */
function cashflowEvents() {
  const events = [];
  for (const p of state.payments.filter((x) => x.posted)) {
    const deal = dealById(p.dealId);
    events.push({
      date: p.datePaymentExecution, amount: p.kind === 'in' ? p.amount : -p.amount,
      plan: false, label: `${p.num} · ${deal ? deal.counterparty : '—'}`,
      dir: p.kind,
    });
  }
  for (const deal of state.deals) {
    for (const o of moneyRegister(deal).open) {
      events.push({
        date: o.date, amount: deal.kind === 'sale' ? o.left : -o.left,
        plan: true, label: `План по накладной ${o.ref} · ${deal.counterparty}`,
        dir: deal.kind === 'sale' ? 'in' : 'out',
      });
    }
  }
  // прочие платежи: ближайшие 60 дней, со своим приоритетом
  const today = todayISO();
  for (const p of state.otherPayments) {
    const cat = OTHER_CATEGORIES[p.category] || OTHER_CATEGORIES.other;
    const overdueOnce = p.recurring !== 'monthly' && p.date < today;
    for (const d of otherPaymentOccurrences(p, today, addDays(today, 60))) {
      events.push({
        date: d, amount: -p.amount, plan: true,
        label: `${p.name} · ${cat.label}${p.recurring === 'monthly' ? ' (ежемесячно)' : ''}${overdueOnce ? ` — просрочен с ${fmtDate(p.date)}` : ''}`,
        dir: 'out', prio: overdueOnce ? 'critical' : p.priority,
      });
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date));
  return events;
}

/* =====================================================================
   Главный экран: живые остатки, матрица ликвидности, прогноз по дням.
   По спецификации «Главный экран»: Надо = Мы должны − (Живой остаток + Нам должны);
   маркер кассового разрыва — остаток ДС к концу дня < 0,
   маркер дефицита — остаток ТМЦ < 0. Любое проведение документа «сегодня»
   автоматически пересчитывает весь плановый горизонт (эффект домино).
   ===================================================================== */

/* Текущие остатки: заданные вручную либо расчётные из проведённых документов */
function currentBalances() {
  const s = getSettings();
  let cashCalc = 0, stockCalc = 0;
  for (const d of state.deals) {
    const a = dealAggregates(d);
    cashCalc += a.moneyFact;
    stockCalc += a.tmcFact;
  }
  const manualCash = typeof s.cashOpening === 'number' && isFinite(s.cashOpening);
  const manualStock = typeof s.stockOpening === 'number' && isFinite(s.stockOpening);
  return {
    cash: manualCash ? s.cashOpening : cashCalc,
    stock: manualStock ? s.stockOpening : stockCalc,
    manualCash, manualStock, cashCalc, stockCalc,
  };
}

/* Матрица товарно-денежного баланса (контуры ДС и ТМЦ) */
function liquidityMatrix() {
  const bal = currentBalances();
  let dsIn = 0, dsOut = 0, tmcIn = 0, tmcOut = 0;
  for (const deal of state.deals) {
    const isSale = deal.kind === 'sale';
    for (const o of moneyRegister(deal).open) {
      if (isSale) dsIn += o.left; else dsOut += o.left;
    }
    for (const o of materialRegister(deal).open) {
      if (isSale) tmcOut += o.left; else tmcIn += o.left;
    }
  }
  // прочие обязательные платежи ближайших 30 дней (аренда, налоги, зарплата…)
  const today = todayISO();
  const horizonEnd = addDays(today, 30);
  for (const p of state.otherPayments) {
    dsOut += p.amount * otherPaymentOccurrences(p, today, horizonEnd).length;
  }
  return {
    ds: { have: bal.cash, in: dsIn, out: dsOut, need: Math.max(0, dsOut - (bal.cash + dsIn)) },
    tmc: { have: bal.stock, in: tmcIn, out: tmcOut, need: Math.max(0, tmcOut - (bal.stock + tmcIn)) },
    bal,
  };
}

/* Прогноз остатков по дням будущего.
   Консервативный сценарий: просроченные ПРИТОКИ (деньги дебиторов, недошедшие
   поставки) в прогноз не включаются — на них нельзя рассчитывать; просроченные
   ОТТОКИ (наши долги и отгрузки) ставятся на «сегодня».
   sim — необязательный сценарий симулятора «Что если?»:
     {kind:'shift', src:'wb'|'other', id, newDate}  — сдвиг планового оттока
     {kind:'early', src:'wb', id}                   — досрочный приток просроченной ДЗ
     {kind:'drop',  src:'other', id}                — отказ от дискреционного расхода */
function computeProjection(horizon = 30, sim = null) {
  const today = todayISO();
  const bal = currentBalances();
  const horizonEnd = addDays(today, horizon);
  const events = [];
  const atRisk = [];
  for (const deal of state.deals) {
    const isSale = deal.kind === 'sale';
    for (const o of moneyRegister(deal).open) {
      const overdue = o.date < today;
      if (isSale) {
        if (overdue) {
          if (sim && sim.kind === 'early' && sim.src === 'wb' && sim.id === o.key) {
            events.push({ date: addDays(today, 1), cash: o.left, stock: 0, label: `Досрочная оплата от ${deal.counterparty} (${o.ref})`, sim: true });
          } else {
            atRisk.push({ kind: 'money', amount: o.left, deal, date: o.date, ref: o.ref, key: o.key });
          }
        } else {
          events.push({ date: o.date, cash: o.left, stock: 0, label: `Оплата от ${deal.counterparty} (${o.ref})` });
        }
      } else {
        let date = overdue ? today : o.date;
        let simmed = false;
        if (sim && sim.kind === 'shift' && sim.src === 'wb' && sim.id === o.key) { date = sim.newDate; simmed = true; }
        events.push({ date, cash: -o.left, stock: 0, label: `Оплата ${deal.counterparty} (${o.ref})`, overdue: overdue && !simmed, sim: simmed, src: 'wb', srcId: o.key });
      }
    }
    for (const o of materialRegister(deal).open) {
      const overdue = o.date < today;
      if (isSale) {
        events.push({ date: overdue ? today : o.date, cash: 0, stock: -o.left, label: `Отгрузка ${deal.counterparty} (${o.ref})`, overdue });
      } else {
        if (overdue) atRisk.push({ kind: 'stock', amount: o.left, deal, date: o.date, ref: o.ref, key: o.key });
        else events.push({ date: o.date, cash: 0, stock: o.left, label: `Поставка ${deal.counterparty} (${o.ref})` });
      }
    }
  }
  // прочие платежи (вне сделок): аренда, налоги, зарплата, дискреционные
  for (const p of state.otherPayments) {
    if (sim && sim.kind === 'drop' && sim.src === 'other' && sim.id === p.id) continue;
    let occ = otherPaymentOccurrences(p, today, horizonEnd);
    if (sim && sim.kind === 'shift' && sim.src === 'other' && sim.id === p.id && occ.length) {
      occ = [sim.newDate, ...occ.slice(1)];
    }
    const cat = OTHER_CATEGORIES[p.category] || OTHER_CATEGORIES.other;
    for (const [i, d] of occ.entries()) {
      events.push({
        date: d, cash: -p.amount, stock: 0,
        label: `${p.name} (${cat.label.toLowerCase()})`,
        overdue: p.date < today && p.recurring !== 'monthly',
        sim: !!(sim && sim.kind === 'shift' && sim.src === 'other' && sim.id === p.id && i === 0),
        src: 'other', srcId: p.id, prio: p.priority,
      });
    }
  }
  const days = [];
  let cash = bal.cash, stock = bal.stock;
  for (let i = 0; i <= horizon; i++) {
    const d = addDays(today, i);
    const evs = events.filter((e) => e.date === d);
    cash += sum(evs.map((e) => e.cash));
    stock += sum(evs.map((e) => e.stock));
    days.push({ date: d, cash, stock, events: evs, cashGap: cash < -0.004, deficit: stock < -0.004 });
  }
  return {
    days,
    firstGap: days.find((x) => x.cashGap) || null,
    firstDeficit: days.find((x) => x.deficit) || null,
    atRisk, bal, today,
  };
}

/* =====================================================================
   Симулятор «Что если?» — готовые решения при кассовом разрыве
   ===================================================================== */

function generateSolutions(proj, horizon = 30) {
  if (!proj.firstGap) return [];
  const sols = [];
  const today = proj.today;
  const gapDays = proj.days.filter((d) => d.cashGap);
  const lastGapDate = gapDays[gapDays.length - 1].date;

  const describe = (sim) => {
    const p2 = computeProjection(horizon, sim);
    if (!p2.firstGap) return { resolved: true, text: 'разрыв полностью устраняется' };
    if (p2.firstGap.date > proj.firstGap.date || p2.days.filter((d) => d.cashGap).length < gapDays.length) {
      return { resolved: false, text: `разрыв сокращается (останется с ${fmtDate(p2.firstGap.date)})` };
    }
    return null; // не улучшает — не предлагаем
  };

  // 1) сдвиг плановых оттоков, попадающих в зону разрыва
  const outflows = [];
  for (const d of proj.days) {
    if (d.date > lastGapDate) break;
    for (const e of d.events) {
      // ежемесячные серии сдвигом одного вхождения не решаются — не предлагаем
      if (e.cash < 0 && e.src && !(e.src === 'other' &&
        state.otherPayments.find((x) => x.id === e.srcId)?.recurring === 'monthly')) {
        outflows.push({ ...e, date: d.date });
      }
    }
  }
  const seen = new Set();
  for (const o of outflows) {
    if (seen.has(o.src + o.srcId)) continue;
    seen.add(o.src + o.srcId);
    // ищем ближайшую дату сдвига, при которой разрыв уходит
    for (let i = diffDays(lastGapDate, today) + 1; i <= horizon; i++) {
      const sim = { kind: 'shift', src: o.src, id: o.srcId, newDate: addDays(today, i) };
      const eff = describe(sim);
      if (eff && eff.resolved) {
        sols.push({ sim, title: `Сдвинуть «${o.label}» ${fmtMoney(-o.cash)} на ${fmtDate(sim.newDate)}`, effect: eff.text });
        break;
      }
    }
  }

  // 2) досрочная оплата просроченной дебиторки
  for (const r of proj.atRisk.filter((x) => x.kind === 'money')) {
    const sim = { kind: 'early', src: 'wb', id: r.key };
    const eff = describe(sim);
    if (eff) sols.push({ sim, title: `Запросить досрочную оплату у ${r.deal.counterparty}: ${fmtMoney(r.amount)} (${r.ref})`, effect: eff.text });
  }

  // 3) отказ от дискреционных расходов — предлагаем и при частичном эффекте
  const minCash = (p) => Math.min(...p.days.map((d) => d.cash));
  for (const p of state.otherPayments.filter((x) => !x.done && x.priority === 'discretionary')) {
    const sim = { kind: 'drop', src: 'other', id: p.id };
    let eff = describe(sim);
    if (!eff) {
      const p2 = computeProjection(horizon, sim);
      const before = minCash(proj), after = minCash(p2);
      if (after > before + 0.004) eff = { resolved: false, text: `глубина разрыва уменьшится: ${fmtMoney(before)} → ${fmtMoney(after)}` };
    }
    if (eff) sols.push({ sim, title: `Отказаться от «${p.name}» (${fmtMoney(p.amount)}${p.recurring === 'monthly' ? '/мес' : ''})`, effect: eff.text });
  }

  return sols.slice(0, 4);
}

/* Активный сценарий моделирования (не сохраняется, живёт до перезагрузки) */
let simulation = null;
let lastSolutions = [];

function applySimulation() {
  if (!simulation) return;
  const sim = simulation;
  const today = todayISO();
  // цель могла быть удалена или изменена, пока шло моделирование
  const target = sim.src === 'wb'
    ? state.waybills.find((w) => w.id === sim.id)
    : state.otherPayments.find((x) => x.id === sim.id);
  if (!target) {
    simulation = null;
    showToast('Сценарий не применён', ['Документ сценария не найден — данные изменились. Пересчитайте решения.'], 'red');
    render();
    return;
  }
  if (sim.src === 'wb') {
    const wb = state.waybills.find((w) => w.id === sim.id);
    if (wb) {
      const oldDate = wb.datePaymentPlan;
      wb.datePaymentPlan = sim.kind === 'early' ? addDays(today, 1) : sim.newDate;
      state.journal.unshift({
        ts: new Date().toISOString(),
        doc: `Накладная ${wb.num}`,
        deal: dealById(wb.dealId) ? dealTitle(dealById(wb.dealId)) : '—',
        real: true,
        lines: [`Корректировка_Плановой_Даты(${fmtDate(oldDate)} → ${fmtDate(wb.datePaymentPlan)})`,
          sim.kind === 'early' ? '// дебитор подтвердил досрочную оплату' : '// сценарий симулятора утверждён руководителем'],
      });
    }
  } else if (sim.src === 'other') {
    const p = state.otherPayments.find((x) => x.id === sim.id);
    if (p) {
      if (sim.kind === 'drop') {
        p.done = true;
        state.journal.unshift({ ts: new Date().toISOString(), doc: `Прочий платёж «${p.name}»`, deal: '—', real: true,
          lines: ['Отказ_От_Расхода() — дискреционный платёж исключён из графика'] });
      } else {
        const oldDate = p.date;
        p.date = sim.newDate;
        state.journal.unshift({ ts: new Date().toISOString(), doc: `Прочий платёж «${p.name}»`, deal: '—', real: true,
          lines: [`Корректировка_Плановой_Даты(${fmtDate(oldDate)} → ${fmtDate(p.date)})`, '// сценарий симулятора утверждён руководителем'] });
      }
    }
  }
  simulation = null;
  save();
  showToast('Сценарий утверждён', ['График будущего пересчитан (эффект домино)']);
  render();
}

/* =====================================================================
   Склад по номенклатуре: остатки в натуре, дефицит и залежалость по позициям
   ===================================================================== */

/* Фактические движения позиции из строк реальных проведённых накладных */
function itemMovements(itemId) {
  const moves = [];
  for (const w of state.waybills) {
    if (!w.posted || !w.isReal || !Array.isArray(w.lines)) continue;
    for (const l of w.lines) {
      if (l.itemId !== itemId) continue;
      moves.push({ date: w.dateMaterialFact, qty: w.kind === 'in' ? l.qty : -l.qty, num: w.num });
    }
  }
  moves.sort((a, b) => a.date.localeCompare(b.date));
  return moves;
}

/* Плановые движения позиции: остаток обязательств по строкам сделок.
   Плановая дата — ближайшая открытая материальная квота сделки. */
function itemPlanMoves(itemId, today) {
  const plans = [];
  for (const deal of state.deals) {
    if (!Array.isArray(deal.lines)) continue;
    const plannedQty = sum(deal.lines.filter((l) => l.itemId === itemId).map((l) => l.qty));
    if (plannedQty <= 0) continue;
    let factQty = 0;
    for (const w of state.waybills) {
      if (!w.posted || !w.isReal || w.dealId !== deal.id || !Array.isArray(w.lines)) continue;
      for (const l of w.lines) if (l.itemId === itemId) factQty += l.qty;
    }
    const remaining = Math.max(0, plannedQty - factQty);
    if (remaining <= 0) continue;
    const open = materialRegister(deal).open;
    // плановая дата: из открытых квот (после оплат), иначе — из договорного
    // графика (обязательства юр. блока, ещё не возникшие документами)
    let dueDate = open.length ? open[0].date
      : (deal.scheduleDays ? nextScheduleDate(deal.scheduleDays, today) : null);
    // отгрузка со склада поставщика: получение = дата графика + время доставки
    if (dueDate && !open.length && deal.kind === 'purchase' && deal.deliveryDays) {
      dueDate = addDays(dueDate, deal.deliveryDays);
    }
    plans.push({
      deal, remaining,
      qty: deal.kind === 'sale' ? -remaining : remaining,
      dueDate, overdue: dueDate ? dueDate < today : false,
      scheduled: !!dueDate,
    });
  }
  return plans;
}

/* Плановые события позиции для прогноза (общий помощник Табл.1 и склада):
   продажи (оттоки) — просроченные на сегодня; закупки (притоки) — просроченные
   не учитываем (консервативно, как в денежном прогнозе).
   planned — те же события по ИСХОДНЫМ датам (для Табл.2 «план/факт/отклонение»). */
function itemProjectionEvents(itemId, today) {
  const events = [];
  const planned = [];
  const atRiskQty = [];
  for (const p of itemPlanMoves(itemId, today)) {
    if (!p.scheduled) continue;
    planned.push({ date: p.dueDate, qty: p.qty, deal: p.deal });
    if (p.qty < 0) events.push({ date: p.overdue ? today : p.dueDate, qty: p.qty, deal: p.deal });
    else if (p.overdue) atRiskQty.push(p);
    else events.push({ date: p.dueDate, qty: p.qty, deal: p.deal });
  }
  return { events, planned, atRiskQty };
}

/* Сводка по складу: остатки, прогноз, маркеры дефицита и залежалости */
function computeItemsOutlook(horizon = 30) {
  const today = todayISO();
  const rows = [];
  for (const item of state.items) {
    const moves = itemMovements(item.id);
    const qtyToday = (item.qtyOpening || 0) + sum(moves.map((m) => m.qty));
    const plans = itemPlanMoves(item.id, today);
    const { events, atRiskQty } = itemProjectionEvents(item.id, today);
    let q = qtyToday, minQty = qtyToday, minDate = today;
    for (let i = 0; i <= horizon; i++) {
      const d = addDays(today, i);
      q += sum(events.filter((e) => e.date === d).map((e) => e.qty));
      if (q < minQty) { minQty = q; minDate = d; }
    }

    const lastMove = moves.length ? moves[moves.length - 1].date : null;
    const staleDays = item.staleDays || 0;
    // возраст без движения: от последнего движения либо от создания позиции —
    // свежая карточка с начальным остатком не считается залежалой в день создания
    const baseDate = lastMove || item.createdAt || today;
    const idleDays = diffDays(today, baseDate);
    const stale = staleDays > 0 && qtyToday > 0.004 && idleDays >= staleDays;
    const unscheduled = plans.filter((p) => !p.scheduled);

    rows.push({
      item, qtyToday,
      valueToday: qtyToday * (item.price || 0),
      minQty, minDate,
      deficit: minQty < -0.004,
      stale, idleDays,
      frozenValue: stale ? qtyToday * (item.price || 0) : 0,
      atRiskQty, unscheduled,
    });
  }
  return {
    rows,
    deficitCount: rows.filter((r) => r.deficit).length,
    staleCount: rows.filter((r) => r.stale).length,
    frozenTotal: sum(rows.map((r) => r.frozenValue)),
  };
}

/* Приоритет планового оттока для платёжного календаря.
   У прочих платежей приоритет собственный (по категории), у сделок — по сроку. */
function outflowPriority(date, today, prioKey) {
  if (prioKey && PRIORITIES[prioKey]) return PRIORITIES[prioKey];
  if (date < today) return PRIORITIES.critical;
  if (diffDays(date, today) <= 7) return PRIORITIES.primary;
  return PRIORITIES.flexible;
}

/* =====================================================================
   Проведение документов — логическая матрица из спецификации
   ===================================================================== */

function postDocument(type, id) {
  const list = type === 'payment' ? state.payments : state.waybills;
  const doc = list.find((d) => d.id === id);
  if (!doc || doc.posted) return;

  const deal = dealById(doc.dealId);
  const isReal = type === 'payment' ? true : !!doc.isReal;
  const label = type === 'payment'
    ? `Платёжный документ ${doc.num} (${PAY_KIND[doc.kind].toLowerCase()})`
    : `Накладная ${doc.num} (${WB_KIND[doc.kind].toLowerCase()})`;

  doc.posted = true;

  const lines = [];
  if (isReal) {
    const matDate = type === 'payment' ? doc.dateMaterialPlan : doc.dateMaterialFact;
    const payDate = type === 'payment' ? doc.datePaymentExecution : doc.datePaymentPlan;
    if (matDate) lines.push(`Обновить_График_ТМЦ("${shortId(doc.dealId)}", ${fmtDate(matDate)})`);
    if (payDate) lines.push(`Обновить_График_CashFlow("${shortId(doc.dealId)}", ${fmtDate(payDate)})`);
    lines.push('Актуализировать_Матрицу_Ресурсов()');
  } else {
    lines.push('Игнорировать_Управленческие_Регистры()');
    lines.push('// только стандартные бухгалтерские проводки');
  }

  state.journal.unshift({
    ts: new Date().toISOString(),
    doc: label,
    deal: deal ? dealTitle(deal) : '—',
    real: isReal,
    lines,
  });
  save();
  showToast(
    isReal ? `Проведено: ${label}` : `Проведено без управленческого следа: ${label}`,
    lines,
    isReal ? 'blue' : 'grey'
  );
  render();
}

function unpostDocument(type, id) {
  const list = type === 'payment' ? state.payments : state.waybills;
  const doc = list.find((d) => d.id === id);
  if (!doc || !doc.posted) return;
  doc.posted = false;
  const isReal = type === 'payment' ? true : !!doc.isReal;
  state.journal.unshift({
    ts: new Date().toISOString(),
    doc: `${type === 'payment' ? 'Платёжный документ' : 'Накладная'} ${doc.num}`,
    deal: dealById(doc.dealId) ? dealTitle(dealById(doc.dealId)) : '—',
    real: isReal,
    lines: isReal
      ? ['Отмена_Проведения() — записи регистров сторнированы', 'Актуализировать_Матрицу_Ресурсов()']
      : ['Отмена_Проведения()', '// управленческие регистры не затрагивались (Is_Real = НЕТ)'],
  });
  save();
  showToast(`Проведение отменено: ${doc.num}`,
    [isReal ? 'Записи регистров сторнированы' : 'Управленческие регистры не затрагивались'], 'grey');
  render();
}

/* =====================================================================
   UI-инфраструктура: модальные окна, тосты, роутер
   ===================================================================== */

let modalDirty = false;

function openModal(title, bodyHTML, onMount) {
  modalDirty = false;
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHTML;
  $('#modalBackdrop').hidden = false;
  document.body.style.overflow = 'hidden';
  if (onMount) onMount($('#modalBody'));
}

/* force=true — закрытие по «Отмена»/успешному сохранению, без вопросов.
   Случайный Esc или клик мимо заполненной формы требует подтверждения. */
function closeModal(force) {
  if (!force && modalDirty && $('#modalBody').querySelector('form') &&
      !confirm('Закрыть форму? Введённые данные будут потеряны.')) return;
  $('#modalBackdrop').hidden = true;
  $('#modalBody').innerHTML = '';
  document.body.style.overflow = '';
}

let quietToasts = false;

function showToast(title, lines, kind = 'blue') {
  if (quietToasts) return;
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.innerHTML = `<div class="toast-title">${esc(title)}</div>` +
    (lines || []).map((l) => `<div class="toast-line">${esc(l)}</div>`).join('');
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, 5200);
}

const ROUTES = {
  dashboard: { title: 'Главный экран', render: renderPlan },
  analytics: { title: 'Аналитика и графики', render: renderAnalytics },
  deals: { title: 'Сделки', render: renderDeals },
  payments: { title: 'Платёжные документы', render: renderPayments },
  waybills: { title: 'Накладные', render: renderWaybills },
  tmc: { title: 'График ТМЦ', render: renderTmc },
  plan: { title: 'Главный экран', render: renderPlan },
  'plan-t2': { title: 'Главный экран', render: renderPlan },
  stock: { title: 'Склад и номенклатура', render: renderStock },
  cashflow: { title: 'CashFlow-календарь', render: renderCashflow },
  matrix: { title: 'Матрица ресурсов', render: renderMatrix },
  journal: { title: 'Журнал проведения', render: renderJournal },
  help: { title: 'Спецификация', render: renderHelp },
};

function currentRoute() {
  const r = (location.hash || '#/dashboard').replace(/^#\//, '');
  return ROUTES[r] ? r : 'dashboard';
}

function render() {
  const route = currentRoute();
  const navRoute = route === 'plan-t2' || route === 'plan' ? 'dashboard' : route;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === navRoute));
  $('#pageTitle').textContent = ROUTES[route].title;
  $('#todayChip').textContent = 'Сегодня: ' + fmtDate(todayISO());
  const flags = computeFlags();
  const reds = flags.filter((f) => f.severity === 'red').length;
  const navFlag = $('#navFlagCount');
  navFlag.hidden = reds === 0;
  navFlag.textContent = reds;
  $('#main').innerHTML = ROUTES[route].render(flags);
  bindMainEvents();
  $('#sidebar').classList.remove('open');
  $('#sidebarOverlay').classList.remove('show');
}

/* =====================================================================
   Страницы
   ===================================================================== */

function emptyBlock(icon, title, text, actionsHTML = '') {
  return `<div class="empty"><div class="empty-ico">${ic(icon, 30)}</div>
    <div class="empty-title">${esc(title)}</div><p>${esc(text)}</p>${actionsHTML}</div>`;
}

/* Заголовок карточки с рисованной иконкой */
function cardTitle(icon, title, hint) {
  return `<div class="card-title"><span class="ct-ico">${ic(icon, 16)}</span><span>${title}</span>${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
}

const demoButtonHTML = `<button class="btn btn-primary" data-action="demo">Загрузить демо-сценарий</button>`;

/* ---------- Дашборд ---------- */
/* Герой-счётчик красных маркеров: флаги + разрыв + дефициты (общий для страниц) */
function buildMarkerHero(flags, proj, mx, stockOutlook) {
  const today = proj.today;
  const reds = flags.filter((f) => f.severity === 'red');
  const markerCount = reds.length + (proj.firstGap ? 1 : 0) + (proj.firstDeficit ? 1 : 0) + stockOutlook.deficitCount;
  const markerSubs = [];
  if (proj.firstGap) markerSubs.push(`кассовый разрыв ${fmtDate(proj.firstGap.date)} (через ${diffDays(proj.firstGap.date, today)} дн.)`);
  if (proj.firstDeficit) markerSubs.push(`дефицит ТМЦ ${fmtDate(proj.firstDeficit.date)}`);
  if (stockOutlook.deficitCount) markerSubs.push(`дефицит по ${stockOutlook.deficitCount} поз. склада`);
  if (reds.length) markerSubs.push(`просрочек: ${reds.length}`);
  if (stockOutlook.staleCount) markerSubs.push(`заморожено ${fmtMoney(stockOutlook.frozenTotal)} (${stockOutlook.staleCount} залежалых поз.)`);

  return `
  <div class="marker-hero ${markerCount ? 'alert' : 'calm'}">
    <div class="marker-count-wrap">
      <div class="marker-count">${markerCount}</div>
      <div class="marker-caption">красных маркеров</div>
    </div>
    <div class="marker-verdict">
      ${markerCount
        ? `<div class="marker-title">Требуется вмешательство</div>
           <div class="marker-sub">${markerSubs.map(esc).join(' · ')}</div>
           <button class="btn btn-outline btn-sm" style="margin-top:10px" data-action="goto-flags">Спуститься к причинам</button>`
        : `<div class="marker-title">Бизнес работает нормально</div>
           <div class="marker-sub">Все обязательства исполняются в срок, разрывов на горизонте нет. Вы свободны от операционки.</div>`}
    </div>
    <div class="marker-balances">
      <div class="mb-row"><span class="mb-label">Живой остаток ДС</span>
        <span class="mb-value ${mx.ds.have < 0 ? 'neg' : ''}">${fmtMoney(mx.ds.have)}</span></div>
      <div class="mb-row"><span class="mb-label">Запас ТМЦ на складе</span>
        <span class="mb-value ${mx.tmc.have < 0 ? 'neg' : ''}">${fmtMoney(mx.tmc.have)}</span></div>
      <div class="mb-note">${proj.bal.manualCash || proj.bal.manualStock ? 'заданы вручную' : 'расчёт из документов'}
        · <button class="link-btn" data-action="edit-balances">изменить</button></div>
    </div>
  </div>`;
}

function renderAnalytics(flags) {
  if (!state.deals.length && !state.payments.length && !state.waybills.length) {
    return `<div class="card">${emptyBlock('chart', 'Аналитика пуста',
      'Создайте сделку и документы — или загрузите демонстрационный сценарий.', demoButtonHTML)}</div>`;
  }

  const today = todayISO();
  const proj = computeProjection(30);
  const mx = liquidityMatrix();

  /* Матрица товарно-денежного баланса: Надо = Мы должны − (Есть + Нам должны) */
  const matrixHTML = `
  <div class="card">${cardTitle('table', 'Матрица товарно-денежного баланса', 'Надо = Мы должны − (Живой остаток + Нам должны)')}
  <div class="table-wrap"><table>
    <thead><tr><th>Контур</th><th class="num">У нас есть</th><th class="num">Нам должны</th><th class="num">Мы должны</th><th class="num">НАДО (фокус)</th></tr></thead>
    <tbody>
      <tr>
        <td><div class="cell-main">Денежные средства</div><div class="cell-sub">счета и касса + обязательства по деньгам</div></td>
        <td class="num ${mx.ds.have < 0 ? 'neg-cell' : ''}">${fmtMoney(mx.ds.have)}</td>
        <td class="num">${mx.ds.in ? '+' + fmtMoney(mx.ds.in) : '—'}</td>
        <td class="num">${mx.ds.out ? '−' + fmtMoney(mx.ds.out) : '—'}</td>
        <td class="num">${mx.ds.need > 0
          ? `<span class="badge badge-red">не хватает ${fmtMoney(mx.ds.need)}</span>`
          : proj.firstGap
            ? `<span class="badge badge-red">разрыв ${fmtDate(proj.firstGap.date)}: ${fmtMoney(proj.firstGap.cash)}</span>`
            : '<span class="badge badge-green">покрыто</span>'}</td>
      </tr>
      <tr>
        <td><div class="cell-main">Товары (ТМЦ)</div><div class="cell-sub">склад + обязательства по перемещению</div></td>
        <td class="num ${mx.tmc.have < 0 ? 'neg-cell' : ''}">${fmtMoney(mx.tmc.have)}</td>
        <td class="num">${mx.tmc.in ? '+' + fmtMoney(mx.tmc.in) : '—'}</td>
        <td class="num">${mx.tmc.out ? '−' + fmtMoney(mx.tmc.out) : '—'}</td>
        <td class="num">${mx.tmc.need > 0
          ? `<span class="badge badge-red">дефицит ${fmtMoney(mx.tmc.need)}</span>`
          : proj.firstDeficit
            ? `<span class="badge badge-red">дефицит ${fmtDate(proj.firstDeficit.date)}: ${fmtMoney(proj.firstDeficit.stock)}</span>`
            : '<span class="badge badge-green">покрыто</span>'}</td>
      </tr>
    </tbody>
  </table></div>
  <div class="legend" style="margin-top:10px">
    <span>«Нам должны» — подтверждённая ДЗ и оплаченные недошедшие поставки</span>
    <span>«Мы должны» — КЗ поставщикам и обязательства по отгрузке за предоплаты</span>
  </div></div>`;

  const atRiskHTML = proj.atRisk.length
    ? `<div class="callout callout-grey" style="margin-top:12px">Вне прогноза (просроченные притоки, на них нельзя рассчитывать): ${proj.atRisk.map((r) =>
        esc(`${r.kind === 'money' ? 'оплата' : 'поставка'} ${fmtMoney(r.amount)} от ${r.deal.counterparty} (ждали ${fmtDate(r.date)})`)).join('; ')}.</div>`
    : '';

  const projHTML = `
  <div class="card">${cardTitle('chart', 'Прогноз остатков на 30 дней', 'эффект домино: каждый проведённый документ пересчитывает график')}
    ${svgProjection(proj)}
    ${atRiskHTML}
  </div>`;

  const events = cashflowEvents().filter((e) => e.plan);
  const horizon = addDays(today, 14);
  const upcoming = events.filter((e) => e.date <= horizon).slice(0, 8);
  const calHTML = upcoming.length
    ? upcoming.map((e) => calEventHTML(e, today, true)).join('')
    : `<div class="empty" style="padding:24px"><div class="empty-ico">${ic('banknote', 30)}</div><div class="empty-title">Плановых платежей нет</div><p>Ближайшие 14 дней свободны от денежных обязательств.</p></div>`;

  const lastJournal = state.journal.slice(0, 4).map(journalEntryHTML).join('') ||
    `<p style="color:var(--ink-soft);font-size:13px">Документы ещё не проводились.</p>`;

  return `${matrixHTML}
  ${projHTML}
  <div class="two-col">
    <div class="card">${cardTitle('calendar', 'Платёжный календарь', 'приоритеты: обязательный · первоочередной · не первоочередной')}${calHTML}</div>
    <div class="card">${cardTitle('ledger', 'Последние проведения')}${lastJournal}</div>
  </div>`;
}

/* Ступенчатый график прогноза: ДС (тушь) и ТМЦ (охра), красное — ниже нуля */
function svgProjection(proj) {
  const days = proj.days;
  if (!days.length) return '';
  const W = 860, H = 240, PL = 84, PR = 20, PT = 14, PB = 28;
  const vals = days.flatMap((d) => [d.cash, d.stock]).concat([0]);
  const vmin = Math.min(...vals), vmax = Math.max(...vals);
  const vspan = Math.max(1, vmax - vmin);
  const x = (i) => PL + ((W - PL - PR) * i) / Math.max(1, days.length - 1);
  const y = (v) => PT + (H - PT - PB) * (1 - (v - vmin) / vspan);

  const path = (key) => days.map((d, i) => {
    const px = x(i).toFixed(1), py = y(d[key]).toFixed(1);
    return i === 0 ? `M ${px} ${py}` : `L ${px} ${(y(days[i - 1][key])).toFixed(1)} L ${px} ${py}`;
  }).join(' ');

  const markers = days.map((d, i) => {
    let out = '';
    if (d.cashGap) out += `<circle cx="${x(i).toFixed(1)}" cy="${y(d.cash).toFixed(1)}" r="4" fill="#9e2b25" stroke="#fbfaf5" stroke-width="1.5"><title>${esc(fmtDate(d.date) + ' — кассовый разрыв: ' + fmtMoney(d.cash))}</title></circle>`;
    if (d.deficit) out += `<rect x="${(x(i) - 3.5).toFixed(1)}" y="${(y(d.stock) - 3.5).toFixed(1)}" width="7" height="7" fill="#9e2b25" stroke="#fbfaf5" stroke-width="1.5"><title>${esc(fmtDate(d.date) + ' — дефицит ТМЦ: ' + fmtMoney(d.stock))}</title></rect>`;
    return out;
  }).join('');

  const zeroY = y(0);
  const fmtShort = (v) => (Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + ' млн' : Math.abs(v) >= 1e3 ? Math.round(v / 1e3) + ' тыс' : String(Math.round(v)));
  const grid = [vmax, (vmax + vmin) / 2, vmin].map((v) =>
    `<line x1="${PL}" y1="${y(v).toFixed(1)}" x2="${W - PR}" y2="${y(v).toFixed(1)}" stroke="#e6e0cf" stroke-width="1"/>
     <text x="${PL - 8}" y="${(y(v) + 4).toFixed(1)}" font-size="11" fill="#7a725d" text-anchor="end" font-family="PT Sans, sans-serif">${fmtShort(v)}</text>`).join('');

  return `<svg class="timeline-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Прогноз остатков">
    ${grid}
    <line x1="${PL}" y1="${zeroY.toFixed(1)}" x2="${W - PR}" y2="${zeroY.toFixed(1)}" stroke="#b8ae95" stroke-width="1.5" stroke-dasharray="2 3"/>
    <path d="${path('cash')}" fill="none" stroke="#1c1a15" stroke-width="2" stroke-linejoin="round"/>
    <path d="${path('stock')}" fill="none" stroke="#8a6d1f" stroke-width="1.8" stroke-dasharray="7 4" stroke-linejoin="round"/>
    ${markers}
    <text x="${PL}" y="${H - 10}" font-size="10" fill="#7a725d" font-family="PT Sans, sans-serif">${fmtDate(days[0].date)} (сегодня)</text>
    <text x="${W - PR}" y="${H - 10}" font-size="10" fill="#7a725d" text-anchor="end" font-family="PT Sans, sans-serif">${fmtDate(days[days.length - 1].date)}</text>
  </svg>
  <div class="legend" style="margin-top:8px">
    <span><i style="background:#1c1a15"></i> остаток ДС</span>
    <span><i style="background:#8a6d1f"></i> запас ТМЦ (в ₽)</span>
    <span><i style="background:#9e2b25"></i> маркер: разрыв / дефицит</span>
  </div>`;
}

function flagItemHTML(f) {
  const deal = dealById(f.dealId);
  return `<div class="flag-item">
    <span class="flag-dot ${f.severity}" style="margin-top:6px"></span>
    <div class="flag-body">
      <div class="flag-text">${esc(f.text)}</div>
      <div class="flag-meta">
        <span class="badge ${f.severity === 'red' ? 'badge-red' : 'badge-amber'}">${f.workplace}</span>
        <span>${deal ? esc(dealTitle(deal)) : ''}</span>
      </div>
    </div>
  </div>`;
}

function calEventHTML(e, today, withPriority) {
  const overdue = e.plan && e.date < today;
  // приоритет ранжирует только оттоки (докс: критичные / первоочередные / гибкие / дискреционные)
  const prio = withPriority && e.plan && e.dir === 'out' ? outflowPriority(e.date, today, e.prio) : null;
  return `<div class="cal-event ${e.dir} ${overdue ? 'overdue' : ''}">
    <span class="badge ${e.plan ? (overdue ? 'badge-red' : 'badge-blue') : 'badge-grey'}">${overdue ? 'просрочено' : e.plan ? 'план' : 'факт'}</span>
    ${prio ? `<span class="badge ${prio.cls}">${prio.label}</span>` : ''}
    <span>${fmtDate(e.date)} · ${esc(e.label)}</span>
    <span class="amt">${e.dir === 'in' ? '+' : '−'}${fmtMoney(Math.abs(e.amount))}</span>
  </div>`;
}

/* Форма живых остатков на сегодня */
function openBalancesForm() {
  const s = getSettings();
  const bal = currentBalances();
  openModal('Живые остатки на сегодня', `
    <form id="frm" class="form-grid">
      <div class="field full"><label>Остаток денежных средств, ₽</label>
        <input name="cashOpening" type="number" step="0.01" value="${bal.manualCash ? s.cashOpening : ''}" placeholder="расчётный: ${fmtMoney(bal.cashCalc)}">
        <div class="note">Деньги на счетах и в кассе на сегодня — из банковской выписки. Пусто — берётся расчёт из проведённых платёжек.</div></div>
      <div class="field full"><label>Запас ТМЦ на складе, ₽</label>
        <input name="stockOpening" type="number" step="0.01" value="${bal.manualStock ? s.stockOpening : ''}" placeholder="расчётный: ${fmtMoney(bal.stockCalc)}">
        <div class="note">Фактический складской запас в оценке — из инвентаризации. Пусто — расчёт из реальных накладных.</div></div>
      <div class="form-actions full">
        <button type="button" class="btn btn-outline" data-close>Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить остатки</button>
      </div>
    </form>`, (body) => {
    body.querySelector('#frm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const parse = (v) => {
        const t = String(v).trim();
        if (!t) return null;
        const n = parseFloat(t);
        return isFinite(n) ? n : null;
      };
      const st = getSettings();
      st.cashOpening = parse(f.get('cashOpening'));
      st.stockOpening = parse(f.get('stockOpening'));
      save(); closeModal(true); render();
      showToast('Остатки обновлены', [
        `ДС: ${st.cashOpening != null ? fmtMoney(st.cashOpening) + ' (вручную)' : 'расчёт из документов'}`,
        `ТМЦ: ${st.stockOpening != null ? fmtMoney(st.stockOpening) + ' (вручную)' : 'расчёт из документов'}`,
      ]);
    });
  });
}

/* Форма позиции номенклатуры */
function openItemForm(id) {
  const it = id ? itemById(id) : null;
  openModal(it ? 'Позиция ' + it.sku : 'Новая позиция номенклатуры', `
    <form id="frm" class="form-grid">
      <div class="field"><label>Артикул <span class="req">*</span></label>
        <input name="sku" required value="${it ? esc(it.sku) : ''}" placeholder="АРТ-001"></div>
      <div class="field"><label>Наименование <span class="req">*</span></label>
        <input name="name" required value="${it ? esc(it.name) : ''}" placeholder="Секции ограждений"></div>
      <div class="field"><label>Единица измерения</label>
        <input name="unit" value="${it ? esc(it.unit) : 'шт'}"></div>
      <div class="field"><label>Учётная цена, ₽</label>
        <input name="price" type="number" min="0" step="0.01" value="${it ? it.price : ''}">
        <div class="note">Для оценки стоимости остатка и «замороженных» денег.</div></div>
      <div class="field"><label>Начальный остаток (кол-во)</label>
        <input name="qtyOpening" type="number" min="0" step="0.001" value="${it ? it.qtyOpening : 0}">
        <div class="note">Остаток на момент начала учёта — из инвентаризации. Не может быть отрицательным.</div></div>
      <div class="field"><label>Норматив залежалости, дней</label>
        <input name="staleDays" type="number" min="0" step="1" value="${it ? it.staleDays : 30}">
        <div class="note">Нет движения дольше — позиция подсвечивается как «замороженные деньги». 0 — не контролировать.</div></div>
      <div class="form-actions full">
        <button type="button" class="btn btn-outline" data-close>Отмена</button>
        <button type="submit" class="btn btn-primary">${it ? 'Сохранить' : 'Создать позицию'}</button>
      </div>
    </form>`, (body) => {
    body.querySelector('#frm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const sku = f.get('sku').trim(), name = f.get('name').trim();
      if (!sku || !name) { showToast('Заполните артикул и наименование', ['Пробелы не считаются'], 'red'); return; }
      if (state.items.some((x) => x.sku === sku && x.id !== (it ? it.id : ''))) {
        showToast('Артикул уже занят', [sku], 'red'); return;
      }
      const rec = it || { id: uuid(), createdAt: todayISO() };
      rec.sku = sku; rec.name = name;
      rec.unit = f.get('unit').trim() || 'шт';
      rec.price = Math.max(0, parseFloat(f.get('price')) || 0);
      rec.qtyOpening = Math.max(0, parseFloat(f.get('qtyOpening')) || 0);
      rec.staleDays = Math.max(0, parseInt(f.get('staleDays'), 10) || 0);
      if (!it) state.items.push(rec);
      save(); closeModal(true); render();
      showToast(it ? 'Позиция обновлена' : 'Позиция создана', [`${rec.sku} · ${rec.name}`]);
    });
  });
}

/* Форма прочего платежа (вне сделок) */
function openOtherForm(id) {
  const p = id ? state.otherPayments.find((x) => x.id === id) : null;
  const catOptions = Object.entries(OTHER_CATEGORIES).map(([k, c]) =>
    `<option value="${k}" ${p && p.category === k ? 'selected' : ''}>${c.label}</option>`).join('');
  const prioOptions = Object.entries(PRIORITIES).map(([k, c]) =>
    `<option value="${k}" ${p && p.priority === k ? 'selected' : ''}>${c.label}</option>`).join('');
  openModal(p ? 'Платёж «' + p.name + '»' : 'Новый прочий платёж', `
    <form id="frm" class="form-grid">
      <div class="field full"><label>Название <span class="req">*</span></label>
        <input name="name" required value="${p ? esc(p.name) : ''}" placeholder="Аренда склада"></div>
      <div class="field"><label>Категория</label>
        <select name="category" id="fCat">${catOptions}</select>
        <div class="note" id="fCatNote">Приоритет подставляется по категории, его можно изменить.</div></div>
      <div class="field"><label>Приоритет</label>
        <select name="priority" id="fPrio">${prioOptions}</select>
        <div class="note">Дискреционные расходы симулятор предложит отменить при риске разрыва.</div></div>
      <div class="field"><label>Сумма, ₽ <span class="req">*</span></label>
        <input name="amount" type="number" min="0.01" step="0.01" required value="${p ? p.amount : ''}"></div>
      <div class="field"><label>Дата платежа <span class="req">*</span></label>
        <input name="date" type="date" required value="${p ? p.date : todayISO()}"></div>
      <div class="field full"><label>Повторение</label>
        <select name="recurring">
          <option value="none" ${!p || p.recurring !== 'monthly' ? 'selected' : ''}>Разовый</option>
          <option value="monthly" ${p && p.recurring === 'monthly' ? 'selected' : ''}>Ежемесячно</option>
        </select>
        <div class="note">Ежемесячно: прошедшие вхождения считаются исполненными. Неоплаченный прошлый период оформите отдельным разовым платежом — он попадёт в прогноз как просроченный.</div></div>
      <div class="form-actions full">
        <button type="button" class="btn btn-outline" data-close>Отмена</button>
        <button type="submit" class="btn btn-primary">${p ? 'Сохранить' : 'Добавить платёж'}</button>
      </div>
    </form>`, (body) => {
    const fCat = body.querySelector('#fCat');
    const fPrio = body.querySelector('#fPrio');
    if (!p) fPrio.value = OTHER_CATEGORIES[fCat.value].prio;
    fCat.addEventListener('change', () => { fPrio.value = OTHER_CATEGORIES[fCat.value].prio; });
    body.querySelector('#frm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const name = f.get('name').trim();
      const amount = parseFloat(f.get('amount')) || 0;
      if (!name || amount <= 0) { showToast('Заполните название и сумму', [], 'red'); return; }
      const rec = p || { id: uuid(), done: false };
      rec.name = name;
      rec.category = f.get('category');
      rec.priority = f.get('priority');
      rec.amount = amount;
      rec.date = f.get('date');
      rec.recurring = f.get('recurring');
      if (!p) state.otherPayments.push(rec);
      save(); closeModal(true); render();
      showToast(p ? 'Платёж обновлён' : 'Платёж добавлен в график',
        [`${rec.name} · ${fmtMoney(rec.amount)}${rec.recurring === 'monthly' ? '/мес' : ''} · ${PRIORITIES[rec.priority].label}`]);
    });
  });
}

/* =====================================================================
   Редактор строк спецификации (позиция × кол-во × цена) для сделок и накладных
   ===================================================================== */

function itemOptions(selectedId) {
  return '<option value="">— позиция —</option>' + state.items.map((i) =>
    `<option value="${esc(i.id)}" ${i.id === selectedId ? 'selected' : ''}>${esc(i.sku + ' · ' + i.name)}</option>`).join('');
}

function linesEditorHTML(lines) {
  const rows = (lines || []).map((l) => lineRowHTML(l)).join('');
  if (!state.items.length) {
    return `<div class="field full"><label>Спецификация по позициям</label>
      <div class="note">Номенклатуры пока нет — создайте позиции в разделе «Склад и номенклатура», чтобы вести поартикульный учёт. Без спецификации документ работает по сумме.</div></div>`;
  }
  return `<div class="field full"><label>Спецификация по позициям</label>
    <div id="linesBox">${rows}</div>
    <button type="button" class="btn btn-outline btn-sm" id="addLine" style="margin-top:6px">+ позиция</button>
    <div class="note" id="linesNote">Со спецификацией сумма документа считается по строкам; без неё — вводится вручную.</div>
  </div>`;
}

function lineRowHTML(l) {
  return `<div class="line-row">
    <select class="l-item">${itemOptions(l ? l.itemId : '')}</select>
    <input class="l-qty" type="number" step="0.001" min="0" placeholder="кол-во" value="${l ? l.qty : ''}">
    <input class="l-price" type="number" step="0.01" min="0" placeholder="цена" value="${l ? l.price : ''}">
    <span class="l-sum">—</span>
    <button type="button" class="l-del" title="Убрать строку">✕</button>
  </div>`;
}

/* Монтирует обработчики редактора строк; totalInput — поле «Сумма» документа */
function mountLinesEditor(body, totalInput) {
  const box = body.querySelector('#linesBox');
  if (!box) return { getLines: () => [] };

  const recalc = () => {
    let total = 0, any = false;
    box.querySelectorAll('.line-row').forEach((row) => {
      const qty = parseFloat(row.querySelector('.l-qty').value) || 0;
      const price = parseFloat(row.querySelector('.l-price').value) || 0;
      const ok = row.querySelector('.l-item').value && qty > 0;
      const s = qty * price;
      row.querySelector('.l-sum').textContent = ok ? fmtMoney(s) : '—';
      if (ok) { total += s; any = true; }
    });
    if (any) {
      totalInput.value = total.toFixed(2);
      totalInput.readOnly = true;
    } else {
      totalInput.readOnly = false;
    }
  };

  box.addEventListener('input', recalc);
  box.addEventListener('change', (e) => {
    // при выборе позиции подставляем учётную цену, если цена ещё не задана
    if (e.target.classList.contains('l-item')) {
      const row = e.target.closest('.line-row');
      const item = itemById(e.target.value);
      const priceEl = row.querySelector('.l-price');
      if (item && !parseFloat(priceEl.value)) priceEl.value = item.price || '';
    }
    recalc();
  });
  box.addEventListener('click', (e) => {
    if (e.target.classList.contains('l-del')) { e.target.closest('.line-row').remove(); modalDirty = true; recalc(); }
  });
  body.querySelector('#addLine').addEventListener('click', () => {
    box.insertAdjacentHTML('beforeend', lineRowHTML(null));
    modalDirty = true;
  });
  recalc();

  return {
    getLines: () => {
      const out = [];
      box.querySelectorAll('.line-row').forEach((row) => {
        const itemId = row.querySelector('.l-item').value;
        const qty = parseFloat(row.querySelector('.l-qty').value) || 0;
        const price = parseFloat(row.querySelector('.l-price').value) || 0;
        if (itemId && itemById(itemId) && qty > 0) out.push({ itemId, qty, price });
      });
      return out;
    },
  };
}

/* ---------- Сделки ---------- */
function renderDeals() {
  const rows = state.deals.map((d) => {
    const a = dealAggregates(d);
    return `<tr>
      <td><div class="cell-main">${esc(d.name)}</div><div class="cell-sub">${esc(d.counterparty)}</div></td>
      <td><span class="badge ${d.kind === 'sale' ? 'badge-green' : 'badge-blue'}">${DEAL_KIND[d.kind].label}</span></td>
      <td class="uuid" data-action="copy-uuid" data-id="${esc(d.id)}" title="Скопировать полный UUID">${esc(shortId(d.id))}…</td>
      <td class="num">${fmtMoney(d.amount)}</td>
      <td class="num">${d.shipDays} дн.</td>
      <td class="num">${d.deferDays} дн.</td>
      <td class="num">${fmtMoney(a.paid)}</td>
      <td class="num">${fmtMoney(a.moved)}</td>
      <td><div class="row-actions">
        <button class="btn btn-outline btn-sm" data-action="edit-deal" data-id="${esc(d.id)}">Изменить</button>
        <button class="btn btn-outline btn-sm" data-action="del-deal" data-id="${esc(d.id)}">Удалить</button>
      </div></td>
    </tr>`;
  }).join('');

  return `<div class="page-head">
    <div class="desc">Сделка = договор со связкой <code style="font-family:var(--mono)">ID_Deal (UUID)</code>. Юридический блок задаёт два срока: поставка/отгрузка после оплаты и отсрочка платежа после перемещения ТМЦ — из них автоматически считаются плановые даты в документах.</div>
    <div class="spacer"></div>
    <button class="btn btn-primary" data-action="new-deal">+ Новая сделка</button>
  </div>
  <div class="card"><div class="table-wrap">
  ${state.deals.length ? `<table>
    <thead><tr><th>Сделка</th><th>Тип</th><th>ID_Deal</th><th class="num">Сумма</th><th class="num">Срок ТМЦ</th><th class="num">Отсрочка</th><th class="num">Оплачено</th><th class="num">Перемещено</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`
    : emptyBlock('deal', 'Сделок нет', 'Создайте первую сделку — документы привязываются к ней через ID_Deal.', demoButtonHTML)}
  </div></div>`;
}

/* ---------- Платёжные документы ---------- */
function renderPayments() {
  const rows = [...state.payments].sort((a, b) => b.datePaymentExecution.localeCompare(a.datePaymentExecution)).map((p) => {
    const deal = dealById(p.dealId);
    return `<tr>
      <td><div class="cell-main">${esc(p.num)}</div><div class="cell-sub">${deal ? esc(dealTitle(deal)) : '—'}</div></td>
      <td><span class="badge ${p.kind === 'in' ? 'badge-green' : 'badge-amber'}">${PAY_KIND[p.kind]}</span></td>
      <td class="num">${fmtMoney(p.amount)}</td>
      <td class="num">${fmtDate(p.datePaymentExecution)}</td>
      <td class="num">${fmtDate(p.dateMaterialPlan)}</td>
      <td>${p.posted ? '<span class="badge badge-green">Проведён</span>' : '<span class="badge badge-grey">Черновик</span>'}</td>
      <td><div class="row-actions">
        ${p.posted
          ? `<button class="btn btn-outline btn-sm" data-action="unpost" data-type="payment" data-id="${esc(p.id)}">Распровести</button>`
          : `<button class="btn btn-primary btn-sm" data-action="post" data-type="payment" data-id="${esc(p.id)}">Провести</button>
             <button class="btn btn-outline btn-sm" data-action="edit-payment" data-id="${esc(p.id)}">Изменить</button>
             <button class="btn btn-outline btn-sm" data-action="del-payment" data-id="${esc(p.id)}">Удалить</button>`}
      </div></td>
    </tr>`;
  }).join('');

  return `<div class="page-head">
    <div class="desc">Платёжка управляет денежным потоком и несёт две временные точки: <b>Date_Payment_Execution</b> — факт движения денег, и <b>Date_Material_Execution_Plan</b> — план, до какой даты ТМЦ должны быть физически перемещены (считается из договора).</div>
    <div class="spacer"></div>
    <button class="btn btn-primary" data-action="new-payment">+ Новый платёжный документ</button>
  </div>
  <div class="card"><div class="table-wrap">
  ${state.payments.length ? `<table>
    <thead><tr><th>Документ</th><th>Тип</th><th class="num">Сумма</th><th class="num">Оплата (факт)</th><th class="num">ТМЦ (план)</th><th>Статус</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`
    : emptyBlock('card', 'Платёжных документов нет', state.deals.length ? 'Создайте платёжный документ по сделке.' : 'Сначала создайте сделку — платёжка привязывается через ID_Deal.')}
  </div></div>`;
}

/* ---------- Накладные ---------- */
function renderWaybills() {
  const rows = [...state.waybills].sort((a, b) => b.dateMaterialFact.localeCompare(a.dateMaterialFact)).map((w) => {
    const deal = dealById(w.dealId);
    return `<tr>
      <td><div class="cell-main">${esc(w.num)}</div><div class="cell-sub">${deal ? esc(dealTitle(deal)) : '—'}${w.goods ? ' · ' + esc(w.goods) : ''}</div></td>
      <td><span class="badge ${w.kind === 'in' ? 'badge-blue' : 'badge-amber'}">${WB_KIND[w.kind]}</span></td>
      <td>${w.isReal ? '<span class="badge badge-green">Реальная</span>' : '<span class="badge badge-grey">Виртуальная</span>'}</td>
      <td class="num">${fmtMoney(w.amount)}</td>
      <td class="num">${fmtDate(w.dateMaterialFact)}</td>
      <td class="num">${w.isReal ? fmtDate(w.datePaymentPlan) : '—'}</td>
      <td>${w.posted ? '<span class="badge badge-green">Проведена</span>' : '<span class="badge badge-grey">Черновик</span>'}</td>
      <td><div class="row-actions">
        ${w.posted
          ? `<button class="btn btn-outline btn-sm" data-action="unpost" data-type="waybill" data-id="${esc(w.id)}">Распровести</button>`
          : `<button class="btn btn-primary btn-sm" data-action="post" data-type="waybill" data-id="${esc(w.id)}">Провести</button>
             <button class="btn btn-outline btn-sm" data-action="edit-waybill" data-id="${esc(w.id)}">Изменить</button>
             <button class="btn btn-outline btn-sm" data-action="del-waybill" data-id="${esc(w.id)}">Удалить</button>`}
      </div></td>
    </tr>`;
  }).join('');

  return `<div class="page-head">
    <div class="desc">Накладная — документ двойного контроля: фиксирует факт перемещения ТМЦ (<b>Date_Material_Execution_Fact</b>), порождает план оплаты (<b>Date_Payment_Execution_Plan</b> = факт + отсрочка) и признаком <b>Is_Real</b> отделяет реальные операции от бумажных корректировок.</div>
    <div class="spacer"></div>
    <button class="btn btn-primary" data-action="new-waybill">+ Новая накладная</button>
  </div>
  <div class="card"><div class="table-wrap">
  ${state.waybills.length ? `<table>
    <thead><tr><th>Документ</th><th>Тип</th><th>Is_Real</th><th class="num">Сумма</th><th class="num">ТМЦ (факт)</th><th class="num">Оплата (план)</th><th>Статус</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`
    : emptyBlock('box', 'Накладных нет', state.deals.length ? 'Создайте накладную по сделке.' : 'Сначала создайте сделку — накладная привязывается через ID_Deal.')}
  </div></div>`;
}

/* ---------- Оперативный план (Табл. 1 и Табл. 2 из письма Б.) ----------
   Табличный вид по дням, как в исходном Excel: движение ТМЦ в натуральных
   единицах по каждой позиции + денежный поток. Горизонт — до момента
   последнего исполнения обязательств. Красные ячейки = маркеры. */

function planHorizonDays(today) {
  let maxDate = addDays(today, 14);
  for (const deal of state.deals) {
    for (const o of moneyRegister(deal).open) if (o.date > maxDate) maxDate = o.date;
    for (const o of materialRegister(deal).open) if (o.date > maxDate) maxDate = o.date;
    if (deal.scheduleDays) {
      const nd = nextScheduleDate(deal.scheduleDays, today);
      if (nd && nd > maxDate) maxDate = nd;
    }
  }
  for (const p of state.otherPayments) {
    if (!p.done && p.recurring !== 'monthly' && p.date > maxDate) maxDate = p.date;
  }
  return Math.min(120, diffDays(maxDate, today) + 2);
}

function fmtQty(q) {
  const r = Math.round(q * 1000) / 1000;
  return r % 1 ? r.toFixed(Math.abs(r) < 10 ? 2 : 1) : String(r);
}

function renderPlan(flags) {
  const today = todayISO();
  if (!state.deals.length && !state.items.length) {
    return `<div class="card">${emptyBlock('table', 'Главный экран пуст',
      'Создайте сделки, номенклатуру и документы — здесь появится таблица движения ТМЦ и денег по дням, как в исходной Excel-модели.', demoButtonHTML)}</div>`;
  }
  const horizon = planHorizonDays(today);
  const proj = computeProjection(horizon);
  // режим моделирования: Табл. 1 и ведомость показывают сценарий —
  // «принятие решения с вводом данных онлайн отражается в табл. 1»
  const simProj = simulation ? computeProjection(horizon, simulation) : null;
  const shownProj = simProj || proj;
  const mode = location.hash.includes('t2') ? 't2' : 't1';
  const heroHTML = buildMarkerHero(flags || computeFlags(), proj, liquidityMatrix(), computeItemsOutlook(30));

  /* Экономическая шапка: выручка по отгрузке и по оплате, себестоимость, прибыль */
  let revShipped = 0, revPaid = 0, cost = 0, costKnown = true;
  for (const w of state.waybills) {
    if (!w.posted || !w.isReal || w.kind !== 'out') continue;
    revShipped += w.amount;
    if (Array.isArray(w.lines) && w.lines.length) {
      for (const l of w.lines) cost += l.qty * ((itemById(l.itemId) || {}).price || 0);
    } else costKnown = false;
  }
  for (const p of state.payments) if (p.posted && p.kind === 'in') revPaid += p.amount;
  const profit = revShipped - cost;
  const econHTML = `
  <div class="rev-grid" style="margin-bottom:20px">
    <div class="rev-cell"><div class="rev-label">Выручка по отгрузке</div>
      <div class="rev-value">${fmtMoney(revShipped)}</div><div class="rev-sub">P&L, реальные накладные</div></div>
    <div class="rev-cell"><div class="rev-label">Выручка по оплате</div>
      <div class="rev-value">${fmtMoney(revPaid)}</div><div class="rev-sub">Cash Flow, входящие платёжки</div></div>
    <div class="rev-cell"><div class="rev-label">Себестоимость</div>
      <div class="rev-value">${fmtMoney(cost)}</div><div class="rev-sub">управленческая, по учётным ценам${costKnown ? '' : ' · есть накладные без спецификации'}</div></div>
    <div class="rev-cell"><div class="rev-label">Прибыль</div>
      <div class="rev-value ${profit < 0 ? 'neg-cell' : ''}">${fmtMoney(profit)}</div><div class="rev-sub">может отличаться от бухгалтерской</div></div>
  </div>`;

  /* Платёжная ведомость на сегодня: подразделы по письму Б. */
  const todayEvents = shownProj.days[0] ? shownProj.days[0].events.filter((e) => e.cash < 0) : [];
  const groups = { critical: [], primary: [], other: [] };
  for (const e of todayEvents) {
    const prio = e.prio || (e.overdue ? 'critical' : 'primary');
    if (prio === 'critical') groups.critical.push(e);
    else if (prio === 'primary') groups.primary.push(e);
    else groups.other.push(e);
  }
  const groupHTML = (title, list) => list.length
    ? `<div class="cal-day"><div class="cal-date">${title} <span class="badge badge-grey">${fmtMoney(-sum(list.map((e) => e.cash)))}</span></div>
       ${list.map((e) => `<div class="cal-event out"><span>${esc(e.label)}${e.overdue ? ' <span class="badge badge-red">просрочено</span>' : ''}</span><span class="amt">−${fmtMoney(-e.cash)}</span></div>`).join('')}</div>`
    : '';
  const vedomostHTML = todayEvents.length
    ? groupHTML('1. Обязательные (налоги, зарплата, коммунальные)', groups.critical) +
      groupHTML('2. Первоочередные (основные поставщики)', groups.primary) +
      groupHTML('3. Не первоочередные', groups.other)
    : '<p style="color:var(--ink-soft);font-size:13px">На сегодня выплат нет.</p>';

  /* Колонки позиций: только с остатком или движением */
  const itemCols = state.items.map((item) => {
    const moves = itemMovements(item.id);
    const qty0 = (item.qtyOpening || 0) + sum(moves.map((m) => m.qty));
    const { events, planned } = itemProjectionEvents(item.id, today);
    return { item, qty0, events, planned, active: Math.abs(qty0) > 0.004 || events.length || planned.length };
  }).filter((c) => c.active);

  /* Табл.1: строки-дни; ДС приток/отток/остаток + остаток каждой позиции */
  const rowsT1 = [];
  const qtys = itemCols.map((c) => c.qty0);
  for (let i = 0; i <= horizon; i++) {
    const d = shownProj.days[i];
    if (!d) break;
    const inflow = sum(d.events.filter((e) => e.cash > 0).map((e) => e.cash));
    const outflow = sum(d.events.filter((e) => e.cash < 0).map((e) => e.cash));
    itemCols.forEach((c, j) => { qtys[j] += sum(c.events.filter((e) => e.date === d.date).map((e) => e.qty)); });
    const hasActivity = inflow || outflow || d.cashGap ||
      itemCols.some((c, j) => c.events.some((e) => e.date === d.date)) || i === 0;
    rowsT1.push(`<tr class="${hasActivity ? '' : 'row-quiet'}">
      <td class="num">${i}</td>
      <td class="num">${fmtDate(d.date)}</td>
      <td class="num">${inflow ? '+' + fmtMoney(inflow) : ''}</td>
      <td class="num">${outflow ? '−' + fmtMoney(-outflow) : ''}</td>
      <td class="num ${d.cashGap ? 'neg-cell' : ''}">${fmtMoney(d.cash)}${d.cashGap ? ' ⚑' : ''}</td>
      ${itemCols.map((c, j) => `<td class="num ${qtys[j] < -0.004 ? 'neg-cell' : ''}">${fmtQty(qtys[j])}${qtys[j] < -0.004 ? ' ⚑' : ''}</td>`).join('')}
    </tr>`);
  }
  const t1HTML = `
  <div class="table-wrap"><table class="plan-table">
    <thead>
      <tr><th class="num" rowspan="2">№</th><th class="num" rowspan="2">Дата</th>
        <th colspan="3" style="text-align:center">Денежные средства, ₽</th>
        ${itemCols.map((c) => `<th class="num" rowspan="2" title="${esc(c.item.name)}">${esc(c.item.sku)}, ${esc(c.item.unit)}</th>`).join('')}</tr>
      <tr><th class="num">Приток</th><th class="num">Отток</th><th class="num">Остаток</th></tr>
    </thead>
    <tbody>${rowsT1.join('')}</tbody>
  </table></div>`;

  /* Табл.2: план / факт / отклонение движений по дням (окно: −14 дн … горизонт).
     План — по исходным договорным датам (просрочка остаётся на своей дате),
     факт — из накладных; отклонение = факт − план. */
  let t2HTML = '';
  if (mode === 't2') {
    const start = addDays(today, -14);
    const dates = [];
    for (let i = -14; i <= horizon; i++) dates.push(addDays(today, i));
    const rowsT2 = dates.map((d, di) => {
      const cells = itemCols.map((c) => {
        const planQty = sum(c.planned.filter((e) => e.date === d).map((e) => e.qty));
        const factQty = sum(itemMovements(c.item.id).filter((m) => m.date === d).map((m) => m.qty));
        const dev = factQty - planQty;
        // отклонение имеет смысл только там, где был план; маркер — план,
        // не исполненный к прошедшей дате (факт без плана — закрытая квота, норма)
        const hasPlan = Math.abs(planQty) > 0.004;
        const devBad = hasPlan && d <= today && Math.abs(dev) > 0.004;
        return `<td class="num">${planQty ? fmtQty(planQty) : ''}</td>
          <td class="num">${factQty ? fmtQty(factQty) : ''}</td>
          <td class="num ${devBad ? 'neg-cell' : ''}">${hasPlan && d <= today ? fmtQty(dev) : ''}${devBad ? ' ⚑' : ''}</td>`;
      }).join('');
      const any = itemCols.some((c) =>
        c.planned.some((e) => e.date === d) || itemMovements(c.item.id).some((m) => m.date === d));
      return `<tr class="${any ? '' : 'row-quiet'} ${d === today ? 'row-today' : ''}">
        <td class="num">${fmtDate(d)}${d === today ? ' ←' : ''}</td>${cells}</tr>`;
    });
    t2HTML = `
    <div class="table-wrap"><table class="plan-table">
      <thead>
        <tr><th class="num" rowspan="2">Дата</th>
          ${itemCols.map((c) => `<th colspan="3" style="text-align:center" title="${esc(c.item.name)}">${esc(c.item.sku)}, ${esc(c.item.unit)}</th>`).join('')}</tr>
        <tr>${itemCols.map(() => '<th class="num">План</th><th class="num">Факт</th><th class="num">Откл.</th>').join('')}</tr>
      </thead>
      <tbody>${rowsT2.join('')}</tbody>
    </table></div>
    <div class="legend" style="margin-top:8px"><span>Отклонение = факт − план; красное — план не исполнен (причина маркера). Мы не разбираем причины — мы указываем на них.</span></div>`;
  }

  /* Симулятор: баннер активного сценария либо готовые решения при разрыве.
     Изменения видны сразу в Табл. 1 — «понимание новой реальности» */
  let simHTML = '';
  if (simulation && simProj) {
    const before = proj.firstGap ? `разрыв ${fmtDate(proj.firstGap.date)} (${fmtMoney(proj.firstGap.cash)})` : 'разрыва нет';
    const after = simProj.firstGap ? `разрыв ${fmtDate(simProj.firstGap.date)} (${fmtMoney(simProj.firstGap.cash)})` : 'разрыва нет';
    simHTML = `
    <div class="sim-banner" style="margin:0 0 20px">
      <div class="sim-banner-head">Режим моделирования: ${esc(simulation.label || 'сценарий')}</div>
      <div class="sim-banner-body">Было: ${esc(before)} → Станет: <b>${esc(after)}</b>. Табл. 1 и ведомость ниже показывают новую реальность (данные не изменены).</div>
      <div class="sim-banner-actions">
        <button class="btn btn-primary btn-sm" data-action="sim-apply">Утвердить сценарий</button>
        <button class="btn btn-outline btn-sm" data-action="sim-reset">Сбросить</button>
      </div>
    </div>`;
  } else if (proj.firstGap) {
    lastSolutions = generateSolutions(proj, Math.max(horizon, 30));
    if (lastSolutions.length) {
      simHTML = `
      <div class="solutions" style="margin:0 0 20px">
        <div class="solutions-title">Готовые решения — симулятор «Что если?»</div>
        ${lastSolutions.map((s, i) => `
          <div class="solution-row">
            <div class="solution-body">
              <div class="solution-name">${esc(s.title)}</div>
              <div class="solution-effect">${esc(s.effect)}</div>
            </div>
            <button class="btn btn-outline btn-sm" data-action="simulate" data-idx="${i}">Смоделировать</button>
          </div>`).join('')}
      </div>`;
    }
  }

  const flagsHTML = (flags || []).length
    ? flags.map((f) => flagItemHTML(f)).join('')
    : `<div class="empty" style="padding:24px"><div class="empty-ico">${ic('check', 30)}</div><div class="empty-title">Флагов нет</div><p>Все обязательства исполняются в срок.</p></div>`;

  return `${heroHTML}
  <div class="page-head">
    <div class="desc">Система оперативного управления: что, когда, сколько — по каждому виду ТМЦ в натуральных единицах и по деньгам. Горизонт — до последнего исполнения обязательств (${horizon} дн.). Красные ячейки ⚑ — маркеры для управленческих решений.</div>
    <div class="spacer"></div>
    <div class="row-actions">
      <a class="btn ${mode === 't1' ? 'btn-primary' : 'btn-outline'}" href="#/plan">Табл. 1 · Остатки</a>
      <a class="btn ${mode === 't2' ? 'btn-primary' : 'btn-outline'}" href="#/plan-t2">Табл. 2 · План/Факт</a>
    </div>
  </div>
  ${econHTML}
  ${simHTML}
  ${mode === 't1' ? `<div class="card">${cardTitle('table', 'Табл. 1 — движение ТМЦ и ДС по дням', simulation ? 'сценарий моделирования' : 'натуральные единицы; остатки на конец дня')}${t1HTML}</div>
  <div class="card">${cardTitle('banknote', 'Платёжная ведомость на сегодня', 'сколько и кому мы платим сегодня')}${vedomostHTML}</div>`
  : `<div class="card">${cardTitle('table', 'Табл. 2 — план / факт / отклонение', 'почему возник маркер: план не исполнен')}${t2HTML}</div>`}
  <div class="card" id="dash-flags">${cardTitle('flag', 'Красные флаги — причины', 'материальные и денежные просрочки')}${flagsHTML}</div>`;
}

/* ---------- Склад и номенклатура ---------- */
function renderStock() {
  const today = todayISO();
  const outlook = computeItemsOutlook(30);

  const rows = outlook.rows.map((r) => {
    const marker = r.deficit
      ? `<span class="badge badge-red">дефицит ${fmtDate(r.minDate)}: ${r.minQty % 1 ? r.minQty.toFixed(1) : r.minQty} ${esc(r.item.unit)}</span>`
      : r.stale
        ? `<span class="badge badge-amber">залежалый · заморожено ${fmtMoney(r.frozenValue)}</span>`
        : '<span class="badge badge-green">норма</span>';
    const extra = [];
    if (r.atRiskQty.length) extra.push(`ожидание просроченных поставок: ${r.atRiskQty.map((p) => `${p.remaining} ${esc(r.item.unit)} (${esc(p.deal.counterparty)})`).join(', ')}`);
    if (r.unscheduled.length) extra.push(`обязательства без плановой даты: ${r.unscheduled.map((p) => `${p.remaining} ${esc(r.item.unit)}`).join(', ')}`);
    return `<tr>
      <td><div class="cell-main">${esc(r.item.sku)}</div><div class="cell-sub">${esc(r.item.name)}</div></td>
      <td class="num">${fmtMoney(r.item.price)}</td>
      <td class="num ${r.qtyToday < 0 ? 'neg-cell' : ''}">${r.qtyToday % 1 ? r.qtyToday.toFixed(1) : r.qtyToday} ${esc(r.item.unit)}</td>
      <td class="num">${fmtMoney(r.valueToday)}</td>
      <td class="num ${r.minQty < 0 ? 'neg-cell' : ''}">${r.minQty % 1 ? r.minQty.toFixed(1) : r.minQty} ${esc(r.item.unit)} · ${fmtDate(r.minDate)}</td>
      <td>${marker}${extra.length ? `<div class="cell-sub" style="margin-top:3px">${extra.join('; ')}</div>` : ''}</td>
      <td><div class="row-actions">
        <button class="btn btn-outline btn-sm" data-action="edit-item" data-id="${esc(r.item.id)}">Изменить</button>
        <button class="btn btn-outline btn-sm" data-action="del-item" data-id="${esc(r.item.id)}">Удалить</button>
      </div></td>
    </tr>`;
  }).join('');

  const itemsCard = `<div class="card">
    ${cardTitle('box', 'Остатки по позициям', 'дефицит и залежалость — по каждому артикулу')}
    <div class="table-wrap">
    ${outlook.rows.length ? `<table>
      <thead><tr><th>Артикул</th><th class="num">Учётная цена</th><th class="num">Остаток</th><th class="num">Стоимость</th><th class="num">Мин. за 30 дн</th><th>Маркер</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>`
      : emptyBlock('box', 'Номенклатуры нет', 'Создайте позиции — тогда сделки и накладные смогут вести поартикульный учёт, а система будет считать дефицит и залежалость по каждому артикулу.')}
    </div>
    <div style="margin-top:14px"><button class="btn btn-primary" data-action="new-item">+ Новая позиция</button></div>
  </div>`;

  const others = [...state.otherPayments].sort((a, b) => a.date.localeCompare(b.date));
  const otherRows = others.map((p) => {
    const cat = OTHER_CATEGORIES[p.category] || OTHER_CATEGORIES.other;
    const prio = PRIORITIES[p.priority] || PRIORITIES.flexible;
    return `<tr class="${p.done ? 'row-done' : ''}">
      <td><div class="cell-main">${esc(p.name)}</div><div class="cell-sub">${cat.label}${p.recurring === 'monthly' ? ' · ежемесячно' : ''}</div></td>
      <td class="num">${fmtMoney(p.amount)}</td>
      <td class="num">${fmtDate(p.date)}</td>
      <td><span class="badge ${prio.cls}">${prio.label}</span></td>
      <td>${p.done ? '<span class="badge badge-grey">исполнен / отменён</span>' : '<span class="badge badge-blue">в графике</span>'}</td>
      <td><div class="row-actions">
        <button class="btn btn-outline btn-sm" data-action="toggle-other-done" data-id="${esc(p.id)}">${p.done ? 'Вернуть в график' : 'Исполнен'}</button>
        <button class="btn btn-outline btn-sm" data-action="edit-other" data-id="${esc(p.id)}">Изменить</button>
        <button class="btn btn-outline btn-sm" data-action="del-other" data-id="${esc(p.id)}">Удалить</button>
      </div></td>
    </tr>`;
  }).join('');

  const othersCard = `<div class="card">
    ${cardTitle('banknote', 'Прочие платежи', 'аренда, налоги, зарплата — вне сделок; входят в прогноз и календарь')}
    <div class="table-wrap">
    ${others.length ? `<table>
      <thead><tr><th>Платёж</th><th class="num">Сумма</th><th class="num">Дата</th><th>Приоритет</th><th>Статус</th><th></th></tr></thead>
      <tbody>${otherRows}</tbody></table>`
      : emptyBlock('banknote', 'Прочих платежей нет', 'Добавьте регулярные обязательства — налоги, зарплату, аренду. Они попадут в платёжный календарь с приоритетами и в прогноз кассовых разрывов.')}
    </div>
    <div style="margin-top:14px"><button class="btn btn-primary" data-action="new-other">+ Новый платёж</button></div>
  </div>`;

  return `<div class="page-head"><div class="desc">Складской контур в натуральном выражении: остатки по каждому артикулу, прогноз минимума на 30 дней, маркеры дефицита и сверхнормативных (залежалых) остатков, «съедающих» оборотный капитал. Здесь же — прочие платежи вне сделок для полного платёжного календаря.</div></div>
  ${itemsCard}
  ${othersCard}`;
}

/* ---------- График ТМЦ ---------- */
function renderTmc() {
  const today = todayISO();
  const blocks = state.deals.map((deal) => {
    const events = [];
    for (const p of postedPayments(deal.id)) {
      if (p.dateMaterialPlan) events.push({ date: p.dateMaterialPlan, type: 'plan', label: `План по ${p.num}: ${fmtMoney(p.amount)}` });
    }
    const mat = materialRegister(deal);
    for (const w of postedRealWaybills(deal.id)) {
      const isLate = mat.late.some((l) => l.factKey === w.id);
      events.push({ date: w.dateMaterialFact, type: isLate ? 'factLate' : 'factOk', label: `Факт ${w.num}: ${fmtMoney(w.amount)}${isLate ? ' (позже плана)' : ''}` });
    }
    for (const o of mat.open) {
      if (o.date < today) {
        const ev = events.find((e) => e.date === o.date && e.type === 'plan');
        if (ev) ev.type = 'planOverdue';
      }
    }
    if (!events.length) return '';
    events.sort((a, b) => a.date.localeCompare(b.date));
    const openSum = sum(mat.open.map((o) => o.left));
    return `<div class="deal-block card">
      <div class="deal-block-head">
        <span class="name">${esc(dealTitle(deal))}</span>
        <span class="badge ${deal.kind === 'sale' ? 'badge-green' : 'badge-blue'}">${DEAL_KIND[deal.kind].label}</span>
        ${openSum > 0 ? `<span class="badge ${mat.open.some((o) => o.date < today) ? 'badge-red' : 'badge-blue'}">не перемещено: ${fmtMoney(openSum)}</span>` : '<span class="badge badge-green">обязательства закрыты</span>'}
      </div>
      ${timelineSVG(events, today)}
      <div style="margin-top:8px">${events.map((e) => `
        <div class="flag-meta" style="margin-bottom:3px">
          <i class="flag-dot" style="box-shadow:none;background:${TL_COLORS[e.type]}"></i>
          <span>${fmtDate(e.date)}</span><span>${esc(e.label)}</span>
        </div>`).join('')}
      </div>
    </div>`;
  }).filter(Boolean).join('');

  return `<div class="page-head"><div class="desc">Материальный след сделок: плановые даты перемещения ТМЦ (из платёжек) против фактов (из реальных накладных). Красное — просрочки и опоздания.</div></div>
  ${blocks || `<div class="card">${emptyBlock('chart', 'График пуст', 'Проведите платёжные документы и накладные — здесь появится материальный след сделок.', state.deals.length ? '' : demoButtonHTML)}</div>`}
  <div class="card"><div class="legend">
    <span><i style="background:#3a352a"></i> план (из платёжки)</span>
    <span><i style="background:#9e2b25"></i> план просрочен</span>
    <span><i style="background:#2f5e3f"></i> факт вовремя</span>
    <span><i style="background:#8a6d1f"></i> факт позже плана</span>
  </div></div>`;
}

const TL_COLORS = { plan: '#3a352a', planOverdue: '#9e2b25', factOk: '#2f5e3f', factLate: '#8a6d1f' };

function timelineSVG(events, today) {
  const dates = events.map((e) => e.date).concat([today]);
  let min = dates.reduce((a, b) => (a < b ? a : b));
  let max = dates.reduce((a, b) => (a > b ? a : b));
  if (min === max) { min = addDays(min, -3); max = addDays(max, 3); }
  min = addDays(min, -2); max = addDays(max, 2);
  const span = Math.max(1, diffDays(max, min));
  const W = 760, H = 74, PL = 16, PR = 16, Y = 40;
  const x = (iso) => PL + ((W - PL - PR) * diffDays(iso, min)) / span;

  const todayX = x(today);
  let dots = '';
  // группируем совпадающие даты вертикальным смещением
  const seen = {};
  for (const e of events) {
    const cx = x(e.date);
    const key = Math.round(cx / 14);
    seen[key] = (seen[key] || 0);
    const cy = Y - seen[key] * 14;
    seen[key]++;
    dots += `<circle cx="${cx.toFixed(1)}" cy="${cy}" r="6.5" fill="${TL_COLORS[e.type]}" stroke="#fbfaf5" stroke-width="2"><title>${esc(fmtDate(e.date) + ' — ' + e.label)}</title></circle>`;
  }
  return `<svg class="timeline-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Таймлайн ТМЦ">
    <line x1="${PL}" y1="${Y}" x2="${W - PR}" y2="${Y}" stroke="#d8d2c0" stroke-width="3" stroke-linecap="round"/>
    <line x1="${todayX.toFixed(1)}" y1="10" x2="${todayX.toFixed(1)}" y2="${H - 14}" stroke="#a89f89" stroke-width="1.5" stroke-dasharray="4 4"/>
    <text x="${todayX.toFixed(1)}" y="${H - 2}" font-size="10" fill="#7a725d" text-anchor="middle" font-family="PT Sans, sans-serif">сегодня</text>
    <text x="${PL}" y="${H - 2}" font-size="10" fill="#7a725d" font-family="PT Sans, sans-serif">${fmtDate(min)}</text>
    <text x="${W - PR}" y="${H - 2}" font-size="10" fill="#7a725d" text-anchor="end" font-family="PT Sans, sans-serif">${fmtDate(max)}</text>
    ${dots}
  </svg>`;
}

/* ---------- CashFlow ---------- */
function renderCashflow() {
  const events = cashflowEvents();
  if (!events.length) {
    return `<div class="card">${emptyBlock('banknote', 'Денежных событий нет', 'Проводите платёжки (факт) и реальные накладные (план) — здесь соберётся календарь выплат и график потока.', state.deals.length ? '' : demoButtonHTML)}</div>`;
  }
  const today = todayISO();

  // кумулятивный график: сплошная — факты, пунктир — открытый план от сегодняшнего дня
  // (просроченные плановые обязательства ожидаются «сейчас», поэтому ставятся на сегодня)
  let cum = 0;
  const factPts = events.filter((e) => !e.plan).map((e) => { cum += e.amount; return { date: e.date, cum }; });
  // «якорь» прогноза: сегодня, либо самый поздний факт, если он датирован будущим
  const lastFactDate = factPts.length ? factPts[factPts.length - 1].date : today;
  const anchor = lastFactDate > today ? lastFactDate : today;
  let pcum = cum;
  const planPts = events.filter((e) => e.plan)
    .map((e) => ({ ...e, date: e.date < anchor ? anchor : e.date }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((e) => { pcum += e.amount; return { date: e.date, cum: pcum }; });

  // календарь: план-события, сгруппированные по датам
  const planned = events.filter((e) => e.plan);
  const byDate = {};
  for (const e of planned) (byDate[e.date] = byDate[e.date] || []).push(e);
  const calendar = Object.keys(byDate).sort().map((date) => {
    const overdue = date < today;
    return `<div class="cal-day">
      <div class="cal-date">${fmtDate(date)}
        ${overdue ? '<span class="badge badge-red">просрочено</span>' : diffDays(date, today) <= 7 ? '<span class="badge badge-amber">скоро</span>' : ''}
      </div>
      ${byDate[date].map((e) => calEventHTML(e, today, true)).join('')}
    </div>`;
  }).join('') || '<p style="color:var(--muted);font-size:13px">Открытых плановых обязательств нет — все накладные оплачены.</p>';

  const facts = events.filter((e) => !e.plan);
  const factsHTML = facts.length ? [...facts].reverse().map((e) => calEventHTML(e, today)).join('') : '<p style="color:var(--muted);font-size:13px">Фактов оплат нет.</p>';

  /* Выручка в двух разрезах: по отгрузке (P&L) и по деньгам (Cash Flow) —
     без путаницы и ложных иллюзий о прибыльности */
  let revShipped = 0, revReceived = 0, revPlanned = 0;
  for (const w of state.waybills) {
    if (w.posted && w.isReal && w.kind === 'out') revShipped += w.amount;
  }
  for (const p of state.payments) {
    if (p.posted && p.kind === 'in') revReceived += p.amount;
  }
  for (const deal of state.deals.filter((d) => d.kind === 'sale')) {
    revPlanned += sum(moneyRegister(deal).open.map((o) => o.left));
  }
  const revHTML = `
  <div class="card">${cardTitle('banknote', 'Выручка в двух разрезах', 'по отгрузке (P&L) и по деньгам (Cash Flow)')}
    <div class="rev-grid">
      <div class="rev-cell"><div class="rev-label">Начислено по отгрузке (P&L)</div>
        <div class="rev-value">${fmtMoney(revShipped)}</div>
        <div class="rev-sub">реальные расходные накладные</div></div>
      <div class="rev-cell"><div class="rev-label">Поступило денег (Cash Flow)</div>
        <div class="rev-value">${fmtMoney(revReceived)}</div>
        <div class="rev-sub">входящие платёжки</div></div>
      <div class="rev-cell"><div class="rev-label">Начислено, но не оплачено</div>
        <div class="rev-value ${revPlanned ? 'neg-cell' : ''}">${fmtMoney(revPlanned)}</div>
        <div class="rev-sub">дебиторка: прибыль на бумаге — не деньги</div></div>
    </div>
  </div>`;

  return `<div class="page-head"><div class="desc">Денежный след: факты из платёжек (Date_Payment_Execution) и плановые дедлайны из реальных накладных (Date_Payment_Execution_Plan). Система строит календарь выплат кредиторам и напоминаний дебиторам.</div></div>
  <div class="card">${cardTitle('chart', 'Кумулятивный денежный поток', 'сплошная — факт, пунктир — прогноз с учётом плана')}${cashflowSVG(factPts, planPts, today, anchor)}</div>
  ${revHTML}
  <div class="two-col">
    <div class="card">${cardTitle('calendar', 'Календарь плановых платежей')}${calendar}</div>
    <div class="card">${cardTitle('check', 'Факты оплат')}${factsHTML}</div>
  </div>`;
}

function cashflowSVG(factPts, planPts, today, anchor) {
  anchor = anchor || today;
  const W = 860, H = 260, PL = 84, PR = 20, PT = 16, PB = 30;
  const all = factPts.concat(planPts);
  const dates = all.map((p) => p.date).concat([today, anchor]);
  let min = dates.reduce((a, b) => (a < b ? a : b));
  let max = dates.reduce((a, b) => (a > b ? a : b));
  if (min === max) { min = addDays(min, -3); max = addDays(max, 3); }
  const span = Math.max(1, diffDays(max, min));
  const vals = all.map((p) => p.cum).concat([0]);
  const vmin = Math.min(...vals), vmax = Math.max(...vals);
  const vspan = Math.max(1, vmax - vmin);
  const x = (iso) => PL + ((W - PL - PR) * diffDays(iso, min)) / span;
  const y = (v) => PT + (H - PT - PB) * (1 - (v - vmin) / vspan);

  // факт: ступенчатая линия от нуля, продлевается горизонтально до «сегодня»
  let prevY = y(0);
  let dFact = `M ${x(min).toFixed(1)} ${prevY.toFixed(1)}`;
  for (const p of factPts) {
    dFact += ` L ${x(p.date).toFixed(1)} ${prevY.toFixed(1)} L ${x(p.date).toFixed(1)} ${y(p.cum).toFixed(1)}`;
    prevY = y(p.cum);
  }
  dFact += ` L ${x(anchor).toFixed(1)} ${prevY.toFixed(1)}`;

  // план: пунктир от текущего фактического остатка (якорь) в будущее
  let dPlan = '';
  if (planPts.length) {
    let py = prevY;
    dPlan = `M ${x(anchor).toFixed(1)} ${py.toFixed(1)}`;
    for (const p of planPts) {
      dPlan += ` L ${x(p.date).toFixed(1)} ${py.toFixed(1)} L ${x(p.date).toFixed(1)} ${y(p.cum).toFixed(1)}`;
      py = y(p.cum);
    }
  }

  const zeroY = y(0);
  const fmtShort = (v) => (Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + ' млн' : Math.abs(v) >= 1e3 ? Math.round(v / 1e3) + ' тыс' : String(Math.round(v)));
  const gridLines = [vmax, (vmax + vmin) / 2, vmin].map((v) =>
    `<line x1="${PL}" y1="${y(v).toFixed(1)}" x2="${W - PR}" y2="${y(v).toFixed(1)}" stroke="#e6e0cf" stroke-width="1"/>
     <text x="${PL - 8}" y="${(y(v) + 4).toFixed(1)}" font-size="11" fill="#7a725d" text-anchor="end" font-family="PT Sans, sans-serif">${fmtShort(v)}</text>`).join('');

  const dots = factPts.map((p) =>
    `<circle cx="${x(p.date).toFixed(1)}" cy="${y(p.cum).toFixed(1)}" r="3.5" fill="#1c1a15" stroke="#fbfaf5" stroke-width="1.5">
      <title>${esc(fmtDate(p.date) + ' — накопленно: ' + fmtMoney(p.cum))}</title></circle>`).join('') +
    planPts.map((p) =>
    `<circle cx="${x(p.date).toFixed(1)}" cy="${y(p.cum).toFixed(1)}" r="3.5" fill="#9a9077" stroke="#fbfaf5" stroke-width="1.5">
      <title>${esc(fmtDate(p.date) + ' — прогноз: ' + fmtMoney(p.cum))}</title></circle>`).join('');

  const todayX = x(today);
  return `<svg class="timeline-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="График CashFlow">
    ${gridLines}
    <line x1="${PL}" y1="${zeroY.toFixed(1)}" x2="${W - PR}" y2="${zeroY.toFixed(1)}" stroke="#b8ae95" stroke-width="1.5" stroke-dasharray="2 3"/>
    <line x1="${todayX.toFixed(1)}" y1="${PT}" x2="${todayX.toFixed(1)}" y2="${H - PB}" stroke="#a89f89" stroke-width="1.5" stroke-dasharray="4 4"/>
    <text x="${todayX.toFixed(1)}" y="${H - 12}" font-size="10" fill="#7a725d" text-anchor="middle" font-family="PT Sans, sans-serif">сегодня</text>
    <path d="${dFact}" fill="none" stroke="#1c1a15" stroke-width="2" stroke-linejoin="round"/>
    ${dPlan ? `<path d="${dPlan}" fill="none" stroke="#a89f89" stroke-width="2" stroke-dasharray="6 5" stroke-linejoin="round"/>` : ''}
    ${dots}
    <text x="${PL}" y="${H - 12}" font-size="10" fill="#7a725d" font-family="PT Sans, sans-serif">${fmtDate(min)}</text>
    <text x="${W - PR}" y="${H - 12}" font-size="10" fill="#7a725d" text-anchor="end" font-family="PT Sans, sans-serif">${fmtDate(max)}</text>
  </svg>`;
}

/* ---------- Матрица ресурсов ---------- */
function renderMatrix() {
  if (!state.deals.length) {
    return `<div class="card">${emptyBlock('table', 'Матрица пуста', 'Создайте сделки и проведите документы — матрица покажет 6 колонок управленческого баланса по каждой сделке.', demoButtonHTML)}</div>`;
  }
  const today = todayISO();
  const totals = { moneyFact: 0, moneyPlan: 0, tmcFact: 0, tmcPlan: 0, receivable: 0, payable: 0 };
  const rows = state.deals.map((d) => {
    const a = dealAggregates(d);
    for (const k of Object.keys(totals)) totals[k] += a[k];
    const overdueMoney = moneyRegister(d).open.some((o) => o.date < today);
    return `<tr>
      <td><div class="cell-main">${esc(d.name)}</div><div class="cell-sub">${esc(d.counterparty)} · ${DEAL_KIND[d.kind].label}</div></td>
      <td class="num" style="color:${a.moneyFact >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtMoneySign(a.moneyFact)}</td>
      <td class="num" style="color:var(--muted)">${a.moneyPlan ? fmtMoneySign(a.moneyPlan) : '—'}</td>
      <td class="num">${a.tmcFact ? fmtMoneySign(a.tmcFact) : '—'}</td>
      <td class="num" style="color:var(--muted)">${a.tmcPlan ? fmtMoneySign(a.tmcPlan) : '—'}</td>
      <td class="num">${a.receivable ? `<span class="${overdueMoney && d.kind === 'sale' ? 'badge badge-red' : ''}">${fmtMoney(a.receivable)}</span>` : '—'}</td>
      <td class="num">${a.payable ? `<span class="${overdueMoney && d.kind === 'purchase' ? 'badge badge-red' : ''}">${fmtMoney(a.payable)}</span>` : '—'}</td>
    </tr>`;
  }).join('');

  return `<div class="page-head"><div class="desc">Управленческий баланс по сделкам — 6 колонок: денежный и материальный след (факт/план) плюс задолженности. В расчёт входят только проведённые документы, у накладных — только с <b>Is_Real = ДА</b>. Красным подсвечена просроченная задолженность.</div></div>
  <div class="card"><div class="table-wrap"><table>
    <thead><tr><th>Сделка</th><th class="num">Деньги · факт</th><th class="num">Деньги · план</th><th class="num">ТМЦ · факт</th><th class="num">ТМЦ · план</th><th class="num">Дебиторка</th><th class="num">Кредиторка</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td>Итого</td>
      <td class="num">${fmtMoneySign(totals.moneyFact)}</td>
      <td class="num">${totals.moneyPlan ? fmtMoneySign(totals.moneyPlan) : '—'}</td>
      <td class="num">${totals.tmcFact ? fmtMoneySign(totals.tmcFact) : '—'}</td>
      <td class="num">${totals.tmcPlan ? fmtMoneySign(totals.tmcPlan) : '—'}</td>
      <td class="num">${fmtMoney(totals.receivable)}</td>
      <td class="num">${fmtMoney(totals.payable)}</td>
    </tr></tfoot>
  </table></div></div>
  <div class="card"><div class="card-title">Как читать матрицу</div>
    <div class="legend" style="flex-direction:column;gap:6px;align-items:flex-start">
      <span><b>Деньги · факт</b> — чистый денежный поток по проведённым платёжкам (продажи +, закупки −).</span>
      <span><b>Деньги · план</b> — незакрытые денежные обязательства из реальных накладных (ждём поступления / предстоят выплаты).</span>
      <span><b>ТМЦ · факт</b> — материальный след по реальным накладным (приход +, отгрузка −).</span>
      <span><b>ТМЦ · план</b> — оплачено, но не перемещено: ожидаемые поставки (+) и обязательства по отгрузке (−).</span>
      <span><b>Дебиторка</b> — нам должны: отгружено без оплаты или выданный поставщику аванс.</span>
      <span><b>Кредиторка</b> — должны мы: получено без оплаты или полученный от клиента аванс.</span>
    </div>
  </div>`;
}

/* ---------- Журнал ---------- */
function renderJournal() {
  if (!state.journal.length) {
    return `<div class="card">${emptyBlock('ledger', 'Журнал пуст', 'Нажимайте «Провести» в платёжках и накладных — здесь фиксируется, какие управленческие регистры обновил каждый документ.')}</div>`;
  }
  return `<div class="page-head"><div class="desc">Протокол логической матрицы: при проведении система пишет, какие регистры обновлены. Виртуальные накладные (Is_Real = НЕТ) управленческие регистры игнорируют.</div></div>
  <div class="card">${state.journal.map(journalEntryHTML).join('')}</div>`;
}

function journalEntryHTML(j) {
  const d = new Date(j.ts);
  const ts = d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `<div class="j-entry ${j.real ? '' : 'j-grey'}">
    <div class="j-head"><span class="j-doc">${esc(j.doc)}</span>
      ${j.real ? '' : '<span class="badge badge-grey">Is_Real = НЕТ</span>'}
      <span class="j-ts">${ts} · ${esc(j.deal)}</span></div>
    <div class="j-lines">${j.lines.map((l) => `<div class="${l.startsWith('Игнорировать') || l.startsWith('//') ? 'fn-grey' : 'fn'}">${esc(l)}</div>`).join('')}</div>
  </div>`;
}

/* ---------- Спецификация ---------- */
function renderHelp() {
  return `<div class="card help">
    <h2>1. Платёжные документы (входящие и исходящие)</h2>
    <p>Платёжка управляет денежным потоком и содержит две временные точки: когда обязательство по деньгам закрывается (факт) и когда в ответ должны прийти/уйти материальные ценности (план).</p>
    <ul>
      <li><code>ID_Deal (UUID)</code> — уникальный идентификатор сделки (связка со счётом/договором).</li>
      <li><code>Date_Payment_Execution (Date)</code> — дата исполнения платёжного обязательства: для входящих — фактическое зачисление на расчётный счёт, для исходящих — списание банком.</li>
      <li><code>Date_Material_Execution_Plan (Date)</code> — план материального исполнения. Рассчитывается автоматически из юридического блока договора (например, «отгрузить в течение 5 дней после оплаты»). Показывает снабженцам и продавцам, до какой даты товар должен быть физически перемещён.</li>
    </ul>

    <h2>2. Накладные (приходные и расходные)</h2>
    <p>Накладная — документ двойного контроля: фиксирует факт перемещения ТМЦ, формирует дебиторскую/кредиторскую задолженность и определяет, является ли действие настоящим.</p>
    <ul>
      <li><code>ID_Deal (UUID)</code> — уникальный идентификатор сделки.</li>
      <li><code>Is_Real (Boolean)</code> — реальность действия. <b>ДА</b> → товар физически взвешен/посчитан и перемещён, данные идут в управленческий баланс и графики. <b>НЕТ</b> → операция виртуальная (бумажная корректировка, перенос остатков для налоговой), данные блокируются для управленческого учёта.</li>
      <li><code>Date_Material_Execution_Fact (Date)</code> — дата фактического отпуска со склада или приёмки товара материально ответственным лицом.</li>
      <li><code>Date_Payment_Execution_Plan (Date)</code> — план оплаты: <code>Date_Material_Execution_Fact + отсрочка из договора</code>. Дедлайн для напоминаний дебиторам и календаря выплат кредиторам.</li>
    </ul>

    <h2>3. Логическая матрица (поведение регистров)</h2>
    <p>При нажатии «Провести» система проверяет комбинацию полей документа:</p>
<pre><span class="k">ЕСЛИ</span> Документ.Is_Real == ДА <span class="k">Тогда</span>

   <span class="c">// 1. Отражение материального следа</span>
   Обновить_График_ТМЦ(Документ.ID_Deal, Документ.Date_Material_Execution);

   <span class="c">// 2. Отражение денежного следа</span>
   Обновить_График_CashFlow(Документ.ID_Deal, Документ.Date_Payment_Execution);

   <span class="c">// 3. Пересчёт управленческого баланса (6 колонок)</span>
   Актуализировать_Матрицу_Ресурсов();

<span class="k">ИНАЧЕ</span> <span class="c">// Если Реальность == НЕТ</span>

   Игнорировать_Управленческие_Регистры();
   <span class="c">// Документ делает только стандартные бухгалтерские проводки</span>

<span class="k">КонецЕсли</span>;</pre>

    <h2>Что это даёт на рабочих местах</h2>
    <ul>
      <li>У <b>снабженца</b> и <b>продавца</b> в графиках автоматически загораются «красные флаги», если Date_Material_Execution_Fact по накладной превышает плановую дату из договора.</li>
      <li><b>Бухгалтер</b> по снабжению/продажам при разнесении выписки видит чёткие плановые ориентиры по деньгам — это исключает кассовые разрывы.</li>
      <li><b>Бухгалтер по материалам</b>, выставляя Is_Real = НЕТ в корректирующих накладных, полностью изолирует свои действия: документы не порождают плановых дат и не сбивают сроки в логистике и финансах.</li>
    </ul>

    <h2>4. Главный экран руководителя</h2>
    <p>Компания на одной панели управления — единая матрица товарно-денежного баланса по датам будущего.</p>
    <ul>
      <li><b>Счётчик красных маркеров.</b> Ноль — бизнес работает нормально, руководитель свободен от операционки. Появился маркер — в один клик спускаетесь к конкретной причине: просрочке, кассовому разрыву или дефициту ТМЦ.</li>
      <li><b>Матрица баланса</b> по двум контурам (деньги и ТМЦ): <i>У нас есть</i> — живой остаток на счетах и фактический запас склада; <i>Нам должны</i> — подтверждённая ДЗ и оплаченные недошедшие поставки; <i>Мы должны</i> — КЗ поставщикам и обязательства по отгрузке за предоплаты; <i>НАДО</i> — фокус внимания: <code>Надо = Мы должны − (Живой остаток + Нам должны)</code>.</li>
      <li><b>Прогноз остатков по дням.</b> На каждый день будущего система считает остаток ДС и склада: маркер кассового разрыва — остаток к концу дня &lt; 0; маркер дефицита — склад &lt; 0. Разрыв виден за недели до наступления. Консервативный сценарий: на просроченные притоки система не рассчитывает.</li>
      <li><b>«Эффект домино».</b> Любой проведённый документ «сегодня» мгновенно пересчитывает весь плановый горизонт — регистры выводятся из документов, а не хранятся отдельно.</li>
      <li><b>Платёжный календарь с приоритетами</b> оттоков: критичный (налоги, зарплата, просрочки) → первоочередной → гибкий → дискреционный (можно отказаться при риске разрыва).</li>
      <li><b>Симулятор «Что если?»</b> — при риске кассового разрыва система сама генерирует варианты решений: сдвиг платежа, запрос досрочной предоплаты у дебитора, отказ от дискреционного расхода. Вариант можно смоделировать на графике, оценить влияние и утвердить — плановые даты скорректируются с записью в журнал.</li>
      <li><b>Живые остатки</b> ДС и склада задаются вручную (из выписки и инвентаризации) или считаются из проведённых документов.</li>
    </ul>

    <h2>5. Оперативный план (Табл. 1 и Табл. 2)</h2>
    <p>Главный рабочий вид менеджера — таблицы по дням, как в исходной Excel-модели. Система отвечает: где, чего, сколько и почему. Горизонт планирования — до момента последнего исполнения обязательств.</p>
    <ul>
      <li><b>Табл. 1</b> — движение ТМЦ в натуральных единицах (литры, метры, тонны) по каждой позиции и денежный поток: остатки на конец каждого дня, красные ячейки-маркеры на минусах.</li>
      <li><b>Табл. 2</b> — по каждой позиции три столбца: план / факт / отклонение. Мы не разбираем причины — мы указываем на них: видно, какой план на какую дату не исполнен.</li>
      <li><b>Платёжная ведомость на сегодня</b> — «сколько и кому мы платим сегодня», по подразделам: 1) Обязательные (налоги, зарплата, коммунальные) · 2) Первоочередные (основные поставщики) · 3) Не первоочередные.</li>
      <li><b>Экономическая шапка</b> — выручка по отгрузке и по оплате, себестоимость и прибыль (управленческие, по учётным ценам — могут отличаться от бухгалтерских).</li>
      <li><b>Источники плана</b>: существующие обязательства (ДЗ/КЗ по датам и позициям) и юридический блок договора — график поставок (например, 5-го и 20-го числа) и время доставки, если отгрузка со склада поставщика.</li>
    </ul>

    <h2>6. Рабочие места ввода информации</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Потоки</th><th>Менеджмент закупок</th><th>Бухгалтерия</th><th>Менеджмент продаж</th></tr></thead>
      <tbody>
        <tr><td><b>ТМЦ</b></td><td>Товарно-транспортные документы</td><td>Товарно-транспортные документы</td><td>Товарно-транспортные документы</td></tr>
        <tr><td><b>ДС</b></td><td>Счета-фактуры от поставщиков</td><td>Платёжные документы</td><td>Счета на оплату покупателям</td></tr>
        <tr><td></td><td>Управленческий блок + бухгалтерия, всё с указанием дат</td><td>Только бухгалтерия</td><td>Управленческий блок + бухгалтерия, всё с указанием дат</td></tr>
      </tbody>
    </table></div>
    <p style="margin-top:8px">Дашборды — для менеджмента и топ-менеджмента: менеджмент готовит информацию, топ-менеджмент принимает решения. Фактическую картину бытия изменить практически невозможно.</p>

    <h2>7. Склад, номенклатура и прочие платежи</h2>
    <ul>
      <li><b>Поартикульный учёт.</b> Справочник номенклатуры; сделки и накладные ведут спецификацию позиций (кол-во × цена). Остаток каждого артикула считается в натуре по реальным проведённым накладным.</li>
      <li><b>Маркер дефицита</b> — по каждому артикулу строится прогноз остатка на 30 дней с учётом обязательств по отгрузке и ожидаемых поставок; уход в минус подсвечивается красным и попадает в счётчик маркеров.</li>
      <li><b>Залежалые остатки</b> — позиции без движения дольше норматива подсвечиваются как «замороженные» деньги, съедающие оборотный капитал.</li>
      <li><b>Прочие платежи</b> — аренда, налоги, зарплата и другие обязательства вне сделок, разовые и ежемесячные. Входят в матрицу «Мы должны», прогноз разрывов и платёжный календарь со своим приоритетом.</li>
    </ul>
    <div class="callout callout-grey">Этап 2 (бэкенд): интеграция с банком (выписки) и ЭДО (первичка), совместная работа ролей — снабженец, продавец, бухгалтер — с общей базой.</div>
    <div class="callout callout-grey">Данные хранятся локально в браузере (localStorage). «Экспорт» выгружает всё в JSON, «Импорт» — восстанавливает.</div>
  </div>`;
}

/* =====================================================================
   Формы
   ===================================================================== */

function dealOptions(selectedId) {
  return state.deals.map((d) =>
    `<option value="${esc(d.id)}" ${d.id === selectedId ? 'selected' : ''}>${esc(dealTitle(d))} — ${DEAL_KIND[d.kind].label}</option>`).join('');
}

function openDealForm(id) {
  const d = id ? dealById(id) : null;
  openModal(d ? 'Сделка: ' + d.name : 'Новая сделка', `
    <form id="frm" class="form-grid">
      <div class="field full"><label>Наименование сделки <span class="req">*</span></label>
        <input name="name" required value="${d ? esc(d.name) : ''}" placeholder="Договор поставки №14"></div>
      <div class="field"><label>Контрагент <span class="req">*</span></label>
        <input name="counterparty" required value="${d ? esc(d.counterparty) : ''}" placeholder="ООО «Ромашка»"></div>
      <div class="field"><label>Тип сделки</label>
        <select name="kind">
          <option value="sale" ${d && d.kind === 'sale' ? 'selected' : ''}>Продажа (мы отгружаем)</option>
          <option value="purchase" ${d && d.kind === 'purchase' ? 'selected' : ''}>Закупка (нам поставляют)</option>
        </select></div>
      <div class="field"><label>Сумма сделки, ₽ <span class="req">*</span></label>
        <input name="amount" id="fDealAmount" type="number" min="1" step="0.01" required value="${d ? d.amount : ''}"></div>
      <div class="field"><label>ID_Deal (UUID)</label>
        <input readonly value="${d ? esc(d.id) : 'будет сгенерирован автоматически'}"></div>
      ${linesEditorHTML(d ? d.lines : null)}
      <div class="field"><label>Срок перемещения ТМЦ после оплаты, дней</label>
        <input name="shipDays" type="number" min="0" step="1" value="${d ? d.shipDays : 5}">
        <div class="note">Юридический блок: «отгрузить/поставить в течение N дней после оплаты». Из него считается Date_Material_Execution_Plan платёжек.</div></div>
      <div class="field"><label>Отсрочка платежа после перемещения ТМЦ, дней</label>
        <input name="deferDays" type="number" min="0" step="1" value="${d ? d.deferDays : 10}">
        <div class="note">Из неё считается Date_Payment_Execution_Plan накладных: факт + отсрочка.</div></div>
      <div class="field"><label>Доставка / логистика, дней</label>
        <input name="deliveryDays" type="number" min="0" step="1" value="${d ? d.deliveryDays || 0 : 0}">
        <div class="note">Если отгрузка со склада поставщика — время в пути до нас. Прибавляется к плану перемещения ТМЦ.</div></div>
      <div class="field"><label>График по договору, дни месяца</label>
        <input name="scheduleDays" value="${d ? esc(d.scheduleDays || '') : ''}" placeholder="напр.: 5, 20">
        <div class="note">Юридический блок: регулярные отгрузки/поставки (например, 5-го и 20-го числа). Планирует остаток обязательств, пока нет документов.</div></div>
      <div class="field full"><label>Комментарий</label>
        <input name="comment" value="${d ? esc(d.comment || '') : ''}"></div>
      <div class="form-actions full">
        <button type="button" class="btn btn-outline" data-close>Отмена</button>
        <button type="submit" class="btn btn-primary">${d ? 'Сохранить' : 'Создать сделку'}</button>
      </div>
    </form>`, (body) => {
    const linesEd = mountLinesEditor(body, body.querySelector('#fDealAmount'));
    body.querySelector('#frm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const name = f.get('name').trim();
      const counterparty = f.get('counterparty').trim();
      if (!name || !counterparty) { showToast('Заполните наименование и контрагента', ['Пробелы не считаются'], 'red'); return; }
      // все проверки — до мутации rec, чтобы отклонённая правка не портила сделку
      const lines = linesEd.getLines();
      const amount = lines.length
        ? sum(lines.map((l) => l.qty * l.price))
        : Math.max(0, parseFloat(f.get('amount')) || 0);
      if (amount <= 0) { showToast('Сумма сделки должна быть больше нуля', ['Проверьте строки спецификации: нужны позиция, количество и цена больше нуля'], 'red'); return; }
      const rec = d || { id: uuid() };
      rec.name = name;
      rec.counterparty = counterparty;
      rec.kind = f.get('kind');
      rec.lines = lines;
      rec.amount = amount;
      rec.shipDays = Math.max(0, parseInt(f.get('shipDays'), 10) || 0);
      rec.deferDays = Math.max(0, parseInt(f.get('deferDays'), 10) || 0);
      rec.deliveryDays = Math.max(0, parseInt(f.get('deliveryDays'), 10) || 0);
      rec.scheduleDays = f.get('scheduleDays').trim();
      rec.comment = f.get('comment').trim();
      if (!d) state.deals.push(rec);
      // направление привязанных документов следует за типом сделки
      for (const p of state.payments) if (p.dealId === rec.id) p.kind = DEAL_KIND[rec.kind].payKind;
      for (const w of state.waybills) if (w.dealId === rec.id) w.kind = DEAL_KIND[rec.kind].wbKind;
      save(); closeModal(true); render();
      showToast(d ? 'Сделка обновлена' : 'Сделка создана', [`ID_Deal: ${rec.id}`]);
    });
  });
}

function openPaymentForm(id) {
  const p = id ? state.payments.find((x) => x.id === id) : null;
  if (!state.deals.length) { showToast('Сначала создайте сделку', ['Платёжный документ привязывается через ID_Deal'], 'red'); return; }
  const defaults = p || { dealId: state.deals[0].id, amount: '', datePaymentExecution: todayISO(), num: nextNum(state.payments, 'ПП') };

  openModal(p ? 'Платёжный документ ' + p.num : 'Новый платёжный документ', `
    <form id="frm" class="form-grid">
      <div class="field"><label>Номер документа</label>
        <input name="num" value="${esc(defaults.num)}"></div>
      <div class="field"><label>Сделка (ID_Deal) <span class="req">*</span></label>
        <select name="dealId" id="fDeal">${dealOptions(defaults.dealId)}</select>
        <div class="note" id="fKindNote"></div></div>
      <div class="field"><label>Сумма, ₽ <span class="req">*</span></label>
        <input name="amount" id="fAmount" type="number" min="0.01" step="0.01" required value="${defaults.amount}"></div>
      <div class="field"><label>Date_Payment_Execution — факт оплаты <span class="req">*</span></label>
        <input name="datePaymentExecution" id="fPayDate" type="date" required max="${todayISO()}" value="${defaults.datePaymentExecution}">
        <div class="note">Входящие — дата зачисления на счёт, исходящие — дата списания банком. Факт не может быть в будущем.</div></div>
      <div class="field full"><label>Date_Material_Execution_Plan — план перемещения ТМЦ</label>
        <input name="dateMaterialPlan" id="fMatPlan" type="date" value="${p ? p.dateMaterialPlan || '' : ''}">
        <div class="note auto" id="fMatPlanNote"></div></div>
      <div class="field full"><label>Комментарий</label>
        <input name="comment" value="${p ? esc(p.comment || '') : ''}"></div>
      <div class="form-actions full">
        <button type="button" class="btn btn-outline" data-close>Отмена</button>
        <button type="submit" class="btn btn-primary">${p ? 'Сохранить' : 'Создать документ'}</button>
      </div>
    </form>`, (body) => {
    const fDeal = body.querySelector('#fDeal');
    const fPayDate = body.querySelector('#fPayDate');
    const fMatPlan = body.querySelector('#fMatPlan');
    const note = body.querySelector('#fMatPlanNote');
    const kindNote = body.querySelector('#fKindNote');
    let manual = !!p; // при редактировании не перетираем сохранённое, пока не изменят входные данные

    const recalc = (force) => {
      const deal = dealById(fDeal.value);
      kindNote.textContent = deal ? 'Тип: ' + DEAL_KIND[deal.kind].payLabel : '';
      if (!deal || !fPayDate.value) return;
      if (force || !manual) {
        const lead = deal.shipDays + (deal.deliveryDays || 0);
        fMatPlan.value = addDays(fPayDate.value, lead);
        note.textContent = `Рассчитано из договора: оплата + ${deal.shipDays} дн.${deal.deliveryDays ? ` + доставка ${deal.deliveryDays} дн.` : ''} Можно скорректировать вручную.`;
        manual = false;
      }
    };
    fDeal.addEventListener('change', () => recalc(true));
    fPayDate.addEventListener('change', () => recalc(true));
    fMatPlan.addEventListener('input', () => { manual = true; note.textContent = 'Указано вручную (перекрывает расчёт из договора).'; });
    recalc(false);
    if (p && p.dateMaterialPlan) note.textContent = 'Сохранённое значение. Изменение сделки или даты оплаты пересчитает план.';

    body.querySelector('#frm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const deal = dealById(f.get('dealId'));
      if (!deal) return;
      const rec = p || { id: uuid(), posted: false };
      const num = f.get('num').trim() || nextNum(state.payments, 'ПП');
      if (state.payments.some((x) => x.num === num && x.id !== rec.id)) {
        showToast('Номер уже занят', [`Платёжный документ ${num} существует — укажите другой номер`], 'red'); return;
      }
      const amount = parseFloat(f.get('amount')) || 0;
      if (amount <= 0) { showToast('Сумма должна быть больше нуля', [], 'red'); return; }
      rec.num = num;
      rec.dealId = deal.id;
      rec.kind = DEAL_KIND[deal.kind].payKind;
      rec.amount = amount;
      rec.datePaymentExecution = f.get('datePaymentExecution');
      rec.dateMaterialPlan = f.get('dateMaterialPlan') || addDays(rec.datePaymentExecution, deal.shipDays + (deal.deliveryDays || 0));
      rec.comment = f.get('comment').trim();
      if (!p) state.payments.push(rec);
      save(); closeModal(true); render();
      showToast(p ? 'Платёжный документ обновлён' : 'Платёжный документ создан',
        [`${rec.num} · ${PAY_KIND[rec.kind]} · ${fmtMoney(rec.amount)}`, `План ТМЦ: ${fmtDate(rec.dateMaterialPlan)}`]);
    });
  });
}

function openWaybillForm(id) {
  const w = id ? state.waybills.find((x) => x.id === id) : null;
  if (!state.deals.length) { showToast('Сначала создайте сделку', ['Накладная привязывается через ID_Deal'], 'red'); return; }
  const defaults = w || { dealId: state.deals[0].id, amount: '', dateMaterialFact: todayISO(), num: nextNum(state.waybills, 'НК'), isReal: true, goods: '' };

  openModal(w ? 'Накладная ' + w.num : 'Новая накладная', `
    <form id="frm" class="form-grid">
      <div class="field"><label>Номер документа</label>
        <input name="num" value="${esc(defaults.num)}"></div>
      <div class="field"><label>Сделка (ID_Deal) <span class="req">*</span></label>
        <select name="dealId" id="fDeal">${dealOptions(defaults.dealId)}</select>
        <div class="note" id="fKindNote"></div></div>
      <div class="field"><label>Сумма ТМЦ, ₽ <span class="req">*</span></label>
        <input name="amount" id="fWbAmount" type="number" min="0.01" step="0.01" required value="${defaults.amount}"></div>
      <div class="field"><label>Состав ТМЦ (текстом)</label>
        <input name="goods" value="${esc(defaults.goods || '')}" placeholder="металлопрокат, 12 т"></div>
      ${linesEditorHTML(w ? w.lines : null)}
      <div class="field"><label>Date_Material_Execution_Fact — факт перемещения <span class="req">*</span></label>
        <input name="dateMaterialFact" id="fFactDate" type="date" required max="${todayISO()}" value="${defaults.dateMaterialFact}">
        <div class="note">Дата фактического отпуска со склада или приёмки МОЛ. Факт не может быть в будущем.</div></div>
      <div class="field"><label>Date_Payment_Execution_Plan — план оплаты</label>
        <input name="datePaymentPlan" id="fPayPlan" type="date" value="${w ? w.datePaymentPlan || '' : ''}">
        <div class="note auto" id="fPayPlanNote"></div></div>
      <div class="check-row full">
        <input type="checkbox" name="isReal" id="fIsReal" ${defaults.isReal ? 'checked' : ''}>
        <div>
          <label class="check-title" for="fIsReal">Is_Real — реальность действия: ДА</label>
          <div class="check-sub" id="fIsRealNote"></div>
        </div>
      </div>
      <div class="field full"><label>Комментарий</label>
        <input name="comment" value="${w ? esc(w.comment || '') : ''}"></div>
      <div class="form-actions full">
        <button type="button" class="btn btn-outline" data-close>Отмена</button>
        <button type="submit" class="btn btn-primary">${w ? 'Сохранить' : 'Создать накладную'}</button>
      </div>
    </form>`, (body) => {
    const fDeal = body.querySelector('#fDeal');
    const fFact = body.querySelector('#fFactDate');
    const fPlan = body.querySelector('#fPayPlan');
    const fReal = body.querySelector('#fIsReal');
    const note = body.querySelector('#fPayPlanNote');
    const kindNote = body.querySelector('#fKindNote');
    const realNote = body.querySelector('#fIsRealNote');
    const linesEd = mountLinesEditor(body, body.querySelector('#fWbAmount'));
    let manual = !!w;

    const syncReal = () => {
      const on = fReal.checked;
      body.querySelector('.check-title').textContent = 'Is_Real — реальность действия: ' + (on ? 'ДА' : 'НЕТ');
      realNote.textContent = on
        ? 'Товар физически взвешен/посчитан и перемещён. Данные идут в управленческий баланс и графики.'
        : 'Виртуальная операция (бумажная корректировка, перенос остатков). Управленческие регистры игнорируются, плановая дата оплаты не порождается.';
      fPlan.closest('.field').style.opacity = on ? '' : '.45';
      fPlan.disabled = !on;
    };
    const recalc = (force) => {
      const deal = dealById(fDeal.value);
      kindNote.textContent = deal ? 'Тип: ' + DEAL_KIND[deal.kind].wbLabel : '';
      if (!deal || !fFact.value) return;
      if (force || !manual) {
        fPlan.value = addDays(fFact.value, deal.deferDays);
        note.textContent = `Рассчитано: факт + отсрочка ${deal.deferDays} дн. из договора. Можно скорректировать вручную.`;
        manual = false;
      }
    };
    fDeal.addEventListener('change', () => recalc(true));
    fFact.addEventListener('change', () => recalc(true));
    fPlan.addEventListener('input', () => { manual = true; note.textContent = 'Указано вручную (перекрывает расчёт из договора).'; });
    fReal.addEventListener('change', syncReal);
    recalc(false); syncReal();
    if (w && w.datePaymentPlan) note.textContent = 'Сохранённое значение. Изменение сделки или даты факта пересчитает план.';

    body.querySelector('#frm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const deal = dealById(f.get('dealId'));
      if (!deal) return;
      const rec = w || { id: uuid(), posted: false };
      const num = f.get('num').trim() || nextNum(state.waybills, 'НК');
      if (state.waybills.some((x) => x.num === num && x.id !== rec.id)) {
        showToast('Номер уже занят', [`Накладная ${num} существует — укажите другой номер`], 'red'); return;
      }
      // все проверки — до мутации rec, чтобы отклонённая правка не портила документ
      const lines = linesEd.getLines();
      const amount = lines.length ? sum(lines.map((l) => l.qty * l.price)) : (parseFloat(f.get('amount')) || 0);
      if (amount <= 0) { showToast('Сумма должна быть больше нуля', ['Проверьте строки спецификации: нужны позиция, количество и цена больше нуля'], 'red'); return; }
      rec.num = num;
      rec.dealId = deal.id;
      rec.kind = DEAL_KIND[deal.kind].wbKind;
      rec.lines = lines;
      rec.amount = amount;
      rec.goods = f.get('goods').trim();
      rec.isReal = fReal.checked;
      rec.dateMaterialFact = f.get('dateMaterialFact');
      // Is_Real = НЕТ → плановая дата оплаты не порождается (см. спецификацию)
      rec.datePaymentPlan = rec.isReal ? (f.get('datePaymentPlan') || addDays(rec.dateMaterialFact, deal.deferDays)) : null;
      rec.comment = f.get('comment').trim();
      if (!w) state.waybills.push(rec);
      save(); closeModal(true); render();
      showToast(w ? 'Накладная обновлена' : 'Накладная создана',
        [`${rec.num} · ${WB_KIND[rec.kind]} · ${fmtMoney(rec.amount)} · Is_Real: ${rec.isReal ? 'ДА' : 'НЕТ'}`,
         rec.isReal ? `План оплаты: ${fmtDate(rec.datePaymentPlan)}` : 'Управленческие регистры не затрагиваются']);
    });
  });
}

/* =====================================================================
   Демо-данные
   ===================================================================== */

function loadDemo() {
  const T = todayISO();
  simulation = null;

  // номенклатура
  const iOgr = { id: uuid(), sku: 'АРТ-001', createdAt: addDays(T, -60), name: 'Секции ограждений', unit: 'шт', price: 8500, qtyOpening: 30, staleDays: 30 };
  const iUdo = { id: uuid(), sku: 'АРТ-002', createdAt: addDays(T, -60), name: 'Удобрение азотное', unit: 'т', price: 40000, qtyOpening: 0, staleDays: 45 };
  const iKond = { id: uuid(), sku: 'АРТ-003', createdAt: addDays(T, -60), name: 'Кондиционер настенный', unit: 'шт', price: 52000, qtyOpening: 10, staleDays: 21 };
  const iMet = { id: uuid(), sku: 'АРТ-004', createdAt: addDays(T, -60), name: 'Металлопрокат', unit: 'т', price: 15000, qtyOpening: 0, staleDays: 60 };
  const iFbs = { id: uuid(), sku: 'АРТ-005', createdAt: addDays(T, -60), name: 'Блоки ФБС', unit: 'шт', price: 4800, qtyOpening: 120, staleDays: 60 };
  const iFuel = { id: uuid(), sku: 'АРТ-006', createdAt: addDays(T, -60), name: 'Дизельное топливо', unit: 'л', price: 62, qtyOpening: 400, staleDays: 90 };

  const dRomashka = { id: uuid(), name: 'Договор поставки №14', counterparty: 'ООО «Ромашка»', kind: 'sale', amount: 480000, shipDays: 5, deferDays: 10, comment: 'Аванс 100%, отгрузка в течение 5 дней', lines: [{ itemId: iOgr.id, qty: 40, price: 12000 }] };
  const dStal = { id: uuid(), name: 'Закупка металлопроката', counterparty: 'АО «СтальТрейд»', kind: 'purchase', amount: 750000, shipDays: 14, deferDays: 0, comment: 'Предоплата, поставка 14 дней', lines: [{ itemId: iMet.id, qty: 50, price: 15000 }] };
  const dAgro = { id: uuid(), name: 'Закупка удобрений', counterparty: 'ООО «АгроСнаб»', kind: 'purchase', amount: 320000, shipDays: 0, deferDays: 15, comment: 'Отсрочка 15 дней после приёмки', lines: [{ itemId: iUdo.id, qty: 8, price: 40000 }] };
  const dTehno = { id: uuid(), name: 'Договор продажи №7', counterparty: 'ООО «ТехноДом»', kind: 'sale', amount: 560000, shipDays: 3, deferDays: 20, comment: 'Отсрочка 20 дней после отгрузки', lines: [{ itemId: iKond.id, qty: 8, price: 70000 }] };
  const dStroy = { id: uuid(), name: 'Договор продажи №11', counterparty: 'ООО «СтройГрад»', kind: 'sale', amount: 650000, shipDays: 3, deferDays: 14, comment: 'Отсрочка 14 дней после отгрузки', lines: [{ itemId: iFbs.id, qty: 100, price: 6500 }] };
  // обязательство только из юр. блока: график поставок 5-го и 20-го, доставка 2 дня
  const dFuel = { id: uuid(), name: 'Договор поставки топлива', counterparty: 'ООО «НефтеТрейд»', kind: 'purchase', amount: 124000, shipDays: 0, deferDays: 10, deliveryDays: 2, scheduleDays: '5, 20', comment: 'Поставки 5-го и 20-го числа, доставка 2 дня', lines: [{ itemId: iFuel.id, qty: 2000, price: 62 }] };

  // живые остатки: разрыв возникает в будущем — виден заранее, симулятор предложит решения
  state = {
    deals: [dRomashka, dStal, dAgro, dTehno, dStroy, dFuel],
    payments: [], waybills: [], journal: [],
    items: [iOgr, iUdo, iKond, iMet, iFbs, iFuel],
    otherPayments: [
      { id: uuid(), name: 'Аренда склада', category: 'rent', priority: 'primary', amount: 70000, date: addDays(T, 3), recurring: 'monthly', done: false },
      { id: uuid(), name: 'Подписка на сервис аналитики', category: 'other', priority: 'discretionary', amount: 25000, date: addDays(T, 4), recurring: 'monthly', done: false },
      { id: uuid(), name: 'Зарплата', category: 'salary', priority: 'critical', amount: 140000, date: addDays(T, 6), recurring: 'monthly', done: false },
      { id: uuid(), name: 'Налог УСН (аванс)', category: 'taxes', priority: 'critical', amount: 60000, date: addDays(T, 10), recurring: 'none', done: false },
    ],
    settings: { cashOpening: 300000, stockOpening: 400000 },
  };

  const mkPay = (deal, num, amount, dayOffset) => ({
    id: uuid(), num, dealId: deal.id, kind: DEAL_KIND[deal.kind].payKind, amount,
    datePaymentExecution: addDays(T, dayOffset),
    dateMaterialPlan: addDays(addDays(T, dayOffset), deal.shipDays + (deal.deliveryDays || 0)),
    comment: '', posted: false,
  });
  const mkWb = (deal, num, amount, dayOffset, isReal, goods, lines) => ({
    id: uuid(), num, dealId: deal.id, kind: DEAL_KIND[deal.kind].wbKind, amount,
    isReal, goods: goods || '', lines: lines || [],
    dateMaterialFact: addDays(T, dayOffset),
    datePaymentPlan: isReal ? addDays(addDays(T, dayOffset), deal.deferDays) : null,
    comment: '', posted: false,
  });

  // Ромашка (продажа): аванс 12 дней назад → план отгрузки −7 дн.; отгружено 25 из 40 шт с опозданием
  // → к отгрузке 15 шт при складе 10 шт: дефицит по АРТ-001
  state.payments.push(mkPay(dRomashka, 'ПП-1', 480000, -12));
  state.waybills.push(mkWb(dRomashka, 'НК-1', 300000, -4, true, 'секции ограждений', [{ itemId: iOgr.id, qty: 25, price: 12000 }]));
  // СтальТрейд (закупка): предоплата 6 дней назад → поставка 50 т через 8 дней
  state.payments.push(mkPay(dStal, 'ПП-2', 750000, -6));
  // АгроСнаб (закупка): приёмка 8 т 10 дней назад → оплата через 5 дней
  state.waybills.push(mkWb(dAgro, 'НК-2', 320000, -10, true, 'удобрения', [{ itemId: iUdo.id, qty: 8, price: 40000 }]));
  // ТехноДом (продажа): отгрузка 30 дней назад, оплата частичная → просроченная дебиторка;
  // остаток 2 кондиционера без движения 30 дней → залежалый сток
  state.waybills.push(mkWb(dTehno, 'НК-3', 560000, -30, true, 'климатическое оборудование', [{ itemId: iKond.id, qty: 8, price: 70000 }]));
  state.payments.push(mkPay(dTehno, 'ПП-3', 200000, -8));
  // СтройГрад (продажа): отгрузка 100 блоков 2 дня назад → оплата 650 000 через 12 дней
  state.waybills.push(mkWb(dStroy, 'НК-5', 650000, -2, true, 'блоки ФБС', [{ itemId: iFbs.id, qty: 100, price: 6500 }]));
  // Виртуальная корректировка по Ромашке: Is_Real = НЕТ, регистры не трогает
  state.waybills.push(mkWb(dRomashka, 'НК-4', 50000, -2, false, 'перенос остатков (корректировка)'));

  // проводим все документы через штатный механизм — журнал заполняется по
  // логической матрице; тосты на время массового проведения глушим
  quietToasts = true;
  try {
    for (const p of state.payments) postDocument('payment', p.id);
    for (const w of state.waybills) postDocument('waybill', w.id);
  } finally {
    quietToasts = false;
  }

  save();
  location.hash = '#/dashboard';
  render();
  showToast('Демо-сценарий загружен', [
    '5 сделок, 5 позиций склада, прочие платежи (аренда, налоги, зарплата)',
    'На главном экране: разрыв заранее, дефицит по артикулу и симулятор решений',
  ]);
}

/* =====================================================================
   Экспорт / импорт / сброс
   ===================================================================== */

function exportJSON() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `upravlencheskiy-kontur-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* Строгая валидация импортируемых записей: битые записи отбрасываются,
   чтобы повреждённый файл не «окирпичил» приложение через localStorage. */
function sanitizeImported(s) {
  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : null);
  const str = (v) => (typeof v === 'string' ? v : '');
  // id допускаются только как безопасные токены (UUID и т.п.);
  // «грязные» id сделок заменяются с сохранением связок через idMap
  const okId = (v) => typeof v === 'string' && /^[\w-]{1,64}$/.test(v);
  const idMap = new Map();
  const safeDealId = (v) => {
    if (okId(v)) return v;
    if (!idMap.has(v)) idMap.set(v, uuid());
    return idMap.get(v);
  };
  const resolveDealRef = (v) => (okId(v) ? v : idMap.get(v));

  const deals = (s.deals || []).filter((d) => d && typeof d === 'object' && str(d.id) && str(d.name))
    .map((d) => ({
      id: safeDealId(d.id), name: str(d.name), counterparty: str(d.counterparty) || '—',
      kind: d.kind === 'purchase' ? 'purchase' : 'sale',
      amount: num(d.amount) || 0,
      shipDays: Math.max(0, parseInt(d.shipDays, 10) || 0),
      deferDays: Math.max(0, parseInt(d.deferDays, 10) || 0),
      deliveryDays: Math.max(0, parseInt(d.deliveryDays, 10) || 0),
      scheduleDays: str(d.scheduleDays),
      comment: str(d.comment),
      _srcLines: d.lines,
    }));
  const dealIds = new Set(deals.map((d) => d.id));

  const payments = (s.payments || []).filter((p) => p && typeof p === 'object' && dealIds.has(resolveDealRef(p.dealId)) && num(p.amount) && isDate(p.datePaymentExecution))
    .map((p) => {
      const dealRef = resolveDealRef(p.dealId);
      const deal = deals.find((d) => d.id === dealRef);
      return {
        id: okId(p.id) ? p.id : uuid(), num: str(p.num) || 'ПП-?', dealId: dealRef,
        kind: DEAL_KIND[deal.kind].payKind, amount: num(p.amount),
        datePaymentExecution: p.datePaymentExecution,
        dateMaterialPlan: isDate(p.dateMaterialPlan) ? p.dateMaterialPlan : addDays(p.datePaymentExecution, deal.shipDays + (deal.deliveryDays || 0)),
        comment: str(p.comment), posted: !!p.posted,
      };
    });

  const waybills = (s.waybills || []).filter((w) => w && typeof w === 'object' && dealIds.has(resolveDealRef(w.dealId)) && num(w.amount) && isDate(w.dateMaterialFact))
    .map((w) => {
      const dealRef = resolveDealRef(w.dealId);
      const deal = deals.find((d) => d.id === dealRef);
      const isReal = w.isReal !== false;
      return {
        id: okId(w.id) ? w.id : uuid(), num: str(w.num) || 'НК-?', dealId: dealRef,
        kind: DEAL_KIND[deal.kind].wbKind, amount: num(w.amount), isReal,
        goods: str(w.goods), dateMaterialFact: w.dateMaterialFact,
        datePaymentPlan: isReal ? (isDate(w.datePaymentPlan) ? w.datePaymentPlan : addDays(w.dateMaterialFact, deal.deferDays)) : null,
        comment: str(w.comment), posted: !!w.posted,
        _srcLines: w.lines,
      };
    });

  const journal = (Array.isArray(s.journal) ? s.journal : []).filter((j) => j && typeof j === 'object' && str(j.doc))
    .map((j) => ({ ts: str(j.ts) || new Date().toISOString(), doc: str(j.doc), deal: str(j.deal), real: j.real !== false, lines: Array.isArray(j.lines) ? j.lines.map(str) : [] }));

  const numOrNull = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const settings = s.settings && typeof s.settings === 'object'
    ? { cashOpening: numOrNull(s.settings.cashOpening), stockOpening: numOrNull(s.settings.stockOpening) }
    : { cashOpening: null, stockOpening: null };

  // «грязные» id позиций ремапятся с сохранением ссылок из строк спецификаций
  const itemIdMap = new Map();
  const safeItemId = (v) => {
    if (okId(v)) return v;
    if (!itemIdMap.has(v)) itemIdMap.set(v, uuid());
    return itemIdMap.get(v);
  };
  const items = (s.items || []).filter((i) => i && typeof i === 'object' && str(i.sku) && str(i.name))
    .map((i) => ({
      id: safeItemId(i.id),
      sku: str(i.sku), name: str(i.name), unit: str(i.unit) || 'шт',
      price: typeof i.price === 'number' && isFinite(i.price) && i.price >= 0 ? i.price : 0,
      qtyOpening: typeof i.qtyOpening === 'number' && isFinite(i.qtyOpening) ? Math.max(0, i.qtyOpening) : 0,
      staleDays: Math.max(0, parseInt(i.staleDays, 10) || 0),
      createdAt: isDate(i.createdAt) ? i.createdAt : todayISO(),
    }));
  const itemIds = new Set(items.map((i) => i.id));
  const resolveItemRef = (v) => (okId(v) ? v : itemIdMap.get(v));

  const cleanLines = (lines) => Array.isArray(lines)
    ? lines.map((l) => (l ? { ...l, itemId: resolveItemRef(l.itemId) } : l))
        .filter((l) => l && itemIds.has(l.itemId) && num(l.qty) && typeof l.price === 'number' && isFinite(l.price) && l.price >= 0)
        .map((l) => ({ itemId: l.itemId, qty: l.qty, price: l.price }))
    : [];
  for (const d of deals) { d.lines = cleanLines(d._srcLines); delete d._srcLines; }
  for (const w of waybills) { w.lines = cleanLines(w._srcLines); delete w._srcLines; }

  const otherPayments = (s.otherPayments || []).filter((p) => p && typeof p === 'object' && str(p.name) && num(p.amount) && isDate(p.date))
    .map((p) => ({
      id: okId(p.id) ? p.id : uuid(),
      name: str(p.name),
      category: OTHER_CATEGORIES[p.category] ? p.category : 'other',
      priority: PRIORITIES[p.priority] ? p.priority : 'flexible',
      amount: num(p.amount), date: p.date,
      recurring: p.recurring === 'monthly' ? 'monthly' : 'none',
      done: !!p.done,
    }));

  return { deals, payments, waybills, journal, settings, items, otherPayments };
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const raw = JSON.parse(reader.result);
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.deals)) throw new Error('bad');
      const clean = sanitizeImported(raw);
      const dropped = (raw.deals?.length || 0) - clean.deals.length +
        ((raw.payments?.length || 0) - clean.payments.length) +
        ((raw.waybills?.length || 0) - clean.waybills.length);
      const hasData = state.deals.length || state.payments.length || state.waybills.length;
      if (hasData && !confirm(`Импорт заменит текущие данные (сделок: ${state.deals.length}, документов: ${state.payments.length + state.waybills.length}). Продолжить?`)) return;
      state = clean;
      save(); render();
      showToast('Данные импортированы',
        [`Сделок: ${clean.deals.length}, платёжек: ${clean.payments.length}, накладных: ${clean.waybills.length}`,
         ...(dropped > 0 ? [`Отброшено битых записей: ${dropped}`] : [])]);
    } catch (e) {
      showToast('Ошибка импорта', ['Файл не похож на экспорт этой системы'], 'red');
    }
  };
  reader.readAsText(file);
}

/* Копирование с fallback для браузеров без Clipboard API / не-secure контекста */
function copyText(text) {
  const done = () => showToast('UUID скопирован', [text]);
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { /* не поддерживается */ }
    ta.remove();
    ok ? done() : showToast('Скопируйте вручную', [text], 'grey');
  };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}

/* =====================================================================
   События
   ===================================================================== */

function bindMainEvents() {
  $('#main').querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', () => {
      const a = el.dataset.action, id = el.dataset.id, type = el.dataset.type;
      if (a === 'demo') loadDemo();
      else if (a === 'new-deal') openDealForm();
      else if (a === 'edit-deal') openDealForm(id);
      else if (a === 'del-deal') {
        const hasDocs = state.payments.some((p) => p.dealId === id) || state.waybills.some((w) => w.dealId === id);
        if (hasDocs) { showToast('Нельзя удалить сделку', ['К ней привязаны документы — удалите их сначала'], 'red'); return; }
        if (confirm('Удалить сделку?')) { state.deals = state.deals.filter((d) => d.id !== id); save(); render(); }
      }
      else if (a === 'new-payment') openPaymentForm();
      else if (a === 'edit-payment') openPaymentForm(id);
      else if (a === 'del-payment') { if (confirm('Удалить платёжный документ?')) { state.payments = state.payments.filter((p) => p.id !== id); save(); render(); } }
      else if (a === 'new-waybill') openWaybillForm();
      else if (a === 'edit-waybill') openWaybillForm(id);
      else if (a === 'del-waybill') { if (confirm('Удалить накладную?')) { state.waybills = state.waybills.filter((w) => w.id !== id); save(); render(); } }
      else if (a === 'post') postDocument(type, id);
      else if (a === 'unpost') unpostDocument(type, id);
      else if (a === 'copy-uuid') copyText(id);
      else if (a === 'edit-balances') openBalancesForm();
      else if (a === 'goto-flags') document.getElementById('dash-flags')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else if (a === 'simulate') {
        const sol = lastSolutions[parseInt(el.dataset.idx, 10)];
        if (sol) { simulation = { ...sol.sim, label: sol.title }; render(); }
      }
      else if (a === 'sim-apply') applySimulation();
      else if (a === 'sim-reset') { simulation = null; render(); }
      else if (a === 'new-item') openItemForm();
      else if (a === 'edit-item') openItemForm(id);
      else if (a === 'del-item') {
        const used = state.deals.some((d) => (d.lines || []).some((l) => l.itemId === id)) ||
          state.waybills.some((w) => (w.lines || []).some((l) => l.itemId === id));
        if (used) { showToast('Нельзя удалить позицию', ['Она используется в строках сделок или накладных'], 'red'); return; }
        if (confirm('Удалить позицию номенклатуры?')) { state.items = state.items.filter((i) => i.id !== id); save(); render(); }
      }
      else if (a === 'new-other') openOtherForm();
      else if (a === 'edit-other') openOtherForm(id);
      else if (a === 'del-other') { if (confirm('Удалить прочий платёж?')) { state.otherPayments = state.otherPayments.filter((p) => p.id !== id); save(); render(); } }
      else if (a === 'toggle-other-done') {
        const p = state.otherPayments.find((x) => x.id === id);
        if (p) { p.done = !p.done; save(); render(); }
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  window.addEventListener('hashchange', render);
  $('#modalClose').addEventListener('click', () => closeModal());
  $('#modalBackdrop').addEventListener('click', (e) => { if (e.target === $('#modalBackdrop')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modalBackdrop').hidden) closeModal(); });
  document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(true); });
  $('#modalBody').addEventListener('input', () => { modalDirty = true; });
  const syncSidebar = (open) => {
    $('#sidebar').classList.toggle('open', open);
    $('#sidebarOverlay').classList.toggle('show', open);
  };
  $('#burger').addEventListener('click', () => syncSidebar(!$('#sidebar').classList.contains('open')));
  $('#sidebarOverlay').addEventListener('click', () => syncSidebar(false));
  // тап по пункту меню закрывает сайдбар и при переходе на текущую страницу
  $('#nav').addEventListener('click', (e) => { if (e.target.closest('a')) syncSidebar(false); });
  $('#btnDemo').addEventListener('click', () => {
    if (!state.deals.length || confirm('Текущие данные будут заменены демо-сценарием. Продолжить?')) loadDemo();
  });
  $('#btnExport').addEventListener('click', exportJSON);
  $('#btnImport').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ''; });
  $('#btnWipe').addEventListener('click', () => {
    if (confirm('Удалить все данные без возможности восстановления?')) {
      state = { deals: [], payments: [], waybills: [], journal: [], items: [], otherPayments: [] };
      simulation = null;
      save(); render();
    }
  });
  render();
});
