use std::net::SocketAddr;

use swing_sentinel_core::{
    diagnostics::DiagnosticsState,
    http,
    service::{self, MomentumSettings},
};

#[tokio::main]
async fn main() {
    let settings = MomentumSettings::from_env().expect("valid momentum settings");
    let diagnostics = if settings.enabled {
        DiagnosticsState::enabled(settings.config.config_hash())
    } else {
        DiagnosticsState::disabled(settings.config.config_hash())
    };
    if settings.enabled {
        tokio::spawn(service::run(settings, diagnostics.clone()));
    }

    let address: SocketAddr = std::env::var("RUST_CORE_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8787".into())
        .parse()
        .expect("valid RUST_CORE_ADDR");
    assert!(
        address.ip().is_loopback(),
        "RUST_CORE_ADDR must be loopback"
    );
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .expect("bind rust core");
    println!("swing-sentinel Rust shadow core listening on {address}");
    axum::serve(listener, http::router(diagnostics))
        .await
        .expect("serve rust core");
}
