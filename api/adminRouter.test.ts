import { afterAll, describe, expect, it } from "vitest";
const SECRET = "integration-admin-secret-with-32-plus-characters";
process.env.APP_SECRET = SECRET;
const { appRouter } = await import("./router");
function caller(authorization?: string) {
  return appRouter.createCaller({ req: new Request("http://localhost/api/trpc", { headers: authorization ? { authorization } : undefined }), resHeaders: new Headers() });
}
afterAll(() => { delete process.env.APP_SECRET; });
describe("tRPC 管理操作鉴权", () => {
  it("有效令牌可以读取管理状态", async () => {
    await expect(caller(`Bearer ${SECRET}`).trading.adminStatus()).resolves.toEqual({ ok: true });
  });
  it("无令牌和错误令牌在执行数据库重置前就被拒绝", async () => {
    await expect(caller().trading.reset()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller().trading.deleteBacktest({ id: crypto.randomUUID() })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller("Bearer wrong-token-that-is-long-enough-000").trading.reset()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
