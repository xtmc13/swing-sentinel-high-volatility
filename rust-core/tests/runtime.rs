use swing_sentinel_core::{
    config::DetectorConfig,
    model::{AggTrade, DepthLevel, DepthSnapshot, DepthUpdate, MarkPrice, PublicEvent, Side},
    runtime::SymbolRuntime,
};

fn level(price: f64, quantity: f64) -> DepthLevel {
    DepthLevel { price, quantity }
}

fn runtime(config: DetectorConfig) -> SymbolRuntime {
    let mut runtime = SymbolRuntime::new("BTCUSDT", config, 8);
    runtime.load_snapshot(DepthSnapshot {
        last_update_id: 100,
        bids: vec![level(100.4, 14.0)],
        asks: vec![level(100.6, 6.0)],
    });
    runtime
}

fn depth(first: u64, final_id: u64, previous: u64, event_time: i64) -> PublicEvent {
    PublicEvent::Depth {
        data: DepthUpdate {
            first_update_id: first,
            final_update_id: final_id,
            previous_final_update_id: previous,
            event_time,
            bids: vec![level(100.4, 14.0)],
            asks: vec![level(100.6, 6.0)],
        },
        received_time: event_time + 1,
    }
}

#[test]
fn runtime_composes_public_events_into_a_confirmed_candidate() {
    let mut runtime = runtime(DetectorConfig {
        min_history: 2,
        ..DetectorConfig::default()
    });
    runtime.handle(
        PublicEvent::MarkPrice {
            data: MarkPrice {
                event_time: 9_000,
                price: 100.0,
            },
            received_time: 9_001,
        },
        9_001,
    );
    runtime.handle(
        PublicEvent::MarkPrice {
            data: MarkPrice {
                event_time: 10_000,
                price: 101.0,
            },
            received_time: 10_001,
        },
        10_001,
    );
    runtime.handle(
        PublicEvent::Trade {
            data: AggTrade {
                event_time: 10_000,
                price: 101.0,
                quantity: 20.0,
                is_buyer_maker: false,
            },
            received_time: 10_001,
        },
        10_001,
    );
    runtime.handle(
        PublicEvent::Trade {
            data: AggTrade {
                event_time: 10_000,
                price: 101.0,
                quantity: 5.0,
                is_buyer_maker: true,
            },
            received_time: 10_001,
        },
        10_001,
    );

    let first = runtime.handle(depth(99, 101, 98, 10_000), 10_001);
    assert!(first.candidate.is_none());
    assert!(first.frame.is_some());
    let second = runtime.handle(depth(102, 102, 101, 10_010), 10_011);
    let candidate = second.candidate.expect("two consecutive qualifying frames");
    assert_eq!(candidate.side, Side::Long);
    assert_eq!(candidate.frame.sequence, 102);
}

#[test]
fn runtime_depth_gap_fails_closed_and_requests_resync() {
    let mut runtime = runtime(DetectorConfig::default());
    runtime.handle(depth(99, 101, 98, 10_000), 10_001);
    let output = runtime.handle(depth(110, 111, 999, 10_010), 10_011);
    assert!(output.resync_required);
    assert!(output.frame.is_none());
    assert!(output.candidate.is_none());
}

#[test]
fn reconnect_runtime_preserves_supplied_monotonic_generation() {
    let mut first = SymbolRuntime::new_with_generation("BTCUSDT", DetectorConfig::default(), 8, 41);
    first.load_snapshot(DepthSnapshot {
        last_update_id: 100,
        bids: vec![level(100.4, 14.0)],
        asks: vec![level(100.6, 6.0)],
    });
    let first_frame = first
        .handle(depth(99, 101, 98, 10_000), 10_001)
        .frame
        .unwrap();
    assert_eq!(first_frame.generation, 41);

    let mut reconnected =
        SymbolRuntime::new_with_generation("BTCUSDT", DetectorConfig::default(), 8, 42);
    reconnected.load_snapshot(DepthSnapshot {
        last_update_id: 200,
        bids: vec![level(100.4, 14.0)],
        asks: vec![level(100.6, 6.0)],
    });
    let frame = reconnected
        .handle(depth(199, 201, 198, 10_010), 10_011)
        .frame
        .unwrap();
    assert_eq!(frame.generation, 42);
    assert!(frame.generation > first_frame.generation);
}

#[test]
fn history_overflow_requests_fail_closed_resync() {
    let mut runtime = runtime(DetectorConfig {
        max_trade_history: 1,
        ..DetectorConfig::default()
    });
    let trade = PublicEvent::Trade {
        data: AggTrade {
            event_time: 10_000,
            price: 100.0,
            quantity: 1.0,
            is_buyer_maker: false,
        },
        received_time: 10_001,
    };
    assert!(!runtime.handle(trade.clone(), 10_001).resync_required);
    let output = runtime.handle(trade, 10_001);
    assert!(output.resync_required);
    assert!(output.candidate.is_none());
}
