use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::{header, StatusCode},
    response::{Html, IntoResponse, Redirect, Response},
    routing::get,
    Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

const MAX_PEERS: usize = 6;

const INDEX_HTML: &str = include_str!("../static/index.html");
const ROOM_HTML: &str = include_str!("../static/room.html");
const ROOM_JS: &str = include_str!("../static/room.js");

/// Channel used to push text messages to one participant's WebSocket.
type Tx = mpsc::UnboundedSender<String>;

#[derive(Default)]
struct Room {
    next_id: u32,
    peers: HashMap<u32, Tx>,
}

type Rooms = Arc<Mutex<HashMap<String, Room>>>;

/// The only message a client sends: "deliver `data` to participant `to`".
/// `data` (offer, answer, ICE candidate, sharing on/off) is relayed untouched.
#[derive(Deserialize)]
struct ClientMsg {
    to: u32,
    data: Value,
}

#[tokio::main]
async fn main() {
    let rooms: Rooms = Arc::default();

    let app = Router::new()
        .route("/", get(|| async { Html(INDEX_HTML) }))
        .route("/room/{id}", get(room_page))
        .route(
            "/room.js",
            get(|| async { ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], ROOM_JS) }),
        )
        .route("/ws/{id}", get(ws_handler))
        .with_state(rooms);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("não foi possível abrir a porta");
    println!("Servidor em http://localhost:{port}");
    axum::serve(listener, app).await.unwrap();
}

fn valid_room_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Short prefix of the room ID for logs, so the full link never lands in them.
fn short(id: &str) -> &str {
    &id[..id.len().min(6)]
}

async fn room_page(Path(id): Path<String>) -> Response {
    if valid_room_id(&id) {
        Html(ROOM_HTML).into_response()
    } else {
        Redirect::to("/").into_response()
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(room_id): Path<String>,
    State(rooms): State<Rooms>,
) -> Response {
    if !valid_room_id(&room_id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    ws.max_message_size(64 * 1024)
        .on_upgrade(move |socket| handle_socket(socket, room_id, rooms))
}

async fn handle_socket(mut socket: WebSocket, room_id: String, rooms: Rooms) {
    let (tx, mut rx) = mpsc::unbounded_channel();

    let Some((my_id, others)) = join(&rooms, &room_id, tx) else {
        let _ = socket.send(text(json!({ "type": "full" }))).await;
        let _ = socket.send(Message::Close(None)).await;
        return;
    };

    let welcome = json!({ "type": "welcome", "id": my_id, "peers": others });
    if socket.send(text(welcome)).await.is_ok() {
        loop {
            tokio::select! {
                incoming = socket.recv() => match incoming {
                    Some(Ok(Message::Text(msg))) => relay(&rooms, &room_id, my_id, msg.as_str()),
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {} // binary/ping/pong: ignored
                },
                outgoing = rx.recv() => match outgoing {
                    Some(msg) => {
                        if socket.send(Message::Text(msg.into())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                },
            }
        }
    }

    leave(&rooms, &room_id, my_id);
}

fn text(value: Value) -> Message {
    Message::Text(value.to_string().into())
}

/// Adds a participant to the room. Returns its number and the numbers of the
/// participants already there, or `None` if the room is full.
fn join(rooms: &Rooms, room_id: &str, tx: Tx) -> Option<(u32, Vec<u32>)> {
    let mut rooms = rooms.lock().unwrap();
    let room = rooms.entry(room_id.to_string()).or_default();
    if room.peers.len() >= MAX_PEERS {
        println!("[sala {}] entrada recusada: sala cheia", short(room_id));
        return None;
    }

    room.next_id += 1;
    let id = room.next_id;
    let others: Vec<u32> = room.peers.keys().copied().collect();

    let msg = json!({ "type": "peer-joined", "id": id }).to_string();
    for peer in room.peers.values() {
        let _ = peer.send(msg.clone());
    }
    room.peers.insert(id, tx);

    println!(
        "[sala {}] participante {id} entrou ({}/{MAX_PEERS})",
        short(room_id),
        room.peers.len()
    );
    Some((id, others))
}

fn relay(rooms: &Rooms, room_id: &str, from: u32, msg: &str) {
    let Ok(msg) = serde_json::from_str::<ClientMsg>(msg) else {
        return;
    };
    let out = json!({ "type": "signal", "from": from, "data": msg.data }).to_string();
    let rooms = rooms.lock().unwrap();
    if let Some(peer) = rooms.get(room_id).and_then(|r| r.peers.get(&msg.to)) {
        let _ = peer.send(out);
    }
}

fn leave(rooms: &Rooms, room_id: &str, id: u32) {
    let mut rooms = rooms.lock().unwrap();
    let Some(room) = rooms.get_mut(room_id) else {
        return;
    };
    room.peers.remove(&id);
    let remaining = room.peers.len();

    let msg = json!({ "type": "peer-left", "id": id }).to_string();
    for peer in room.peers.values() {
        let _ = peer.send(msg.clone());
    }

    println!(
        "[sala {}] participante {id} saiu ({remaining}/{MAX_PEERS})",
        short(room_id)
    );
    if remaining == 0 {
        rooms.remove(room_id);
        println!("[sala {}] vazia, apagada", short(room_id));
    }
}
