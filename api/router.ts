import { createRouter, publicQuery } from "./middleware";
import { createCredentialRouter } from "./credentialRouter";
import { tradingRouter } from "./tradingRouter";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  credentials: createCredentialRouter(),
  trading: tradingRouter,
});

export type AppRouter = typeof appRouter;
