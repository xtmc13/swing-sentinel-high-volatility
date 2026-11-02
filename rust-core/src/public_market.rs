use std::time::Duration;

use serde::{de::DeserializeOwned, Deserialize};
use serde_json::Value;
use tokio::{net::TcpStream, time::timeout};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
    MaybeTlsStream, WebSocketStream,
};

use crate::model::{
    AggTrade, DepthLevel, DepthSnapshot, DepthUpdate, Kline, MarkPrice, PublicEvent,
};

const REST_BASE: &str = "https://fapi.binance.com";
const WS_BASE: &str = "wss://fstream.binance.com/stream?streams=";
const MAX_PUBLIC_MESSAGE_BYTES: usize = 256 * 1024;
const MAX_SNAPSHOT_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug)]
pub struct PublicError(pub String);

impl std::fmt::Display for PublicError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for PublicError {}

#[derive(Debug)]
pub struct BinancePublicClient {
    http: reqwest::Client,
    timeout: Duration,
}

impl BinancePublicClient {
    pub fn new(timeout: Duration) -> Result<Self, PublicError> {
        if timeout.is_zero() {
            return Err(PublicError("public market timeout must be positive".into()));
        }
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| PublicError(error.to_string()))?;
        Ok(Self { http, timeout })
    }

    pub fn stream_url(symbol: &str) -> String {
        let symbol = symbol.to_ascii_lowercase();
        format!(
            "{WS_BASE}{symbol}@aggTrade/{symbol}@bookTicker/{symbol}@depth@100ms/{symbol}@markPrice@1s/{symbol}@kline_1m"
        )
    }

    pub async fn depth_snapshot(
        &self,
        symbol: &str,
        limit: u16,
    ) -> Result<DepthSnapshot, PublicError> {
        if !valid_symbol(symbol) || ![5, 10, 20, 50, 100, 500, 1000].contains(&limit) {
            return Err(PublicError("invalid public depth request".into()));
        }
        let response = self
            .http
            .get(format!("{REST_BASE}/fapi/v1/depth"))
            .query(&[("symbol", symbol), ("limit", &limit.to_string())])
            .send()
            .await
            .map_err(|error| PublicError(error.to_string()))?
            .error_for_status()
            .map_err(|error| PublicError(error.to_string()))?;
        let raw = bounded_json::<RawSnapshot>(response, MAX_SNAPSHOT_RESPONSE_BYTES).await?;
        Ok(DepthSnapshot {
            last_update_id: raw.last_update_id,
            bids: parse_levels(&raw.bids)?,
            asks: parse_levels(&raw.asks)?,
        })
    }

    pub async fn connect(
        &self,
        symbol: &str,
    ) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>, PublicError> {
        if !valid_symbol(symbol) {
            return Err(PublicError("invalid public stream symbol".into()));
        }
        let config = WebSocketConfig {
            max_message_size: Some(MAX_PUBLIC_MESSAGE_BYTES),
            max_frame_size: Some(64 * 1024),
            ..WebSocketConfig::default()
        };
        let (socket, _) = timeout(
            self.timeout,
            connect_async_with_config(Self::stream_url(symbol), Some(config), false),
        )
        .await
        .map_err(|_| PublicError("public websocket connect timed out".into()))?
        .map_err(|error| PublicError(error.to_string()))?;
        Ok(socket)
    }

    pub fn parse_text(
        received_time: i64,
        message: &Message,
    ) -> Result<Option<PublicEvent>, PublicError> {
        match message {
            Message::Text(text) => parse_public_message(received_time, text).map(Some),
            Message::Binary(_) => Err(PublicError(
                "binary public messages are not accepted".into(),
            )),
            _ => Ok(None),
        }
    }
}

