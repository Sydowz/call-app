//! Screen sharing between friends: serves the pages and relays WebRTC signaling.

mod rooms;
mod signaling;

use std::error::Error;

use axum::{
    extract::{Path, RawQuery, State},
    http::header,
    response::{Html, IntoResponse, Redirect, Response},
    routing::get,
    Router,
};

use rooms::{valid_room_id, Rooms};

const DEFAULT_PORT: u16 = 3000;

const INDEX_HTML: &str = include_str!("../static/index.html");
const ROOM_HTML: &str = include_str!("../static/room.html");
const ROOM_JS: &str = include_str!("../static/room.js");
const LOBBY_JS: &str = include_str!("../static/lobby.js");
const COMMON_JS: &str = include_str!("../static/common.js");
const COMMON_CSS: &str = include_str!("../static/common.css");

/// Most rooms the lobby may ask about in one request.
const MAX_COUNT_IDS: usize = 30;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let port = match std::env::var("PORT") {
        Ok(value) => value
            .parse()
            .map_err(|_| format!("PORT inválida: {value:?}"))?,
        Err(_) => DEFAULT_PORT,
    };
    let max_peers = match std::env::var("MAX_PEERS") {
        Ok(value) => value
            .parse()
            .ok()
            .filter(|&n: &usize| n >= 2)
            .ok_or_else(|| format!("MAX_PEERS inválido (mínimo 2): {value:?}"))?,
        Err(_) => rooms::DEFAULT_MAX_PEERS,
    };

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    println!("Servidor em http://localhost:{port} (até {max_peers} pessoas por sala)");
    axum::serve(listener, app(Rooms::new(max_peers))).await?;
    Ok(())
}

fn app(rooms: Rooms) -> Router {
    Router::new()
        .route("/", get(|| async { Html(INDEX_HTML) }))
        .route("/room/{id}", get(room_page))
        .route("/room.js", get(|| async { javascript(ROOM_JS) }))
        .route("/lobby.js", get(|| async { javascript(LOBBY_JS) }))
        .route("/common.js", get(|| async { javascript(COMMON_JS) }))
        .route(
            "/common.css",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
                    COMMON_CSS,
                )
            }),
        )
        .route("/api/rooms", get(room_counts))
        .route("/ws/{id}", get(signaling::ws_handler))
        // For the hosting platform's health checks.
        .route("/health", get(|| async { "ok" }))
        .with_state(rooms)
}

async fn room_page(Path(id): Path<String>) -> Response {
    if valid_room_id(&id) {
        Html(ROOM_HTML).into_response()
    } else {
        Redirect::to("/").into_response()
    }
}

fn javascript(source: &'static str) -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        source,
    )
}

