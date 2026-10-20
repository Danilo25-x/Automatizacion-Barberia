const $ = selector => document.querySelector(selector);
const byId = id => document.getElementById(id);
const money = amount => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(amount);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const form = byId('booking-form');
const serviceSelect = byId('service');
const barberSelect = byId('barber');
const dateInput = byId('date');
const timeInput = byId('time');
let catalog = { services: [], barbers: [] };
let business = { businessName: 'Corte & Estilo', openHour: 9, closeHour: 19, whatsappConfigured: false };
let selectedSlot = '';
let slotRequest = 0;
let adminPollTimer;
let knownAppointmentIds = new Set();
let adminDate = localDate();
let adminBarber = 'all';
let adminSettings = { openHour: 9, closeHour: 19, closedDays: [0] };
let adminBarbers = [];
let adminServices = [];
let adminWhatsappEnabled = false;

function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function selectedService() { return catalog.services.find(item => item.id === serviceSelect.value); }
function setMessage(message, kind = 'error') {
  const target = byId('form-message');
  target.textContent = message;
  target.style.color = kind === 'success' ? '#4d8c61' : '#aa5146';
}
function renderSummary() {
  const service = selectedService();
  const barber = catalog.barbers.find(item => item.id === barberSelect.value);
  const slot = selectedSlot;
  const text = [service?.name, barber?.name, dateInput.value, slot].filter(Boolean);
  byId('summary').firstElementChild.innerHTML = text.length ? text.map(escapeHtml).join(' <span aria-hidden="true">·</span> ') : 'Selecciona servicio y horario';
  byId('summary-price').textContent = service ? money(service.price) : '';
}
async function loadCatalog() {
  const [configResponse, catalogResponse] = await Promise.all([fetch('/api/config'), fetch('/api/catalog')]);
  business = await configResponse.json();
  catalog = await catalogResponse.json();
  document.title = `Reservas | ${business.businessName}`;
  $('#brand-name').innerHTML = `${escapeHtml(business.businessName).toUpperCase()}<small>BARBERÍA · BOGOTÁ</small>`;
  byId('whatsapp-consent-text').textContent = `Acepto recibir de ${business.businessName} por WhatsApp la confirmación y el recordatorio de esta cita. Puedo retirar esta autorización contactando a la barbería.`;
  serviceSelect.innerHTML = '<option value="">Elige un servicio</option>' + catalog.services.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${money(item.price)}</option>`).join('');
  barberSelect.innerHTML = '<option value="">Elige a tu barbero</option>' + catalog.barbers.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
  dateInput.min = localDate();
  dateInput.value = localDate();
  byId('year').textContent = new Date().getFullYear();
  renderServices();
}
function renderServices() {
  byId('service-list').innerHTML = catalog.services.map((service, index) => `<article class="service-card"><span class="service-index">0${index + 1}</span><h3>${escapeHtml(service.name)}</h3><p>${escapeHtml(service.description)}</p><div class="service-bottom"><strong>${money(service.price)}</strong><span>◷ ${service.duration} min</span></div></article>`).join('');
}
async function loadSlots() {
  selectedSlot = '';
  timeInput.value = '';
  renderSummary();
  const container = byId('slots');
  if (!dateInput.value || !serviceSelect.value || !barberSelect.value) {
    container.innerHTML = '<span class="slot-hint">Primero elige servicio, barbero y fecha</span>';
    return;
  }
  const request = ++slotRequest;
  container.innerHTML = '<span class="slot-loading">Buscando espacios disponibles…</span>';
  try {
    const query = new URLSearchParams({ date: dateInput.value, serviceId: serviceSelect.value, barberId: barberSelect.value });
    const response = await fetch(`/api/availability?${query}`);
    const { slots = [] } = await response.json();
    if (request !== slotRequest) return;
    if (!slots.length) { container.innerHTML = '<span class="slot-empty">No hay horarios disponibles ese día. Prueba otra fecha o barbero.</span>'; return; }
    container.innerHTML = slots.map(slot => `<button type="button" class="slot-button" data-time="${slot}">${slot}</button>`).join('');
  } catch { container.innerHTML = '<span class="slot-empty">No pudimos consultar los horarios. Intenta de nuevo.</span>'; }
}
byId('slots').addEventListener('click', event => {
  const button = event.target.closest('[data-time]');
  if (!button) return;
  selectedSlot = button.dataset.time;
  timeInput.value = selectedSlot;
  byId('slots').querySelectorAll('.slot-button').forEach(item => item.classList.toggle('selected', item === button));
  renderSummary();
});
serviceSelect.addEventListener('change', loadSlots);
barberSelect.addEventListener('change', loadSlots);
dateInput.addEventListener('change', loadSlots);

form.addEventListener('submit', async event => {
  event.preventDefault();
  setMessage('');
  if (!form.reportValidity()) return;
  const button = byId('submit-booking');
  button.disabled = true;
  button.innerHTML = 'Guardando tu espacio…';
  const payload = { serviceId: serviceSelect.value, barberId: barberSelect.value, date: dateInput.value, time: timeInput.value, name: byId('name').value, phone: byId('phone').value, notes: byId('notes').value, whatsappOptIn: byId('whatsapp-consent').checked };
  try {
    const response = await fetch('/api/appointments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No pudimos guardar la cita.');
    const service = selectedService();
    const barber = catalog.barbers.find(item => item.id === barberSelect.value);
    byId('success-copy').textContent = `${payload.name}, tu cita para ${service.name} con ${barber.name} quedó confirmada el ${payload.date} a las ${payload.time}.${result.whatsappCloudEnabled && payload.whatsappOptIn ? ' Dejamos preparada la confirmación y el recordatorio por WhatsApp.' : ' Si quieres, puedes avisar a la barbería por WhatsApp.'}`;
    const whatsapp = byId('whatsapp-link');
    if (result.whatsappUrl) { whatsapp.href = result.whatsappUrl; whatsapp.classList.remove('hidden'); }
    else whatsapp.classList.add('hidden');
    $('#success-dialog').showModal();
    form.reset();
    dateInput.value = localDate();
    await loadSlots();
  } catch (error) {
    setMessage(error.message);
    await loadSlots();
  } finally {
    button.disabled = false;
    button.innerHTML = 'Confirmar mi cita <span>↗</span>';
  }
});

const adminDialog = byId('admin-dialog');
const adminContent = byId('admin-content');
function showLogin(message = '') {
  adminContent.innerHTML = `<form class="admin-login" id="admin-login"><span class="eyebrow">PANEL PRIVADO</span><h2>Gestión de citas</h2><p>Ingresa el código de administración para ver la agenda y actualizar los estados.</p><label>Código de acceso<input id="admin-pin" type="password" inputmode="numeric" autocomplete="current-password" placeholder="Tu código" required></label><p class="form-message">${escapeHtml(message)}</p><button class="button button-primary button-full" type="submit">Entrar al panel <span>↗</span></button></form>`;
  byId('admin-login').addEventListener('submit', async event => {
    event.preventDefault();
    const response = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: byId('admin-pin').value }) });
    const result = await response.json();
    if (!response.ok) return showLogin(result.error || 'No pudimos iniciar sesión.');
    await showDashboard(true);
    startAdminPolling();
  });
}
function dateLabel(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('es-CO', { day: '2-digit', month: 'short' }).format(new Date(year, month - 1, day));
}
const statusLabel = { confirmed: 'Confirmada', completed: 'Atendida', cancelled: 'Cancelada' };
function notificationState() {
  const button = byId('enable-notifications');
  if (!button) return;
  const supported = 'Notification' in window;
  const active = supported && Notification.permission === 'granted' && localStorage.getItem('barberAlerts') === 'on';
  button.textContent = active ? 'Desactivar avisos' : 'Activar avisos';
  button.classList.toggle('notification-on', active);
}
function notifyNewAppointments(appointments) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || localStorage.getItem('barberAlerts') !== 'on') return;
  for (const item of appointments) {
    new Notification('Nueva cita agendada', { body: `${item.name} · ${item.date} a las ${item.time} · ${item.serviceName}`, tag: item.id });
  }
}
function showNewAppointmentToast(appointments) {
  let toast = byId('admin-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'admin-toast';
    toast.className = 'admin-toast';
    adminContent.prepend(toast);
  }
  toast.textContent = appointments.length === 1 ? (appointments[0].time ? `Nueva cita: ${appointments[0].name} · ${appointments[0].time}` : appointments[0].name) : `${appointments.length} citas nuevas en la agenda`;
  toast.classList.add('visible');
  window.setTimeout(() => toast.classList.remove('visible'), 6000);
}
function renderDashboard(appointments) {
  const today = localDate();
  const upcoming = appointments.filter(item => item.date >= today && item.status !== 'cancelled').length;
  const todayCount = appointments.filter(item => item.date === today && item.status !== 'cancelled').length;
  const dayAppointments = appointments.filter(item => item.date === adminDate && (adminBarber === 'all' || item.barberId === adminBarber)).sort((a, b) => a.time.localeCompare(b.time));
  const selectedDateLabel = new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${adminDate}T12:00:00`));
  const weekdays = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const grouped = dayAppointments.reduce((groups, item) => { (groups[item.time] ||= []).push(item); return groups; }, {});
  const timeline = Object.entries(grouped).map(([time, items]) => `<div class="agenda-row"><div class="agenda-time">${escapeHtml(time)}<span></span></div><div class="agenda-cards">${items.map(item => `<article class="agenda-card status-${escapeHtml(item.status)}"><div class="agenda-card-main"><div><span class="agenda-state">${escapeHtml(statusLabel[item.status] || item.status)}</span><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.serviceName)} <span>·</span> ${escapeHtml(item.duration)} min</p></div><div class="agenda-card-time">${escapeHtml(item.time)}<small>con ${escapeHtml(item.barberName)}</small></div></div><div class="agenda-card-details"><span>☎ ${escapeHtml(item.phone)}</span>${item.notes ? `<span>Nota: ${escapeHtml(item.notes)}</span>` : ''}<label>Estado<select aria-label="Estado de ${escapeHtml(item.name)}" data-status-id="${escapeHtml(item.id)}"><option value="confirmed" ${item.status === 'confirmed' ? 'selected' : ''}>Confirmada</option><option value="completed" ${item.status === 'completed' ? 'selected' : ''}>Atendida</option><option value="cancelled" ${item.status === 'cancelled' ? 'selected' : ''}>Cancelada</option></select></label></div></article>`).join('')}</div></div>`).join('');
  adminContent.innerHTML = `<div class="admin-inner"><div class="admin-title"><div><span class="eyebrow">${escapeHtml(business.businessName).toUpperCase()}</span><h2>Agenda de la barbería</h2></div><div class="admin-actions"><button class="admin-notify" id="enable-notifications">Activar avisos</button><button class="admin-logout" id="admin-logout">Cerrar sesión</button></div></div><div class="admin-stats"><div class="admin-stat">Citas próximas<strong>${upcoming}</strong></div><div class="admin-stat">Hoy<strong>${todayCount}</strong></div><div class="admin-stat">Total<strong>${appointments.length}</strong></div></div><section class="day-agenda"><div class="day-agenda-header"><div><span class="eyebrow">CALENDARIO DIARIO</span><h3>${escapeHtml(selectedDateLabel)}</h3><span class="day-count">${dayAppointments.length} ${dayAppointments.length === 1 ? 'cita' : 'citas'}${adminBarber !== 'all' ? ' · barbero seleccionado' : ''}</span></div><div class="agenda-controls"><button class="agenda-nav" id="day-prev" aria-label="Día anterior">‹</button><input id="agenda-date" type="date" value="${escapeHtml(adminDate)}" aria-label="Fecha de la agenda"><button class="agenda-nav" id="day-next" aria-label="Día siguiente">›</button><button class="agenda-today" id="day-today">Hoy</button></div></div><label class="agenda-filter">Ver barbero<select id="agenda-barber"><option value="all">Todos</option>${catalog.barbers.map(item => `<option value="${escapeHtml(item.id)}" ${adminBarber === item.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></label><div class="agenda-timeline">${timeline || `<div class="admin-empty agenda-empty"><span>✦</span><strong>Un día libre para empezar.</strong><span>No hay citas para esta fecha${adminBarber !== 'all' ? ' con este barbero' : ''}.</span></div>`}</div><p class="agenda-live"><span class="status-dot"></span> Agenda actualizada automáticamente cada 20 segundos</p></section><details class="hours-settings"><summary>Configurar horario y días de descanso</summary><form id="hours-form"><div class="hours-range"><label>Abre a las<select name="openHour">${Array.from({length:24},(_,hour)=>`<option value="${hour}" ${adminSettings.openHour===hour?'selected':''}>${String(hour).padStart(2,'0')}:00</option>`).join('')}</select></label><label>Cierra a las<select name="closeHour">${Array.from({length:25},(_,hour)=>`<option value="${hour}" ${adminSettings.closeHour===hour?'selected':''}>${String(hour).padStart(2,'0')}:00</option>`).join('')}</select></label></div><fieldset class="day-checks"><legend>Días que cierra toda la barbería</legend>${weekdays.map((day,index)=>`<label><input type="checkbox" name="closedDays" value="${index}" ${adminSettings.closedDays.includes(index)?'checked':''}><span>${day}</span></label>`).join('')}</fieldset>${adminBarbers.map(barber=>`<fieldset class="day-checks"><legend>Descanso de ${escapeHtml(barber.name)}</legend>${weekdays.map((day,index)=>`<label><input type="checkbox" name="daysOff-${escapeHtml(barber.id)}" value="${index}" ${(barber.daysOff||[]).includes(index)?'checked':''}><span>${day}</span></label>`).join('')}</fieldset>`).join('')}<div class="hours-save-row"><span id="hours-message" role="status"></span><button class="button button-primary" type="submit">Guardar horario</button></div></form></details></div>`;
  const barberPhones = adminBarbers.map(barber => `<div class="barber-phone"><label>WhatsApp personal de ${escapeHtml(barber.name)}<small>Incluye el código de país, sin +</small><input type="tel" name="phone-${escapeHtml(barber.id)}" value="${escapeHtml(barber.phone || '')}" placeholder="573001234567" maxlength="15"></label><label class="staff-consent"><input type="checkbox" name="notify-${escapeHtml(barber.id)}" ${barber.whatsappOptIn ? 'checked' : ''}><span>Autorizó recibir avisos internos por WhatsApp</span></label><div class="wa-test-row"><button class="admin-notify" type="button" data-wa-test="${escapeHtml(barber.id)}">Probar mensaje</button><span class="wa-test-result" data-wa-result="${escapeHtml(barber.id)}" role="status"></span></div></div>`).join('');
  byId('hours-form').querySelector('.hours-save-row').insertAdjacentHTML('beforebegin', `<div class="barber-phone-list">${barberPhones}</div><p class="whatsapp-connection ${adminWhatsappEnabled ? 'connected' : ''}">${adminWhatsappEnabled ? 'Credenciales de WhatsApp Cloud API configuradas. Puedes probar el envío a cada barbero.' : 'WhatsApp Business aún no está configurado. Completa las credenciales del servidor para enviar avisos automáticos.'}</p>`);
  const priceEditor = `<details class="hours-settings price-settings"><summary>Editar precios de los servicios</summary><form id="prices-form">${adminServices.map(service => `<label class="price-row"><span><strong>${escapeHtml(service.name)}</strong><small>${escapeHtml(service.duration)} min</small></span><span class="price-input"><span>$</span><input type="number" min="0" max="100000000" step="1000" name="price-${escapeHtml(service.id)}" value="${escapeHtml(service.price)}" required></span></label>`).join('')}<div class="hours-save-row"><span id="prices-message" role="status"></span><button class="button button-primary" type="submit">Guardar precios</button></div></form></details>`;
  byId('hours-form').closest('.hours-settings').insertAdjacentHTML('afterend', priceEditor);
  for (const appointment of dayAppointments) {
    if (!appointment.whatsappNotifications?.length) continue;
    const select = adminContent.querySelector(`[data-status-id="${CSS.escape(appointment.id)}"]`);
    const details = select?.closest('.agenda-card-details');
    if (!details) continue;
    const badges = appointment.whatsappNotifications.map(item => {
      const label = item.type === 'booking' ? 'Cliente: confirmación' : item.type === 'reminder' ? 'Cliente: recordatorio' : item.type.startsWith('barber') ? 'Barbero: aviso' : 'Cliente: estado';
      const state = item.status === 'sent' ? 'Aceptado' : item.status === 'pending' ? (item.type === 'reminder' ? 'Programado' : 'En cola') : item.status === 'sending' ? 'Enviando' : item.status === 'failed' ? 'Falló' : 'Omitido';
      return `<span class="wa-status-chip ${item.status === 'failed' ? 'failed' : ''}">${escapeHtml(label)} · ${escapeHtml(state)}</span>`;
    }).join('');
    details.insertAdjacentHTML('beforeend', `<div class="wa-status-list">${badges}</div>`);
  }
  notificationState();
  byId('admin-logout').addEventListener('click', async () => {
    clearInterval(adminPollTimer);
    await fetch('/api/admin/logout', { method: 'POST' });
    showLogin('');
  });
  const changeDay = amount => {
    const date = new Date(`${adminDate}T12:00:00`);
    date.setDate(date.getDate() + amount);
    adminDate = localDate(date);
    renderDashboard(appointments);
  };
  byId('day-prev').addEventListener('click', () => changeDay(-1));
  byId('day-next').addEventListener('click', () => changeDay(1));
  byId('day-today').addEventListener('click', () => { adminDate = localDate(); renderDashboard(appointments); });
  byId('agenda-date').addEventListener('change', event => { adminDate = event.target.value || localDate(); renderDashboard(appointments); });
  byId('agenda-barber').addEventListener('change', event => { adminBarber = event.target.value; renderDashboard(appointments); });
  byId('hours-form').addEventListener('submit', async event => {
    event.preventDefault();
    const settingsForm = event.currentTarget;
    const button = settingsForm.querySelector('button[type="submit"]');
    const message = byId('hours-message');
    const payload = {
      openHour: Number(settingsForm.elements.openHour.value),
      closeHour: Number(settingsForm.elements.closeHour.value),
      closedDays: [...settingsForm.querySelectorAll('[name="closedDays"]:checked')].map(input => Number(input.value)),
      barberDaysOff: Object.fromEntries(adminBarbers.map(barber => [barber.id, [...settingsForm.querySelectorAll(`[name="daysOff-${CSS.escape(barber.id)}"]:checked`)].map(input => Number(input.value))])),
      barberPhones: Object.fromEntries(adminBarbers.map(barber => [barber.id, settingsForm.elements[`phone-${barber.id}`].value])),
      barberNotificationsOptIn: Object.fromEntries(adminBarbers.map(barber => [barber.id, settingsForm.elements[`notify-${barber.id}`].checked])),
    };
    if (payload.closeHour <= payload.openHour) { message.textContent = 'La hora de cierre debe ser posterior a la apertura.'; return; }
    button.disabled = true;
    message.textContent = 'Guardando…';
    const response = await fetch('/api/admin/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) { message.textContent = result.error || 'No pudimos guardar el horario.'; button.disabled = false; return; }
    message.textContent = 'Horario guardado.';
    await showDashboard(false);
  });
  byId('prices-form').addEventListener('submit', async event => {
    event.preventDefault();
    const priceForm = event.currentTarget;
    const button = priceForm.querySelector('button[type="submit"]');
    const message = byId('prices-message');
    const prices = Object.fromEntries(adminServices.map(service => [service.id, Number(priceForm.elements[`price-${service.id}`].value)]));
    if (Object.values(prices).some(price => !Number.isSafeInteger(price) || price < 0)) { message.textContent = 'Escribe un precio válido en pesos.'; return; }
    button.disabled = true;
    message.textContent = 'Guardando…';
    const response = await fetch('/api/admin/services/prices', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prices }) });
    const result = await response.json();
    if (!response.ok) { message.textContent = result.error || 'No pudimos guardar los precios.'; button.disabled = false; return; }
    await showDashboard(false);
  });
  byId('enable-notifications').addEventListener('click', async () => {
    if (!('Notification' in window)) { showNewAppointmentToast([{ name: 'Este navegador no permite avisos.' }]); return; }
    if (Notification.permission === 'granted' && localStorage.getItem('barberAlerts') === 'on') {
      localStorage.removeItem('barberAlerts');
      notificationState();
      return;
    }
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (permission === 'granted') localStorage.setItem('barberAlerts', 'on');
    else localStorage.removeItem('barberAlerts');
    notificationState();
    if (permission !== 'granted') showNewAppointmentToast([{ name: 'Permite los avisos del navegador para activarlos.' }]);
  });
  adminContent.querySelectorAll('[data-wa-test]').forEach(button => button.addEventListener('click', async () => {
    const resultText = adminContent.querySelector(`[data-wa-result="${CSS.escape(button.dataset.waTest)}"]`);
    button.disabled = true;
    resultText.textContent = 'Enviando…';
    const response = await fetch('/api/admin/whatsapp/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ barberId: button.dataset.waTest }) });
    const result = await response.json();
    resultText.textContent = response.ok ? 'Meta aceptó el mensaje.' : (result.error || 'No se pudo enviar.');
    resultText.classList.toggle('success', response.ok);
    button.disabled = false;
  }));
  adminContent.querySelectorAll('[data-status-id]').forEach(select => select.addEventListener('change', async () => {
    select.disabled = true;
    const response = await fetch(`/api/admin/appointments/${encodeURIComponent(select.dataset.statusId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: select.value }) });
    await showDashboard(false);
  }));
}
async function showDashboard(initial = false) {
  const [response, settingsResponse] = await Promise.all([fetch('/api/admin/appointments'), fetch('/api/admin/settings')]);
  const data = await response.json();
  const settingsData = await settingsResponse.json();
  if (response.status === 401 || settingsResponse.status === 401) { showLogin(data.error || settingsData.error); return false; }
  adminSettings = settingsData.settings;
  adminBarbers = settingsData.barbers;
  adminServices = settingsData.services;
  adminWhatsappEnabled = settingsData.whatsappCloudEnabled;
  const appointments = data.appointments || [];
  const incoming = initial ? [] : appointments.filter(item => !knownAppointmentIds.has(item.id));
  if (initial) { knownAppointmentIds = new Set(appointments.map(item => item.id)); adminDate = localDate(); adminBarber = 'all'; }
  knownAppointmentIds = new Set(appointments.map(item => item.id));
  renderDashboard(appointments);
  if (incoming.length) { showNewAppointmentToast(incoming); notifyNewAppointments(incoming); }
  return true;
}
function startAdminPolling() {
  clearInterval(adminPollTimer);
  adminPollTimer = window.setInterval(() => {
    if (adminDialog.open) showDashboard(false).catch(() => {});
  }, 20000);
}
function openAdmin() { adminDialog.showModal(); showDashboard(true).then(authorized => { if (authorized) startAdminPolling(); }).catch(() => showLogin('No pudimos cargar la agenda.')); }
byId('admin-open').addEventListener('click', openAdmin);
byId('admin-footer').addEventListener('click', openAdmin);
byId('admin-close').addEventListener('click', () => { clearInterval(adminPollTimer); adminDialog.close(); });
adminDialog.addEventListener('close', () => clearInterval(adminPollTimer));
byId('success-close').addEventListener('click', () => byId('success-dialog').close());
byId('done-button').addEventListener('click', () => byId('success-dialog').close());
for (const dialog of [adminDialog, byId('success-dialog')]) dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });

loadCatalog().then(loadSlots).catch(() => { byId('service-list').innerHTML = '<p>No pudimos cargar los servicios. Actualiza la página para intentarlo de nuevo.</p>'; });
