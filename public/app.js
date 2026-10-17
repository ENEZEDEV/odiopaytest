const $ = selector => document.querySelector(selector);
const money = cents => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
const date = value => new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const statusText = { succeeded: 'Confirmado', pending: 'Pendente', failed: 'Recusado', reserved: 'Reservado', refunded: 'Estornado' };

let state;
let view = 'overview';
let toastTimer;

// Armazenamento demonstrativo local para execução resiliente sem dependência estrita do Node /app-api/
const DEMO_STORAGE_KEY = 'odiopay_demo_homologation_state';

function getDefaultDemoState() {
  return {
    csrf: 'demo-csrf-token-sandbox',
    authMode: 'demonstrativo_local', // Claramente identificado
    wallet: {
      availableCents: 342500, // R$ 3.425,00
      receivableCents: 15000, // R$ 150,00
      reservedCents: 0
    },
    payments: [
      { id: 'pay_demo_pix_901a8b', method: 'pix', amountCents: 15000, netCents: 14000, feeCents: 100, status: 'succeeded', createdAt: Date.now() - 3600000 * 2 },
      { id: 'pay_demo_card_482c1e', method: 'card', amountCents: 25000, netCents: 23963, feeCents: 1037, status: 'succeeded', createdAt: Date.now() - 3600000 * 5 },
      { id: 'pay_demo_pix_732f91', method: 'pix', amountCents: 10000, netCents: 9900, feeCents: 100, status: 'pending', createdAt: Date.now() - 3600000 * 8 },
      { id: 'pay_demo_card_118d04', method: 'card', amountCents: 8500, netCents: 8121, feeCents: 379, status: 'succeeded', createdAt: Date.now() - 3600000 * 24 }
    ],
    withdrawals: [
      { id: 'wth_demo_883a', amountCents: 50000, status: 'succeeded', createdAt: Date.now() - 3600000 * 48 }
    ],
    destinations: [
      { id: 'dest_sandbox_mp_01' },
      { id: 'dest_sandbox_mp_02' }
    ]
  };
}

function getStoredState() {
  try {
    const raw = localStorage.getItem(DEMO_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return getDefaultDemoState();
}

function saveStoredState(data) {
  try {
    localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(data));
  } catch {}
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function toast(message) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

// Cliente de API híbrido: tenta /app-api/ do backend; se indisponível (hospedagem estática),
// opera com o mock local de homologação sem quebrar a interface
async function api(path, body) {
  try {
    const res = await fetch(`/app-api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (res.ok) {
      return await res.json();
    }
  } catch {}

  // Fallback transparente para o modo demonstrativo no navegador
  if (path === 'overview' || path === 'demo') {
    return getStoredState();
  }
  if (path === 'logout') {
    return { ok: true };
  }

  throw new Error('Operação desabilitada em homologação externa (Aguardando credenciais ativas).');
}

async function load() {
  state = await api('overview');
  $('#welcome').hidden = true;
  $('#shell').hidden = false;
  render();
}

function renderPayments() {
  const search = $('#search').value.toLowerCase();
  const status = $('#status-filter').value;
  const method = $('#method-filter').value;
  const filtered = state.payments.filter(p =>
    p.id.toLowerCase().includes(search) &&
    (status === 'all' || p.status === status) &&
    (method === 'all' || p.method === method)
  );

  $('#payment-rows').replaceChildren(...filtered.map(p => {
    const row = el('tr');
    const identity = el('td');
    const line = el('div', undefined, 'row-id');
    line.append(
      el('span', p.method === 'pix' ? '◇' : '▤', 'row-icon'),
      el('span', `#${p.id.slice(0, 10)}`)
    );
    identity.append(line);
    identity.title = p.id;

    const statusCell = el('td');
    statusCell.append(el('span', statusText[p.status] || p.status, `badge ${p.status}`));

    const actions = el('td');
    const note = el('span', 'Apenas leitura', 'badge-disabled');
    actions.append(note);

    row.append(
      identity,
      el('td', p.method === 'pix' ? 'Pix' : 'Cartão'),
      el('td', money(p.amountCents)),
      el('td', money(p.netCents)),
      statusCell,
      el('td', date(p.createdAt)),
      actions
    );
    return row;
  }));

  $('#empty-payments').hidden = filtered.length > 0;
  $('#row-count').textContent = `${filtered.length} de ${state.payments.length} cobranças demonstrativas`;
}

