//! Screen sharing between friends: serves the pages and relays WebRTC signaling.

mod rooms;
mod signaling;

use std::error::Error;

use axum::{
    extract::Path,
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

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let port = match std::env::var("PORT") {
        Ok(value) => value
            .parse()
            .map_err(|_| format!("PORT inválida: {value:?}"))?,
        Err(_) => DEFAULT_PORT,
    };

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    println!("Servidor em http://localhost:{port}");
    axum::serve(listener, app(Rooms::default())).await?;
    Ok(())
}

fn app(rooms: Rooms) -> Router {
    Router::new()
        .route("/", get(|| async { Html(INDEX_HTML) }))
        .route("/room/{id}", get(room_page))
        .route("/room.js", get(room_js))
        .route("/ws/{id}", get(signaling::ws_handler))
        .with_state(rooms)
}

async fn room_page(Path(id): Path<String>) -> Response {
    if valid_room_id(&id) {
        Html(ROOM_HTML).into_response()
    } else {
        Redirect::to("/").into_response()
    }
}

async fn room_js() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        ROOM_JS,
    )
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
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app(Rooms::default())).await });
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
    }

    #[tokio::test]
    async fn signaling_over_websocket() {
        let addr = start_server().await;

        let mut a = connect(&addr, "room1").await;
        assert_eq!(
            recv(&mut a).await,
            json!({ "type": "welcome", "id": 1, "peers": [] })
        );

        let mut b = connect(&addr, "room1").await;
        assert_eq!(
            recv(&mut b).await,
            json!({ "type": "welcome", "id": 2, "peers": [1] })
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
    async fn seventh_participant_gets_room_full() {
        let addr = start_server().await;
        let mut clients = Vec::new();
        for _ in 0..rooms::MAX_PEERS {
            let mut ws = connect(&addr, "busy").await;
            recv(&mut ws).await;
            clients.push(ws);
        }

        let mut extra = connect(&addr, "busy").await;
        assert_eq!(recv(&mut extra).await, json!({ "type": "full" }));
        assert!(matches!(
            extra.next().await,
            Some(Ok(Message::Close(_))) | None
        ));
    }
}
