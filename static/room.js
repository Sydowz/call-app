'use strict';

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const roomId = location.pathname.split('/').pop();

const $ = (id) => document.getElementById(id);
const shareBtn = $('share');
const stopBtn = $('stop');
const statusEl = $('status');
const peopleEl = $('people');
const emptyEl = $('empty');
const grid = $('grid');

let myId = null;
let localTrack = null; // our screen's video track while sharing
let roomFull = false;
const peers = new Map(); // id -> { id, pc, transceiver, sharing, queue, tile, label, video }

const STATE_TEXT = {
  new: 'conectando…',
  connecting: 'conectando…',
  disconnected: 'conexão instável…',
  failed: 'falha na conexão P2P',
  closed: 'desconectado',
};

// ---------- link da sala ----------

$('link').value = location.href;
$('copy').onclick = () => {
  $('link').select();
  navigator.clipboard?.writeText(location.href).then(() => {
    $('copy').textContent = 'Copiado!';
    setTimeout(() => ($('copy').textContent = 'Copiar'), 1500);
  }, () => {});
};

const canShare = !!navigator.mediaDevices?.getDisplayMedia;
if (!canShare) {
  $('hint').textContent =
    'Este navegador só permite compartilhar a tela em HTTPS ou localhost (veja o README). Você ainda pode assistir.';
}

// ---------- sinalização (WebSocket) ----------

const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${roomId}`);

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  switch (msg.type) {
    case 'welcome':
      myId = msg.id;
      shareBtn.disabled = !canShare;
      updateStatus();
      for (const id of msg.peers) createPeer(id, true);
      refresh();
      break;
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
};

ws.onclose = () => {
  shareBtn.disabled = true;
  statusEl.textContent = roomFull
    ? 'Sala cheia (máximo de 6 pessoas).'
    : 'Desconectado do servidor. Recarregue a página para entrar de novo.';
};

function send(to, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ to, data }));
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
  const peer = { id, pc, transceiver: null, sharing: false, queue: Promise.resolve() };
  peers.set(id, peer);
  buildTile(peer);

  pc.onicecandidate = (e) => {
    if (e.candidate) send(id, { candidate: e.candidate });
  };
  pc.onconnectionstatechange = () => updateTile(peer);

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

  updateTile(peer);
  return peer;
}

function attachTransceiver(peer, transceiver) {
  peer.transceiver = transceiver;
  // The receiver track exists from the start; it simply has no frames until
  // the other side calls replaceTrack() with its screen.
  peer.video.srcObject = new MediaStream([transceiver.receiver.track]);
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
    updateTile(peer);
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
  peer.tile.remove();
  peers.delete(id);
  refresh();
}

// ---------- compartilhar / parar ----------

shareBtn.onclick = async () => {
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
  peers.forEach(sendScreenTo);
  shareBtn.hidden = true;
  stopBtn.hidden = false;
  updateStatus();
};

stopBtn.onclick = stopShare;

function stopShare() {
  if (!localTrack) return;
  localTrack.onended = null;
  localTrack.stop();
  localTrack = null;
  peers.forEach(sendScreenTo);
  shareBtn.hidden = false;
  stopBtn.hidden = true;
  updateStatus();
}

// ---------- interface ----------

function buildTile(peer) {
  peer.tile = document.createElement('div');
  peer.tile.className = 'tile';
  peer.label = document.createElement('div');
  peer.label.className = 'label';
  peer.video = document.createElement('video');
  peer.video.autoplay = true;
  peer.video.muted = true;
  peer.video.playsInline = true;
  peer.video.title = 'Duplo clique para tela cheia';
  peer.video.ondblclick = () => peer.video.requestFullscreen?.();
  peer.tile.append(peer.label, peer.video);
  grid.append(peer.tile);
}

function updateTile(peer) {
  const state = STATE_TEXT[peer.pc.connectionState];
  peer.label.textContent = `Participante ${peer.id}` + (state ? ` (${state})` : '');
  peer.tile.hidden = !peer.sharing;
  if (peer.sharing) peer.video.play().catch(() => {});
  refresh();
}

function updateStatus() {
  statusEl.textContent =
    `Você é o Participante ${myId}.` + (localTrack ? ' Você está compartilhando sua tela.' : '');
}

function refresh() {
  const list = [...peers.values()];
  emptyEl.hidden = list.some((p) => p.sharing);
  const names = list.map((p) => {
    const state = STATE_TEXT[p.pc.connectionState];
    return `Participante ${p.id}` + (state ? ` (${state})` : '');
  });
  peopleEl.textContent =
    `Na sala (${list.length + 1}/6): você` + (names.length ? ', ' + names.join(', ') : '');
}
