use swing_sentinel_core::config::DetectorConfig;
use swing_sentinel_core::features::{FeatureEngine, FrameInput};
use swing_sentinel_core::model::{AggTrade, DepthLevel, MarkPrice, MarketQuality};

fn level(price: f64, quantity: f64) -> DepthLevel {
    DepthLevel { price, quantity }
}

fn input(event_time: i64, received_time: i64) -> FrameInput {
    FrameInput {
        event_time,
        received_time,
        sequence: 42,
        generation: 7,
        bid: Some(level(99.0, 2.0)),
        ask: Some(level(101.0, 4.0)),
    }
}

#[test]
fn frame_computes_microstructure_flow_return_and_metadata() {
    let config = DetectorConfig {
        min_history: 2,
        ..DetectorConfig::default()
    };
    let expected_hash = config.config_hash();
    let mut engine = FeatureEngine::new("BTCUSDT", config);
    engine.push_mark(MarkPrice {
        event_time: 900,
        price: 100.0,
    });
    engine.push_mark(MarkPrice {
        event_time: 1_000,
        price: 101.0,
    });
    engine.push_trade(AggTrade {
        event_time: 1_000,
        price: 100.0,
        quantity: 6.0,
        is_buyer_maker: false,
    });
    engine.push_trade(AggTrade {
        event_time: 1_000,
        price: 100.0,
        quantity: 4.0,
        is_buyer_maker: true,
    });

    let frame = engine.build_frame(input(1_000, 1_001), 1_001);
    assert_eq!(frame.quality, MarketQuality::Good);
    assert_eq!(frame.symbol, "BTCUSDT");
    assert_eq!(frame.event_time, 1_000);
    assert_eq!(frame.received_time, 1_001);
    assert_eq!((frame.sequence, frame.generation), (42, 7));
    assert_eq!(frame.config_hash, expected_hash);
    assert!((frame.microprice.unwrap() - 99.666_666_666_7).abs() < 1e-9);
    assert!((frame.spread_bps.unwrap() - 200.0).abs() < 1e-9);
    assert!((frame.depth_imbalance.unwrap() + 1.0 / 3.0).abs() < 1e-9);
    assert_eq!(frame.aggressive_buy_volume, 6.0);
    assert_eq!(frame.aggressive_sell_volume, 4.0);
    assert!((frame.short_return.unwrap() - 0.01).abs() < 1e-12);
    assert_eq!(frame.realized_volatility, Some(0.0));
    assert!(frame.burst_z.is_some());
}

#[test]
fn stale_frame_is_explicitly_not_good() {
    let mut engine = FeatureEngine::new("BTCUSDT", DetectorConfig::default());
    let frame = engine.build_frame(input(1_000, 1_001), 5_000);
    assert_eq!(frame.quality, MarketQuality::Stale);
}

#[test]
fn one_sided_and_crossed_books_fail_closed() {
    let mut engine = FeatureEngine::new("BTCUSDT", DetectorConfig::default());
    let mut one_sided = input(1_000, 1_001);
    one_sided.ask = None;
    assert_eq!(
        engine.build_frame(one_sided, 1_001).quality,
        MarketQuality::OneSided
    );

    let mut crossed = input(1_000, 1_001);
    crossed.bid = Some(level(102.0, 1.0));
    assert_eq!(
        engine.build_frame(crossed, 1_001).quality,
        MarketQuality::Crossed
    );
}

#[test]
fn trade_and_mark_history_caps_fail_closed_on_overflow() {
    let config = DetectorConfig {
        max_trade_history: 1,
        max_mark_history: 1,
        ..DetectorConfig::default()
    };
    let trade = AggTrade {
        event_time: 1_000,
        price: 100.0,
        quantity: 1.0,
        is_buyer_maker: false,
    };
    let mut trade_engine = FeatureEngine::new("BTCUSDT", config.clone());
    trade_engine.push_trade(trade);
    trade_engine.push_trade(trade);
    assert_eq!(
        trade_engine.build_frame(input(1_000, 1_001), 1_001).quality,
        MarketQuality::HistoryOverflow
    );

    let mark = MarkPrice {
        event_time: 1_000,
        price: 100.0,
    };
    let mut mark_engine = FeatureEngine::new("BTCUSDT", config);
    mark_engine.push_mark(mark);
    mark_engine.push_mark(mark);
    assert_eq!(
        mark_engine.build_frame(input(1_000, 1_001), 1_001).quality,
        MarketQuality::HistoryOverflow
    );
}

#[test]
fn frame_uses_latest_mark_at_or_before_event_time_never_future_mark() {
    let mut engine = FeatureEngine::new(
        "BTCUSDT",
        DetectorConfig {
            min_history: 2,
            ..DetectorConfig::default()
        },
    );
    engine.push_mark(MarkPrice {
        event_time: 900,
        price: 100.0,
    });
    engine.push_mark(MarkPrice {
        event_time: 1_000,
        price: 101.0,
    });
    engine.push_mark(MarkPrice {
        event_time: 1_100,
        price: 999.0,
    });

    let frame = engine.build_frame(input(1_000, 1_001), 1_001);
    assert_eq!(frame.quality, MarketQuality::Good);
    assert_eq!(frame.mark_price, Some(101.0));
    assert!((frame.short_return.unwrap() - 0.01).abs() < 1e-12);
}
