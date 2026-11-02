use swing_sentinel_core::service::MomentumSettings;

#[test]
fn momentum_is_disabled_by_default_without_candidate_endpoint() {
    let settings = MomentumSettings::from_values(None, None, None).unwrap();
    assert!(!settings.enabled);
    assert!(settings.symbols.is_empty());
}

#[test]
fn enabled_runtime_requires_valid_symbols_and_loopback_delivery() {
    let settings = MomentumSettings::from_values(
        Some("true"),
        Some("BTCUSDT,ETHUSDT"),
        Some("http://127.0.0.1:3000/v1/momentum/candidate"),
    )
    .unwrap();
    assert!(settings.enabled);
    assert_eq!(settings.symbols, vec!["BTCUSDT", "ETHUSDT"]);
    assert_eq!(settings.config.confirmations, 2);

    assert!(MomentumSettings::from_values(Some("true"), Some("BTCUSDT"), None).is_err());
    assert!(MomentumSettings::from_values(
        Some("true"),
        Some("BTCUSDT"),
        Some("https://example.com/candidate"),
    )
    .is_err());
}

#[test]
fn duplicate_or_malformed_symbols_are_rejected_fail_closed() {
    assert!(MomentumSettings::from_values(
        Some("true"),
        Some("BTCUSDT,BTCUSDT"),
        Some("http://127.0.0.1:3000/candidate"),
    )
    .is_err());
    assert!(MomentumSettings::from_values(
        Some("true"),
        Some("btcusdt"),
        Some("http://127.0.0.1:3000/candidate"),
    )
    .is_err());
}
