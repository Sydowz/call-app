'use strict';

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const MAX_PEERS = 6;
const AVATAR_COLORS = ['#2E3A5C', '#5C3B3B', '#3B5C47', '#4A3B5C', '#5C4F3B', '#3B525C'];
const roomId = location.pathname.split('/').pop();
const canShare = !!navigator.mediaDevices?.getDisplayMedia;

const $ = (id) => document.getElementById(id);
const shareBtn = $('share');

let ws = null; // set once we join; null means "not in the room yet"
let myId = null;
let myNick = loadNick();
let localTrack = null; // our screen's video track while sharing
let roomFull = false;
let left = false;
let timer = null;
const peers = new Map(); // id -> { id, nick, pc, transceiver, sharing, queue, screen }
const localScreen = buildScreen('Prévia da sua tela');

// ---------- perfil (nick) ----------

function loadNick() {
  try { return localStorage.getItem('nick') || ''; } catch { return ''; }
}

function saveNick(nick) {
  try { localStorage.setItem('nick', nick); } catch { /* private mode: keep it in memory */ }
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

function paintAvatar(el, name, id) {
  el.textContent = initials(name || '?');
  el.style.background = AVATAR_COLORS[((id ?? 1) - 1) % AVATAR_COLORS.length];
}

const profile = $('profile');
const nickInput = $('nick-input');

function openProfile() {
  $('profile-title').textContent = ws ? 'Editar perfil' : 'Como seus amigos vão te ver?';
  $('profile-submit').textContent = ws ? 'Salvar' : 'Entrar na sala';
  nickInput.value = myNick;
  updatePreview();
  profile.showModal();
}

function updatePreview() {
  paintAvatar($('preview-avatar'), cleanNick(nickInput.value), myId);
}

nickInput.oninput = updatePreview;
profile.oncancel = (e) => {
  if (!ws) e.preventDefault(); // a nick is required before joining
};
$('profile-form').onsubmit = (e) => {
  e.preventDefault();
  const nick = cleanNick(nickInput.value);
  if (!nick) return;
  myNick = nick;
  saveNick(nick);
  profile.close();
  if (ws) {
    peers.forEach((peer) => send(peer.id, { nick }));
    refresh();
  } else {
    join();
  }
};
$('edit').onclick = openProfile;

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
    id, nick: '', pc, transceiver: null, sharing: false,
    queue: Promise.resolve(),
    screen: buildScreen('Tela cheia: duplo clique'),
  };
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

  send(id, { nick: myNick });
  refresh();
  return peer;
}

function attachTransceiver(peer, transceiver) {
  peer.transceiver = transceiver;
  // The receiver track exists from the start; it simply has no frames until
  // the other side calls replaceTrack() with its screen.
  peer.screen.video.srcObject = new MediaStream([transceiver.receiver.track]);
  if (localTrack) sendScreenTo(peer);
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
    refresh();
  } else if ('nick' in data) {
    peer.nick = cleanNick(data.nick);
    refresh();
  }
}

function sendScreenTo(peer) {
  if (!peer.transceiver) return; // attached later, once that peer's offer arrives
  peer.transceiver.sender.replaceTrack(localTrack).catch((err) => console.warn(err));
  send(peer.id, { sharing: !!localTrack });
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
  peers.forEach(sendScreenTo);
  refresh();
}

function stopShare() {
  if (!localTrack) return;
  localTrack.onended = null;
  localTrack.stop();
  localTrack = null;
  localScreen.video.srcObject = null;
  peers.forEach(sendScreenTo);
  refresh();
}

$('leave').onclick = () => {
  left = true;
  stopShare();
  ws?.close();
  clearInterval(timer);
  [...peers.keys()].forEach(removePeer);
  shareBtn.disabled = true;
  showNotice('Você saiu da sala', 'O link continua valendo enquanto houver alguém na sala.');
};

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
function showNotice(title, text) {
  $('notice-title').textContent = title;
  $('notice-text').textContent = text;
  if (!notice.open) notice.showModal();
}
notice.oncancel = (e) => e.preventDefault(); // nothing usable behind it
$('notice-retry').onclick = () => location.reload();

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

function buildScreen(hint) {
  const card = el('div', 'screen card');
  card.hidden = true;
  const frame = el('div', 'frame');
  const video = el('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.title = 'Duplo clique para tela cheia';
  video.ondblclick = () => video.requestFullscreen?.();
  frame.append(video);
  const pill = el('span', 'pill');
  const foot = el('div', 'screen-foot');
  foot.append(pill, el('span', 'hint muted', hint));
  card.append(frame, foot);
  $('screens').append(card);
  return { card, video, pill };
}

function peerStatus(peer) {
  switch (peer.pc.connectionState) {
    case 'failed': return ['falha na conexão', 'warn'];
    case 'disconnected': return ['conexão instável', 'warn'];
    case 'connected': return peer.sharing ? ['compartilhando', 'live'] : ['na sala', 'muted'];
    default: return ['conectando…', 'muted'];
  }
}

function personRow(person) {
  const li = el('li', 'row');
  const avatar = el('div', 'avatar');
  avatar.setAttribute('aria-hidden', 'true');
  paintAvatar(avatar, person.name, person.id);
  const name = el('span', 'ellipsis', person.name);
  if (person.self) name.append(el('span', 'muted', ' (você)'));
  li.append(avatar, name, el('span', `end ${person.status[1]}`, person.status[0]));
  return li;
}

function personTile(person) {
  const tile = el('div', person.self ? 'tile card self' : 'tile card');
  const avatar = el('div', 'avatar');
  avatar.setAttribute('aria-hidden', 'true');
  paintAvatar(avatar, person.name, person.id);
  const name = el('strong', 'ellipsis', person.name);
  const status = person.self ? ['você', 'online'] : person.status;
  tile.append(avatar, name, el('span', `status ${status[1]}`, status[0]));
  return tile;
}

function showScreen(screen, visible, label) {
  screen.card.hidden = !visible;
  screen.pill.textContent = label;
  if (visible && screen.video.paused) screen.video.play().catch(() => {});
}

function refresh() {
  const list = [...peers.values()].sort((a, b) => a.id - b.id);
  const me = {
    self: true, id: myId, name: myNick,
    status: localTrack ? ['compartilhando', 'live'] : ['na sala', 'online'],
  };
  const people = myId === null ? [] : [me, ...list.map((p) => ({ id: p.id, name: displayName(p), status: peerStatus(p) }))];

  $('online').textContent = people.length ? `● ${people.length}/${MAX_PEERS} online` : '';
  $('people').replaceChildren(...people.map(personRow));
  $('tiles').replaceChildren(...people.map(personTile));

  showScreen(localScreen, !!localTrack, '● Você está compartilhando');
  for (const peer of list) showScreen(peer.screen, peer.sharing, `● ${displayName(peer)} está compartilhando`);
  const shown = (localTrack ? 1 : 0) + list.filter((p) => p.sharing).length;
  $('empty').hidden = shown > 0;
  $('screens').style.setProperty('--cols', shown > 2 ? 2 : 1);
  $('live').hidden = shown === 0;

  paintAvatar($('me-avatar'), myNick, myId);
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
if (myNick) join(); else openProfile();
