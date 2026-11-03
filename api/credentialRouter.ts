import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import {
  binanceCredentialStore,
  type BinanceCredentialStore,
} from "./credentials/binanceCredentialStore";
import { productionLiveRuntime } from "./live/productionSingleton";

const binanceCredentialInput = z.object({
  apiKey: z.string().regex(/^[A-Za-z0-9]{64}$/, "API key 必须为 64 位字母或数字"),
  apiSecret: z.string().regex(/^[A-Za-z0-9]{64}$/, "API secret 必须为 64 位字母或数字"),
}).strict();

function credentialError(error: unknown, action: string): TRPCError {
  if (error instanceof TRPCError) return error;
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("CREDENTIAL_ENCRYPTION_KEY")) {
    return new TRPCError({ code: "PRECONDITION_FAILED", message });
  }
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `币安 MAINNET 凭据${action}失败` });
}

export function createCredentialRouter(
  store: BinanceCredentialStore = binanceCredentialStore,
  invalidate: () => Promise<void> = () => productionLiveRuntime.stop(),
) {
  return createRouter({
    status: publicQuery.query(async () => {
      try {
        return await store.status();
      } catch (error) {
        throw credentialError(error, "状态读取");
      }
    }),
    save: publicQuery.input(binanceCredentialInput).mutation(async ({ input }) => {
      try {
        const status = await store.save(input);
        await invalidate();
        return status;
      } catch (error) {
        throw credentialError(error, "保存");
      }
    }),
    delete: publicQuery.mutation(async () => {
      try {
        const status = await store.delete();
        await invalidate();
        return status;
      } catch (error) {
        throw credentialError(error, "删除");
      }
    }),
  });
}
