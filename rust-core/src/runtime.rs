use crate::{
    candidate::CandidateDetector,
    config::DetectorConfig,
    depth::{DepthStatus, DepthSync},
    features::{FeatureEngine, FrameInput},
    model::{Candidate, DepthSnapshot, FeatureFrame, Kline, PublicEvent},
};

#[derive(Debug, Default)]
pub struct RuntimeOutput {
    pub frame: Option<FeatureFrame>,
    pub candidate: Option<Candidate>,
    pub resync_required: bool,
}

#[derive(Debug)]
pub struct SymbolRuntime {
    depth: DepthSync,
    features: FeatureEngine,
    candidates: CandidateDetector,
    pub last_kline: Option<Kline>,
}

impl SymbolRuntime {
    pub fn new(symbol: impl Into<String>, config: DetectorConfig, depth_buffer: usize) -> Self {
        let symbol = symbol.into();
        Self {
            depth: DepthSync::new(depth_buffer),
            features: FeatureEngine::new(symbol, config.clone()),
            candidates: CandidateDetector::new(config),
            last_kline: None,
        }
    }

    pub fn load_snapshot(&mut self, snapshot: DepthSnapshot) -> DepthStatus {
        self.depth.load_snapshot(snapshot)
    }

    pub fn handle(&mut self, event: PublicEvent, now: i64) -> RuntimeOutput {
        let frame = match event {
            PublicEvent::Trade { data, .. } => {
                self.features.push_trade(data);
                None
            }
            PublicEvent::MarkPrice { data, .. } => {
                self.features.push_mark(data);
                None
            }
            PublicEvent::Kline { data, .. } => {
                self.last_kline = Some(data);
                None
            }
            PublicEvent::Depth {
                data,
                received_time,
            } => {
                let event_time = data.event_time;
                match self.depth.push(data) {
                    DepthStatus::Applied { sequence } => {
                        self.depth.best_bid_ask().map(|(bid, ask)| FrameInput {
                            event_time,
                            received_time,
                            sequence,
                            generation: self.depth.generation(),
                            bid: Some(bid),
                            ask: Some(ask),
                        })
                    }
                    DepthStatus::ResyncRequired => {
                        return RuntimeOutput {
                            resync_required: true,
                            ..RuntimeOutput::default()
                        };
                    }
                    DepthStatus::Buffered | DepthStatus::Duplicate => None,
                }
            }
            PublicEvent::BookTicker {
                event_time,
                received_time,
                bid,
                ask,
            } => self.depth.last_sequence().map(|sequence| FrameInput {
                event_time,
                received_time,
                sequence,
                generation: self.depth.generation(),
                bid: Some(bid),
                ask: Some(ask),
            }),
        };

        let frame = frame.map(|input| self.features.build_frame(input, now));
        let candidate = frame
            .clone()
            .and_then(|frame| self.candidates.observe(frame, now));
        RuntimeOutput {
            frame,
            candidate,
            resync_required: false,
        }
    }
}
