import { describe, expect, it } from "vitest";

delete process.env.APP_SECRET;
const { appRouter } = await import("./router");

function caller(authorization?: string) {
  return appRouter.createCaller({ req: new Request("http://localhost/api/trpc", { headers: authorization ? { authorization } : undefined }), resHeaders: new Headers() });
}

describe("tRPC 公共控制入口", () => {
  it("无令牌、错误令牌和未配置 APP_SECRET 均可读取控制状态", async () => {
    await expect(caller().trading.adminStatus()).resolves.toEqual({ ok: true });
    await expect(caller("Bearer wrong-token").trading.adminStatus()).resolves.toEqual({ ok: true });
  });
});
