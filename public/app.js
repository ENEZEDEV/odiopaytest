const $ = selector => document.querySelector(selector);
const money = cents => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
const date = value => new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const statusText = { succeeded: 'Confirmado', pending: 'Pendente', failed: 'Recusado', reserved: 'Reservado' };
const errors = { insufficient_balance: 'Saldo disponível insuficiente para este saque.', invalid_amount: 'Informe um valor entre R$ 1,00 e R$ 1.000.000,00.', session_expired: 'Sua sessão terminou. Entre novamente na demonstração.', rate_limited: 'Muitas solicitações. Aguarde um minuto e tente novamente.', invalid_csrf: 'Sua sessão precisa ser atualizada. Recarregue a página.', demo_capacity: 'Limite de sessões de demonstração atingido. Tente novamente mais tarde.' };
let state;
let csrf;
let view = 'overview';
let toastTimer;
let paymentKey;
let withdrawalKey;

function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500); }
async function api(path, body, headers = {}) {
  const response = await fetch(`/app-api/${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': csrf ?? '' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) { $('#shell').hidden = true; $('#welcome').hidden = false; }
    throw new Error(errors[data.error?.code] ?? 'Não foi possível concluir. Atualize e tente novamente.');
  }
  return data;
}
async function load() { state = await api('overview'); csrf = state.csrf; $('#welcome').hidden = true; $('#shell').hidden = false; render(); }
function cents(value) {
  if (!/^\d+([,.]\d{1,2})?$/.test(value.trim())) throw new Error('Informe o valor em reais, por exemplo: 125,50.');
  const [whole, fraction = ''] = value.trim().replace(',', '.').split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(result) || result < 100 || result > 100000000) throw new Error(errors.invalid_amount);
  return result;
}
function action(label, fn) {
  const button = el('button', label, 'row-action');
  button.addEventListener('click', async () => { button.disabled = true; try { await fn(); await load(); } catch (error) { toast(error.message); button.disabled = false; } });
  return button;
}
function renderPayments() {
  const search = $('#search').value.toLowerCase();
  const status = $('#status-filter').value;
  const method = $('#method-filter').value;
  const filtered = state.payments.filter(p => p.id.includes(search) && (status === 'all' || p.status === status) && (method === 'all' || p.method === method));
  $('#payment-rows').replaceChildren(...filtered.map(p => {
    const row = el('tr');
    const identity = el('td'); const line = el('div', undefined, 'row-id'); line.append(el('span', p.method === 'pix' ? '◇' : '▤', 'row-icon'), el('span', `#${p.id.slice(0, 8)}`)); identity.append(line); identity.title = p.id;
    const statusCell = el('td'); statusCell.append(el('span', statusText[p.status], `badge ${p.status}`));
    const actions = el('td');
    if (p.status === 'pending') actions.append(action('Simular pagamento', async () => { await api('simulate-payment', { id: p.id }); toast('Pagamento e liquidação simulados. Saldo atualizado.'); }));
    row.append(identity, el('td', p.method === 'pix' ? 'Pix' : 'Cartão'), el('td', money(p.amountCents)), el('td', money(p.netCents)), statusCell, el('td', date(p.createdAt)), actions);
    return row;
  }));
  $('#empty-payments').hidden = filtered.length > 0;
  $('#row-count').textContent = `${filtered.length} de ${state.payments.length} cobranças · até 100 mais recentes`;
}
function render() {
  const w = state.wallet;
  $('#available').textContent = $('#wallet-available').textContent = money(w.availableCents);
  $('#receivable').textContent = money(w.receivableCents);
  $('#reserved').textContent = money(w.reservedCents);
  const paid = state.payments.filter(p => p.status === 'succeeded');
  const total = paid.reduce((sum, p) => sum + p.amountCents, 0);
  $('#gross').textContent = money(total);
  $('#payment-count').textContent = `${paid.length} pagamentos confirmados`;
  $('#method-chart').replaceChildren(...['pix', 'card'].map(method => {
    const amount = paid.filter(p => p.method === method).reduce((sum, p) => sum + p.amountCents, 0);
    const row = el('div', undefined, `chart-row ${method}`); const meter = el('meter'); meter.max = Math.max(total, 1); meter.value = amount; meter.setAttribute('aria-label', `${method === 'pix' ? 'Pix' : 'Cartão'}: ${money(amount)}`);
    row.append(el('span', method === 'pix' ? 'Pix' : 'Cartão'), meter, el('span', money(amount))); return row;
  }));
  renderPayments();
  $('#withdrawal-rows').replaceChildren(...state.withdrawals.map(w => {
    const row = el('tr'); const badge = el('td'); badge.append(el('span', w.status === 'succeeded' ? 'Concluído' : w.status === 'failed' ? 'Devolvido' : 'Reservado', `badge ${w.status}`));
    const actions = el('td');
    if (w.status === 'reserved') for (const [label, status] of [['Simular sucesso', 'succeeded'], ['Simular falha', 'failed']]) actions.append(action(label, async () => { await api('simulate-withdrawal', { id: w.id, status }); toast(status === 'succeeded' ? 'Saque concluído no simulador.' : 'Falha simulada. Valor devolvido ao disponível.'); }));
    row.append(el('td', `#${w.id.slice(0, 8)}`), el('td', money(w.amountCents)), badge, el('td', date(w.createdAt)), actions); return row;
  }));
  $('#empty-withdrawals').hidden = state.withdrawals.length > 0;
}
function changeView(next) {
  view = next;
  const titles = { overview: ['Visão geral', 'Seu negócio em movimento.', 'Tudo o que você precisa acompanhar, em uma visão.'], payments: ['Cobranças', 'Cada recebimento, de perto.', 'Crie e acompanhe cobranças Pix e cartão.'], wallet: ['Carteira e saques', 'Seu saldo. Seu próximo passo.', 'Acompanhe a disponibilidade e solicite saques simulados.'], plans: ['Planos e tarifas', 'Espaço para crescer.', 'Conheça os modelos ilustrativos de tarifas.'] };
  const [name, title, description] = titles[next];
  $('#breadcrumb').textContent = name; $('#page-title').textContent = title; $('#page-description').textContent = description;
  $('#overview-view').hidden = next !== 'overview'; $('#payments-section').hidden = !['overview', 'payments'].includes(next); $('#wallet-view').hidden = next !== 'wallet'; $('#plans-view').hidden = next !== 'plans';
  $('#new-payment').hidden = next === 'plans' || next === 'wallet';
  document.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === next); button.setAttribute('aria-current', button.dataset.view === next ? 'page' : 'false'); });
}
function openPayment(method = 'pix') { paymentKey = crypto.randomUUID(); $('#payment-form').reset(); $('#payment-method').value = method; $('#payment-form .form-error').textContent = ''; $('#payment-dialog').showModal(); }
function openWithdrawal() {
  withdrawalKey = crypto.randomUUID(); $('#withdraw-form').reset(); $('#withdraw-form .form-error').textContent = '';
  $('#withdraw-balance').textContent = `Disponível para saque: ${money(state.wallet.availableCents)}`;
  $('#destination').replaceChildren(...state.destinations.map((d, i) => { const option = el('option', `Destino fictício ${i + 1} · ${d.id.slice(0, 6)}`); option.value = d.id; return option; }));
  $('#withdraw-dialog').showModal();
}
$('#enter').addEventListener('click', async () => { $('#enter').disabled = true; try { await api('demo', {}, { 'x-odiopay-demo': '1' }); await load(); } catch (error) { $('#login-error').textContent = error.message; } finally { $('#enter').disabled = false; } });
$('#logout').addEventListener('click', async () => { try { await api('logout', {}); state = null; csrf = null; $('#shell').hidden = true; $('#welcome').hidden = false; changeView('overview'); } catch (error) { toast(error.message); } });
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => changeView(button.dataset.view)));
$('#new-payment').addEventListener('click', () => openPayment()); $('#create-pix').addEventListener('click', () => openPayment());
$('#withdraw-shortcut').addEventListener('click', openWithdrawal); $('#new-withdrawal').addEventListener('click', openWithdrawal);
$('#refresh').addEventListener('click', async () => { try { await load(); toast('Dados atualizados.'); } catch (error) { toast(error.message); } });
for (const selector of ['#search', '#status-filter', '#method-filter']) $(selector).addEventListener('input', renderPayments);
document.querySelectorAll('dialog .close').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
for (const [selector, submit] of [
  ['#payment-form', async form => { const method = form.elements.method.value; await api('payments', { amountCents: cents(form.elements.amount.value), currency: 'BRL', method, ...(method === 'card' ? { cardToken: 'tok_sandbox_dashboard123456789' } : {}) }, { 'idempotency-key': paymentKey }); toast('Cobrança criada. Você já pode simular o pagamento.'); changeView('payments'); }],
  ['#withdraw-form', async form => { await api('withdrawals', { amountCents: cents(form.elements.amount.value), currency: 'BRL', destinationId: form.elements.destination.value }, { 'idempotency-key': withdrawalKey }); toast('Saque solicitado. O valor foi reservado.'); changeView('wallet'); }]
]) $(selector).addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('[type=submit]'); button.disabled = true; form.querySelector('.form-error').textContent = '';
  try { await submit(form); form.closest('dialog').close(); await load(); }
  catch (error) { form.querySelector('.form-error').textContent = error.message; }
  finally { button.disabled = false; }
});
load().catch(() => { $('#welcome').hidden = false; $('#shell').hidden = true; });
