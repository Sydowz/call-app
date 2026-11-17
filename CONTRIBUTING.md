# Como contribuir

Obrigado pelo interesse! O projeto aceita contribuições, mas **toda mudança passa pela revisão e aprovação do mantenedor** antes de entrar.

## Fluxo

1. **Comece por uma issue.** Escolha uma aberta ou abra uma nova descrevendo o problema ou a ideia. Para mudanças grandes, espere um "ok" na issue antes de programar.
2. **Faça um fork** e crie a sua branch a partir de `development`:
   - `feat/<nome>` para funcionalidades
   - `fix/<nome>` para correções
3. **Abra o PR para `development`** (nunca para `main`), citando a issue (`Closes #N`).
4. O mantenedor revisa. O PR só é mergeado depois da aprovação dele. Ninguém faz push direto em `main` ou `development`.
5. A `main` só recebe código por PR vindo da `development`, também aprovado pelo mantenedor.

## Antes de abrir o PR

```sh
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo test
```

Teste no navegador também: rode `cargo run --release`, abra a mesma sala em dois navegadores (ou numa aba anônima) e confira o que você mudou. Conte no PR como testou.

## Princípios do projeto

- **Simples e leve:** HTML e JavaScript puros, sem framework nem bundler, e o mínimo de dependências em Rust. Uma dependência nova precisa de justificativa no PR.
- **O servidor não guarda nada:** ele só repassa a sinalização e o chat. Nada de banco de dados, logs com dados pessoais ou mídia passando pelo servidor sem discussão prévia numa issue.
- **Leve para quem joga:** mudanças que aumentem o uso de CPU ou GPU de quem compartilha precisam de cuidado extra.

## Segurança

Achou uma vulnerabilidade? **Não abra uma issue pública.** Use "Report a vulnerability" na aba *Security* do repositório, para o reporte ficar privado até a correção.
