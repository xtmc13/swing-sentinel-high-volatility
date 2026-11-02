use std::time::Duration;

use futures_util::StreamExt;
use swing_sentinel_core::public_market::BinancePublicClient;
use tokio::time::timeout;

#[tokio::test]
#[ignore = "bounded read-only Binance mainnet public smoke"]
async fn public_snapshot_and_three_stream_events() {
    let client = BinancePublicClient::new(Duration::from_secs(5)).unwrap();
    let snapshot = client.depth_snapshot("BTCUSDT", 5).await.unwrap();
    assert!(snapshot.last_update_id > 0);
    assert!(!snapshot.bids.is_empty());
    assert!(!snapshot.asks.is_empty());

    let mut socket = client.connect("BTCUSDT").await.unwrap();
    let mut events = 0;
    while events < 3 {
        let message = timeout(Duration::from_secs(10), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if BinancePublicClient::parse_text(1_000, &message)
            .unwrap()
            .is_some()
        {
            events += 1;
        }
    }
    timeout(Duration::from_secs(2), socket.close(None))
        .await
        .unwrap()
        .unwrap();
    println!(
        "public smoke: snapshot={}, events={events}",
        snapshot.last_update_id
    );
}
