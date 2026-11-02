use swing_sentinel_core::candidate::CandidateDetector;
use swing_sentinel_core::config::DetectorConfig;
use swing_sentinel_core::model::{FeatureFrame, MarketQuality, Side};

fn qualifying_frame(sequence: u64) -> FeatureFrame {
    FeatureFrame {
        symbol: "BTCUSDT".into(),
        event_time: 10_000 + sequence as i64,
        received_time: 10_010 + sequence as i64,
        sequence,
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
    }
}

#[test]
fn single_qualifying_frame_is_not_a_candidate_but_consecutive_confirmation_emits() {
    let config = DetectorConfig {
        confirmations: 2,
        ..DetectorConfig::default()
    };
    let mut detector = CandidateDetector::new(config);

    assert!(detector.observe(qualifying_frame(1), 10_011).is_none());
    let candidate = detector
        .observe(qualifying_frame(2), 10_012)
        .expect("confirmed candidate");
    assert_eq!(candidate.side, Side::Long);
    assert_eq!(candidate.symbol, "BTCUSDT");
    assert_eq!(candidate.reference_price, 101.0);
    assert_eq!(candidate.created_time, 10_012);
    assert_eq!(candidate.expires_at, 10_762);
    assert_eq!(candidate.frame.sequence, 2);
    assert_eq!(candidate.frame.generation, 3);
    assert!(candidate.validate().is_ok());
}

#[test]
fn no_candidate_on_stale_data_and_confirmation_streak_fails_closed() {
    let mut detector = CandidateDetector::new(DetectorConfig::default());
    assert!(detector.observe(qualifying_frame(1), 10_011).is_none());

    let mut stale = qualifying_frame(2);
    stale.quality = MarketQuality::Stale;
    assert!(detector.observe(stale, 10_012).is_none());
    assert!(detector.observe(qualifying_frame(3), 10_013).is_none());
    assert!(detector.observe(qualifying_frame(4), 10_014).is_some());
}

#[test]
fn book_ticker_reusing_depth_sequence_cannot_confirm_or_emit() {
    let mut detector = CandidateDetector::new(DetectorConfig::default());
    assert!(detector.observe(qualifying_frame(8), 10_011).is_none());
    assert!(detector.observe(qualifying_frame(8), 10_012).is_none());
    assert!(detector.observe(qualifying_frame(9), 10_013).is_some());
}

#[test]
fn short_candidate_uses_mirrored_flow_and_depth_conditions() {
    let mut detector = CandidateDetector::new(DetectorConfig::default());
    let mut frame = qualifying_frame(1);
    frame.short_return = Some(-0.002);
    frame.depth_imbalance = Some(-0.4);
    frame.aggressive_buy_volume = 5.0;
    frame.aggressive_sell_volume = 20.0;
    assert!(detector.observe(frame.clone(), 10_011).is_none());
    frame.sequence = 2;
    let candidate = detector
        .observe(frame, 10_012)
        .expect("mirrored short candidate");
    assert_eq!(candidate.side, Side::Short);
}

#[test]
fn generation_change_resets_streak_and_allows_sequence_restart_but_rejects_old_generation() {
    let mut detector = CandidateDetector::new(DetectorConfig::default());
    assert!(detector.observe(qualifying_frame(8), 10_020).is_none());

    let mut next_generation = qualifying_frame(1);
    next_generation.generation = 4;
    assert!(detector.observe(next_generation, 10_012).is_none());
    let mut confirming = qualifying_frame(2);
    confirming.generation = 4;
    assert!(detector.observe(confirming, 10_013).is_some());

    assert!(detector.observe(qualifying_frame(9), 10_021).is_none());
}
