use crate::{
    config::DetectorConfig,
    model::{Candidate, FeatureFrame, MarketQuality, Side},
};

#[derive(Debug)]
pub struct CandidateDetector {
    config: DetectorConfig,
    config_hash: String,
    last_generation: u64,
    last_sequence: u64,
    streak: u8,
    streak_side: Option<Side>,
}

impl CandidateDetector {
    pub fn new(config: DetectorConfig) -> Self {
        let config_hash = config.config_hash();
        Self {
            config,
            config_hash,
            last_generation: 0,
            last_sequence: 0,
            streak: 0,
            streak_side: None,
        }
    }

    pub fn observe(&mut self, frame: FeatureFrame, now: i64) -> Option<Candidate> {
        if frame.generation == 0 || frame.generation < self.last_generation {
            return None;
        }
        if frame.generation > self.last_generation {
            self.last_generation = frame.generation;
            self.last_sequence = 0;
            self.reset_streak();
        }
        if frame.sequence == 0 || frame.sequence <= self.last_sequence {
            return None;
        }
        self.last_sequence = frame.sequence;

        let Some(side) = self.qualifies(&frame, now) else {
            self.reset_streak();
            return None;
        };
        if self.streak_side == Some(side) {
            self.streak = self.streak.saturating_add(1);
        } else {
            self.streak_side = Some(side);
            self.streak = 1;
        }
        if self.streak < self.config.confirmations {
            return None;
        }

        let candidate = Candidate {
            candidate_id: format!(
                "{}:{}:{}:{}",
                frame.symbol,
                frame.generation,
                frame.sequence,
                match side {
                    Side::Long => "LONG",
                    Side::Short => "SHORT",
                }
            ),
            symbol: frame.symbol.clone(),
            side,
            reference_price: frame
                .mark_price
                .unwrap_or_else(|| frame.microprice.unwrap()),
            created_time: frame.received_time,
            expires_at: frame
                .received_time
                .saturating_add(self.config.candidate_ttl_ms),
            frame,
        };
        self.reset_streak();
        candidate.validate().ok()?;
        Some(candidate)
    }

    fn qualifies(&self, frame: &FeatureFrame, now: i64) -> Option<Side> {
        if frame.quality != MarketQuality::Good
            || frame.config_hash != self.config_hash
            || frame.generation == 0
            || frame.received_time < frame.event_time
            || now < frame.event_time
            || now.saturating_sub(frame.event_time) > self.config.max_frame_age_ms
            || now.saturating_sub(frame.received_time) > self.config.max_frame_age_ms
        {
            return None;
        }
        let values = [
            frame.mark_price?,
            frame.microprice?,
            frame.spread_bps?,
            frame.depth_imbalance?,
            frame.aggressive_buy_volume,
            frame.aggressive_sell_volume,
            frame.short_return?,
            frame.burst_z?,
            frame.realized_volatility?,
        ];
        if values.iter().any(|value| !value.is_finite())
            || frame.mark_price? <= 0.0
            || frame.microprice? <= 0.0
            || frame.spread_bps? < 0.0
            || frame.spread_bps? > self.config.max_spread_bps
            || frame.short_return?.abs() < self.config.min_short_return
            || frame.depth_imbalance?.abs() < self.config.min_depth_imbalance
            || frame.burst_z? < self.config.min_burst_z
            || frame.realized_volatility? > self.config.max_realized_volatility
        {
            return None;
        }

        let side = if frame.short_return? > 0.0 {
            Side::Long
        } else {
            Side::Short
        };
        let depth = frame.depth_imbalance?;
        let (same_side_volume, opposite_volume) = match side {
            Side::Long => (frame.aggressive_buy_volume, frame.aggressive_sell_volume),
            Side::Short => (frame.aggressive_sell_volume, frame.aggressive_buy_volume),
        };
        let depth_aligned = match side {
            Side::Long => depth >= self.config.min_depth_imbalance,
            Side::Short => depth <= -self.config.min_depth_imbalance,
        };
        let flow_aligned = opposite_volume == 0.0 && same_side_volume > 0.0
            || same_side_volume / opposite_volume >= self.config.min_aggressive_ratio;
        (depth_aligned && flow_aligned).then_some(side)
    }

    fn reset_streak(&mut self) {
        self.streak = 0;
        self.streak_side = None;
    }
}
