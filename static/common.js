'use strict';

// Shared by the lobby and the room: small DOM helpers, browser storage, the
// profile (nick + photo) and its dialog, the toast and the list of rooms you
// have been in. Nothing here talks to the server.

const AVATAR_COLORS = ['#2E3A5C', '#5C3B3B', '#3B5C47', '#4A3B5C', '#5C4F3B', '#3B525C'];
const MAX_PHOTO = 40_000; // photos travel inside signaling messages (64 KB limit on the server)

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function load(key) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

function save(key, value) {
  try {
    if (value) localStorage.setItem(key, value); else localStorage.removeItem(key);
  } catch { /* private mode: keep it in memory */ }
}

// ---------- perfil ----------

function cleanNick(value) {
  return Array.from(String(value ?? '').trim()).slice(0, 32).join('');
}

// Only inline images are accepted: a remote URL would let a participant
// track everyone else's IP when their browser fetches it.
function validPhoto(value) {
  return typeof value === 'string' && value.length <= MAX_PHOTO &&
    /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(value) ? value : '';
}

// Center-crops and shrinks the picked image to a small JPEG data URL.
async function photoFromFile(file) {
  const bitmap = await createImageBitmap(file);
  const size = 128;
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1F2230'; // JPEG has no transparency
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  for (const quality of [0.85, 0.7, 0.5]) {
    const url = canvas.toDataURL('image/jpeg', quality);
    if (url.length <= MAX_PHOTO) return url;
  }
  throw new Error('foto grande demais');
}

function initials(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const chars = words.length > 1
    ? [Array.from(words[0])[0], Array.from(words[1])[0]]
    : Array.from(words[0] ?? '?').slice(0, 2);
  return chars.join('').toUpperCase();
}

function paintAvatar(node, name, id, photo) {
  node.textContent = photo ? '' : initials(name || '?');
  node.style.backgroundColor = AVATAR_COLORS[((id ?? 1) - 1) % AVATAR_COLORS.length];
  // Safe inside url(""): validPhoto() only lets base64 characters through.
  node.style.backgroundImage = photo ? `url("${photo}")` : '';
}

// ---------- diálogo de perfil e toast (marcação comum às duas páginas) ----------

document.body.insertAdjacentHTML('beforeend', `
  <dialog id="profile" aria-labelledby="profile-title">
    <form id="profile-form">
      <div class="banner"></div>
      <div class="dialog-body">
        <div class="avatar-row">
          <div class="avatar big" id="preview-avatar" aria-hidden="true"></div>
          <button type="button" class="btn small" id="photo-pick">Adicionar foto</button>
          <button type="button" class="btn small" id="photo-remove">Remover</button>
          <input type="file" id="photo-input" accept="image/*" hidden>
        </div>
        <div class="heading">
          <h2 id="profile-title">Como seus amigos vão te ver?</h2>
          <span class="muted">Nick e foto aparecem só para quem está na sala.</span>
        </div>
        <label class="field">
          <span class="muted">Nick</span>
          <input id="nick-input" maxlength="32" autocomplete="nickname" required>
        </label>
        <button class="btn small primary" id="profile-submit">Salvar</button>
      </div>
    </form>
  </dialog>
  <div class="toast" id="toast" role="status" hidden></div>
`);

let draftPhoto = ''; // photo being edited in the profile dialog
let profileColorId = 1;
let profileRequired = false;
let profileOnSave = null;

// Opens the profile dialog; `onSave(nick, photo)` runs after both are stored.
function openProfileDialog({ title, submitLabel, required = false, nick, photo, colorId, onSave }) {
  $('profile-title').textContent = title;
  $('profile-submit').textContent = submitLabel;
  $('nick-input').value = nick;
  draftPhoto = photo;
  profileColorId = colorId ?? 1;
  profileRequired = required;
  profileOnSave = onSave;
  updateProfilePreview();
  $('profile').showModal();
}

function updateProfilePreview() {
  paintAvatar($('preview-avatar'), cleanNick($('nick-input').value), profileColorId, draftPhoto);
  $('photo-remove').hidden = !draftPhoto;
  $('photo-pick').textContent = draftPhoto ? 'Trocar foto' : 'Adicionar foto';
}

$('nick-input').oninput = updateProfilePreview;
$('photo-pick').onclick = () => $('photo-input').click();
$('photo-remove').onclick = () => {
  draftPhoto = '';
  updateProfilePreview();
};
$('photo-input').onchange = async () => {
  const file = $('photo-input').files[0];
  $('photo-input').value = ''; // picking the same file again still fires onchange
  if (!file) return;
  try {
    draftPhoto = await photoFromFile(file);
    updateProfilePreview();
  } catch {
    toast('Não deu para usar essa imagem');
  }
};
$('profile').oncancel = (e) => {
  if (profileRequired) e.preventDefault(); // e.g. a nick is required before joining
};
$('profile-form').onsubmit = (e) => {
  e.preventDefault();
  const nick = cleanNick($('nick-input').value);
  if (!nick) return;
  save('nick', nick);
  save('photo', draftPhoto);
  $('profile').close();
  profileOnSave?.(nick, draftPhoto);
};

let toastTimer = null;
function toast(text) {
  const node = $('toast');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 2500);
}

// ---------- salas ----------

function validRoomId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

// "churrasco-k3f9x2" (name + random suffix) shows as "churrasco"; random IDs
// show their first 8 characters.
function roomName(id) {
  return id.match(/^(.+)-[a-z0-9]{4,6}$/)?.[1] ?? id.slice(0, 8);
}

// Rooms you have been in, newest first: [{ id, at, pinned }].
function loadRooms() {
  try {
    const list = JSON.parse(load('rooms') || '[]');
    return Array.isArray(list) ? list.filter((r) => r && validRoomId(r.id)) : [];
  } catch {
    return [];
  }
}

function saveRooms(list) {
  save('rooms', JSON.stringify(list.slice(0, 30)));
}

function rememberRoom(id) {
  const list = loadRooms();
  const old = list.find((r) => r.id === id);
  saveRooms([{ id, at: Date.now(), pinned: !!old?.pinned }, ...list.filter((r) => r.id !== id)]);
}

function roomUrl(id) {
  return `${location.origin}/room/${id}`;
}
