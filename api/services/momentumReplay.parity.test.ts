import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@contracts/trading";
import { replayMomentum, type MomentumReplayEvent } from "./momentumReplay";

const NOW = 1_800_000_000_000;

function book(sequence: number, eventTime: number) {
  return {
    type: "order_book" as const,
    eventTime,
    receivedTime: eventTime + 1,
    sequence,
    generation: 1,
    bid: { price: 99.99, quantity: 2 },
    ask: { price: 100.01, quantity: 1 },
  };
}

describe("replay and Rust sampling parity", () => {
  it("uses independent mark events and requires the Rust default of three marks", () => {
    const events: MomentumReplayEvent[] = [
      { type: "mark", eventTime: NOW - 20, price: 100 },
      { type: "mark", eventTime: NOW - 10, price: 100.01 },
      { type: "mark", eventTime: NOW, price: 100.02 },
      book(1, NOW - 20),
      book(2, NOW - 10),
      book(3, NOW),
    ];

    const result = replayMomentum({ events, context: { market: { symbol: "BTCUSDT" } } as never, settings: DEFAULT_SETTINGS });

    expect(result.frames.map((frame) => frame.quality)).toEqual([
      "INSUFFICIENT_HISTORY", "INSUFFICIENT_HISTORY", "GOOD",
    ]);
    expect(result.frames.map((frame) => frame.mark_price)).toEqual([100, 100.01, 100.02]);
  });

  it("never samples a future mark into an earlier book frame", () => {
    const result = replayMomentum({
      events: [
        { type: "mark", eventTime: NOW - 10, price: 100 },
        { type: "mark", eventTime: NOW, price: 110 },
        book(1, NOW - 10),
        book(2, NOW),
      ],
      context: { market: { symbol: "BTCUSDT" } } as never,
      settings: DEFAULT_SETTINGS,
    });

    expect(result.frames[0]?.mark_price).toBe(100);
    expect(result.frames[1]?.mark_price).toBe(110);
  });
});
