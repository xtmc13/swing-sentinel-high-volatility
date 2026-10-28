FROM rust:1.85-bookworm AS build
WORKDIR /src
COPY Cargo.toml ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 appuser
COPY --from=build /src/target/release/swing-sentinel-core /usr/local/bin/swing-sentinel-core
USER appuser
EXPOSE 8787
CMD ["/usr/local/bin/swing-sentinel-core"]
