interface ShutdownTarget {
  once(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

export function installProductionShutdown(
  target: ShutdownTarget,
  stop: () => Promise<void>,
  exit: (code: number) => void,
): void {
  const shutdown = () => {
    void stop().then(() => exit(0), () => exit(1));
  };
  target.once("SIGTERM", shutdown);
  target.once("SIGINT", shutdown);
}
