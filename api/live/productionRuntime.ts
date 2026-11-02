import type { LiveReadiness, PrivateWsHealth, TradingSettings, LiveControls } from "@contracts/trading";
import type { ExecutionAdapter } from "../services/executionCoordinator";
import { getLivePublicStatus, liveTradingEnabled, type ServerEnvironment } from "./liveConfig";

export interface ProductionLiveServices {
  adapter: ExecutionAdapter;
  start(): Promise<void>;
  stop(): Promise<void>;
  preflight(): Promise<LiveReadiness>;
  privateWs: { health(): PrivateWsHealth };
  reconciliation: { health(): { configured: boolean; running: boolean; lastRunAt: number | null } };
}

export interface ProductionLiveRuntimeOptions {
  env: ServerEnvironment;
  getSettings: () => Promise<TradingSettings>;
  getLiveControls: () => Promise<LiveControls>;
  hasOutstandingLiveRisk: () => Promise<boolean>;
  createServices: () => ProductionLiveServices;
}

const disconnectedPrivateWs = (): PrivateWsHealth => ({
  configured: false,
  running: false,
  connected: false,
  lastMessageAt: null,
  reconnects: 0,
});

const stoppedReconciliation = () => ({ configured: false, running: false, lastRunAt: null });

export function createProductionLiveRuntime(options: ProductionLiveRuntimeOptions) {
  let current: ProductionLiveServices | null = null;
  let starting: Promise<ProductionLiveServices> | null = null;
  let stopping: Promise<void> | null = null;
  let generation = 0;

  async function getLiveAdapter(humanApproved = false): Promise<ExecutionAdapter | null> {
    if (stopping) await stopping;
    const requestedGeneration = generation;
    const settings = await options.getSettings();
    if (settings.executionMode !== "LIVE_MAINNET") return null;
    if (!liveTradingEnabled(options.env) || !getLivePublicStatus(options.env).credentialsConfigured) return null;
    if (current) return current.adapter;
    const controls = await options.getLiveControls();
    if (!controls.armed && !humanApproved && !await options.hasOutstandingLiveRisk()) return null;
    if (requestedGeneration !== generation) return getLiveAdapter(humanApproved);
    let pending = starting;
    if (!pending) {
      const startGeneration = generation;
      pending = (async () => {
        const created = options.createServices();
        try {
          await created.start();
        } catch (error) {
          try { await created.stop(); } catch { /* startup error remains the caller result */ }
          throw error;
        }
        if (startGeneration === generation) current = created;
        return created;
      })();
      starting = pending;
      try {
        await pending;
      } catch (error) {
        if (starting === pending) starting = null;
        if (startGeneration === generation) current = null;
        throw error;
      }
    }
    const started = await pending;
    if (requestedGeneration !== generation && stopping) await stopping;
    return started.adapter;
  }

  return {
    getLiveAdapter,
    async runLivePreflight(humanApproved = false): Promise<LiveReadiness> {
      const live = await getLiveAdapter(humanApproved);
      if (!live || !current) return { ready: false, reasons: ["主网执行门控未满足"], checkedAt: null };
      return current.preflight();
    },
    privateWs: { health: () => current?.privateWs.health() ?? disconnectedPrivateWs() },
    reconciliation: { health: () => current?.reconciliation.health() ?? stoppedReconciliation() },
    async stop(): Promise<void> {
      if (stopping) return stopping;
      generation += 1;
      const stopGeneration = generation;
      const pending = starting;
      const services = current;
      current = null;
      starting = null;
      const operation = (async () => {
        if (pending) {
          try {
            const started = await pending;
            if (stopGeneration === generation) current = null;
            await started.stop();
          } catch {
            if (stopGeneration === generation) current = null;
          }
        } else if (services) await services.stop();
      })();
      stopping = operation;
      try {
        await operation;
      } finally {
        if (stopping === operation) stopping = null;
      }
    },
  };
}
