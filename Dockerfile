# Build: compiles the server (the HTML/JS are embedded in the binary).
FROM rust:1-slim-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY static ./static
RUN cargo build --release --locked

# Run: just the binary on a minimal image.
FROM gcr.io/distroless/cc-debian12
COPY --from=build /app/target/release/call-app /call-app
ENV PORT=3000
EXPOSE 3000
USER nonroot
CMD ["/call-app"]
