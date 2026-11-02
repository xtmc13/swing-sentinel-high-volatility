use swing_sentinel_core::depth::{DepthStatus, DepthSync};
use swing_sentinel_core::model::{DepthLevel, DepthSnapshot, DepthUpdate};

fn level(price: f64, quantity: f64) -> DepthLevel {
    DepthLevel { price, quantity }
}

fn snapshot(last_update_id: u64) -> DepthSnapshot {
    DepthSnapshot {
        last_update_id,
        bids: vec![level(99.0, 2.0)],
        asks: vec![level(101.0, 3.0)],
    }
}

fn update(first: u64, final_id: u64, previous: u64) -> DepthUpdate {
    DepthUpdate {
        first_update_id: first,
        final_update_id: final_id,
        previous_final_update_id: previous,
        event_time: (final_id * 1_000) as i64,
        bids: vec![level(99.0, 4.0)],
        asks: vec![level(101.0, 5.0)],
    }
}

#[test]
fn snapshot_waits_for_bridging_diff_then_applies_in_order() {
    let mut depth = DepthSync::new(8);
    assert_eq!(depth.push(update(102, 103, 101)), DepthStatus::Buffered);
    assert_eq!(depth.push(update(99, 101, 98)), DepthStatus::Buffered);
    assert!(depth.best_bid_ask().is_none());

    assert_eq!(
        depth.load_snapshot(snapshot(100)),
        DepthStatus::Applied { sequence: 103 }
    );
    let (bid, ask) = depth.best_bid_ask().expect("synchronized top of book");
    assert_eq!((bid.price, bid.quantity), (99.0, 4.0));
    assert_eq!((ask.price, ask.quantity), (101.0, 5.0));
    assert_eq!(depth.last_sequence(), Some(103));
}

#[test]
fn duplicate_diff_is_ignored_without_advancing_sequence() {
    let mut depth = DepthSync::new(8);
    depth.push(update(99, 101, 98));
    depth.load_snapshot(snapshot(100));

    assert_eq!(depth.push(update(99, 101, 98)), DepthStatus::Duplicate);
    assert_eq!(depth.last_sequence(), Some(101));
}

#[test]
fn sequence_gap_fails_closed_and_next_snapshot_resynchronizes_new_generation() {
    let mut depth = DepthSync::new(8);
    depth.push(update(99, 101, 98));
    depth.load_snapshot(snapshot(100));
    let original_generation = depth.generation();

    assert_eq!(
        depth.push(update(110, 111, 999)),
        DepthStatus::ResyncRequired
    );
    assert!(depth.best_bid_ask().is_none());
    assert!(depth.generation() > original_generation);

    depth.push(update(110, 111, 109));
    assert_eq!(
        depth.load_snapshot(snapshot(109)),
        DepthStatus::Applied { sequence: 111 }
    );
    assert_eq!(depth.last_sequence(), Some(111));
}

#[test]
fn bounded_pre_snapshot_buffer_overflows_into_fail_closed_resync() {
    let mut depth = DepthSync::new(1);
    assert_eq!(depth.push(update(99, 101, 98)), DepthStatus::Buffered);
    assert_eq!(
        depth.push(update(102, 103, 101)),
        DepthStatus::ResyncRequired
    );
    assert!(depth.best_bid_ask().is_none());
}
