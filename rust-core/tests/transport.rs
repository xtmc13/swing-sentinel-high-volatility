use std::time::Duration;

use swing_sentinel_core::{
    config::DetectorConfig,
    model::{Candidate, FeatureFrame, MarketQuality, Side},
    transport::CandidateSender,
};

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

#[test]
fn candidate_sender_accepts_only_literal_loopback_http_endpoints() {
    assert!(CandidateSender::new(
        "http://127.0.0.1:8787/v1/momentum/candidate",
        Duration::from_millis(500)
    )
    .is_ok());
    assert!(CandidateSender::new(
        "http://[::1]:8787/v1/momentum/candidate",
        Duration::from_millis(500)
    )
    .is_ok());
    assert!(CandidateSender::new(
        "https://example.com/v1/momentum/candidate",
        Duration::from_millis(500)
    )
    .is_err());
    assert!(CandidateSender::new(
        "http://localhost:8787/v1/momentum/candidate",
        Duration::from_millis(500)
    )
    .is_err());
    assert!(CandidateSender::new(
        "http://user:password@127.0.0.1:8787/v1/momentum/candidate",
        Duration::from_millis(500)
    )
    .is_err());
}

#[test]
fn candidate_json_is_strict_and_rejects_unknown_fields() {
    let mut encoded = serde_json::to_value(candidate()).unwrap();
    encoded
        .as_object_mut()
        .unwrap()
        .insert("unexpected".into(), true.into());
    assert!(serde_json::from_value::<Candidate>(encoded).is_err());
}

#[test]
fn invalid_candidate_is_not_delivered() {
    let sender =
        CandidateSender::new("http://127.0.0.1:9/candidate", Duration::from_millis(50)).unwrap();
    let mut invalid = candidate();
    invalid.frame.quality = MarketQuality::Stale;
    let error = sender.validate_payload(&invalid).unwrap_err();
    assert_eq!(error, "invalid_candidate_metadata");
}

#[test]
fn non_finite_or_negative_feature_values_are_not_delivered() {
    let sender =
        CandidateSender::new("http://127.0.0.1:9/candidate", Duration::from_millis(50)).unwrap();
    let mut invalid = candidate();
    invalid.frame.burst_z = Some(f64::NAN);
    assert_eq!(
        sender.validate_payload(&invalid),
        Err("invalid_feature_values")
    );

    let mut invalid = candidate();
    invalid.frame.aggressive_buy_volume = -1.0;
    assert_eq!(
        sender.validate_payload(&invalid),
        Err("invalid_feature_values")
    );
}

#[tokio::test]
async fn candidate_sender_posts_strict_json_to_real_loopback_endpoint() {
    use axum::{body::Bytes, http::StatusCode, routing::post, Router};
    use tokio::sync::oneshot;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (tx, rx) = oneshot::channel();
    let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
    let app = Router::new().route(
        "/candidate",
        post(move |body: Bytes| {
            let tx = tx.clone();
            async move {
                if let Some(tx) = tx.lock().unwrap().take() {
                    tx.send(body).unwrap();
                }
                StatusCode::ACCEPTED
            }
        }),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let sender = CandidateSender::new(
        format!("http://{address}/candidate"),
        Duration::from_millis(500),
    )
    .unwrap();

    sender.send(candidate()).await.unwrap();
    let body = tokio::time::timeout(Duration::from_millis(500), rx)
        .await
        .unwrap()
        .unwrap();
    let decoded: Candidate = serde_json::from_slice(&body).unwrap();
    assert_eq!(decoded, candidate());
    server.abort();
}

#[tokio::test]
async fn every_feature_frame_can_be_posted_to_the_loopback_frame_endpoint() {
    use axum::{body::Bytes, http::StatusCode, routing::post, Router};
    use tokio::sync::oneshot;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (tx, rx) = oneshot::channel();
    let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
    let app = Router::new().route(
        "/v1/momentum/frame",
        post(move |body: Bytes| {
            let tx = tx.clone();
            async move {
                if let Some(tx) = tx.lock().unwrap().take() {
                    tx.send(body).unwrap();
                }
                StatusCode::ACCEPTED
            }
        }),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let sender = CandidateSender::new(
        format!("http://{address}/v1/momentum/candidate"),
        Duration::from_millis(500),
    )
    .unwrap();

    sender.send_frame(candidate().frame).await.unwrap();
    let body = tokio::time::timeout(Duration::from_millis(500), rx)
        .await
        .unwrap()
        .unwrap();
    let decoded: FeatureFrame = serde_json::from_slice(&body).unwrap();
    assert_eq!(decoded, candidate().frame);
    server.abort();
}