/// `GET /api/rooms?ids=a,b,c` -> `{"a":3,"b":0,"c":0}`: how many people are in
/// each room the browser already knows. Only counts; no names, no listing.
async fn room_counts(State(rooms): State<Rooms>, RawQuery(query): RawQuery) -> Response {
    let query = query.unwrap_or_default();
    let ids: Vec<&str> = query
        .split('&')
        .filter_map(|pair| pair.strip_prefix("ids="))
        .flat_map(|list| list.split(','))
        .filter(|id| valid_room_id(id))
        .take(MAX_COUNT_IDS)
        .collect();
    let counts: serde_json::Map<String, serde_json::Value> = rooms
        .counts(&ids)
        .into_iter()
        .map(|(id, count)| (id.to_owned(), count.into()))
        .collect();
    (
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        serde_json::Value::Object(counts).to_string(),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use serde_json::{json, Value};
    use tokio::net::TcpStream;
    use tokio_tungstenite::{tungstenite::Message, MaybeTlsStream, WebSocketStream};

    type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;

    async fn start_server() -> String {
        start_server_with(Rooms::default()).await
    }

    async fn start_server_with(rooms: Rooms) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app(rooms)).await });
        format!("127.0.0.1:{}", addr.port())
    }

    async fn connect(addr: &str, room: &str) -> Client {
        let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws/{room}"))
            .await
            .unwrap();
        ws
    }

    async fn recv(ws: &mut Client) -> Value {
        loop {
            match ws.next().await.expect("connection closed").unwrap() {
                Message::Text(text) => return serde_json::from_str(&text).unwrap(),
                Message::Close(_) => panic!("connection closed"),
                _ => {}
            }
        }
    }

    async fn send(ws: &mut Client, value: Value) {
        ws.send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn pages_are_served() {
        let addr = start_server().await;
        let get = |path: &str| {
            let request = format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
            let addr = addr.clone();
            async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut stream = TcpStream::connect(addr).await.unwrap();
                stream.write_all(request.as_bytes()).await.unwrap();
                let mut response = String::new();
                stream.read_to_string(&mut response).await.unwrap();
                response
            }
        };

        assert!(get("/").await.starts_with("HTTP/1.1 200"));
        assert!(get("/room/abc123").await.contains("room.js"));
        assert!(get("/room/bad!id").await.starts_with("HTTP/1.1 303"));
        assert!(get("/room.js")
            .await
            .contains("content-type: text/javascript"));
        assert!(get("/common.js").await.contains("text/javascript"));
        assert!(get("/lobby.js").await.contains("text/javascript"));
        assert!(get("/common.css").await.contains("content-type: text/css"));
        let health = get("/health").await;
        assert!(health.starts_with("HTTP/1.1 200") && health.ends_with("ok"));
    }

    #[tokio::test]
    async fn signaling_over_websocket() {
        let addr = start_server().await;

        let mut a = connect(&addr, "room1").await;
        assert_eq!(
            recv(&mut a).await,
            json!({ "type": "welcome", "id": 1, "peers": [], "max": rooms::DEFAULT_MAX_PEERS })
        );

        let mut b = connect(&addr, "room1").await;
        assert_eq!(
            recv(&mut b).await,
            json!({ "type": "welcome", "id": 2, "peers": [1], "max": rooms::DEFAULT_MAX_PEERS })
        );
        assert_eq!(
            recv(&mut a).await,
            json!({ "type": "peer-joined", "id": 2 })
        );

        send(&mut b, json!("not a signal")).await; // ignored
        send(
            &mut b,
            json!({ "to": 1, "data": { "description": "offer" } }),
        )
        .await;
        assert_eq!(
            recv(&mut a).await,
            json!({ "type": "signal", "from": 2, "data": { "description": "offer" } })
        );

        b.close(None).await.unwrap();
        assert_eq!(recv(&mut a).await, json!({ "type": "peer-left", "id": 2 }));
    }

    #[tokio::test]
    async fn room_counts_endpoint() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let addr = start_server().await;
        let mut ws = connect(&addr, "countme").await;
        recv(&mut ws).await; // welcome: we are in

        let mut stream = TcpStream::connect(&addr).await.unwrap();
        let request = "GET /api/rooms?ids=countme,empty,bad!id HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n";
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();

        assert!(response.contains("content-type: application/json"));
        assert!(response.contains("cache-control: no-store"));
        let body = response.split("\r\n\r\n").nth(1).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(body).unwrap(),
            json!({ "countme": 1, "empty": 0 })
        );
    }

    #[tokio::test]
    async fn participant_over_the_limit_gets_room_full() {
        let addr = start_server_with(Rooms::new(3)).await;
        let mut clients = Vec::new();
        for _ in 0..3 {
            let mut ws = connect(&addr, "busy").await;
            recv(&mut ws).await;
            clients.push(ws);
        }

        let mut extra = connect(&addr, "busy").await;
        assert_eq!(recv(&mut extra).await, json!({ "type": "full", "max": 3 }));
        assert!(matches!(
            extra.next().await,
            Some(Ok(Message::Close(_))) | None
        ));
    }
}
