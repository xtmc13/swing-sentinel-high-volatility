use swing_sentinel_core::model::PublicEvent;
use swing_sentinel_core::public_market::{parse_public_message, BinancePublicClient};

#[test]
fn stream_url_contains_only_required_public_market_channels() {
    let url = BinancePublicClient::stream_url("BTCUSDT");
    assert_eq!(
        url,
        "wss://fstream.binance.com/stream?streams=btcusdt@aggTrade/btcusdt@bookTicker/btcusdt@depth@100ms/btcusdt@markPrice@1s/btcusdt@kline_1m"
    );
    assert!(!url.contains("listenKey"));
}

#[test]
fn parses_all_required_public_event_types() {
    let trade = r#"{"stream":"btcusdt@aggTrade","data":{"e":"aggTrade","E":1000,"s":"BTCUSDT","p":"100.5","q":"2.5","m":false}}"#;
    let PublicEvent::Trade {
        data,
        received_time,
    } = parse_public_message(1001, trade).unwrap()
    else {
        panic!("expected trade")
    };
    assert_eq!(data.price, 100.5);
    assert_eq!(data.quantity, 2.5);
    assert!(!data.is_buyer_maker);
    assert_eq!(received_time, 1001);

    let book = r#"{"stream":"btcusdt@bookTicker","data":{"e":"bookTicker","E":1002,"b":"100.0","B":"3.0","a":"101.0","A":"4.0"}}"#;
    let PublicEvent::BookTicker { bid, ask, .. } = parse_public_message(1003, book).unwrap() else {
        panic!("expected book ticker")
    };
    assert_eq!(bid.price, 100.0);
    assert_eq!(ask.quantity, 4.0);

    let depth = r#"{"stream":"btcusdt@depth@100ms","data":{"e":"depthUpdate","E":1004,"U":10,"u":11,"pu":9,"b":[["100.0","3.0"]],"a":[["101.0","4.0"]]}}"#;
    let PublicEvent::Depth { data, .. } = parse_public_message(1005, depth).unwrap() else {
        panic!("expected depth")
    };
    assert_eq!(
        (
            data.first_update_id,
            data.final_update_id,
            data.previous_final_update_id
        ),
        (10, 11, 9)
    );
    assert_eq!(data.bids[0].price, 100.0);

    let mark =
        r#"{"stream":"btcusdt@markPrice@1s","data":{"e":"markPriceUpdate","E":1006,"p":"100.25"}}"#;
    let PublicEvent::MarkPrice { data, .. } = parse_public_message(1007, mark).unwrap() else {
        panic!("expected mark price")
    };
    assert_eq!(data.price, 100.25);

    let kline = r#"{"stream":"btcusdt@kline_1m","data":{"e":"kline","E":1008,"k":{"t":0,"T":59999,"i":"1m","o":"100","h":"102","l":"99","c":"101","v":"12.5","x":true}}}"#;
    let PublicEvent::Kline { data, .. } = parse_public_message(1009, kline).unwrap() else {
        panic!("expected kline")
    };
    assert!(data.is_closed);
    assert_eq!(data.close, 101.0);
}

#[test]
fn malformed_or_cross_symbol_events_are_rejected() {
    let malformed = r#"{"stream":"btcusdt@aggTrade","data":{"e":"aggTrade","E":1000,"s":"BTCUSDT","p":"not-a-price","q":"2.5","m":false}}"#;
    assert!(parse_public_message(1001, malformed).is_err());

    let wrong_symbol = r#"{"stream":"ethusdt@aggTrade","data":{"e":"aggTrade","E":1000,"s":"BTCUSDT","p":"100.5","q":"2.5","m":false}}"#;
    assert!(parse_public_message(1001, wrong_symbol).is_err());
}
