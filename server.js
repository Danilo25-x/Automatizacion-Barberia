import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'appointments.json');
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PIN = process.env.ADMIN_PIN || '2468';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-development-secret';
const WHATSAPP_NUMBER = (process.env.WHATSAPP_NUMBER || '').replace(/\D/g, '');
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID || '';
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN || '';
const WA_GRAPH_API_VERSION = process.env.WA_GRAPH_API_VERSION || '';
const WA_TEMPLATE_LANGUAGE = process.env.WA_TEMPLATE_LANGUAGE || 'es_CO';
const WA_TEMPLATES = {
  booked: process.env.WA_TEMPLATE_BOOKED || 'cita_agendada',
  reminder: process.env.WA_TEMPLATE_REMINDER || 'recordatorio_cita',
  status: process.env.WA_TEMPLATE_STATUS || 'estado_cita',
  barber: process.env.WA_TEMPLATE_BARBER || 'aviso_barbero',
};
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Corte & Estilo';
const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || 'America/Bogota';
const OPEN_HOUR = Number(process.env.OPEN_HOUR || 9);
const CLOSE_HOUR = Number(process.env.CLOSE_HOUR || 19);
const SLOT_STEP = 30;
const BUFFER_MINUTES = 10;
const SESSION_MS = 8 * 60 * 60 * 1000;
const loginAttempts = new Map();
let processingWhatsAppQueue = false;

function whatsappCloudReady() {
  return Boolean(WA_PHONE_NUMBER_ID && WA_ACCESS_TOKEN && /^v\d+\.\d+$/.test(WA_GRAPH_API_VERSION));
}

if (process.env.NODE_ENV === 'production' && (ADMIN_PIN === '2468' || SESSION_SECRET === 'change-this-development-secret' || SESSION_SECRET.includes('replace-with-a-random-secret') || SESSION_SECRET.length < 32)) {
  console.error('Configura ADMIN_PIN y un SESSION_SECRET aleatorio de al menos 32 caracteres antes de ejecutar en producción.');
  process.exit(1);
}

const seed = {
  services: [
    { id: 'corte-clasico', name: 'Corte clásico', duration: 40, price: 25000, description: 'Corte personalizado y acabado limpio.' },
    { id: 'barba', name: 'Arreglo de barba', duration: 30, price: 18000, description: 'Perfilado, toalla caliente y cuidado.' },
    { id: 'corte-barba', name: 'Corte + barba', duration: 65, price: 38000, description: 'Un servicio completo para renovar tu estilo.' },
  ],
  barbers: [
    { id: 'andres', name: 'Andrés', daysOff: [] },
    { id: 'mateo', name: 'Mateo', daysOff: [] },
  ],
  settings: { openHour: OPEN_HOUR, closeHour: CLOSE_HOUR, closedDays: [0] },
  whatsappJobs: [],
  appointments: [],
};