function render() {
  const w = state.wallet;
  $('#available').textContent = $('#wallet-available').textContent = money(w.availableCents);
  $('#receivable').textContent = money(w.receivableCents);
  $('#reserved').textContent = money(w.reservedCents);

  const paid = state.payments.filter(p => p.status === 'succeeded');
  const total = paid.reduce((sum, p) => sum + p.amountCents, 0);
  $('#gross').textContent = money(total);
  $('#payment-count').textContent = `${paid.length} pagamentos demonstrativos`;

  $('#method-chart').replaceChildren(...['pix', 'card'].map(method => {
    const amount = paid.filter(p => p.method === method).reduce((sum, p) => sum + p.amountCents, 0);
    const row = el('div', undefined, `chart-row ${method}`);
    const meter = el('meter');
    meter.max = Math.max(total, 1);
    meter.value = amount;
    meter.setAttribute('aria-label', `${method === 'pix' ? 'Pix' : 'Cartão'}: ${money(amount)}`);
    row.append(el('span', method === 'pix' ? 'Pix' : 'Cartão'), meter, el('span', money(amount)));
    return row;
  }));

  renderPayments();

  $('#withdrawal-rows').replaceChildren(...state.withdrawals.map(w => {
    const row = el('tr');
    const badge = el('td');
    badge.append(el('span', w.status === 'succeeded' ? 'Concluído' : w.status === 'failed' ? 'Devolvido' : 'Reservado', `badge ${w.status}`));
    const actions = el('td');
    actions.append(el('span', 'Demonstrativo', 'badge-disabled'));
    row.append(el('td', `#${w.id.slice(0, 10)}`), el('td', money(w.amountCents)), badge, el('td', date(w.createdAt)), actions);
    return row;
  }));

  $('#empty-withdrawals').hidden = state.withdrawals.length > 0;
}

function changeView(next) {
  view = next;
  const titles = {
    overview: ['Visão geral', 'Seu negócio em movimento.', 'Tudo o que você precisa acompanhar, em uma visão demonstrativa.'],
    payments: ['Cobranças', 'Cada recebimento, de perto.', 'Acompanhamento demonstrativo de cobranças Pix e cartão.'],
    wallet: ['Carteira e saques', 'Seu saldo. Seu próximo passo.', 'Acompanhe a disponibilidade demonstrativa e histórico de saques.'],
    plans: ['Planos e tarifas', 'Espaço para crescer.', 'Conheça os modelos ilustrativos de tarifas calculadas no servidor.']
  };
  const [name, title, description] = titles[next] || titles.overview;
  $('#breadcrumb').textContent = name;
  $('#page-title').textContent = title;
  $('#page-description').textContent = description;

  $('#overview-view').hidden = next !== 'overview';
  $('#payments-section').hidden = !['overview', 'payments'].includes(next);
  $('#wallet-view').hidden = next !== 'wallet';
  $('#plans-view').hidden = next !== 'plans';

  document.querySelectorAll('[data-view]').forEach(button => {
    const isActive = button.dataset.view === next;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-current', isActive ? 'page' : 'false');
  });
}

function notifyDisabled() {
  toast('Operações financeiras externas estão desabilitadas em homologação. Nenhuma transação bancária real é permitida.');
}

// Inicialização de eventos
$('#enter').addEventListener('click', async () => {
  $('#enter').disabled = true;
  try {
    state = getStoredState();
    $('#welcome').hidden = true;
    $('#shell').hidden = false;
    render();
    toast('Painel de homologação carregado em modo demonstrativo.');
  } catch (error) {
    $('#login-error').textContent = error.message;
  } finally {
    $('#enter').disabled = false;
  }
});

$('#logout').addEventListener('click', () => {
  state = null;
  $('#shell').hidden = true;
  $('#welcome').hidden = false;
  changeView('overview');
});

document.querySelectorAll('[data-view]').forEach(button => {
  button.addEventListener('click', () => changeView(button.dataset.view));
});

// Ações financeiras desabilitadas
$('#new-payment').addEventListener('click', notifyDisabled);
$('#create-pix').addEventListener('click', notifyDisabled);
$('#withdraw-shortcut').addEventListener('click', notifyDisabled);
$('#new-withdrawal').addEventListener('click', notifyDisabled);

$('#refresh').addEventListener('click', () => {
  render();
  toast('Dados demonstrativos atualizados.');
});

for (const selector of ['#search', '#status-filter', '#method-filter']) {
  $(selector).addEventListener('input', renderPayments);
}

// Inicialização automática se já logado ou carregar na tela inicial
load().catch(() => {
  $('#welcome').hidden = false;
  $('#shell').hidden = true;
});
