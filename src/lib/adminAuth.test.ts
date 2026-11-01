import { afterEach, describe, expect, it } from "vitest";
import { clearAdminToken, getAdminToken, setAdminToken } from "./adminAuth";

afterEach(() => clearAdminToken());

describe("管理员令牌生命周期", () => {
  it("仅在当前运行时内存中设置和读取令牌", () => {
    expect(getAdminToken()).toBe("");
    setAdminToken("test-admin-token");
    expect(getAdminToken()).toBe("test-admin-token");
  });

  it("退出管理员控制后立即清空令牌", () => {
    setAdminToken("test-admin-token");
    clearAdminToken();
    expect(getAdminToken()).toBe("");
  });
});
