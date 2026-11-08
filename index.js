import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing');
const apiBase = `https://api.telegram.org/bot${token}`;
const videoUrl = process.env.DEMO_VIDEO_URL || '';
const externalUrl = process.env.DEMO_EXTERNAL_URL || '';
const statePath = resolve('state.json');
let offset = 0;
let state = { progress: {}, subs: {}, lists: {}, files: {} };
const sessions = new Map();

try { state = { ...state, ...JSON.parse(await readFile(statePath, 'utf8')) }; } catch {}

async function save() {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(`${statePath}.tmp`, JSON.stringify(state), 'utf8');
  await rename(`${statePath}.tmp`, statePath);
}
async function tg(method, body) {
  const r = await fetch(`${apiBase}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.description}`);
  return j.result;
}
function esc(v) { return String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
function cb(text, data) { return { text, callback_data: data }; }
function kb(rows) { return { inline_keyboard: rows }; }
function menu(user) {
  const has = Boolean(state.progress[user]);
  return kb([[cb('🔎 Найти аниме', 'search')], ...(has ? [[cb('⏯ Продолжить', 'continue'), cb('🔔 Подписки', 'subs')]] : [[cb('🔔 Подписки', 'subs')]]), [cb('🗓 Календарь', 'calendar'), cb('📚 Мои списки', 'lists')], [cb('⚙️ Настройки', 'settings')]]);
}
const titles = [
  { id: 'demon', title: 'Клинок, рассекающий демонов', alt: 'Demon Slayer: Kimetsu no Yaiba', year: 2019, status: 'Завершён', aliases: ['клинок', 'demon slayer', 'kimetsu'], genres: 'Экшен, Фэнтези', eps: 8, translations: [['dub', 'Демо-озвучка'], ['sub', 'Демо-субтитры']] },
  { id: 'pharmacist', title: 'Монолог фармацевта', alt: 'The Apothecary Diaries', year: 2023, status: 'Онгоинг', aliases: ['фармацевт', 'apothecary', 'kusuriya'], genres: 'Детектив, Драма', eps: 9, translations: [['dub', 'Демо-озвучка']] },
];
function find(id) { return titles.find(x => x.id === id); }
function search(q) { const n = q.toLocaleLowerCase('ru').replaceAll('ё', 'е'); return titles.filter(x => [x.title, x.alt, ...x.aliases].join(' ').toLocaleLowerCase('ru').includes(n)); }
function titleText(t) { return `<b>${esc(t.title)}</b>\n<i>${esc(t.alt)}</i>\n${t.year} • TV • ${t.status}\nСерии: ${t.eps}\nЖанры: ${esc(t.genres)}\n\nВыбери действие:`; }
function titleKb(t, user) { return kb([[cb('▶️ Смотреть', `watch:${t.id}`)], [cb(state.subs[`${user}:${t.id}`] ? '🔕 Отписаться' : '🔔 Подписаться', state.subs[`${user}:${t.id}`] ? `unsub:${t.id}` : `sub:${t.id}`), cb('＋ В список', `list:${t.id}`)], [cb('‹ В меню', 'menu')]]); }
function episodes(t, tr) { const rows = []; for (let i = 1; i <= t.eps; i += 4) rows.push([...(Array.from({ length: Math.min(4, t.eps - i + 1) }, (_, j) => cb(String(i + j), `ep:${t.id}:${tr}:${i + j}`)))]); rows.push([cb('Сменить озвучку', `watch:${t.id}`), cb('К тайтлу', `title:${t.id}`)]); return kb(rows); }
async function send(chat, text, markup) { return tg('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: markup }); }
async function edit(chat, id, text, markup) { return tg('editMessageText', { chat_id: chat, message_id: id, text, parse_mode: 'HTML', reply_markup: markup }); }
async function start(chat, user) { return send(chat, `<b>Привет!</b>\n\nНайди аниме, выбери озвучку и серию. Прогресс сохранится автоматически.`, menu(user)); }
async function deliver(chat, user, t, tr, ep) {
  const key = `${t.id}:${tr}:${ep}`; const source = state.files[key] || videoUrl;
  const markup = kb([[cb('✓ Просмотрено', `watched:${t.id}:${tr}:${ep}`), ...(Number(ep) < t.eps ? [cb('Следующая ›', `ep:${t.id}:${tr}:${Number(ep) + 1}`)] : [])], [cb('Сменить озвучку', `watch:${t.id}`)], ...(externalUrl ? [[{ text: '▶️ Смотреть у источника', url: externalUrl }]] : []), [cb('К тайтлу', `title:${t.id}`)]]);
  if (!source) return send(chat, 'Видео для этого демо ещё не подключено. После добавления разрешённого MP4 бот будет отправлять серию прямо в чат.', markup);
  await send(chat, `Готовлю видео: серия ${ep}, 720p…`);
  const r = await tg('sendVideo', { chat_id: chat, video: source, caption: `<b>${esc(t.title)}</b>\nСерия ${ep} • 720p\nОзвучка: ${esc(tr)}`, parse_mode: 'HTML', supports_streaming: true, reply_markup: markup });
  if (r.video?.file_id) state.files[key] = r.video.file_id;
  state.progress[user] = { title: t.id, tr, ep: Number(ep) }; await save();
}
async function callback(q) {
  const [action, a, b, c] = String(q.data || '').split(':'); const chat = q.message?.chat.id; const mid = q.message?.message_id; const user = q.from.id;
  await tg('answerCallbackQuery', { callback_query_id: q.id, text: action === 'ep' ? 'Готовлю серию…' : '' });
  if (!chat) return;
  if (action === 'menu') return edit(chat, mid, `<b>Что посмотрим?</b>\nПодсказка: нажми поиск и напиши название.`, menu(user));
  if (action === 'search') { sessions.set(user, 'search'); return send(chat, 'Напиши название аниме.', kb([[cb('‹ В меню', 'menu')]])); }
  if (action === 'title') { const t = find(a); return t && edit(chat, mid, titleText(t), titleKb(t, user)); }
  if (action === 'watch') { const t = find(a); return t && edit(chat, mid, `<b>${esc(t.title)}</b>\n\nВыбери озвучку или субтитры.`, kb(t.translations.map(x => [cb(`${x[1]}`, `tr:${t.id}:${x[0]}`)]).concat([[cb('‹ К тайтлу', `title:${t.id}`)]]))); }
  if (action === 'tr') { const t = find(a); return t && edit(chat, mid, `<b>${esc(t.title)}</b>\nОзвучка: ${esc(b)}\n\nВыбери серию.`, episodes(t, b)); }
  if (action === 'ep') { const t = find(a); return t && deliver(chat, user, t, b, c); }
  if (action === 'watched') { state.progress[user] = { title: a, tr: b, ep: Number(c) }; await save(); return tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Отмечено ✓' }); }
  if (action === 'sub' || action === 'unsub') { state.subs[`${user}:${a}`] = action === 'sub'; await save(); return callback({ ...q, data: `title:${a}` }); }
  if (action === 'list') { state.lists[`${user}:${a}`] = 'planned'; await save(); return tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Добавлено в список' }); }
  if (action === 'continue') { const p = state.progress[user], t = p && find(p.title); return t && deliver(chat, user, t, p.tr, p.ep); }
  if (['subs', 'lists', 'calendar', 'settings'].includes(action)) return send(chat, 'Эта функция подключается следующим обновлением. Основной просмотр уже готов.', kb([[cb('‹ В меню', 'menu')]]));
}
async function message(m) {
  const chat = m.chat.id; const user = m.from.id; const text = (m.text || '').trim(); const cmd = text.split(/\s+/)[0].split('@')[0].toLowerCase();
  if (cmd === '/start') return start(chat, user);
  if (cmd === '/menu') return send(chat, '<b>Что посмотрим?</b>', menu(user));
  if (cmd === '/help') return send(chat, '<b>Команды</b>\n/start — запуск\n/menu — меню\n/find название — поиск\n/play название — просмотр', kb([[cb('‹ В меню', 'menu')]]));
  if (cmd === '/find' || cmd === '/play' || sessions.get(user) === 'search') {
    const q = text.replace(/^\/\w+(?:@\w+)?\s*/u, ''); sessions.delete(user); const found = search(q);
    if (!found.length) return send(chat, 'Ничего не нашлось. Попробуй другое написание.', kb([[cb('🔎 Новый поиск', 'search')], [cb('‹ В меню', 'menu')]]));
    const t = found[0]; return send(chat, `<b>${esc(t.title)}</b>\n<i>${esc(t.alt)}</i>\n${t.year} • ${t.status}`, kb([[cb('Открыть', `title:${t.id}`)], [cb('🔎 Новый поиск', 'search')], [cb('В меню', 'menu')]]));
  }
  return send(chat, 'Используй кнопку меню или команду /find.', menu(user));
}
console.log('AniHart bot started');
while (true) { try { const updates = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }); for (const u of updates) { offset = u.update_id + 1; try { if (u.message) await message(u.message); if (u.callback_query) await callback(u.callback_query); } catch (e) { console.error(e.message); } } } catch (e) { console.error(e.message); await new Promise(r => setTimeout(r, 3000)); } }
