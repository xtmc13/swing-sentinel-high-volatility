use std::collections::BTreeMap;

use crate::model::{DepthLevel, DepthSnapshot, DepthUpdate};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DepthStatus {
    Buffered,
    Applied { sequence: u64 },
    Duplicate,
    ResyncRequired,
}

#[derive(Debug)]
struct OrderBook {
    last_update_id: u64,
    bids: BTreeMap<u64, f64>,
    asks: BTreeMap<u64, f64>,
    bridged: bool,
}

impl OrderBook {
    fn from_snapshot(snapshot: DepthSnapshot) -> Option<Self> {
        if snapshot
            .bids
            .iter()
            .chain(&snapshot.asks)
            .copied()
            .all(DepthLevel::is_valid)
        {
            let mut book = Self {
                last_update_id: snapshot.last_update_id,
                bids: BTreeMap::new(),
                asks: BTreeMap::new(),
                bridged: false,
            };
            book.apply_levels(snapshot.bids, true);
            book.apply_levels(snapshot.asks, false);
            Some(book)
        } else {
            None
        }
    }

    fn apply(&mut self, update: &DepthUpdate) {
        self.apply_levels(update.bids.iter().copied(), true);
        self.apply_levels(update.asks.iter().copied(), false);
        self.last_update_id = update.final_update_id;
        self.bridged = true;
    }

    fn apply_levels(&mut self, levels: impl IntoIterator<Item = DepthLevel>, bids: bool) {
        let side = if bids { &mut self.bids } else { &mut self.asks };
        for level in levels {
            if level.quantity == 0.0 {
                side.remove(&level.price.to_bits());
            } else {
                side.insert(level.price.to_bits(), level.quantity);
            }
        }
    }

    fn best_bid_ask(&self) -> Option<(DepthLevel, DepthLevel)> {
        let (bid_price, bid_quantity) = self.bids.iter().next_back()?;
        let (ask_price, ask_quantity) = self.asks.iter().next()?;
        Some((
            DepthLevel {
                price: f64::from_bits(*bid_price),
                quantity: *bid_quantity,
            },
            DepthLevel {
                price: f64::from_bits(*ask_price),
                quantity: *ask_quantity,
            },
        ))
    }
}

#[derive(Debug)]
enum SyncState {
    AwaitingSnapshot,
    Ready(OrderBook),
}

#[derive(Debug)]
pub struct DepthSync {
    state: SyncState,
    buffered: Vec<DepthUpdate>,
    max_buffer: usize,
    generation: u64,
}

impl DepthSync {
    pub fn new(max_buffer: usize) -> Self {
        Self::with_generation(max_buffer, 1)
    }

    pub fn with_generation(max_buffer: usize, generation: u64) -> Self {
        Self {
            state: SyncState::AwaitingSnapshot,
            buffered: Vec::new(),
            max_buffer: max_buffer.max(1),
            generation: generation.max(1),
        }
    }

    pub fn push(&mut self, update: DepthUpdate) -> DepthStatus {
        if !update.is_valid() {
            self.invalidate(Some(update));
            return DepthStatus::ResyncRequired;
        }

        match &mut self.state {
            SyncState::AwaitingSnapshot => self.buffer(update),
            SyncState::Ready(book) => {
                if update.final_update_id <= book.last_update_id {
                    return DepthStatus::Duplicate;
                }
                let contiguous = if book.bridged {
                    update.previous_final_update_id == book.last_update_id
                } else {
                    update.first_update_id <= book.last_update_id
                        || update.previous_final_update_id == book.last_update_id
                };
                if !contiguous {
                    self.invalidate(Some(update));
                    return DepthStatus::ResyncRequired;
                }
                book.apply(&update);
                DepthStatus::Applied {
                    sequence: book.last_update_id,
                }
            }
        }
    }

    pub fn load_snapshot(&mut self, snapshot: DepthSnapshot) -> DepthStatus {
        let Some(mut book) = OrderBook::from_snapshot(snapshot) else {
            self.invalidate(None);
            return DepthStatus::ResyncRequired;
        };
        self.buffered
            .sort_by_key(|update| (update.first_update_id, update.final_update_id));

        let mut bridged = false;
        let pending = std::mem::take(&mut self.buffered);
        for update in pending {
            if update.final_update_id <= book.last_update_id {
                continue;
            }
            if !bridged {
                if update.first_update_id <= book.last_update_id
                    || update.previous_final_update_id == book.last_update_id
                {
                    book.apply(&update);
                    bridged = true;
                }
            } else if update.previous_final_update_id == book.last_update_id {
                book.apply(&update);
            } else {
                self.invalidate(None);
                return DepthStatus::ResyncRequired;
            }
        }

        self.state = SyncState::Ready(book);
        if !bridged {
            return DepthStatus::ResyncRequired;
        }
        let sequence = self.last_sequence().expect("bridged book has a sequence");
        DepthStatus::Applied { sequence }
    }

    pub fn best_bid_ask(&self) -> Option<(DepthLevel, DepthLevel)> {
        match &self.state {
            SyncState::AwaitingSnapshot => None,
            SyncState::Ready(book) if book.bridged => book.best_bid_ask(),
            SyncState::Ready(_) => None,
        }
    }

    pub fn last_sequence(&self) -> Option<u64> {
        match &self.state {
            SyncState::AwaitingSnapshot => None,
            SyncState::Ready(book) if book.bridged => Some(book.last_update_id),
            SyncState::Ready(_) => None,
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    fn buffer(&mut self, update: DepthUpdate) -> DepthStatus {
        if self.buffered.len() >= self.max_buffer {
            self.invalidate(None);
            return DepthStatus::ResyncRequired;
        }
        self.buffered.push(update);
        DepthStatus::Buffered
    }

    fn invalidate(&mut self, update: Option<DepthUpdate>) {
        self.state = SyncState::AwaitingSnapshot;
        self.buffered.clear();
        if let Some(update) = update {
            self.buffered.push(update);
        }
        self.generation = self.generation.saturating_add(1);
    }
}
