'use strict';

/* =====================================================================
   Управленческий контур — платёжные документы, накладные, регистры.
   Спецификация: конфигурационные карты Б. (см. раздел «Спецификация»).
   Хранение: localStorage, ключ boris-uchet-v1.
   ===================================================================== */

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
    .map((x) => ({ date: x.date, left: x.amount, ref: x.ref }))
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
  return { late, open: q.filter((x) => x.left > 0.004).map((x) => ({ date: x.date, left: x.left, ref: x.ref })) };
}

/* Материальный контур сделки */
function materialRegister(deal) {
  const quotas = postedPayments(deal.id)
    .filter((p) => p.dateMaterialPlan)
    .map((p) => ({ date: p.dateMaterialPlan, amount: p.amount, ref: p.num }));
  const facts = postedRealWaybills(deal.id)
    .map((w) => ({ date: w.dateMaterialFact, amount: w.amount, ref: w.num, key: w.id }));
  return fifoMatch(quotas, facts);
}

/* Денежный контур сделки */
function moneyRegister(deal) {
  const quotas = postedRealWaybills(deal.id)
    .filter((w) => w.datePaymentPlan)
    .map((w) => ({ date: w.datePaymentPlan, amount: w.amount, ref: w.num }));
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
  events.sort((a, b) => a.date.localeCompare(b.date));
  return events;
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
  dashboard: { title: 'Дашборд', render: renderDashboard },
  deals: { title: 'Сделки', render: renderDeals },
  payments: { title: 'Платёжные документы', render: renderPayments },
  waybills: { title: 'Накладные', render: renderWaybills },
  tmc: { title: 'График ТМЦ', render: renderTmc },
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
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === route));
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
  return `<div class="empty"><div class="empty-ico">${icon}</div>
    <div class="empty-title">${esc(title)}</div><p>${esc(text)}</p>${actionsHTML}</div>`;
}

const demoButtonHTML = `<button class="btn btn-primary" data-action="demo">Загрузить демо-сценарий</button>`;

