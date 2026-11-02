import { timingSafeEqual } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { publicQuery } from "./middleware";
import { env } from "./lib/env";

export function isFreshAdminSecret(candidate: string, secret: string): boolean {
  if (!candidate || !secret || candidate.length > 512 || secret.length > 512) return false;
  const actual = Buffer.from(candidate, "utf8");
  const expected = Buffer.from(secret, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function isAdminRequest(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return isFreshAdminSecret(header.slice("Bearer ".length).trim(), secret);
}

export const adminQuery = publicQuery.use(async ({ ctx, next }) => {
  if (!env.appSecret) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "服务端未配置 APP_SECRET，管理操作已锁定" });
  }
  if (!isAdminRequest(ctx.req, env.appSecret)) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "需要先在页面顶部解锁管理员控制" });
  }
  return next();
});