async fn bounded_json<T: DeserializeOwned>(
    mut response: reqwest::Response,
    max_bytes: u64,
) -> Result<T, PublicError> {
    if response
        .content_length()
        .is_some_and(|size| size > max_bytes)
    {
        return Err(PublicError("public response exceeds response bound".into()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| PublicError(error.to_string()))?
    {
        if (body.len() as u64).saturating_add(chunk.len() as u64) > max_bytes {
            return Err(PublicError("public response exceeds response bound".into()));
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|error| PublicError(error.to_string()))
}

#[derive(Deserialize)]
struct RawSnapshot {
    #[serde(rename = "lastUpdateId")]
    last_update_id: u64,
    bids: Vec<[String; 2]>,
    asks: Vec<[String; 2]>,
}

pub fn parse_public_message(received_time: i64, text: &str) -> Result<PublicEvent, PublicError> {
    if received_time < 0 || text.len() > MAX_PUBLIC_MESSAGE_BYTES {
        return Err(PublicError(
            "invalid public message metadata or size".into(),
        ));
    }
    let envelope: Value =
        serde_json::from_str(text).map_err(|error| PublicError(error.to_string()))?;
    let stream = string_field(&envelope, "stream")?;
    let data = envelope
        .get("data")
        .ok_or_else(|| PublicError("missing public event data".into()))?;
    let event_type = string_field(data, "e")?;
    if data.get("s").and_then(Value::as_str).is_some_and(|symbol| {
        !stream
            .to_ascii_lowercase()
            .starts_with(&format!("{}@", symbol.to_ascii_lowercase()))
    }) {
        return Err(PublicError(
            "public event symbol does not match stream".into(),
        ));
    }
    let event_time = integer_field(data, "E")?;
    match event_type {
        "aggTrade" => Ok(PublicEvent::Trade {
            data: AggTrade {
                event_time,
                price: float_field(data, "p")?,
                quantity: float_field(data, "q")?,
                is_buyer_maker: data
                    .get("m")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| PublicError("missing maker flag".into()))?,
            },
            received_time,
        }),
        "bookTicker" => Ok(PublicEvent::BookTicker {
            event_time,
            received_time,
            bid: DepthLevel {
                price: float_field(data, "b")?,
                quantity: float_field(data, "B")?,
            },
            ask: DepthLevel {
                price: float_field(data, "a")?,
                quantity: float_field(data, "A")?,
            },
        }),
        "depthUpdate" => Ok(PublicEvent::Depth {
            data: DepthUpdate {
                first_update_id: unsigned_field(data, "U")?,
                final_update_id: unsigned_field(data, "u")?,
                previous_final_update_id: unsigned_field(data, "pu")?,
                event_time,
                bids: parse_value_levels(data.get("b"))?,
                asks: parse_value_levels(data.get("a"))?,
            },
            received_time,
        }),
        "markPriceUpdate" => Ok(PublicEvent::MarkPrice {
            data: MarkPrice {
                event_time,
                price: float_field(data, "p")?,
            },
            received_time,
        }),
        "kline" => {
            let kline = data
                .get("k")
                .ok_or_else(|| PublicError("missing kline data".into()))?;
            Ok(PublicEvent::Kline {
                data: Kline {
                    event_time,
                    open_time: integer_field(kline, "t")?,
                    close_time: integer_field(kline, "T")?,
                    open: float_field(kline, "o")?,
                    high: float_field(kline, "h")?,
                    low: float_field(kline, "l")?,
                    close: float_field(kline, "c")?,
                    volume: float_field(kline, "v")?,
                    is_closed: kline
                        .get("x")
                        .and_then(Value::as_bool)
                        .ok_or_else(|| PublicError("missing kline close flag".into()))?,
                },
                received_time,
            })
        }
        _ => Err(PublicError("unsupported public event type".into())),
    }
}

fn valid_symbol(symbol: &str) -> bool {
    !symbol.is_empty()
        && symbol.len() <= 20
        && symbol
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
}

fn string_field<'a>(value: &'a Value, field: &str) -> Result<&'a str, PublicError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| PublicError(format!("missing {field}")))
}

fn float_field(value: &Value, field: &str) -> Result<f64, PublicError> {
    string_field(value, field)?
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite())
        .ok_or_else(|| PublicError(format!("invalid {field}")))
}

fn integer_field(value: &Value, field: &str) -> Result<i64, PublicError> {
    value
        .get(field)
        .and_then(Value::as_i64)
        .filter(|number| *number >= 0)
        .ok_or_else(|| PublicError(format!("invalid {field}")))
}

fn unsigned_field(value: &Value, field: &str) -> Result<u64, PublicError> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| PublicError(format!("invalid {field}")))
}

fn parse_value_levels(value: Option<&Value>) -> Result<Vec<DepthLevel>, PublicError> {
    let levels = value
        .and_then(Value::as_array)
        .ok_or_else(|| PublicError("invalid depth levels".into()))?;
    levels
        .iter()
        .map(|level| {
            let pair = level
                .as_array()
                .filter(|pair| pair.len() == 2)
                .ok_or_else(|| PublicError("invalid depth level".into()))?;
            Ok(DepthLevel {
                price: pair[0]
                    .as_str()
                    .ok_or_else(|| PublicError("invalid depth price".into()))?
                    .parse()
                    .map_err(|_| PublicError("invalid depth price".into()))?,
                quantity: pair[1]
                    .as_str()
                    .ok_or_else(|| PublicError("invalid depth quantity".into()))?
                    .parse()
                    .map_err(|_| PublicError("invalid depth quantity".into()))?,
            })
        })
        .collect()
}

fn parse_levels(levels: &[[String; 2]]) -> Result<Vec<DepthLevel>, PublicError> {
    levels
        .iter()
        .map(|level| {
            Ok(DepthLevel {
                price: level[0]
                    .parse()
                    .map_err(|_| PublicError("invalid snapshot price".into()))?,
                quantity: level[1]
                    .parse()
                    .map_err(|_| PublicError("invalid snapshot quantity".into()))?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn chunked_unknown_length_snapshot_is_rejected_at_cumulative_byte_limit() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 1024];
            let _ = socket.read(&mut request).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                .await
                .unwrap();
            let body = br#"{"lastUpdateId":1,"bids":[],"asks":[],"padding":"this-chunked-body-exceeds-the-test-limit"}"#;
            for chunk in body.chunks(16) {
                socket
                    .write_all(format!("{:X}\r\n", chunk.len()).as_bytes())
                    .await
                    .unwrap();
                socket.write_all(chunk).await.unwrap();
                socket.write_all(b"\r\n").await.unwrap();
            }
            socket.write_all(b"0\r\n\r\n").await.unwrap();
        });

        let response = reqwest::get(format!("http://{address}/fapi/v1/depth"))
            .await
            .unwrap();
        assert_eq!(response.content_length(), None);
        let error = bounded_json::<RawSnapshot>(response, 64)
            .await
            .err()
            .expect("body must be rejected");
        assert!(
            error.0.contains("exceeds response bound"),
            "unexpected error: {error}"
        );
        server.await.unwrap();
    }
}
