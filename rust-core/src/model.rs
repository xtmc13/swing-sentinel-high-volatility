use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct DepthLevel {
    pub price: f64,
    pub quantity: f64,
}

impl DepthLevel {
    pub fn is_valid(self) -> bool {
        self.price.is_finite()
            && self.price > 0.0
            && self.quantity.is_finite()
            && self.quantity >= 0.0
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DepthSnapshot {
    pub last_update_id: u64,
    pub bids: Vec<DepthLevel>,
    pub asks: Vec<DepthLevel>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DepthUpdate {
    pub first_update_id: u64,
    pub final_update_id: u64,
    pub previous_final_update_id: u64,
    pub event_time: i64,
    pub bids: Vec<DepthLevel>,
    pub asks: Vec<DepthLevel>,
}

impl DepthUpdate {
    pub fn is_valid(&self) -> bool {
        self.first_update_id <= self.final_update_id
            && self.event_time >= 0
            && self
                .bids
                .iter()
                .chain(&self.asks)
                .copied()
                .all(DepthLevel::is_valid)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AggTrade {
    pub event_time: i64,
    pub price: f64,
    pub quantity: f64,
    pub is_buyer_maker: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MarkPrice {
    pub event_time: i64,
    pub price: f64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MarketQuality {
    Good,
    Stale,
    OneSided,
    Crossed,
    InsufficientHistory,
    HistoryOverflow,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Side {
    Long,
    Short,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FeatureFrame {
    pub symbol: String,
    pub event_time: i64,
    pub received_time: i64,
    pub sequence: u64,
    pub generation: u64,
    pub quality: MarketQuality,
    pub config_hash: String,
    pub mark_price: Option<f64>,
    pub microprice: Option<f64>,
    pub spread_bps: Option<f64>,
    pub depth_imbalance: Option<f64>,
    pub aggressive_buy_volume: f64,
    pub aggressive_sell_volume: f64,
    pub short_return: Option<f64>,
    pub burst_z: Option<f64>,
    pub realized_volatility: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Candidate {
    pub candidate_id: String,
    pub symbol: String,
    pub side: Side,
    pub reference_price: f64,
    pub created_time: i64,
    pub expires_at: i64,
    pub frame: FeatureFrame,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Kline {
    pub event_time: i64,
    pub open_time: i64,
    pub close_time: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    pub is_closed: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PublicEvent {
    Trade {
        data: AggTrade,
        received_time: i64,
    },
    BookTicker {
        event_time: i64,
        received_time: i64,
        bid: DepthLevel,
        ask: DepthLevel,
    },
    Depth {
        data: DepthUpdate,
        received_time: i64,
    },
    MarkPrice {
        data: MarkPrice,
        received_time: i64,
    },
    Kline {
        data: Kline,
        received_time: i64,
    },
}

impl Candidate {
    pub fn validate(&self) -> Result<(), &'static str> {
        let valid_symbol = !self.symbol.is_empty()
            && self.symbol.len() <= 20
            && self
                .symbol
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit());
        if !valid_symbol || self.symbol != self.frame.symbol {
            return Err("invalid_symbol");
        }
        if self.candidate_id.is_empty()
            || self.candidate_id.len() > 128
            || !self.reference_price.is_finite()
            || self.reference_price <= 0.0
        {
            return Err("invalid_candidate_values");
        }
        if self.created_time < 0
            || self.expires_at <= self.created_time
            || self.created_time != self.frame.received_time
            || self.frame.event_time < 0
            || self.frame.received_time < self.frame.event_time
            || self.frame.quality != MarketQuality::Good
            || self.frame.sequence == 0
            || self.frame.generation == 0
            || self.frame.config_hash.len() != 64
            || !self
                .frame
                .config_hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("invalid_candidate_metadata");
        }
        let required = [
            self.frame.mark_price,
            self.frame.microprice,
            self.frame.spread_bps,
            self.frame.depth_imbalance,
            self.frame.short_return,
            self.frame.burst_z,
            self.frame.realized_volatility,
        ];
        if required
            .iter()
            .any(|value| value.is_none_or(|value| !value.is_finite()))
            || !self.frame.aggressive_buy_volume.is_finite()
            || !self.frame.aggressive_sell_volume.is_finite()
            || self.frame.mark_price.is_some_and(|value| value <= 0.0)
            || self.frame.microprice.is_some_and(|value| value <= 0.0)
            || self.frame.spread_bps.is_some_and(|value| value < 0.0)
            || self
                .frame
                .depth_imbalance
                .is_some_and(|value| value.abs() > 1.0)
            || self.frame.aggressive_buy_volume < 0.0
            || self.frame.aggressive_sell_volume < 0.0
            || self
                .frame
                .realized_volatility
                .is_some_and(|value| value < 0.0)
        {
            return Err("invalid_feature_values");
        }
        Ok(())
    }
}
