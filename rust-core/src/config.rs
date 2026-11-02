use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct DetectorConfig {
    pub max_frame_age_ms: i64,
    pub history_window_ms: i64,
    pub return_window_ms: i64,
    pub flow_window_ms: i64,
    pub min_history: usize,
    pub max_trade_history: usize,
    pub max_mark_history: usize,
    pub min_depth_imbalance: f64,
    pub min_aggressive_ratio: f64,
    pub min_burst_z: f64,
    pub min_short_return: f64,
    pub max_spread_bps: f64,
    pub max_realized_volatility: f64,
    pub confirmations: u8,
    pub candidate_ttl_ms: i64,
}

impl Default for DetectorConfig {
    fn default() -> Self {
        Self {
            max_frame_age_ms: 750,
            history_window_ms: 120_000,
            return_window_ms: 10_000,
            flow_window_ms: 10_000,
            min_history: 3,
            max_trade_history: 50_000,
            max_mark_history: 2_000,
            min_depth_imbalance: 0.15,
            min_aggressive_ratio: 1.5,
            min_burst_z: 2.0,
            min_short_return: 0.0001,
            max_spread_bps: 50.0,
            max_realized_volatility: 1.0,
            confirmations: 2,
            candidate_ttl_ms: 750,
        }
    }
}

impl DetectorConfig {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.max_frame_age_ms <= 0
            || self.history_window_ms < self.return_window_ms
            || self.return_window_ms <= 0
            || self.flow_window_ms <= 0
            || self.flow_window_ms > self.history_window_ms
            || self.min_history < 2
            || self.confirmations == 0
            || self.candidate_ttl_ms <= 0
        {
            return Err("invalid_detector_windows");
        }
        let thresholds = [
            self.min_depth_imbalance,
            self.min_aggressive_ratio,
            self.min_burst_z,
            self.min_short_return,
            self.max_spread_bps,
            self.max_realized_volatility,
        ];
        if thresholds
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0)
            || self.min_depth_imbalance > 1.0
            || self.min_aggressive_ratio == 0.0
        {
            return Err("invalid_detector_thresholds");
        }
        Ok(())
    }

    pub fn config_hash(&self) -> String {
        let encoded = serde_json::to_vec(self).expect("detector config serializes");
        Sha256::digest(encoded)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}
