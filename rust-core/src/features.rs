use std::collections::{BTreeMap, VecDeque};

use crate::{
    config::DetectorConfig,
    model::{AggTrade, DepthLevel, FeatureFrame, MarkPrice, MarketQuality},
};

#[derive(Clone, Copy, Debug)]
pub struct FrameInput {
    pub event_time: i64,
    pub received_time: i64,
    pub sequence: u64,
    pub generation: u64,
    pub bid: Option<DepthLevel>,
    pub ask: Option<DepthLevel>,
}

#[derive(Debug)]
pub struct FeatureEngine {
    symbol: String,
    config: DetectorConfig,
    config_hash: String,
    trades: VecDeque<AggTrade>,
    marks: VecDeque<MarkPrice>,
}

impl FeatureEngine {
    pub fn new(symbol: impl Into<String>, config: DetectorConfig) -> Self {
        let config_hash = config.config_hash();
        Self {
            symbol: symbol.into(),
            config,
            config_hash,
            trades: VecDeque::new(),
            marks: VecDeque::new(),
        }
    }

    pub fn push_trade(&mut self, trade: AggTrade) {
        if trade.event_time >= 0
            && trade.price.is_finite()
            && trade.price > 0.0
            && trade.quantity.is_finite()
            && trade.quantity > 0.0
        {
            self.trades.push_back(trade);
        }
    }

    pub fn push_mark(&mut self, mark: MarkPrice) {
        if mark.event_time >= 0 && mark.price.is_finite() && mark.price > 0.0 {
            self.marks.push_back(mark);
        }
    }

    pub fn build_frame(&mut self, input: FrameInput, now: i64) -> FeatureFrame {
        self.prune(input.event_time);
        let book_metrics = match (input.bid, input.ask) {
            (Some(bid), Some(ask))
                if bid.is_valid() && ask.is_valid() && bid.quantity > 0.0 && ask.quantity > 0.0 =>
            {
                let quantity_sum = bid.quantity + ask.quantity;
                let mid = (bid.price + ask.price) / 2.0;
                Some((
                    (ask.price * bid.quantity + bid.price * ask.quantity) / quantity_sum,
                    (ask.price - bid.price) / mid * 10_000.0,
                    (bid.quantity - ask.quantity) / quantity_sum,
                ))
            }
            _ => None,
        };
        let (buy_volume, sell_volume) = self.flow_volumes(input.event_time);
        let short_return = self.short_return(input.event_time);
        let realized_volatility = self.realized_volatility(input.event_time);
        let burst_z = Some(self.burst_z(input.event_time));

        let stale = input.event_time < 0
            || input.received_time < input.event_time
            || now < input.event_time
            || now.saturating_sub(input.event_time) > self.config.max_frame_age_ms
            || now.saturating_sub(input.received_time) > self.config.max_frame_age_ms;
        let quality = if stale {
            MarketQuality::Stale
        } else {
            match (input.bid, input.ask, book_metrics) {
                (Some(bid), Some(ask), Some(_)) if bid.price >= ask.price => MarketQuality::Crossed,
                (_, _, None) => MarketQuality::OneSided,
                _ if self.marks.len() < self.config.min_history
                    || short_return.is_none()
                    || realized_volatility.is_none() =>
                {
                    MarketQuality::InsufficientHistory
                }
                _ => MarketQuality::Good,
            }
        };

        FeatureFrame {
            symbol: self.symbol.clone(),
            event_time: input.event_time,
            received_time: input.received_time,
            sequence: input.sequence,
            generation: input.generation,
            quality,
            config_hash: self.config_hash.clone(),
            mark_price: self.marks.back().map(|mark| mark.price),
            microprice: book_metrics.map(|metrics| metrics.0),
            spread_bps: book_metrics.map(|metrics| metrics.1),
            depth_imbalance: book_metrics.map(|metrics| metrics.2),
            aggressive_buy_volume: buy_volume,
            aggressive_sell_volume: sell_volume,
            short_return,
            burst_z,
            realized_volatility,
        }
    }

    fn prune(&mut self, now: i64) {
        let cutoff = now.saturating_sub(self.config.history_window_ms);
        while self
            .trades
            .front()
            .is_some_and(|trade| trade.event_time < cutoff)
        {
            self.trades.pop_front();
        }
        while self
            .marks
            .front()
            .is_some_and(|mark| mark.event_time < cutoff)
        {
            self.marks.pop_front();
        }
    }

    fn flow_volumes(&self, now: i64) -> (f64, f64) {
        let cutoff = now.saturating_sub(self.config.flow_window_ms);
        self.trades
            .iter()
            .filter(|trade| trade.event_time >= cutoff && trade.event_time <= now)
            .fold((0.0, 0.0), |(buy, sell), trade| {
                if trade.is_buyer_maker {
                    (buy, sell + trade.quantity)
                } else {
                    (buy + trade.quantity, sell)
                }
            })
    }

    fn return_marks(&self, now: i64) -> Vec<MarkPrice> {
        let cutoff = now.saturating_sub(self.config.return_window_ms);
        self.marks
            .iter()
            .copied()
            .filter(|mark| mark.event_time >= cutoff && mark.event_time <= now)
            .collect()
    }

    fn short_return(&self, now: i64) -> Option<f64> {
        let marks = self.return_marks(now);
        let first = marks.first()?;
        let last = marks.last()?;
        (marks.len() >= 2).then(|| last.price / first.price - 1.0)
    }

    fn realized_volatility(&self, now: i64) -> Option<f64> {
        let marks = self.return_marks(now);
        if marks.len() < 2 {
            return None;
        }
        let returns: Vec<f64> = marks
            .windows(2)
            .map(|pair| (pair[1].price / pair[0].price).ln())
            .collect();
        let mean = returns.iter().sum::<f64>() / returns.len() as f64;
        Some(
            (returns
                .iter()
                .map(|value| (value - mean).powi(2))
                .sum::<f64>()
                / returns.len() as f64)
                .sqrt(),
        )
    }

    fn burst_z(&self, now: i64) -> f64 {
        let mut buckets = BTreeMap::<i64, f64>::new();
        for trade in &self.trades {
            *buckets
                .entry(trade.event_time.div_euclid(1_000))
                .or_default() += trade.quantity;
        }
        let current_bucket = now.div_euclid(1_000);
        let current = buckets.get(&current_bucket).copied().unwrap_or(0.0);
        let baseline: Vec<f64> = buckets
            .iter()
            .filter(|(bucket, _)| **bucket < current_bucket)
            .map(|(_, volume)| *volume)
            .collect();
        if baseline.is_empty() {
            return current;
        }
        let mean = baseline.iter().sum::<f64>() / baseline.len() as f64;
        let deviation = (baseline
            .iter()
            .map(|value| (value - mean).powi(2))
            .sum::<f64>()
            / baseline.len() as f64)
            .sqrt();
        if deviation > f64::EPSILON {
            (current - mean) / deviation
        } else if mean > f64::EPSILON {
            (current - mean) / mean
        } else {
            current
        }
    }
}
