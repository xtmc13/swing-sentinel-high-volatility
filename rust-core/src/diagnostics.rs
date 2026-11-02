use std::{
    collections::BTreeMap,
    sync::{Arc, RwLock},
};

use serde::Serialize;

use crate::model::{FeatureFrame, Kline, MarketQuality};

#[derive(Clone, Debug, Serialize)]
pub struct DiagnosticsSnapshot {
    pub enabled: bool,
    pub config_hash: String,
    pub symbols: BTreeMap<String, SymbolDiagnostics>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct SymbolDiagnostics {
    pub generation: Option<u64>,
    pub sequence: Option<u64>,
    pub quality: Option<MarketQuality>,
    pub last_event_time: Option<i64>,
    pub last_received_time: Option<i64>,
    pub frames: u64,
    pub candidates: u64,
    pub resyncs: u64,
    pub errors: u64,
    pub last_error: Option<String>,
    pub last_closed_kline_time: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct DiagnosticsState {
    inner: Arc<RwLock<DiagnosticsSnapshot>>,
}

impl DiagnosticsState {
    pub fn disabled(config_hash: String) -> Self {
        Self::new(false, config_hash)
    }

    pub fn enabled(config_hash: String) -> Self {
        Self::new(true, config_hash)
    }

    fn new(enabled: bool, config_hash: String) -> Self {
        Self {
            inner: Arc::new(RwLock::new(DiagnosticsSnapshot {
                enabled,
                config_hash,
                symbols: BTreeMap::new(),
            })),
        }
    }

    pub fn snapshot(&self) -> DiagnosticsSnapshot {
        self.inner.read().expect("diagnostics read lock").clone()
    }

    pub fn note_frame(&self, symbol: &str, frame: &FeatureFrame) {
        self.update(symbol, |diagnostics| {
            diagnostics.generation = Some(frame.generation);
            diagnostics.sequence = Some(frame.sequence);
            diagnostics.quality = Some(frame.quality);
            diagnostics.last_event_time = Some(frame.event_time);
            diagnostics.last_received_time = Some(frame.received_time);
            diagnostics.frames = diagnostics.frames.saturating_add(1);
        });
    }

    pub fn note_candidate(&self, symbol: &str) {
        self.update(symbol, |diagnostics| {
            diagnostics.candidates = diagnostics.candidates.saturating_add(1);
        });
    }

    pub fn note_resync(&self, symbol: &str) {
        self.update(symbol, |diagnostics| {
            diagnostics.resyncs = diagnostics.resyncs.saturating_add(1);
        });
    }

    pub fn note_kline(&self, symbol: &str, kline: &Kline) {
        self.update(symbol, |diagnostics| {
            if kline.is_closed {
                diagnostics.last_closed_kline_time = Some(kline.close_time);
            }
        });
    }

    pub fn note_error(&self, symbol: &str, error: impl Into<String>) {
        self.update(symbol, |diagnostics| {
            diagnostics.errors = diagnostics.errors.saturating_add(1);
            diagnostics.last_error = Some(error.into());
        });
    }

    fn update(&self, symbol: &str, update: impl FnOnce(&mut SymbolDiagnostics)) {
        let mut snapshot = self.inner.write().expect("diagnostics write lock");
        update(snapshot.symbols.entry(symbol.to_owned()).or_default());
    }
}