/* ---------- Дашборд ---------- */
function renderDashboard(flags) {
  if (!state.deals.length && !state.payments.length && !state.waybills.length) {
    return `<div class="card">${emptyBlock('◈', 'Система пуста',
      'Создайте сделку и документы — или загрузите демонстрационный сценарий, который показывает все механики: красные флаги, календарь выплат и изоляцию виртуальных накладных.',
      demoButtonHTML)}</div>`;
  }

  let moneyFact = 0, receivable = 0, payable = 0;
  for (const d of state.deals) {
    const a = dealAggregates(d);
    moneyFact += a.moneyFact;
    receivable += a.receivable;
    payable += a.payable;
  }
  const reds = flags.filter((f) => f.severity === 'red');
  const ambers = flags.filter((f) => f.severity === 'amber');

  const kpi = `
  <div class="grid-kpi">
    <div class="kpi"><div class="kpi-label">Денежный поток (факт)</div>
      <div class="kpi-value ${moneyFact >= 0 ? 'pos' : 'neg'}">${fmtMoneySign(moneyFact)}</div>
      <div class="kpi-sub">по проведённым платёжкам</div></div>
    <div class="kpi"><div class="kpi-label">Дебиторская задолженность</div>
      <div class="kpi-value">${fmtMoney(receivable)}</div>
      <div class="kpi-sub">нам должны</div></div>
    <div class="kpi"><div class="kpi-label">Кредиторская задолженность</div>
      <div class="kpi-value">${fmtMoney(payable)}</div>
      <div class="kpi-sub">должны мы</div></div>
    <div class="kpi"><div class="kpi-label">Красные флаги</div>
      <div class="kpi-value ${reds.length ? 'neg' : 'pos'}">${reds.length}</div>
      <div class="kpi-sub">${ambers.length} предупреждений</div></div>
  </div>`;

  const flagsHTML = flags.length
    ? flags.map((f) => flagItemHTML(f)).join('')
    : `<div class="empty" style="padding:24px"><div class="empty-ico">✓</div><div class="empty-title">Флагов нет</div><p>Все обязательства исполняются в срок.</p></div>`;

  const events = cashflowEvents().filter((e) => e.plan);
  const today = todayISO();
  const horizon = addDays(today, 14);
  const upcoming = events.filter((e) => e.date <= horizon).slice(0, 8);
  const calHTML = upcoming.length
    ? upcoming.map((e) => calEventHTML(e, today)).join('')
    : `<div class="empty" style="padding:24px"><div class="empty-ico">💰</div><div class="empty-title">Плановых платежей нет</div><p>Ближайшие 14 дней свободны от денежных обязательств.</p></div>`;

  const lastJournal = state.journal.slice(0, 4).map(journalEntryHTML).join('') ||
    `<p style="color:var(--muted);font-size:13px">Документы ещё не проводились.</p>`;

  return `${kpi}
  <div class="two-col">
    <div class="card"><div class="card-title">🚩 Красные флаги <span class="hint">материальные и денежные просрочки</span></div>${flagsHTML}</div>
    <div>
      <div class="card"><div class="card-title">📅 Платежи ближайших 14 дней</div>${calHTML}</div>
      <div class="card"><div class="card-title">🗒 Последние проведения</div>${lastJournal}</div>
    </div>
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

function calEventHTML(e, today) {
  const overdue = e.plan && e.date < today;
  return `<div class="cal-event ${e.dir} ${overdue ? 'overdue' : ''}">
    <span class="badge ${e.plan ? (overdue ? 'badge-red' : 'badge-blue') : 'badge-grey'}">${overdue ? 'просрочено' : e.plan ? 'план' : 'факт'}</span>
    <span>${fmtDate(e.date)} · ${esc(e.label)}</span>
    <span class="amt">${e.dir === 'in' ? '+' : '−'}${fmtMoney(Math.abs(e.amount))}</span>
  </div>`;
}

/* ---------- Сделки ---------- */
function renderDeals() {
  const rows = state.deals.map((d) => {
    const a = dealAggregates(d);
    return `<tr>
      <td><div class="cell-main">${esc(d.name)}</div><div class="cell-sub">${esc(d.counterparty)}</div></td>
      <td><span class="badge ${d.kind === 'sale' ? 'badge-green' : 'badge-blue'}">${DEAL_KIND[d.kind].label}</span></td>
      <td class="uuid" data-action="copy-uuid" data-id="${d.id}" title="Скопировать полный UUID">${shortId(d.id)}…</td>
      <td class="num">${fmtMoney(d.amount)}</td>
      <td class="num">${d.shipDays} дн.</td>
      <td class="num">${d.deferDays} дн.</td>
      <td class="num">${fmtMoney(a.paid)}</td>
      <td class="num">${fmtMoney(a.moved)}</td>
      <td><div class="row-actions">
        <button class="btn btn-outline btn-sm" data-action="edit-deal" data-id="${d.id}">Изменить</button>
        <button class="btn btn-outline btn-sm" data-action="del-deal" data-id="${d.id}">Удалить</button>
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
    : emptyBlock('🤝', 'Сделок нет', 'Создайте первую сделку — документы привязываются к ней через ID_Deal.', demoButtonHTML)}
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
          ? `<button class="btn btn-outline btn-sm" data-action="unpost" data-type="payment" data-id="${p.id}">Распровести</button>`
          : `<button class="btn btn-primary btn-sm" data-action="post" data-type="payment" data-id="${p.id}">Провести</button>
             <button class="btn btn-outline btn-sm" data-action="edit-payment" data-id="${p.id}">Изменить</button>
             <button class="btn btn-outline btn-sm" data-action="del-payment" data-id="${p.id}">Удалить</button>`}
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
    : emptyBlock('💳', 'Платёжных документов нет', state.deals.length ? 'Создайте платёжный документ по сделке.' : 'Сначала создайте сделку — платёжка привязывается через ID_Deal.')}
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
          ? `<button class="btn btn-outline btn-sm" data-action="unpost" data-type="waybill" data-id="${w.id}">Распровести</button>`
          : `<button class="btn btn-primary btn-sm" data-action="post" data-type="waybill" data-id="${w.id}">Провести</button>
             <button class="btn btn-outline btn-sm" data-action="edit-waybill" data-id="${w.id}">Изменить</button>
             <button class="btn btn-outline btn-sm" data-action="del-waybill" data-id="${w.id}">Удалить</button>`}
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
    : emptyBlock('📦', 'Накладных нет', state.deals.length ? 'Создайте накладную по сделке.' : 'Сначала создайте сделку — накладная привязывается через ID_Deal.')}
  </div></div>`;
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
  ${blocks || `<div class="card">${emptyBlock('📈', 'График пуст', 'Проведите платёжные документы и накладные — здесь появится материальный след сделок.', state.deals.length ? '' : demoButtonHTML)}</div>`}
  <div class="card"><div class="legend">
    <span><i style="background:#2953d1"></i> план (из платёжки)</span>
    <span><i style="background:#d92d20"></i> план просрочен</span>
    <span><i style="background:#079455"></i> факт вовремя</span>
    <span><i style="background:#dc6803"></i> факт позже плана</span>
  </div></div>`;
}

