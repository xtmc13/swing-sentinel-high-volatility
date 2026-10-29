import { timingSafeEqual } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { publicQuery } from "./middleware";
import { env } from "./lib/env";

export function isAdminRequest(request: Request, secret: string): boolean {
  if (!secret || secret.length > 512) return false;
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length).trim();
  if (!token || token.length > 512) return false;
  const actual = Buffer.from(token, "utf8");
  const expected = Buffer.from(secret, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
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