await mkdir(DATA_DIR, { recursive: true });
if (!existsSync(DB_FILE)) await writeFile(DB_FILE, JSON.stringify(seed, null, 2));
let writeQueue = Promise.resolve();
let mutationQueue = Promise.resolve();
function withMutationLock(action) {
  const task = mutationQueue.then(action, action);
  mutationQueue = task.catch(() => {});
  return task;
}
async function loadDb() {
  try {
    const db = JSON.parse(await readFile(DB_FILE, 'utf8'));
    db.settings ||= structuredClone(seed.settings);
    db.barbers ||= structuredClone(seed.barbers);
    db.barbers.forEach(barber => { barber.daysOff ||= []; });
    db.appointments ||= [];
    db.whatsappJobs ||= [];
    db.services ||= structuredClone(seed.services);
    return db;
  } catch { return structuredClone(seed); }
}
function saveDb(db) {
  writeQueue = writeQueue.then(() => writeFile(DB_FILE, JSON.stringify(db, null, 2)));
  return writeQueue;
}
function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}
function cookieValue(req, name) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=').map(decodeURIComponent)).filter(x => x.length === 2));
  return cookies[name] || '';
}
function makeSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_MS })).toString('base64url');
  const sig = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function isAdmin(req) {
  const token = cookieValue(req, 'barber_session');
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = createHmac('sha256', SESSION_SECRET).update(payload).digest();
  let actual;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return false; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now(); } catch { return false; }
}
async function bodyJson(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 16_000) throw new Error('Solicitud demasiado grande.'); }
  try { return JSON.parse(raw || '{}'); } catch { throw new Error('El formato de la solicitud no es válido.'); }
}
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T12:00:00`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function minutes(value) { const [h, m] = value.split(':').map(Number); return h * 60 + m; }
function formatTime(value) { return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`; }
function businessTimeParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return Object.fromEntries(formatter.formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}
function businessDateNow() {
  const parts = businessTimeParts();
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}
function getSlots(db, date, serviceId, barberId) {
  const service = db.services.find(x => x.id === serviceId);
  const barber = db.barbers.find(x => x.id === barberId);
  if (!service || !barber) return [];
  const settings = db.settings || seed.settings;
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  if ((settings.closedDays || []).includes(weekday) || (barber.daysOff || []).includes(weekday)) return [];
  const now = businessTimeParts();
  const todayString = `${now.year}-${String(now.month).padStart(2, '0')}-${String(now.day).padStart(2, '0')}`;
  const start = settings.openHour * 60;
  const end = settings.closeHour * 60;
  const slots = [];
  for (let at = start; at + service.duration <= end; at += SLOT_STEP) {
    const past = date < todayString || (date === todayString && at <= now.hour * 60 + now.minute);
    const conflict = db.appointments.some(a => a.date === date && a.barberId === barberId && !['cancelled'].includes(a.status) && at < minutes(a.time) + a.duration + BUFFER_MINUTES && at + service.duration + BUFFER_MINUTES > minutes(a.time));
    if (!past && !conflict) slots.push(formatTime(at));
  }
  return slots;
}
function waLink(phone, text) {
  const number = (phone || WHATSAPP_NUMBER).replace(/\D/g, '');
  return number ? `https://wa.me/${number}?text=${encodeURIComponent(text)}` : '';
}
function safeAppointment(a, db) {
  const whatsappNotifications = (db.whatsappJobs || []).filter(job => job.appointmentId === a.id).map(({ type, status }) => ({ type, status }));
  return { ...a, serviceName: db.services.find(s => s.id === a.serviceId)?.name || 'Servicio', barberName: db.barbers.find(b => b.id === a.barberId)?.name || 'Barbero', whatsappNotifications };
}
function queueWhatsApp(db, appointment, type, to, template, params, sendAt = Date.now()) {
  const recipient = String(to || '').replace(/\D/g, '');
  if (!whatsappCloudReady() || recipient.length < 7) return null;
  const job = { id: randomUUID(), appointmentId: appointment.id, type, to: recipient, template, language: WA_TEMPLATE_LANGUAGE, params: params.map(value => String(value ?? '')), sendAt, status: 'pending', attempts: 0, createdAt: new Date().toISOString() };
  db.whatsappJobs.push(job);
  return job;
}
function appointmentDateText(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}
function queueAppointmentReminder(db, appointment, service, barber) {
  if (!appointment.whatsappOptIn || !whatsappCloudReady()) return null;
  const startsAt = appointmentStartEpoch(appointment.date, appointment.time);
  if (startsAt <= Date.now()) return null;
  const existing = db.whatsappJobs.find(job => job.appointmentId === appointment.id && job.type === 'reminder' && ['pending', 'sending', 'sent'].includes(job.status));
  if (existing) return existing;
  const sendAt = Math.max(Date.now(), startsAt - 90 * 60 * 1000);
  return queueWhatsApp(db, appointment, 'reminder', appointment.phone, WA_TEMPLATES.reminder, [appointment.name, BUSINESS_NAME, appointmentDateText(appointment.date), appointment.time, service.name, barber.name], sendAt);
}
function appointmentStartEpoch(date, time) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let index = 0; index < 3; index++) {
    const parts = businessTimeParts(new Date(guess));
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    guess += target - represented;
  }
  return guess;
}
function queueBookingMessages(db, appointment, service, barber) {
  if (!whatsappCloudReady()) return [];
  const dateText = appointmentDateText(appointment.date);
  const clientJobs = appointment.whatsappOptIn ? [queueWhatsApp(db, appointment, 'booking', appointment.phone, WA_TEMPLATES.booked, [appointment.name, BUSINESS_NAME, dateText, appointment.time, service.name, barber.name])] : [];
  const barberJob = barber.whatsappOptIn ? queueWhatsApp(db, appointment, 'barber', barber.phone, WA_TEMPLATES.barber, [barber.name, appointment.name, appointment.phone, service.name, dateText, appointment.time, 'Confirmada']) : null;
  const reminderJob = queueAppointmentReminder(db, appointment, service, barber);
  return [...clientJobs.filter(Boolean), barberJob, reminderJob].filter(Boolean);
}
function queueStatusMessages(db, appointment, service, barber, status) {
  const dateText = appointmentDateText(appointment.date);
  const stateText = status === 'cancelled' ? 'Cancelada' : 'Confirmada';
  const customerJob = appointment.whatsappOptIn ? queueWhatsApp(db, appointment, `customer_${status}`, appointment.phone, WA_TEMPLATES.status, [appointment.name, BUSINESS_NAME, stateText, dateText, appointment.time, service.name, barber.name]) : null;
  const barberJob = barber.whatsappOptIn ? queueWhatsApp(db, appointment, `barber_${status}`, barber.phone, WA_TEMPLATES.barber, [barber.name, appointment.name, appointment.phone, service.name, dateText, appointment.time, stateText]) : null;
  if (status === 'cancelled') for (const job of db.whatsappJobs) if (job.appointmentId === appointment.id && job.type === 'reminder' && job.status === 'pending') job.status = 'skipped';
  return [customerJob, barberJob].filter(Boolean);
}
async function sendWhatsAppTemplate(job) {
  const response = await fetch(`https://graph.facebook.com/${WA_GRAPH_API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: job.to, type: 'template', template: { name: job.template, language: { code: job.language }, components: [{ type: 'body', parameters: job.params.map(text => ({ type: 'text', text })) }] } }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error?.message || `WhatsApp respondió con estado ${response.status}.`);
    error.code = result.error?.code || response.status;
    throw error;
  }
  return result.messages?.[0]?.id || '';
}
async function processWhatsAppQueue() {
  if (!whatsappCloudReady() || processingWhatsAppQueue) return;
  processingWhatsAppQueue = true;
  try {
    for (;;) {
      const job = await withMutationLock(async () => {
        const db = await loadDb();
        const now = Date.now();
        for (const stale of db.whatsappJobs) if (stale.status === 'sending' && now - Date.parse(stale.lastAttemptAt || 0) > 2 * 60 * 1000) stale.status = 'pending';
        const next = db.whatsappJobs.find(item => item.status === 'pending' && item.sendAt <= now && item.attempts < 4);
        if (!next) return null;
        const appointment = db.appointments.find(item => item.id === next.appointmentId);
        if (!appointment || (next.type === 'reminder' && appointment.status !== 'confirmed')) { next.status = 'skipped'; await saveDb(db); return { skipped: true }; }
        next.status = 'sending';
        next.attempts += 1;
        next.lastAttemptAt = new Date(now).toISOString();
        await saveDb(db);
        return structuredClone(next);
      });
      if (!job) break;
      if (job.skipped) continue;
      let result;
      let error;
      try { result = await sendWhatsAppTemplate(job); } catch (caught) { error = caught; }
      await withMutationLock(async () => {
        const db = await loadDb();
        const current = db.whatsappJobs.find(item => item.id === job.id);
        if (!current) return;
        if (!error) {
          current.status = 'sent';
          current.sentAt = new Date().toISOString();
          current.messageId = result;
        } else {
          current.lastError = String(error.code || 'send_error').slice(0, 80);
          current.status = current.attempts >= 4 ? 'failed' : 'pending';
          current.sendAt = Date.now() + [60_000, 5 * 60_000, 20 * 60_000, 0][Math.min(current.attempts - 1, 3)];
          console.error(`WhatsApp ${current.type} job failed (${current.lastError}).`);
        }
        await saveDb(db);
      });
    }
  } finally { processingWhatsAppQueue = false; }
}
async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname, searchParams } = url;
  if (pathname.startsWith('/api/')) {
    if (req.method === 'GET' && pathname === '/api/config') {
      const db = await loadDb();
      return send(res, 200, { businessName: BUSINESS_NAME, openHour: db.settings.openHour, closeHour: db.settings.closeHour, closedDays: db.settings.closedDays, whatsappConfigured: Boolean(WHATSAPP_NUMBER), whatsappCloudEnabled: whatsappCloudReady() });
    }
    if (req.method === 'GET' && pathname === '/api/catalog') {
      const db = await loadDb();
      return send(res, 200, { services: db.services, barbers: db.barbers.map(({ id, name }) => ({ id, name })) });
    }
    if (req.method === 'GET' && pathname === '/api/availability') {
      const date = searchParams.get('date');
      if (!validDate(date)) return send(res, 400, { error: 'Selecciona una fecha válida.' });
      const db = await loadDb();
      return send(res, 200, { slots: getSlots(db, date, searchParams.get('serviceId'), searchParams.get('barberId')) });
    }
    if (req.method === 'POST' && pathname === '/api/appointments') {
      return withMutationLock(async () => {
        const input = await bodyJson(req);
        const db = await loadDb();
        const service = db.services.find(x => x.id === input.serviceId);
        const barber = db.barbers.find(x => x.id === input.barberId);
        const name = String(input.name || '').trim().slice(0, 80);
        const phone = String(input.phone || '').trim().slice(0, 30);
        if (!name || phone.replace(/\D/g, '').length < 7 || !service || !barber || !validDate(input.date) || !/^\d{2}:\d{2}$/.test(input.time || '')) return send(res, 400, { error: 'Revisa tu nombre, teléfono y los datos de la cita.' });
        if (!getSlots(db, input.date, input.serviceId, input.barberId).includes(input.time)) return send(res, 409, { error: 'Ese horario ya no está disponible. Elige otro.' });
        const appointment = { id: randomUUID(), name, phone, whatsappOptIn: input.whatsappOptIn === true, serviceId: service.id, barberId: barber.id, date: input.date, time: input.time, duration: service.duration, price: service.price, notes: String(input.notes || '').trim().slice(0, 300), status: 'confirmed', createdAt: new Date().toISOString() };
        db.appointments.push(appointment);
        const jobs = queueBookingMessages(db, appointment, service, barber);
        await saveDb(db);
        const message = `Hola, acabo de reservar en ${BUSINESS_NAME}. Soy ${name} (${phone}). Mi cita es el ${input.date} a las ${input.time}, para ${service.name} con ${barber.name}.`;
        const whatsappUrl = waLink(WHATSAPP_NUMBER || barber.phone, message);
        setImmediate(() => processWhatsAppQueue().catch(error => console.error('No se pudo procesar la cola de WhatsApp.', error.message)));
        return send(res, 201, { appointment: safeAppointment(appointment, db), whatsappUrl, whatsappCloudEnabled: whatsappCloudReady(), whatsappQueued: jobs.length });
      });
    }
    if (pathname === '/api/admin/login' && req.method === 'POST') {
      const input = await bodyJson(req);
      const ip = req.socket.remoteAddress || 'unknown';
      const attempt = loginAttempts.get(ip);
      if (attempt && attempt.until > Date.now() && attempt.count >= 5) return send(res, 429, { error: 'Demasiados intentos. Espera 10 minutos.' });
      const provided = Buffer.from(String(input.pin || ''));
      const actual = Buffer.from(ADMIN_PIN);
      if (provided.length !== actual.length || !timingSafeEqual(provided, actual)) {
        const next = !attempt || attempt.until <= Date.now() ? { count: 1, until: Date.now() + 10 * 60 * 1000 } : { ...attempt, count: attempt.count + 1 };
        loginAttempts.set(ip, next);
        return send(res, 401, { error: 'El código no es correcto.' });
      }
      loginAttempts.delete(ip);
      const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
      return send(res, 200, { ok: true }, { 'Set-Cookie': `barber_session=${makeSession()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure}` });
    }
    if (pathname.startsWith('/api/admin/')) {
      if (pathname === '/api/admin/logout' && req.method === 'POST') return send(res, 200, { ok: true }, { 'Set-Cookie': 'barber_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
      if (!isAdmin(req)) return send(res, 401, { error: 'Inicia sesión para abrir el panel.' });
      if (pathname === '/api/admin/settings' && req.method === 'PATCH') {
        return withMutationLock(async () => {
          const freshDb = await loadDb();
          const input = await bodyJson(req);
          const validDays = value => Array.isArray(value) && value.every(day => Number.isInteger(day) && day >= 0 && day <= 6);
          if (!Number.isInteger(input.openHour) || !Number.isInteger(input.closeHour) || input.openHour < 0 || input.closeHour > 24 || input.closeHour <= input.openHour || !validDays(input.closedDays) || !input.barberDaysOff || typeof input.barberDaysOff !== 'object') return send(res, 400, { error: 'Revisa las horas y los días seleccionados.' });
          for (const barber of freshDb.barbers) {
            if (!validDays(input.barberDaysOff[barber.id] || [])) return send(res, 400, { error: 'Hay un día de descanso no válido.' });
            const phone = String(input.barberPhones?.[barber.id] ?? barber.phone ?? '').replace(/\D/g, '');
            if (phone && (phone.length < 7 || phone.length > 15)) return send(res, 400, { error: 'Revisa el número internacional de cada barbero.' });
            if (input.barberNotificationsOptIn?.[barber.id] !== undefined && typeof input.barberNotificationsOptIn[barber.id] !== 'boolean') return send(res, 400, { error: 'Revisa la autorización de notificaciones del barbero.' });
          }
          freshDb.settings = { openHour: input.openHour, closeHour: input.closeHour, closedDays: [...new Set(input.closedDays)] };
          freshDb.barbers = freshDb.barbers.map(barber => ({ ...barber, daysOff: [...new Set(input.barberDaysOff[barber.id] || [])], phone: String(input.barberPhones?.[barber.id] ?? barber.phone ?? '').replace(/\D/g, ''), whatsappOptIn: input.barberNotificationsOptIn?.[barber.id] === true }));
          await saveDb(freshDb);
          return send(res, 200, { settings: freshDb.settings, barbers: freshDb.barbers.map(({ id, name, daysOff, phone, whatsappOptIn }) => ({ id, name, daysOff, phone, whatsappOptIn })) });
        });
      }
      if (pathname === '/api/admin/services/prices' && req.method === 'PATCH') {
        return withMutationLock(async () => {
          const freshDb = await loadDb();
          const input = await bodyJson(req);
          if (!input.prices || typeof input.prices !== 'object' || Array.isArray(input.prices)) return send(res, 400, { error: 'Revisa los precios.' });
          for (const service of freshDb.services) {
            const price = Number(input.prices[service.id]);
            if (!Number.isSafeInteger(price) || price < 0 || price > 100_000_000) return send(res, 400, { error: `El precio de ${service.name} no es válido.` });
          }
          freshDb.services = freshDb.services.map(service => ({ ...service, price: Number(input.prices[service.id]) }));
          await saveDb(freshDb);
          return send(res, 200, { services: freshDb.services });
        });
      }
      if (pathname === '/api/admin/whatsapp/test' && req.method === 'POST') {
        if (!whatsappCloudReady()) return send(res, 503, { error: 'Faltan credenciales de WhatsApp Cloud API en el archivo de configuración.' });
        const input = await bodyJson(req);
        const db = await loadDb();
        const barber = db.barbers.find(item => item.id === input.barberId);
        if (!barber?.phone || !barber.whatsappOptIn) return send(res, 400, { error: 'Guarda primero el número del barbero y su autorización.' });
        const params = [barber.name, 'Prueba de conexión', 'No aplica', 'Sistema de citas', appointmentDateText(businessDateNow()), '12:00', 'Prueba'];
        try {
          const messageId = await sendWhatsAppTemplate({ to: barber.phone, template: WA_TEMPLATES.barber, language: WA_TEMPLATE_LANGUAGE, params });
          return send(res, 200, { sent: true, messageId });
        } catch (error) {
          console.error(`WhatsApp test failed (${error.code || 'send_error'}).`);
          return send(res, 502, { error: `Meta no aceptó el mensaje. Revisa el token, el número y la plantilla aprobada (${String(error.code || 'error')}).` });
        }
      }
      const db = await loadDb();
      if (pathname === '/api/admin/settings' && req.method === 'GET') return send(res, 200, { settings: db.settings, barbers: db.barbers.map(({ id, name, daysOff, phone, whatsappOptIn }) => ({ id, name, daysOff, phone, whatsappOptIn })), services: db.services, whatsappCloudEnabled: whatsappCloudReady(), whatsappNumberConfigured: Boolean(WHATSAPP_NUMBER) });
      if (pathname === '/api/admin/appointments' && req.method === 'GET') {
        const items = db.appointments.map(a => safeAppointment(a, db)).sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
        return send(res, 200, { appointments: items });
      }
      const match = pathname.match(/^\/api\/admin\/appointments\/([^/]+)$/);
      if (match && req.method === 'PATCH') {
        return withMutationLock(async () => {
          const freshDb = await loadDb();
          const appt = freshDb.appointments.find(a => a.id === match[1]);
          if (!appt) return send(res, 404, { error: 'No encontramos esa cita.' });
          const input = await bodyJson(req);
          if (!['confirmed', 'completed', 'cancelled'].includes(input.status)) return send(res, 400, { error: 'Estado no válido.' });
          const previousStatus = appt.status;
          appt.status = input.status;
          let jobs = [];
          if (previousStatus !== input.status && ['confirmed', 'cancelled'].includes(input.status)) {
            const service = freshDb.services.find(item => item.id === appt.serviceId);
            const barber = freshDb.barbers.find(item => item.id === appt.barberId);
            if (service && barber) {
              jobs = queueStatusMessages(freshDb, appt, service, barber, input.status);
              if (input.status === 'confirmed') {
                const reminder = queueAppointmentReminder(freshDb, appt, service, barber);
                if (reminder && reminder.status === 'pending') jobs.push(reminder);
              }
            }
          }
          await saveDb(freshDb);
          if (jobs.length) setImmediate(() => processWhatsAppQueue().catch(error => console.error('No se pudo procesar la cola de WhatsApp.', error.message)));
          return send(res, 200, { appointment: safeAppointment(appt, freshDb) });
        });
      }
      return send(res, 404, { error: 'No encontramos esa opción.' });
    }
    return send(res, 404, { error: 'No encontramos esa dirección.' });
  }
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(ROOT, 'public', relative);
  if (!file.startsWith(path.resolve(ROOT, 'public') + path.sep)) return send(res, 403, { error: 'Acceso denegado.' });
  try {
    const content = await readFile(file);
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
    res.end(content);
  } catch { res.writeHead(404); res.end('No encontrado'); }
}

http.createServer((req, res) => {
  route(req, res).catch(error => {
    console.error(error);
    if (!res.headersSent) send(res, 500, { error: 'Ocurrió un problema. Intenta de nuevo.' });
  });
}).listen(PORT, () => console.log(`${BUSINESS_NAME} listo en http://localhost:${PORT}`));

const whatsappQueueTimer = setInterval(() => processWhatsAppQueue().catch(error => console.error('No se pudo procesar la cola de WhatsApp.', error.message)), 15_000);
whatsappQueueTimer.unref();
