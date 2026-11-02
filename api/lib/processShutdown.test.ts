import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installProductionShutdown } from "./processShutdown";

describe("production process shutdown", () => {
  it("SIGTERM and SIGINT stop live services before process exit", async () => {
    const target = new EventEmitter();
    const stops: string[] = [];
    const exit = vi.fn();
    installProductionShutdown(target, async () => { stops.push("stopped"); }, exit);

    target.emit("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(stops).toEqual(["stopped"]);

    target.emit("SIGINT");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(2));
    expect(stops).toEqual(["stopped", "stopped"]);
  });

  it("uses a failed exit code if lifecycle cleanup fails", async () => {
    const target = new EventEmitter();
    const exit = vi.fn();
    installProductionShutdown(target, async () => { throw new Error("stop failed"); }, exit);

    target.emit("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });
});
