use std::time::Duration;

use swing_sentinel_core::{diagnostics::DiagnosticsState, http};

#[tokio::test]
async fn health_diagnostics_and_legacy_empty_batch_remain_compatible() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let diagnostics = DiagnosticsState::disabled(DetectorConfigForHttp::config_hash());
    let app = http::router(diagnostics);
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let client = reqwest::Client::new();

    let health = client
        .get(format!("http://{address}/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(health.status(), 200);
    assert_eq!(health.text().await.unwrap(), "ok");

    let diagnostics = client
        .get(format!("http://{address}/diagnostics"))
        .send()
        .await
        .unwrap();
    assert_eq!(diagnostics.status(), 200);
    let body: serde_json::Value = diagnostics.json().await.unwrap();
    assert_eq!(body["enabled"], false);
    assert_eq!(
        body["config_hash"],
        swing_sentinel_core::config::DetectorConfig::default().config_hash()
    );

    let batch = client
        .post(format!("http://{address}/v1/analyze/batch"))
        .json(&serde_json::json!([]))
        .timeout(Duration::from_millis(500))
        .send()
        .await
        .unwrap();
    assert_eq!(batch.status(), 200);
    let body: serde_json::Value = batch.json().await.unwrap();
    assert_eq!(body["count"], 0);
    assert_eq!(body["signals"], serde_json::json!([]));
    server.abort();
}

struct DetectorConfigForHttp;

impl DetectorConfigForHttp {
    fn config_hash() -> String {
        swing_sentinel_core::config::DetectorConfig::default().config_hash()
    }
}
