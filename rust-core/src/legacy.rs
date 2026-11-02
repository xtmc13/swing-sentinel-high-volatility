use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Semaphore;

#[derive(Clone)]
struct AppState {
    permits: Arc<Semaphore>,
}

#[derive(Clone, Debug, Deserialize)]
struct Candle {
    #[serde(rename = "time")]
    _time: i64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: f64,
}

#[derive(Clone, Debug, Deserialize)]
struct SymbolInput {
    symbol: String,
    #[serde(default)]
    mark_price: Option<f64>,
    h4: Vec<Candle>,
    h1: Vec<Candle>,
    m15: Vec<Candle>,
    m5: Vec<Candle>,
}

#[derive(Debug, Serialize)]
struct Signal {
    symbol: String,
    side: Option<String>,
    ready: bool,
    score: u8,
    entry: Option<f64>,
    stop: Option<f64>,
    target: Option<f64>,
    reason: String,
}

#[derive(Debug, Serialize)]
struct BatchOutput {
    count: usize,
    signals: Vec<Signal>,
}

fn ema(values: &[f64], period: usize) -> Vec<f64> {
    if values.is_empty() || period == 0 {
        return vec![];
    }
    let alpha = 2.0 / (period as f64 + 1.0);
    let mut out = Vec::with_capacity(values.len());
    out.push(values[0]);
    for value in values.iter().skip(1) {
        let previous = *out.last().unwrap();
        out.push(value * alpha + previous * (1.0 - alpha));
    }
    out
}

fn atr(candles: &[Candle], period: usize) -> Vec<f64> {
    if candles.is_empty() {
        return vec![];
    }
    let mut ranges = Vec::with_capacity(candles.len());
    for index in 0..candles.len() {
        let candle = &candles[index];
        let range = candle.high - candle.low;
        let value = if index == 0 {
            range
        } else {
            range
                .max((candle.high - candles[index - 1].close).abs())
                .max((candle.low - candles[index - 1].close).abs())
        };
        ranges.push(value);
    }
    let mut out = Vec::with_capacity(ranges.len());
    out.push(ranges[0]);
    for index in 1..ranges.len() {
        let previous = out[index - 1];
        out.push(if index < period {
            (previous * index as f64 + ranges[index]) / (index + 1) as f64
        } else {
            (previous * (period - 1) as f64 + ranges[index]) / period as f64
        });
    }
    out
}

fn macd_hist(candles: &[Candle]) -> Vec<f64> {
    let close: Vec<f64> = candles.iter().map(|candle| candle.close).collect();
    let fast = ema(&close, 12);
    let slow = ema(&close, 26);
    let dif: Vec<f64> = fast.iter().zip(slow.iter()).map(|(a, b)| a - b).collect();
    let dea = ema(&dif, 9);
    dif.iter()
        .zip(dea.iter())
        .map(|(a, b)| (a - b) * 2.0)
        .collect()
}

fn valid(candles: &[Candle]) -> bool {
    candles.iter().all(|candle| {
        candle.open.is_finite()
            && candle.high.is_finite()
            && candle.low.is_finite()
            && candle.close.is_finite()
            && candle.volume.is_finite()
            && candle.low > 0.0
            && candle.high >= candle.low
            && candle.close > 0.0
    })
}

fn trend(candles: &[Candle]) -> Option<String> {
    if candles.len() < 200 || !valid(candles) {
        return None;
    }
    let close: Vec<f64> = candles.iter().map(|candle| candle.close).collect();
    let e50 = ema(&close, 50);
    let e200 = ema(&close, 200);
    let last = candles.last()?.close;
    if last > *e50.last()? && e50.last()? > e200.last()? {
        Some("LONG".into())
    } else if last < *e50.last()? && e50.last()? < e200.last()? {
        Some("SHORT".into())
    } else {
        None
    }
}

