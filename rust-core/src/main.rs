use axum::{extract::State, http::StatusCode, routing::{get, post}, Json, Router};
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, sync::Arc};
use tokio::sync::Semaphore;

#[derive(Clone)] struct AppState { permits: Arc<Semaphore> }
#[derive(Clone, Debug, Deserialize)] struct Candle { time: i64, open: f64, high: f64, low: f64, close: f64, volume: f64 }
#[derive(Clone, Debug, Deserialize)] struct SymbolInput { symbol: String, #[serde(default)] mark_price: Option<f64>, h4: Vec<Candle>, h1: Vec<Candle>, m15: Vec<Candle>, m5: Vec<Candle> }
#[derive(Debug, Serialize)] struct Signal { symbol: String, side: Option<String>, ready: bool, score: u8, entry: Option<f64>, stop: Option<f64>, target: Option<f64>, reason: String }
#[derive(Debug, Serialize)] struct BatchOutput { count: usize, signals: Vec<Signal> }

fn ema(values: &[f64], period: usize) -> Vec<f64> {
    if values.is_empty() || period == 0 { return vec![]; }
    let alpha = 2.0 / (period as f64 + 1.0);
    let mut out = Vec::with_capacity(values.len()); out.push(values[0]);
    for v in values.iter().skip(1) { let prev = *out.last().unwrap(); out.push(v * alpha + prev * (1.0-alpha)); }
    out
}
fn atr(c: &[Candle], period: usize) -> Vec<f64> {
    if c.is_empty() { return vec![]; }
    let mut tr = Vec::with_capacity(c.len());
    for i in 0..c.len() { let r = c[i].high-c[i].low; let v = if i == 0 { r } else { r.max((c[i].high-c[i-1].close).abs()).max((c[i].low-c[i-1].close).abs()) }; tr.push(v); }
    let mut out = Vec::with_capacity(tr.len()); out.push(tr[0]);
    for i in 1..tr.len() { let prev = out[i-1]; out.push(if i < period { (prev*i as f64 + tr[i])/(i+1) as f64 } else { (prev*(period-1) as f64 + tr[i])/period as f64 }); }
    out
}
fn macd_hist(c: &[Candle]) -> Vec<f64> {
    let close: Vec<f64> = c.iter().map(|x| x.close).collect();
    let fast=ema(&close,12); let slow=ema(&close,26);
    let dif: Vec<f64> = fast.iter().zip(slow.iter()).map(|(a,b)| a-b).collect();
    let dea=ema(&dif,9); dif.iter().zip(dea.iter()).map(|(a,b)| (a-b)*2.0).collect()
}
fn valid(c: &[Candle]) -> bool { c.iter().all(|x| x.open.is_finite() && x.high.is_finite() && x.low.is_finite() && x.close.is_finite() && x.volume.is_finite() && x.low > 0.0 && x.high >= x.low && x.close > 0.0) }
fn trend(c: &[Candle]) -> Option<String> {
    if c.len()<200 || !valid(c) { return None; }
    let close: Vec<f64> = c.iter().map(|x|x.close).collect(); let e50=ema(&close,50); let e200=ema(&close,200); let last=c.last()?.close;
    if last > *e50.last()? && e50.last()? > e200.last()? { Some("LONG".into()) }
    else if last < *e50.last()? && e50.last()? < e200.last()? { Some("SHORT".into()) } else { None }
}
fn analyze(x: SymbolInput) -> Signal {
    let symbol_for_block = x.symbol.clone();
    let blocked = |reason: &str| Signal { symbol:symbol_for_block.clone(), side:None, ready:false, score:0, entry:None, stop:None, target:None, reason:reason.into() };
    if x.h4.len()<200 || x.h1.len()<200 || x.m15.len()<60 || x.m5.len()<30 { return blocked("insufficient_closed_candles"); }
    if !valid(&x.h4) || !valid(&x.h1) || !valid(&x.m15) || !valid(&x.m5) { return blocked("invalid_candle_values"); }
    let t4=trend(&x.h4); let t1=trend(&x.h1);
    if t4.is_none() || t4 != t1 { return blocked("higher_timeframe_not_aligned"); }
    let side=t4.unwrap(); let dir=if side=="LONG" {1.0} else {-1.0};
    let close15:Vec<f64>=x.m15.iter().map(|c|c.close).collect(); let e20=ema(&close15,20); let e50=ema(&close15,50); let a=atr(&x.m15,14);
    let last15=x.m15.last().unwrap(); let atr15=*a.last().unwrap();
    let setup=if side=="LONG" { last15.close>*e50.last().unwrap() && last15.low<=*e20.last().unwrap()+atr15*0.45 } else { last15.close<*e50.last().unwrap() && last15.high>=*e20.last().unwrap()-atr15*0.45 };
    let hist=macd_hist(&x.m5); let last=x.m5.last().unwrap(); let prior=&x.m5[x.m5.len()-5..x.m5.len()-1];
    let trigger=if side=="LONG" { last.close>prior.iter().map(|c|c.high).fold(f64::NEG_INFINITY,f64::max) && hist[hist.len()-1]>hist[hist.len()-2] && *hist.last().unwrap()>0.0 } else { last.close<prior.iter().map(|c|c.low).fold(f64::INFINITY,f64::min) && hist[hist.len()-1]<hist[hist.len()-2] && *hist.last().unwrap()<0.0 };
    let entry=x.mark_price.filter(|p| p.is_finite() && *p > 0.0).unwrap_or(last.close); let recent=&x.m15[x.m15.len().saturating_sub(12)..];
    let structural=if side=="LONG" { recent.iter().map(|c|c.low).fold(f64::INFINITY,f64::min)-atr15*0.1 } else { recent.iter().map(|c|c.high).fold(f64::NEG_INFINITY,f64::max)+atr15*0.1 };
    let mut stop=if side=="LONG" { structural.max(entry-atr15*1.6) } else { structural.min(entry+atr15*1.6) };
    if side=="LONG" && stop>=entry {stop=entry-atr15*1.2;} if side=="SHORT" && stop<=entry {stop=entry+atr15*1.2;}
    let dist=(entry-stop).abs(); let pct=dist/entry*100.0; let volatility=atr15/entry*100.0;
    let ready=setup && trigger && pct>=0.08 && pct<=4.0 && volatility<=3.5 && dist.is_finite() && entry>0.0;
    let score=((35.0_f64)+(if setup {20.0}else{0.0})+(if trigger {20.0}else{0.0})).min(100.0) as u8;
    Signal { symbol:x.symbol, side:Some(side), ready, score, entry:Some(entry), stop:Some(stop), target:Some(entry+dir*dist*2.2), reason:if ready {"aligned_swing_setup".into()} else {"waiting_for_pullback_or_breakout".into()} }
}
async fn health() -> &'static str { "ok" }
async fn batch(State(state): State<AppState>, Json(input): Json<Vec<SymbolInput>>) -> Result<Json<BatchOutput>, (StatusCode,String)> {
    if input.len()>100 { return Err((StatusCode::PAYLOAD_TOO_LARGE,"maximum 100 symbols per batch".into())); }
    let mut tasks=tokio::task::JoinSet::new();
    for item in input { let permits=state.permits.clone(); tasks.spawn(async move { let _permit=permits.acquire_owned().await.ok(); tokio::task::spawn_blocking(move || analyze(item)).await }); }
    let mut signals=Vec::new();
    while let Some(result)=tasks.join_next().await { match result { Ok(Ok(signal))=>signals.push(signal), Ok(Err(e))=>return Err((StatusCode::INTERNAL_SERVER_ERROR,e.to_string())), Err(e)=>return Err((StatusCode::INTERNAL_SERVER_ERROR,e.to_string())) } }
    signals.sort_by(|a,b| b.ready.cmp(&a.ready).then(b.score.cmp(&a.score)).then(a.symbol.cmp(&b.symbol)));
    let count=signals.len(); Ok(Json(BatchOutput{count,signals}))
}
#[tokio::main]
async fn main() {
    let state=AppState{permits:Arc::new(Semaphore::new(8))};
    let app=Router::new().route("/health",get(health)).route("/v1/analyze/batch",post(batch)).with_state(state);
    let addr:SocketAddr="127.0.0.1:8787".parse().unwrap();
    let listener=tokio::net::TcpListener::bind(addr).await.expect("bind rust core");
    println!("swing-sentinel Rust shadow core listening on {addr}");
    axum::serve(listener,app).await.expect("serve rust core");
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn ema_is_stable_for_constant_series(){ assert_eq!(ema(&[2.0,2.0,2.0],2),vec![2.0,2.0,2.0]); }
    #[test] fn invalid_prices_are_rejected(){ let c=Candle{time:0,open:1.0,high:0.5,low:1.0,close:1.0,volume:1.0}; assert!(!valid(&[c])); }
}
