# call-app

Compartilhamento de tela entre amigos. Você abre o link, manda para a galera e cada um pode compartilhar a própria tela. Não tem câmera, chat nem conta.

- Servidor em Rust (axum + tokio) que só retransmite a sinalização WebRTC por WebSocket.
- O vídeo vai direto de navegador para navegador (P2P, mesh), com STUN público do Google.
- Até 6 pessoas por sala. As salas ficam só na memória e somem quando a última pessoa sai.

## Rodar

Precisa do Rust ([rustup.rs](https://rustup.rs)).

```sh
cargo run --release
```

Abra http://localhost:3000. Você cai numa sala nova (`/room/<id>`). É só copiar o link e mandar. Para usar outra porta: `PORT=8080 cargo run --release`.

## Testar

**Duas abas (mesmo computador):** abra http://localhost:3000, copie o link da sala e abra numa segunda aba ou janela. Clique em "Compartilhar tela" numa delas e a tela aparece na outra. Dica: compartilhe uma *outra* janela ou aba para não criar o efeito de espelho infinito. Dê um duplo clique no vídeo para ver em tela cheia.

**Dois computadores:** o servidor escuta em `0.0.0.0`, então na mesma rede dá para abrir `http://<IP-do-servidor>:3000/room/<id>`. Mas atenção: **os navegadores só liberam o compartilhamento de tela em HTTPS ou `localhost`**. Por HTTP pela rede, a pessoa consegue *assistir*, mas não *compartilhar*. Opções:

- Túnel HTTPS (mais fácil, funciona também pela internet): `cloudflared tunnel --url http://localhost:3000` (ou ngrok). Use o link `https://…` que ele mostrar.
- Só para teste na rede local, no Chrome: em `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, adicione `http://<IP>:3000` e reinicie o navegador.

## Desenvolvimento

```sh
cargo fmt                                  # formata
cargo clippy --all-targets -- -D warnings  # lints (deve passar sem avisos)
cargo test                                 # testes das salas e da sinalização via WebSocket
```

Código: [src/main.rs](src/main.rs) (rotas e páginas), [src/rooms.rs](src/rooms.rs) (salas em memória) e [src/signaling.rs](src/signaling.rs) (WebSocket).

## Limitações

- Sem TURN: em algumas redes (NAT simétrico, redes corporativas, alguns 4G) a conexão P2P falha. O nome do participante aparece com "falha na conexão P2P".
- Mesh: quem compartilha envia uma cópia do vídeo para cada pessoa. Com 6 pessoas isso dá até 5 envios, o que exige um bom upload.
- Se cair a conexão com o servidor, é preciso recarregar a página (não há reconexão automática).

## Decisões técnicas

- **HTML/JS embutidos no binário com `include_str!` em vez de `tower-http`**: uma dependência a menos e um binário único. A desvantagem é que qualquer mudança no HTML exige recompilar.
- **ID da sala gerado no navegador (`crypto.getRandomValues`)**: o servidor não precisa do crate `rand`.
- **Uma única transceiver de vídeo `sendrecv` por par, negociada uma vez só, por quem entra**: iniciar e parar o compartilhamento é só `replaceTrack()`, sem renegociação. Assim não há colisão de offers e o padrão "perfect negotiation" fica dispensável.
- **O aviso "compartilhando/parou" vai pelo próprio WebSocket** em vez de um DataChannel. O servidor repassa esse aviso sem ler o conteúdo, como faz com o resto.
- **`tokio::select!` num socket só, em vez de dividi-lo**: dispensa o crate `futures-util`.
- **Erros com `Result` e `?` (`Box<dyn Error>` no `main`) em vez de `anyhow`**: o servidor só tem dois pontos de falha, abrir a porta e ler `PORT`.
- **`println!` em vez de `tracing`**: os logs mostram só o número do participante e os 6 primeiros caracteres da sala. Não registram IP nem o link completo.
