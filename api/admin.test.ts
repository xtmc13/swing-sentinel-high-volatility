import { describe, expect, it } from "vitest";
import { isAdminRequest } from "./admin";
const SECRET = "test-admin-secret-with-at-least-32-characters";
const request = (authorization?: string) => new Request("http://localhost/api/trpc/trading.adminStatus", { headers: authorization ? { authorization } : undefined });
describe("管理员令牌校验", () => {
  it("只接受完全匹配的 Bearer 令牌", () => {
    expect(isAdminRequest(request(`Bearer ${SECRET}`), SECRET)).toBe(true);
    expect(isAdminRequest(request(`Bearer ${SECRET}x`), SECRET)).toBe(false);
    expect(isAdminRequest(request(`Basic ${SECRET}`), SECRET)).toBe(false);
    expect(isAdminRequest(request(), SECRET)).toBe(false);
  });
  it("空密钥和超长令牌失败关闭", () => {
    expect(isAdminRequest(request("Bearer "), "")).toBe(false);
    expect(isAdminRequest(request(`Bearer ${"x".repeat(513)}`), SECRET)).toBe(false);
  });
});
