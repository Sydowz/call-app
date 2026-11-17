'use strict';

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const MAX_PEERS = 6;
const AVATAR_COLORS = ['#2E3A5C', '#5C3B3B', '#3B5C47', '#4A3B5C', '#5C4F3B', '#3B525C'];
const MAX_PHOTO = 40_000; // photos travel inside signaling messages (64 KB limit on the server)
const roomId = location.pathname.split('/').pop();
const canShare = !!navigator.mediaDevices?.getDisplayMedia;

const $ = (id) => document.getElementById(id);
const shareBtn = $('share');

let ws = null; // set once we join; null means "not in the room yet"
let myId = null;
let myNick = load('nick');
let myPhoto = validPhoto(load('photo'));
let draftPhoto = ''; // photo being edited in the profile dialog
let localTrack = null; // our screen's video track while sharing
let roomFull = false;
let left = false;
let timer = null;
// id -> { id, nick, pc, transceiver, queue, screen,
//         sharing (they share), iWatch (I watch them), watchesMe (they watch me) }
const peers = new Map();
const localScreen = buildScreen();

// ---------- perfil (nick) ----------

function load(key) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

function save(key, value) {
  try {
    if (value) localStorage.setItem(key, value); else localStorage.removeItem(key);
  } catch { /* private mode: keep it in memory */ }
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

function profileMsg() {
  return { nick: myNick, photo: myPhoto };
}

function cleanNick(value) {
  return Array.from(String(value ?? '').trim()).slice(0, 32).join('');
}

function displayName(peer) {
  return peer.nick || `Participante ${peer.id}`;
}

function initials(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const chars = words.length > 1
    ? [Array.from(words[0])[0], Array.from(words[1])[0]]
    : Array.from(words[0] ?? '?').slice(0, 2);
  return chars.join('').toUpperCase();
}

function paintAvatar(el, name, id, photo) {
  el.textContent = photo ? '' : initials(name || '?');
  el.style.backgroundColor = AVATAR_COLORS[((id ?? 1) - 1) % AVATAR_COLORS.length];
  // Safe inside url(""): validPhoto() only lets base64 characters through.
  el.style.backgroundImage = photo ? `url("${photo}")` : '';
}

const profile = $('profile');
const nickInput = $('nick-input');

function openProfile() {
  $('profile-title').textContent = ws ? 'Editar perfil' : 'Como seus amigos vão te ver?';
  $('profile-submit').textContent = ws ? 'Salvar' : 'Entrar na sala';
  nickInput.value = myNick;
  draftPhoto = myPhoto;
  updatePreview();
  profile.showModal();
}

function updatePreview() {
  paintAvatar($('preview-avatar'), cleanNick(nickInput.value), myId, draftPhoto);
  $('photo-remove').hidden = !draftPhoto;
  $('photo-pick').textContent = draftPhoto ? 'Trocar foto' : 'Adicionar foto';
}

nickInput.oninput = updatePreview;
$('photo-pick').onclick = () => $('photo-input').click();
$('photo-remove').onclick = () => {
  draftPhoto = '';
  updatePreview();
};
$('photo-input').onchange = async () => {
  const file = $('photo-input').files[0];
  $('photo-input').value = ''; // picking the same file again still fires onchange
  if (!file) return;
  try {
    draftPhoto = await photoFromFile(file);
    updatePreview();
  } catch {
    toast('Não deu para usar essa imagem');
  }
};
profile.oncancel = (e) => {
  if (!ws) e.preventDefault(); // a nick is required before joining
};
$('profile-form').onsubmit = (e) => {
  e.preventDefault();
  const nick = cleanNick(nickInput.value);
  if (!nick) return;
  myNick = nick;
  myPhoto = draftPhoto;
  save('nick', myNick);
  save('photo', myPhoto);
  profile.close();
  if (ws) {
    peers.forEach((peer) => send(peer.id, profileMsg()));
    refresh();
  } else {
    enterRoom();
  }
};
$('edit').onclick = openProfile;

// ---------- uma aba por sala ----------

// Opening the same room in a second tab would make you appear twice. One Web
// Lock per room (shared by all tabs of this browser) detects that: the new tab
// can "steal" it, which makes the old tab's request reject so it leaves.
const ROOM_LOCK = `friends-call-room:${roomId}`;
let releaseLock = null;

function enterRoom(takeover = false) {
  if (!navigator.locks) { // no Web Locks outside HTTPS/localhost: just join
    join();
    return;
  }
  navigator.locks.request(ROOM_LOCK, takeover ? { steal: true } : { ifAvailable: true }, (lock) => {
    if (!lock) {
      showNotice('Você já está nesta sala', 'Ela está aberta em outra aba deste navegador.', {
        label: 'Usar esta aba',
        run: () => {
          notice.close();
          enterRoom(true);
        },
      });
      return undefined;
    }
    join();
    return new Promise((resolve) => (releaseLock = resolve)); // held until we leave
  }).catch((err) => {
    if (err.name !== 'AbortError') return;
    leaveRoom('Sala aberta em outra aba', 'Você continuou nesta sala em outra aba deste navegador.', {
      label: 'Usar esta aba',
      run: () => {
        // This page's state is torn down: reload and steal the room back.
        try { sessionStorage.setItem('takeover', '1'); } catch { /* falls back to the "Usar esta aba" prompt */ }
        location.reload();
      },
    });
  });
}

// ---------- sinalização (WebSocket) ----------

function join() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${roomId}`);
  ws.onmessage = onMessage;
  ws.onclose = () => {
    if (left) return;
    shareBtn.disabled = true;
    clearInterval(timer);
    if (roomFull) {
      showNotice('Sala cheia', `Esta sala já tem ${MAX_PEERS} pessoas. Tente de novo mais tarde ou crie outra.`);
    } else {
      showNotice('Conexão perdida', 'Você foi desconectado do servidor.');
    }
  };
}

function onMessage(ev) {
  const msg = JSON.parse(ev.data);
  switch (msg.type) {
    case 'welcome': {
      myId = msg.id;
      shareBtn.disabled = !canShare;
      const joinedAt = Date.now();
      timer = setInterval(() => ($('timer').textContent = elapsed(joinedAt)), 1000);
      for (const id of msg.peers) createPeer(id, true);
      refresh();
      break;
    }
    case 'peer-joined':
      createPeer(msg.id, false); // the newcomer will send us the offer
      break;
    case 'peer-left':
      removePeer(msg.id);
      break;
    case 'signal': {
      const peer = peers.get(msg.from) ?? createPeer(msg.from, false);
      enqueue(peer, () => handleSignal(peer, msg.data));
      break;
    }
    case 'full':
      roomFull = true;
      break;
  }
}

function send(to, data) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ to, data }));
}

// Each negotiation step is async but they must run strictly in arrival order
// (e.g. ICE candidates can only be added after the remote description is set),
// so every peer gets its own promise chain.
function enqueue(peer, step) {
  peer.queue = peer.queue.then(step).catch((err) => console.warn(`Participante ${peer.id}:`, err));
}

// ---------- WebRTC ----------

function createPeer(id, initiator) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const peer = {
    id, nick: '', photo: '', pc, transceiver: null,
    sharing: false, iWatch: false, watchesMe: false,
    queue: Promise.resolve(),
    screen: buildScreen(),
  };
  peer.screen.watchBtn.onclick = () => setWatch(peer, true);
  peer.screen.unwatchBtn.onclick = () => setWatch(peer, false);
  peers.set(id, peer);

  pc.onicecandidate = (e) => {
    if (e.candidate) send(id, { candidate: e.candidate });
  };
  pc.onconnectionstatechange = refresh;

  if (initiator) {
    // Whoever joins later sends the offer, so each pair negotiates exactly once.
    // One "sendrecv" video transceiver carries a screen in each direction;
    // starting or stopping a share later is just replaceTrack(), with no
    // renegotiation (and therefore no colliding offers between two peers).
    attachTransceiver(peer, pc.addTransceiver('video', { direction: 'sendrecv' }));
    enqueue(peer, async () => {
      await pc.setLocalDescription(); // creates the offer implicitly
      send(id, { description: pc.localDescription });
    });
  }

  send(id, profileMsg());
  if (localTrack) send(id, { sharing: true });
  refresh();
  return peer;
}

function attachTransceiver(peer, transceiver) {
  peer.transceiver = transceiver;
  // The receiver track exists from the start; it simply has no frames until
  // the other side calls replaceTrack() with its screen.
  peer.screen.video.srcObject = new MediaStream([transceiver.receiver.track]);
  sendScreenTo(peer); // in case they asked to watch before this was set up
}

async function handleSignal(peer, data) {
  const { pc } = peer;
  if (data.description) {
    await pc.setRemoteDescription(data.description);
    if (data.description.type === 'offer') {
      // A transceiver created from a remote offer defaults to "recvonly";
      // switch it to "sendrecv" so we can share our screen back later.
      const transceiver = pc.getTransceivers()[0];
      transceiver.direction = 'sendrecv';
      await pc.setLocalDescription(); // creates the answer implicitly
      send(peer.id, { description: pc.localDescription });
      attachTransceiver(peer, transceiver);
    }
  } else if (data.candidate) {
    await pc.addIceCandidate(data.candidate);
  } else if ('sharing' in data) {
    peer.sharing = !!data.sharing;
    if (!peer.sharing) peer.iWatch = false; // a new share starts unwatched
    refresh();
  } else if ('watch' in data) {
    // Ignore a request that crossed with us stopping the share.
    peer.watchesMe = !!data.watch && !!localTrack;
    sendScreenTo(peer);
    refresh();
  } else if ('nick' in data) {
    peer.nick = cleanNick(data.nick);
    peer.photo = validPhoto(data.photo);
    refresh();
  }
}

// Video only flows to peers that clicked "Assistir": everyone else gets a null
// track, so we don't encode for them and they don't decode anything.
function sendScreenTo(peer) {
  if (!peer.transceiver) return; // attached later, once that peer's offer arrives
  const track = localTrack && peer.watchesMe ? localTrack : null;
  if (peer.transceiver.sender.track === track) return;
  peer.transceiver.sender.replaceTrack(track).catch((err) => console.warn(err));
}

function setWatch(peer, watch) {
  peer.iWatch = watch;
  send(peer.id, { watch });
  refresh();
}

function removePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.pc.close();
  peer.screen.card.remove();
  peers.delete(id);
  refresh();
}

// ---------- compartilhar / parar / sair ----------

shareBtn.onclick = () => (localTrack ? stopShare() : startShare());

async function startShare() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false });
  } catch {
    return; // usuário cancelou a escolha
  }
  localTrack = stream.getVideoTracks()[0];
  // "text" makes the encoder keep resolution (sharp text) and drop frames instead.
  localTrack.contentHint = 'text';
  localTrack.onended = stopShare; // the browser's own "stop sharing" bar
  localScreen.video.srcObject = new MediaStream([localTrack]);
  peers.forEach((peer) => send(peer.id, { sharing: true })); // video only once they ask
  refresh();
}

function stopShare() {
  if (!localTrack) return;
  localTrack.onended = null;
  localTrack.stop();
  localTrack = null;
  localScreen.video.srcObject = null;
  peers.forEach((peer) => {
    peer.watchesMe = false;
    sendScreenTo(peer);
    send(peer.id, { sharing: false });
  });
  refresh();
}

function leaveRoom(title, text, action) {
  left = true;
  stopShare();
  ws?.close();
  clearInterval(timer);
  [...peers.keys()].forEach(removePeer);
  shareBtn.disabled = true;
  releaseLock?.();
  showNotice(title, text, action);
}

$('leave').onclick = () => leaveRoom('Você saiu da sala', 'O link continua valendo enquanto houver alguém na sala.');

// ---------- link da sala ----------

async function copyLink() {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Link copiado');
  } catch {
    window.prompt('Copie o link da sala:', location.href); // clipboard needs HTTPS
  }
}
$('copy').onclick = copyLink;
$('copy-side').onclick = copyLink;

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2000);
}

const notice = $('notice');
const RELOAD = { label: 'Entrar de novo', run: () => location.reload() };
let noticeAction = RELOAD.run;

function showNotice(title, text, action = RELOAD) {
  $('notice-title').textContent = title;
  $('notice-text').textContent = text;
  $('notice-retry').textContent = action.label;
  noticeAction = action.run;
  if (!notice.open) notice.showModal();
}
notice.oncancel = (e) => e.preventDefault(); // nothing usable behind it
$('notice-retry').onclick = () => noticeAction();

// ---------- interface ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function elapsed(since) {
  const s = Math.floor((Date.now() - since) / 1000);
  return [s / 3600, (s % 3600) / 60, s % 60].map((n) => String(Math.floor(n)).padStart(2, '0')).join(':');
}

function buildScreen() {
  const card = el('div', 'screen card');
  card.hidden = true;
  const frame = el('div', 'frame');
  const video = el('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.title = 'Duplo clique para tela cheia';
  video.ondblclick = () => video.requestFullscreen?.();
  const waiting = el('div', 'waiting');
  const waitingText = el('span');
  const watchBtn = el('button', 'btn primary', 'Assistir');
  waiting.append(waitingText, watchBtn);
  frame.append(video, waiting);
  const pill = el('span', 'pill');
  const hint = el('span', 'hint muted');
  const unwatchBtn = el('button', 'btn small', 'Parar de assistir');
  const foot = el('div', 'screen-foot');
  foot.append(pill, hint, unwatchBtn);
  card.append(frame, foot);
  $('screens').append(card);
  return { card, video, waiting, waitingText, watchBtn, pill, hint, unwatchBtn };
}

function peerStatus(peer) {
  switch (peer.pc.connectionState) {
    case 'failed': return ['falha na conexão', 'warn'];
    case 'disconnected': return ['conexão instável', 'warn'];
    case 'connected':
      if (peer.sharing) return ['compartilhando', 'live'];
      return peer.watchesMe ? ['assistindo você', 'online'] : ['na sala', 'muted'];
    default: return ['conectando…', 'muted'];
  }
}

function personRow(person) {
  const li = el('li', 'row');
  const avatar = el('div', 'avatar');
  avatar.setAttribute('aria-hidden', 'true');
  paintAvatar(avatar, person.name, person.id, person.photo);
  const name = el('span', 'ellipsis', person.name);
  if (person.self) name.append(el('span', 'muted', ' (você)'));
  li.append(avatar, name, el('span', `end ${person.status[1]}`, person.status[0]));
  return li;
}

function personTile(person) {
  const tile = el('div', person.self ? 'tile card self' : 'tile card');
  const avatar = el('div', 'avatar');
  avatar.setAttribute('aria-hidden', 'true');
  paintAvatar(avatar, person.name, person.id, person.photo);
  const name = el('strong', 'ellipsis', person.name);
  const status = person.self ? ['você', 'online'] : person.status;
  tile.append(avatar, name, el('span', `status ${status[1]}`, status[0]));
  return tile;
}

// `watching` false shows the "Assistir" placeholder instead of the video.
function showScreen(screen, { visible, watching, label, hint, waitingText = '', canUnwatch = false }) {
  screen.card.hidden = !visible;
  screen.video.hidden = !watching;
  screen.waiting.hidden = watching;
  screen.waitingText.textContent = waitingText;
  screen.pill.textContent = label;
  screen.hint.textContent = hint;
  screen.unwatchBtn.hidden = !canUnwatch;
  if (visible && watching && screen.video.paused) screen.video.play().catch(() => {});
}

function refresh() {
  const list = [...peers.values()].sort((a, b) => a.id - b.id);
  const me = {
    self: true, id: myId, name: myNick, photo: myPhoto,
    status: localTrack ? ['compartilhando', 'live'] : ['na sala', 'online'],
  };
  const others = list.map((p) => ({ id: p.id, name: displayName(p), photo: p.photo, status: peerStatus(p) }));
  const people = myId === null ? [] : [me, ...others];

  $('online').textContent = people.length ? `● ${people.length}/${MAX_PEERS} online` : '';
  $('people').replaceChildren(...people.map(personRow));
  $('tiles').replaceChildren(...people.map(personTile));

  const viewers = list.filter((p) => p.watchesMe).length;
  showScreen(localScreen, {
    visible: !!localTrack,
    watching: true,
    label: '● Você está compartilhando',
    hint: viewers === 0 ? 'ninguém assistindo' : viewers === 1 ? '1 pessoa assistindo' : `${viewers} pessoas assistindo`,
  });
  for (const peer of list) {
    const name = displayName(peer);
    showScreen(peer.screen, {
      visible: peer.sharing,
      watching: peer.iWatch,
      label: `● ${name} está compartilhando`,
      hint: peer.iWatch ? 'Tela cheia: duplo clique' : 'O vídeo só chega para quem assiste',
      waitingText: `${name} está compartilhando a tela`,
      canUnwatch: peer.iWatch,
    });
  }
  const shown = (localTrack ? 1 : 0) + list.filter((p) => p.sharing).length;
  $('empty').hidden = shown > 0;
  $('screens').style.setProperty('--cols', shown > 2 ? 2 : 1);
  $('live').hidden = shown === 0;

  paintAvatar($('me-avatar'), myNick, myId, myPhoto);
  $('me-nick').textContent = myNick;
  $('me-status').textContent = me.status[0] === 'na sala' ? 'Na sala' : 'Compartilhando';
  $('me-status').className = me.status[1];

  $('share-long').textContent = localTrack ? 'Parar compartilhamento' : 'Compartilhar tela';
  $('share-short').textContent = localTrack ? 'Parar' : 'Tela';
}

// ---------- início ----------

const shortId = roomId.slice(0, 8);
$('room-tag').textContent = `# ${shortId}`;
$('room-title').textContent = `Sala ${shortId}`;
if (!canShare) {
  shareBtn.title = 'Compartilhar tela exige HTTPS ou localhost';
  $('empty-hint').textContent = 'Neste endereço o navegador não deixa compartilhar a tela (precisa de HTTPS ou localhost), mas você pode assistir.';
}
refresh();
let takeover = false;
try {
  takeover = sessionStorage.getItem('takeover') === '1';
  sessionStorage.removeItem('takeover');
} catch { /* storage blocked: no takeover */ }
if (myNick) enterRoom(takeover); else openProfile();
