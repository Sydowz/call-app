# call-app

Compartilhamento de tela entre amigos. Você abre o link, manda para a galera e cada um pode compartilhar a própria tela, com um chat de texto da sala. Não tem câmera nem conta.

- Servidor em Rust (axum + tokio) que só retransmite a sinalização WebRTC por WebSocket.
- O vídeo vai direto de navegador para navegador (P2P, mesh), com STUN público do Google.
- Cada pessoa escolhe um nick e, se quiser, uma foto (reduzida para 128×128 no próprio navegador). Os dois ficam salvos só no navegador e vão para os outros pelo canal de sinalização; o servidor não registra nada.
- Chat da sala pelo mesmo WebSocket da sinalização, para funcionar mesmo quando a conexão direta de vídeo falha. O servidor só repassa as mensagens: não grava nem registra nada, e quem entra depois não vê as anteriores.
- Até 12 pessoas por sala (configurável). As salas ficam só na memória e somem quando a última pessoa sai.

## Rodar

Precisa do Rust ([rustup.rs](https://rustup.rs)).

```sh
cargo run --release
```

Abra http://localhost:3000. Você cai numa sala nova (`/room/<id>`). É só copiar o link e mandar. Variáveis opcionais: `PORT` (padrão 3000) e `MAX_PEERS` (pessoas por sala, padrão 12), por exemplo `PORT=8080 MAX_PEERS=20 cargo run --release`.

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
- Mesh: quem compartilha envia uma cópia do vídeo para cada pessoa *que está assistindo*. Com a sala cheia (12) isso dá até 11 envios, o que exige um bom upload; salas bem maiores pedem um servidor de mídia (SFU, issue #25).
- Se cair a conexão com o servidor, é preciso recarregar a página (não há reconexão automática).

## Decisões técnicas

- **HTML/JS embutidos no binário com `include_str!` em vez de `tower-http`**: uma dependência a menos e um binário único. A desvantagem é que qualquer mudança no HTML exige recompilar.
- **ID da sala gerado no navegador (`crypto.getRandomValues`)**: o servidor não precisa do crate `rand`.
- **Uma única transceiver de vídeo `sendrecv` por par, negociada uma vez só, por quem entra**: iniciar e parar o compartilhamento é só `replaceTrack()`, sem renegociação. Assim não há colisão de offers e o padrão "perfect negotiation" fica dispensável.
- **H.264 só quando ajuda**: cada navegador detecta se codifica H.264 na placa de vídeo (Media Capabilities, `powerEfficient`) e avisa os outros junto com o nick. Quem compartilha só usa H.264 se tiver encoder de hardware e quem assiste não for Firefox (que depende de um plugin que pode faltar); senão, VP8, que funciona em todo navegador.
- **Modo Jogo / Texto**: Jogo (padrão) prioriza fluidez, até 720p a 30 FPS com `contentHint = "motion"`; Texto prioriza nitidez, até 1080p a 15 FPS com `contentHint = "text"`. Os limites ficam no encoder (`scaleResolutionDownBy`, `maxFramerate`, `maxBitrate` de 2,5 Mbps), o que funciona com qualquer captura. No Jogo a imagem começa mais baixa e fica nítida em uns 15 s, conforme a estimativa de banda sobe.
- **Assistir sob demanda**: quem compartilha só envia o vídeo para quem clicou em "Assistir" (`replaceTrack` com a track para quem assiste e `null` para os outros). Assim ninguém codifica nem decodifica vídeo que não está sendo visto, o que pesa bastante para quem está jogando.
- **O aviso "compartilhando/parou" vai pelo próprio WebSocket** em vez de um DataChannel. O servidor repassa esse aviso sem ler o conteúdo, como faz com o resto.
- **`tokio::select!` num socket só, em vez de dividi-lo**: dispensa o crate `futures-util`.
- **Erros com `Result` e `?` (`Box<dyn Error>` no `main`) em vez de `anyhow`**: o servidor só tem dois pontos de falha, abrir a porta e ler `PORT`.
- **`println!` em vez de `tracing`**: os logs mostram só o número do participante e os 6 primeiros caracteres da sala. Não registram IP nem o link completo.

## Contribuir

Contribuições são bem-vindas, sempre com revisão do mantenedor. Veja o [CONTRIBUTING.md](CONTRIBUTING.md).

## Licença

[MIT](LICENSE).