const TL_COLORS = { plan: '#2953d1', planOverdue: '#d92d20', factOk: '#079455', factLate: '#dc6803' };

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
    dots += `<circle cx="${cx.toFixed(1)}" cy="${cy}" r="6.5" fill="${TL_COLORS[e.type]}" stroke="#fff" stroke-width="2"><title>${esc(fmtDate(e.date) + ' — ' + e.label)}</title></circle>`;
  }
  return `<svg class="timeline-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Таймлайн ТМЦ">
    <line x1="${PL}" y1="${Y}" x2="${W - PR}" y2="${Y}" stroke="#e4e7ec" stroke-width="3" stroke-linecap="round"/>
    <line x1="${todayX.toFixed(1)}" y1="10" x2="${todayX.toFixed(1)}" y2="${H - 14}" stroke="#98a2b3" stroke-width="1.5" stroke-dasharray="4 4"/>
    <text x="${todayX.toFixed(1)}" y="${H - 2}" font-size="10" fill="#667085" text-anchor="middle" font-family="Inter,sans-serif">сегодня</text>
    <text x="${PL}" y="${H - 2}" font-size="10" fill="#667085" font-family="Inter,sans-serif">${fmtDate(min)}</text>
    <text x="${W - PR}" y="${H - 2}" font-size="10" fill="#667085" text-anchor="end" font-family="Inter,sans-serif">${fmtDate(max)}</text>
    ${dots}
  </svg>`;
}

/* ---------- CashFlow ---------- */
function renderCashflow() {
  const events = cashflowEvents();
  if (!events.length) {
    return `<div class="card">${emptyBlock('💰', 'Денежных событий нет', 'Проводите платёжки (факт) и реальные накладные (план) — здесь соберётся календарь выплат и график потока.', state.deals.length ? '' : demoButtonHTML)}</div>`;
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
      ${byDate[date].map((e) => calEventHTML(e, today)).join('')}
    </div>`;
  }).join('') || '<p style="color:var(--muted);font-size:13px">Открытых плановых обязательств нет — все накладные оплачены.</p>';

  const facts = events.filter((e) => !e.plan);
  const factsHTML = facts.length ? [...facts].reverse().map((e) => calEventHTML(e, today)).join('') : '<p style="color:var(--muted);font-size:13px">Фактов оплат нет.</p>';

  return `<div class="page-head"><div class="desc">Денежный след: факты из платёжек (Date_Payment_Execution) и плановые дедлайны из реальных накладных (Date_Payment_Execution_Plan). Система строит календарь выплат кредиторам и напоминаний дебиторам.</div></div>
  <div class="card"><div class="card-title">Кумулятивный денежный поток <span class="hint">сплошная — факт, пунктир — прогноз с учётом плана</span></div>${cashflowSVG(factPts, planPts, today, anchor)}</div>
  <div class="two-col">
    <div class="card"><div class="card-title">📅 Календарь плановых платежей</div>${calendar}</div>
    <div class="card"><div class="card-title">✓ Факты оплат</div>${factsHTML}</div>
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
    `<line x1="${PL}" y1="${y(v).toFixed(1)}" x2="${W - PR}" y2="${y(v).toFixed(1)}" stroke="#eef1f6" stroke-width="1"/>
     <text x="${PL - 8}" y="${(y(v) + 4).toFixed(1)}" font-size="11" fill="#667085" text-anchor="end" font-family="Inter,sans-serif">${fmtShort(v)}</text>`).join('');

  const dots = factPts.map((p) =>
    `<circle cx="${x(p.date).toFixed(1)}" cy="${y(p.cum).toFixed(1)}" r="4" fill="#2953d1" stroke="#fff" stroke-width="1.5">
      <title>${esc(fmtDate(p.date) + ' — накопленно: ' + fmtMoney(p.cum))}</title></circle>`).join('') +
    planPts.map((p) =>
    `<circle cx="${x(p.date).toFixed(1)}" cy="${y(p.cum).toFixed(1)}" r="4" fill="#98a2b3" stroke="#fff" stroke-width="1.5">
      <title>${esc(fmtDate(p.date) + ' — прогноз: ' + fmtMoney(p.cum))}</title></circle>`).join('');

  const todayX = x(today);
  return `<svg class="timeline-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="График CashFlow">
    ${gridLines}
    <line x1="${PL}" y1="${zeroY.toFixed(1)}" x2="${W - PR}" y2="${zeroY.toFixed(1)}" stroke="#c8cfdb" stroke-width="1.5" stroke-dasharray="2 3"/>
    <line x1="${todayX.toFixed(1)}" y1="${PT}" x2="${todayX.toFixed(1)}" y2="${H - PB}" stroke="#98a2b3" stroke-width="1.5" stroke-dasharray="4 4"/>
    <text x="${todayX.toFixed(1)}" y="${H - 12}" font-size="10" fill="#667085" text-anchor="middle" font-family="Inter,sans-serif">сегодня</text>
    <path d="${dFact}" fill="none" stroke="#2953d1" stroke-width="2.5" stroke-linejoin="round"/>
    ${dPlan ? `<path d="${dPlan}" fill="none" stroke="#98a2b3" stroke-width="2" stroke-dasharray="6 5" stroke-linejoin="round"/>` : ''}
    ${dots}
    <text x="${PL}" y="${H - 12}" font-size="10" fill="#667085" font-family="Inter,sans-serif">${fmtDate(min)}</text>
    <text x="${W - PR}" y="${H - 12}" font-size="10" fill="#667085" text-anchor="end" font-family="Inter,sans-serif">${fmtDate(max)}</text>
  </svg>`;
}

