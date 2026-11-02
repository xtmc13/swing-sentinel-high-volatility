use std::{
    collections::HashSet,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use futures_util::{SinkExt, StreamExt};
use tokio::time::{sleep, timeout};
use tokio_tungstenite::tungstenite::Message;

use crate::{
    config::DetectorConfig, diagnostics::DiagnosticsState, public_market::BinancePublicClient,
    runtime::SymbolRuntime, transport::CandidateSender,
};

const DEPTH_BUFFER: usize = 256;
const SNAPSHOT_LIMIT: u16 = 100;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const READ_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(5);

#[derive(Clone, Debug)]
pub struct MomentumSettings {
    pub enabled: bool,
    pub symbols: Vec<String>,
    pub candidate_endpoint: Option<String>,
    pub config: DetectorConfig,
}

impl MomentumSettings {
    pub fn from_env() -> Result<Self, String> {
        Self::from_values(
            std::env::var("MOMENTUM_ENABLED").ok().as_deref(),
            std::env::var("MOMENTUM_SYMBOLS").ok().as_deref(),
            std::env::var("MOMENTUM_CANDIDATE_URL").ok().as_deref(),
        )
    }

    pub fn from_values(
        enabled: Option<&str>,
        symbols: Option<&str>,
        candidate_endpoint: Option<&str>,
    ) -> Result<Self, String> {
        let enabled = match enabled {
            None | Some("false") => false,
            Some("true") => true,
            _ => return Err("MOMENTUM_ENABLED must be true or false".into()),
        };
        let config = DetectorConfig::default();
        config.validate().map_err(str::to_owned)?;
        if !enabled {
            return Ok(Self {
                enabled,
                symbols: Vec::new(),
                candidate_endpoint: None,
                config,
            });
        }

        let symbols: Vec<String> = symbols
            .unwrap_or_default()
            .split(',')
            .filter(|symbol| !symbol.is_empty())
            .map(str::to_owned)
            .collect();
        let valid = !symbols.is_empty()
            && symbols.len() <= 100
            && symbols.iter().all(|symbol| {
                symbol.len() <= 20
                    && symbol
                        .bytes()
                        .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
            });
        let unique = symbols.iter().collect::<HashSet<_>>().len() == symbols.len();
        if !valid || !unique {
            return Err("MOMENTUM_SYMBOLS must contain 1-100 unique uppercase symbols".into());
        }
        let candidate_endpoint = candidate_endpoint
            .ok_or("MOMENTUM_CANDIDATE_URL is required when momentum is enabled")?;
        CandidateSender::new(candidate_endpoint, REQUEST_TIMEOUT)?;
        Ok(Self {
            enabled,
            symbols,
            candidate_endpoint: Some(candidate_endpoint.to_owned()),
            config,
        })
    }
}

pub async fn run(settings: MomentumSettings, diagnostics: DiagnosticsState) {
    let mut tasks = tokio::task::JoinSet::new();
    for symbol in settings.symbols {
        let diagnostics = diagnostics.clone();
        let config = settings.config.clone();
        let endpoint = settings
            .candidate_endpoint
            .clone()
            .expect("enabled settings have an endpoint");
        tasks.spawn(run_symbol(symbol, config, endpoint, diagnostics));
    }
    while tasks.join_next().await.is_some() {}
}

async fn run_symbol(
    symbol: String,
    config: DetectorConfig,
    endpoint: String,
    diagnostics: DiagnosticsState,
) {
    let client =
        BinancePublicClient::new(REQUEST_TIMEOUT).expect("public client configuration is valid");
    let sender =
        CandidateSender::new(endpoint, REQUEST_TIMEOUT).expect("candidate endpoint was validated");
    let mut reconnect_delay = Duration::from_millis(250);
    let mut generation = 1;
    loop {
        if let Err(error) =
            run_session(&symbol, &config, &client, &sender, &diagnostics, generation).await
        {
            diagnostics.note_error(&symbol, error);
        }
        generation = generation.saturating_add(1);
        sleep(reconnect_delay).await;
        reconnect_delay = (reconnect_delay * 2).min(MAX_RECONNECT_DELAY);
    }
}

async fn run_session(
    symbol: &str,
    config: &DetectorConfig,
    client: &BinancePublicClient,
    sender: &CandidateSender,
    diagnostics: &DiagnosticsState,
    generation: u64,
) -> Result<(), String> {
    let mut socket = client
        .connect(symbol)
        .await
        .map_err(|error| error.to_string())?;
    let snapshot = client
        .depth_snapshot(symbol, SNAPSHOT_LIMIT)
        .await
        .map_err(|error| error.to_string())?;
    let mut runtime =
        SymbolRuntime::new_with_generation(symbol, config.clone(), DEPTH_BUFFER, generation);
    runtime.load_snapshot(snapshot);

    loop {
        let message = timeout(READ_TIMEOUT, socket.next())
            .await
            .map_err(|_| "public websocket read timed out".to_owned())?
            .ok_or("public websocket closed".to_owned())?
            .map_err(|error| error.to_string())?;
        let now = now_ms();
        if let Message::Ping(payload) = message {
            timeout(REQUEST_TIMEOUT, socket.send(Message::Pong(payload)))
                .await
                .map_err(|_| "public websocket pong timed out".to_owned())?
                .map_err(|error| error.to_string())?;
            continue;
        }
        let Some(event) =
            BinancePublicClient::parse_text(now, &message).map_err(|error| error.to_string())?
        else {
            continue;
        };
        if let crate::model::PublicEvent::Kline { data, .. } = &event {
            diagnostics.note_kline(symbol, data);
        }
        let output = runtime.handle(event, now);
        if output.resync_required {
            diagnostics.note_resync(symbol);
            return Err("depth sequence gap; rebuilding snapshot".into());
        }
        if let Some(frame) = output.frame {
            diagnostics.note_frame(symbol, &frame);
            sender.send_frame(frame).await?;
        }
        if let Some(candidate) = output.candidate {
            sender.send(candidate).await?;
            diagnostics.note_candidate(symbol);
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is after Unix epoch")
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}
