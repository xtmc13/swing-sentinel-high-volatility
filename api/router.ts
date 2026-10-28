import { createRouter, publicQuery } from "./middleware";
import { tradingRouter } from "./tradingRouter";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  trading: tradingRouter,
});

export type AppRouter = typeof appRouter;