/* ---------- Матрица ресурсов ---------- */
function renderMatrix() {
  if (!state.deals.length) {
    return `<div class="card">${emptyBlock('▦', 'Матрица пуста', 'Создайте сделки и проведите документы — матрица покажет 6 колонок управленческого баланса по каждой сделке.', demoButtonHTML)}</div>`;
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
    return `<div class="card">${emptyBlock('🗒', 'Журнал пуст', 'Нажимайте «Провести» в платёжках и накладных — здесь фиксируется, какие управленческие регистры обновил каждый документ.')}</div>`;
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
    <div class="callout callout-grey">Данные хранятся локально в браузере (localStorage). «Экспорт» выгружает всё в JSON, «Импорт» — восстанавливает.</div>
  </div>`;
}

/* =====================================================================
   Формы
   ===================================================================== */

function dealOptions(selectedId) {
  return state.deals.map((d) =>
    `<option value="${d.id}" ${d.id === selectedId ? 'selected' : ''}>${esc(dealTitle(d))} — ${DEAL_KIND[d.kind].label}</option>`).join('');
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
        <input name="amount" type="number" min="1" step="0.01" required value="${d ? d.amount : ''}"></div>
      <div class="field"><label>ID_Deal (UUID)</label>
        <input readonly value="${d ? d.id : 'будет сгенерирован автоматически'}"></div>
      <div class="field"><label>Срок перемещения ТМЦ после оплаты, дней</label>
        <input name="shipDays" type="number" min="0" step="1" value="${d ? d.shipDays : 5}">
        <div class="note">Юридический блок: «отгрузить/поставить в течение N дней после оплаты». Из него считается Date_Material_Execution_Plan платёжек.</div></div>
      <div class="field"><label>Отсрочка платежа после перемещения ТМЦ, дней</label>
        <input name="deferDays" type="number" min="0" step="1" value="${d ? d.deferDays : 10}">
        <div class="note">Из неё считается Date_Payment_Execution_Plan накладных: факт + отсрочка.</div></div>
      <div class="field full"><label>Комментарий</label>
        <input name="comment" value="${d ? esc(d.comment || '') : ''}"></div>
      <div class="form-actions full">
        <button type="button" class="btn btn-outline" data-close>Отмена</button>
        <button type="submit" class="btn btn-primary">${d ? 'Сохранить' : 'Создать сделку'}</button>
      </div>
    </form>`, (body) => {
    body.querySelector('#frm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const name = f.get('name').trim();
      const counterparty = f.get('counterparty').trim();
      if (!name || !counterparty) { showToast('Заполните наименование и контрагента', ['Пробелы не считаются'], 'red'); return; }
      const rec = d || { id: uuid() };
      rec.name = name;
      rec.counterparty = counterparty;
      rec.kind = f.get('kind');
      rec.amount = Math.max(0, parseFloat(f.get('amount')) || 0);
      rec.shipDays = Math.max(0, parseInt(f.get('shipDays'), 10) || 0);
      rec.deferDays = Math.max(0, parseInt(f.get('deferDays'), 10) || 0);
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
        fMatPlan.value = addDays(fPayDate.value, deal.shipDays);
        note.textContent = `Рассчитано из договора: оплата + ${deal.shipDays} дн. Можно скорректировать вручную.`;
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
      rec.num = num;
      rec.dealId = deal.id;
      rec.kind = DEAL_KIND[deal.kind].payKind;
      rec.amount = parseFloat(f.get('amount')) || 0;
      rec.datePaymentExecution = f.get('datePaymentExecution');
      rec.dateMaterialPlan = f.get('dateMaterialPlan') || addDays(rec.datePaymentExecution, deal.shipDays);
      rec.comment = f.get('comment').trim();
      if (rec.amount <= 0) return;
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
        <input name="amount" type="number" min="0.01" step="0.01" required value="${defaults.amount}"></div>
      <div class="field"><label>Состав ТМЦ</label>
        <input name="goods" value="${esc(defaults.goods || '')}" placeholder="металлопрокат, 12 т"></div>
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
      rec.num = num;
      rec.dealId = deal.id;
      rec.kind = DEAL_KIND[deal.kind].wbKind;
      rec.amount = parseFloat(f.get('amount')) || 0;
      rec.goods = f.get('goods').trim();
      rec.isReal = fReal.checked;
      rec.dateMaterialFact = f.get('dateMaterialFact');
      // Is_Real = НЕТ → плановая дата оплаты не порождается (см. спецификацию)
      rec.datePaymentPlan = rec.isReal ? (f.get('datePaymentPlan') || addDays(rec.dateMaterialFact, deal.deferDays)) : null;
      rec.comment = f.get('comment').trim();
      if (rec.amount <= 0) return;
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
  const dRomashka = { id: uuid(), name: 'Договор поставки №14', counterparty: 'ООО «Ромашка»', kind: 'sale', amount: 480000, shipDays: 5, deferDays: 10, comment: 'Аванс 100%, отгрузка в течение 5 дней' };
  const dStal = { id: uuid(), name: 'Закупка металлопроката', counterparty: 'АО «СтальТрейд»', kind: 'purchase', amount: 750000, shipDays: 14, deferDays: 0, comment: 'Предоплата, поставка 14 дней' };
  const dAgro = { id: uuid(), name: 'Закупка удобрений', counterparty: 'ООО «АгроСнаб»', kind: 'purchase', amount: 320000, shipDays: 0, deferDays: 15, comment: 'Отсрочка 15 дней после приёмки' };
  const dTehno = { id: uuid(), name: 'Договор продажи №7', counterparty: 'ООО «ТехноДом»', kind: 'sale', amount: 560000, shipDays: 3, deferDays: 20, comment: 'Отсрочка 20 дней после отгрузки' };

  state = { deals: [dRomashka, dStal, dAgro, dTehno], payments: [], waybills: [], journal: [] };

  const mkPay = (deal, num, amount, dayOffset) => ({
    id: uuid(), num, dealId: deal.id, kind: DEAL_KIND[deal.kind].payKind, amount,
    datePaymentExecution: addDays(T, dayOffset),
    dateMaterialPlan: addDays(addDays(T, dayOffset), deal.shipDays),
    comment: '', posted: false,
  });
  const mkWb = (deal, num, amount, dayOffset, isReal, goods) => ({
    id: uuid(), num, dealId: deal.id, kind: DEAL_KIND[deal.kind].wbKind, amount,
    isReal, goods: goods || '',
    dateMaterialFact: addDays(T, dayOffset),
    datePaymentPlan: isReal ? addDays(addDays(T, dayOffset), deal.deferDays) : null,
    comment: '', posted: false,
  });

  // Ромашка (продажа): аванс 12 дней назад → план отгрузки −7 дн.; отгружено 300 из 480 с опозданием
  state.payments.push(mkPay(dRomashka, 'ПП-1', 480000, -12));
  state.waybills.push(mkWb(dRomashka, 'НК-1', 300000, -4, true, 'секции ограждений, 40 шт.'));
  // СтальТрейд (закупка): предоплата 6 дней назад → поставка ожидается через 8 дней (без флага)
  state.payments.push(mkPay(dStal, 'ПП-2', 750000, -6));
  // АгроСнаб (закупка): приёмка 10 дней назад → оплата через 5 дней (жёлтый флаг «скоро выплата»)
  state.waybills.push(mkWb(dAgro, 'НК-2', 320000, -10, true, 'удобрения, 8 т'));
  // ТехноДом (продажа): отгрузка 30 дней назад, оплата частичная → просроченная дебиторка
  state.waybills.push(mkWb(dTehno, 'НК-3', 560000, -30, true, 'климатическое оборудование'));
  state.payments.push(mkPay(dTehno, 'ПП-3', 200000, -8));
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
    '4 сделки, 3 платёжки, 4 накладные (одна виртуальная)',
    'Смотрите красные флаги на дашборде и изоляцию Is_Real=НЕТ в журнале',
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

  const deals = (s.deals || []).filter((d) => d && typeof d === 'object' && str(d.id) && str(d.name))
    .map((d) => ({
      id: str(d.id), name: str(d.name), counterparty: str(d.counterparty) || '—',
      kind: d.kind === 'purchase' ? 'purchase' : 'sale',
      amount: num(d.amount) || 0,
      shipDays: Math.max(0, parseInt(d.shipDays, 10) || 0),
      deferDays: Math.max(0, parseInt(d.deferDays, 10) || 0),
      comment: str(d.comment),
    }));
  const dealIds = new Set(deals.map((d) => d.id));

  const payments = (s.payments || []).filter((p) => p && typeof p === 'object' && dealIds.has(p.dealId) && num(p.amount) && isDate(p.datePaymentExecution))
    .map((p) => {
      const deal = deals.find((d) => d.id === p.dealId);
      return {
        id: str(p.id) || uuid(), num: str(p.num) || 'ПП-?', dealId: p.dealId,
        kind: DEAL_KIND[deal.kind].payKind, amount: num(p.amount),
        datePaymentExecution: p.datePaymentExecution,
        dateMaterialPlan: isDate(p.dateMaterialPlan) ? p.dateMaterialPlan : addDays(p.datePaymentExecution, deal.shipDays),
        comment: str(p.comment), posted: !!p.posted,
      };
    });

  const waybills = (s.waybills || []).filter((w) => w && typeof w === 'object' && dealIds.has(w.dealId) && num(w.amount) && isDate(w.dateMaterialFact))
    .map((w) => {
      const deal = deals.find((d) => d.id === w.dealId);
      const isReal = w.isReal !== false;
      return {
        id: str(w.id) || uuid(), num: str(w.num) || 'НК-?', dealId: w.dealId,
        kind: DEAL_KIND[deal.kind].wbKind, amount: num(w.amount), isReal,
        goods: str(w.goods), dateMaterialFact: w.dateMaterialFact,
        datePaymentPlan: isReal ? (isDate(w.datePaymentPlan) ? w.datePaymentPlan : addDays(w.dateMaterialFact, deal.deferDays)) : null,
        comment: str(w.comment), posted: !!w.posted,
      };
    });

  const journal = (Array.isArray(s.journal) ? s.journal : []).filter((j) => j && typeof j === 'object' && str(j.doc))
    .map((j) => ({ ts: str(j.ts) || new Date().toISOString(), doc: str(j.doc), deal: str(j.deal), real: j.real !== false, lines: Array.isArray(j.lines) ? j.lines.map(str) : [] }));

  return { deals, payments, waybills, journal };
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
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  window.addEventListener('hashchange', render);
  $('#modalClose').addEventListener('click', closeModal);
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
  $('#btnDemo').addEventListener('click', () => {
    if (!state.deals.length || confirm('Текущие данные будут заменены демо-сценарием. Продолжить?')) loadDemo();
  });
  $('#btnExport').addEventListener('click', exportJSON);
  $('#btnImport').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ''; });
  $('#btnWipe').addEventListener('click', () => {
    if (confirm('Удалить все данные без возможности восстановления?')) {
      state = { deals: [], payments: [], waybills: [], journal: [] };
      save(); render();
    }
  });
  render();
});
