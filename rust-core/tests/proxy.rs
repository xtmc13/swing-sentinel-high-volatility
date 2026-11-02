use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use swing_sentinel_core::{
    config::DetectorConfig,
    model::{Candidate, FeatureFrame, MarketQuality, Side},
    transport::CandidateSender,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn candidate() -> Candidate {
    Candidate {
        candidate_id: "BTCUSDT:3:9:LONG".into(),
        symbol: "BTCUSDT".into(),
        side: Side::Long,
        reference_price: 101.0,
        created_time: 10_012,
        expires_at: 10_762,
        frame: FeatureFrame {
            symbol: "BTCUSDT".into(),
            event_time: 10_009,
            received_time: 10_012,
            sequence: 9,
            generation: 3,
            quality: MarketQuality::Good,
            config_hash: DetectorConfig::default().config_hash(),
            mark_price: Some(101.0),
            microprice: Some(101.1),
            spread_bps: Some(5.0),
            depth_imbalance: Some(0.4),
            aggressive_buy_volume: 20.0,
            aggressive_sell_volume: 5.0,
            short_return: Some(0.002),
            burst_z: Some(3.0),
            realized_volatility: Some(0.01),
        },
    }
}

#[tokio::test]
async fn candidate_delivery_bypasses_system_proxy_environment() {
    let proxy_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_address = proxy_listener.local_addr().unwrap();
    let proxy_used = Arc::new(AtomicBool::new(false));
    let proxy_flag = proxy_used.clone();
    let proxy = tokio::spawn(async move {
        let (mut socket, _) = proxy_listener.accept().await.unwrap();
        proxy_flag.store(true, Ordering::SeqCst);
        let mut buffer = [0; 1024];
        let _ = socket.read(&mut buffer).await;
        socket
            .write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            .await
            .unwrap();
    });

    let target_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target_address = target_listener.local_addr().unwrap();
    let target = tokio::spawn(async move {
        axum::serve(
            target_listener,
            axum::Router::new().route(
                "/candidate",
                axum::routing::post(|| async { axum::http::StatusCode::ACCEPTED }),
            ),
        )
        .await
        .unwrap();
    });

    let proxy_url = format!("http://{proxy_address}");
    for key in [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        std::env::set_var(key, &proxy_url);
    }
    std::env::set_var("NO_PROXY", "");
    std::env::set_var("no_proxy", "");

    let sender = CandidateSender::new(
        format!("http://{target_address}/candidate"),
        Duration::from_millis(500),
    )
    .unwrap();
    sender.send(candidate()).await.unwrap();
    assert!(
        !proxy_used.load(Ordering::SeqCst),
        "loopback candidate used system proxy"
    );

    target.abort();
    proxy.abort();
}
