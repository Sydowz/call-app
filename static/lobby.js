'use strict';

// The lobby: your profile, create a room, join by link, and the rooms you
// have been in (saved in this browser) with how many people are in each now.

const COUNTS_EVERY_MS = 15_000;
let nick = load('nick');
let photo = validPhoto(load('photo'));
let counts = {}; // room id -> people in it now, from /api/rooms

// ---------- perfil ----------

function renderProfile() {
  paintAvatar($('me-avatar'), nick || '?', 1, photo);
  $('me-nick').textContent = nick;
  $('edit').textContent = nick ? 'Editar' : 'Escolher nick';
}

$('edit').onclick = () => openProfileDialog({
  title: nick ? 'Editar perfil' : 'Como seus amigos vão te ver?',
  submitLabel: 'Salvar',
  nick,
  photo,
  colorId: 1,
  onSave(newNick, newPhoto) {
    nick = newNick;
    photo = newPhoto;
    renderProfile();
  },
});

// ---------- criar / entrar ----------

function slugify(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '') // "Sábado" -> "Sabado"
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40).replace(/-+$/, '');
}

function randomChars(count, alphabet) {
  return Array.from(crypto.getRandomValues(new Uint8Array(count)), (b) => alphabet[b % alphabet.length]).join('');
}

// A name gets a 6-character random suffix so strangers can't guess the room;
// no name gives a fully random ID.
function newRoomId(name) {
  const slug = slugify(name);
  return slug
    ? `${slug}-${randomChars(6, 'abcdefghijklmnopqrstuvwxyz0123456789')}`
    : randomChars(16, '0123456789abcdef');
}

// Accepts a full invite link or just the room code.
function parseRoom(input) {
  const text = input.trim();
  const id = text.match(/\/room\/([A-Za-z0-9_-]{1,64})/)?.[1] ?? text;
  return validRoomId(id) ? id : null;
}

$('create-form').onsubmit = (e) => {
  e.preventDefault();
  location.assign(`/room/${newRoomId($('room-name').value)}`);
};

$('join-form').onsubmit = (e) => {
  e.preventDefault();
  const id = parseRoom($('join-link').value);
  if (id) location.assign(`/room/${id}`);
  else toast('Esse link não parece um convite do Friends Call.');
};

// ---------- suas salas ----------

const ago = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
function timeAgo(at) {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return 'agora há pouco';
  if (minutes < 60) return ago.format(-minutes, 'minute');
  if (minutes < 24 * 60) return ago.format(-Math.round(minutes / 60), 'hour');
  return ago.format(-Math.round(minutes / (24 * 60)), 'day');
}

function colorFor(id) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function peopleText(id) {
  if (!(id in counts)) return ['…', 'muted'];
  const n = counts[id];
  if (n === 0) return ['ninguém agora', 'muted'];
  return [`● ${n} ${n === 1 ? 'pessoa' : 'pessoas'} agora`, 'online'];
}

function roomItem(room) {
  const name = roomName(room.id);
  const li = el('li', 'room-item');
  const link = el('a', 'room-link');
  link.href = `/room/${room.id}`;
  const icon = el('span', 'room-icon', '#');
  icon.style.background = colorFor(room.id);
  icon.setAttribute('aria-hidden', 'true');
  const text = el('span', 'room-text');
  const [people, cls] = peopleText(room.id);
  const meta = el('span', 'room-meta');
  meta.append(el('span', cls, people), ` · ${room.pinned ? 'fixada · ' : ''}${timeAgo(room.at)}`);
  text.append(el('strong', 'ellipsis', name), meta);
  link.append(icon, text);

  const pin = el('button', 'btn small ghost', room.pinned ? 'Desafixar' : 'Fixar');
  pin.setAttribute('aria-pressed', String(!!room.pinned));
  pin.setAttribute('aria-label', `${room.pinned ? 'Desafixar' : 'Fixar'} ${name}`);
  pin.onclick = () => {
    saveRooms(loadRooms().map((r) => (r.id === room.id ? { ...r, pinned: !r.pinned } : r)));
    renderRooms();
  };
  const remove = el('button', 'btn small ghost', 'Remover');
  remove.setAttribute('aria-label', `Tirar ${name} da lista`);
  remove.onclick = () => {
    saveRooms(loadRooms().filter((r) => r.id !== room.id));
    renderRooms();
  };
  li.append(link, pin, remove);
  return li;
}

function renderRooms() {
  const list = loadRooms().sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.at - a.at);
  $('rooms-empty').hidden = list.length > 0;
  $('rooms').replaceChildren(...list.map(roomItem));
}

async function updateCounts() {
  const ids = loadRooms().map((r) => r.id);
  if (!ids.length || document.hidden) return;
  try {
    const res = await fetch(`/api/rooms?ids=${ids.join(',')}`, { cache: 'no-store' });
    if (!res.ok) return;
    counts = await res.json();
    $('rooms-updated').textContent = 'atualiza sozinho';
    renderRooms();
  } catch {
    // Offline: keep the last numbers.
  }
}

// ---------- início ----------

$('example-url').textContent = `${location.host}/room/churrasco-k3f9x2`;
renderProfile();
renderRooms();
updateCounts();
setInterval(updateCounts, COUNTS_EVERY_MS);
document.addEventListener('visibilitychange', updateCounts);
window.addEventListener('storage', renderRooms); // a room opened in another tab
window.addEventListener('pageshow', (e) => { // back button from a room
  if (e.persisted) {
    renderRooms();
    updateCounts();
  }
});