fn analyze(input: SymbolInput) -> Signal {
    let symbol_for_block = input.symbol.clone();
    let blocked = |reason: &str| Signal {
        symbol: symbol_for_block.clone(),
        side: None,
        ready: false,
        score: 0,
        entry: None,
        stop: None,
        target: None,
        reason: reason.into(),
    };
    if input.h4.len() < 200 || input.h1.len() < 200 || input.m15.len() < 60 || input.m5.len() < 30 {
        return blocked("insufficient_closed_candles");
    }
    if !valid(&input.h4) || !valid(&input.h1) || !valid(&input.m15) || !valid(&input.m5) {
        return blocked("invalid_candle_values");
    }
    let t4 = trend(&input.h4);
    let t1 = trend(&input.h1);
    if t4.is_none() || t4 != t1 {
        return blocked("higher_timeframe_not_aligned");
    }
    let side = t4.unwrap();
    let direction = if side == "LONG" { 1.0 } else { -1.0 };
    let close15: Vec<f64> = input.m15.iter().map(|candle| candle.close).collect();
    let e20 = ema(&close15, 20);
    let e50 = ema(&close15, 50);
    let atr15_values = atr(&input.m15, 14);
    let last15 = input.m15.last().unwrap();
    let atr15 = *atr15_values.last().unwrap();
    let setup = if side == "LONG" {
        last15.close > *e50.last().unwrap() && last15.low <= *e20.last().unwrap() + atr15 * 0.45
    } else {
        last15.close < *e50.last().unwrap() && last15.high >= *e20.last().unwrap() - atr15 * 0.45
    };
    let hist = macd_hist(&input.m5);
    let last = input.m5.last().unwrap();
    let prior = &input.m5[input.m5.len() - 5..input.m5.len() - 1];
    let trigger = if side == "LONG" {
        last.close
            > prior
                .iter()
                .map(|candle| candle.high)
                .fold(f64::NEG_INFINITY, f64::max)
            && hist[hist.len() - 1] > hist[hist.len() - 2]
            && *hist.last().unwrap() > 0.0
    } else {
        last.close
            < prior
                .iter()
                .map(|candle| candle.low)
                .fold(f64::INFINITY, f64::min)
            && hist[hist.len() - 1] < hist[hist.len() - 2]
            && *hist.last().unwrap() < 0.0
    };
    let entry = input
        .mark_price
        .filter(|price| price.is_finite() && *price > 0.0)
        .unwrap_or(last.close);
    let recent = &input.m15[input.m15.len().saturating_sub(12)..];
    let structural = if side == "LONG" {
        recent
            .iter()
            .map(|candle| candle.low)
            .fold(f64::INFINITY, f64::min)
            - atr15 * 0.1
    } else {
        recent
            .iter()
            .map(|candle| candle.high)
            .fold(f64::NEG_INFINITY, f64::max)
            + atr15 * 0.1
    };
    let mut stop = if side == "LONG" {
        structural.max(entry - atr15 * 1.6)
    } else {
        structural.min(entry + atr15 * 1.6)
    };
    if side == "LONG" && stop >= entry {
        stop = entry - atr15 * 1.2;
    }
    if side == "SHORT" && stop <= entry {
        stop = entry + atr15 * 1.2;
    }
    let distance = (entry - stop).abs();
    let percent = distance / entry * 100.0;
    let volatility = atr15 / entry * 100.0;
    let ready = setup
        && trigger
        && (0.08..=4.0).contains(&percent)
        && volatility <= 3.5
        && distance.is_finite()
        && entry > 0.0;
    let score = (35.0_f64 + if setup { 20.0 } else { 0.0 } + if trigger { 20.0 } else { 0.0 })
        .min(100.0) as u8;
    Signal {
        symbol: input.symbol,
        side: Some(side),
        ready,
        score,
        entry: Some(entry),
        stop: Some(stop),
        target: Some(entry + direction * distance * 2.2),
        reason: if ready {
            "aligned_swing_setup".into()
        } else {
            "waiting_for_pullback_or_breakout".into()
        },
    }
}

async fn batch(
    State(state): State<AppState>,
    Json(input): Json<Vec<SymbolInput>>,
) -> Result<Json<BatchOutput>, (StatusCode, String)> {
    if input.len() > 100 {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            "maximum 100 symbols per batch".into(),
        ));
    }
    let mut tasks = tokio::task::JoinSet::new();
    for item in input {
        let permits = state.permits.clone();
        tasks.spawn(async move {
            let _permit = permits.acquire_owned().await.ok();
            tokio::task::spawn_blocking(move || analyze(item)).await
        });
    }
    let mut signals = Vec::new();
    while let Some(result) = tasks.join_next().await {
        match result {
            Ok(Ok(signal)) => signals.push(signal),
            Ok(Err(error)) => return Err((StatusCode::INTERNAL_SERVER_ERROR, error.to_string())),
            Err(error) => return Err((StatusCode::INTERNAL_SERVER_ERROR, error.to_string())),
        }
    }
    signals.sort_by(|a, b| {
        b.ready
            .cmp(&a.ready)
            .then(b.score.cmp(&a.score))
            .then(a.symbol.cmp(&b.symbol))
    });
    let count = signals.len();
    Ok(Json(BatchOutput { count, signals }))
}

pub fn router() -> Router {
    let state = AppState {
        permits: Arc::new(Semaphore::new(8)),
    };
    Router::new()
        .route("/v1/analyze/batch", post(batch))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ema_is_stable_for_constant_series() {
        assert_eq!(ema(&[2.0, 2.0, 2.0], 2), vec![2.0, 2.0, 2.0]);
    }

    #[test]
    fn invalid_prices_are_rejected() {
        let candle = Candle {
            _time: 0,
            open: 1.0,
            high: 0.5,
            low: 1.0,
            close: 1.0,
            volume: 1.0,
        };
        assert!(!valid(&[candle]));
    }
}
