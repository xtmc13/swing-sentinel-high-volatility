import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  configured: false,
  saveSuccess: false,
  deleteSuccess: false,
  saveError: null as string | null,
  invalidate: vi.fn(async () => undefined),
  save: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/providers/trpc", () => ({
  trpc: {
    useUtils: () => ({ credentials: { status: { invalidate: hooks.invalidate } } }),
    credentials: {
      status: { useQuery: () => ({ data: { configured: hooks.configured }, isLoading: false }) },
      save: {
        useMutation: () => ({
          mutate: hooks.save,
          isPending: false,
          isSuccess: hooks.saveSuccess,
          isError: hooks.saveError !== null,
          error: hooks.saveError === null ? null : new Error(hooks.saveError),
        }),
      },
      delete: {
        useMutation: () => ({
          mutate: hooks.remove,
          isPending: false,
          isSuccess: hooks.deleteSuccess,
          isError: false,
          error: null,
        }),
      },
    },
  },
}));

import BinanceCredentialForm from "./BinanceCredentialForm";

beforeEach(() => {
  hooks.configured = false;
  hooks.saveSuccess = false;
  hooks.deleteSuccess = false;
  hooks.saveError = null;
  hooks.save.mockClear();
  hooks.remove.mockClear();
  hooks.invalidate.mockClear();
});

function render(): string {
  return renderToStaticMarkup(createElement(BinanceCredentialForm));
}

describe("Binance MAINNET credential form", () => {
  it("uses empty password fields and never renders credential plaintext", () => {
    const apiKey = "A".repeat(64);
    const apiSecret = "b".repeat(64);
    const html = render();

    expect(html).toContain("BINANCE · MAINNET");
    expect(html.match(/type="password"/g)).toHaveLength(2);
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain("panel");
    expect(html).toContain("terminal-input");
    expect(html).toContain("未存密文");
    expect(html).not.toContain(apiKey);
    expect(html).not.toContain(apiSecret);
    expect(html).not.toContain("AdminAccess");
    expect(html).not.toContain("解锁控制");
  });

  it("shows stored status without key fragments or readback fields", () => {
    hooks.configured = true;
    const html = render();

    expect(html).toContain("已存密文");
    expect(html).not.toContain("fingerprint");
    expect(html).not.toContain("API key 前缀");
    expect(html).not.toMatch(/value="[^"]+"/);
  });

  it("labels the status as database-only because a complete env pair takes precedence", () => {
    hooks.configured = false;
    const html = render();

    expect(html).toContain("数据库密文（完整环境变量优先）");
    expect(html).toContain("未存密文");
  });

  it("shows save feedback and confirms that live gates were not enabled", () => {
    hooks.saveSuccess = true;
    const html = render();

    expect(html).toContain("凭据已保存");
    expect(html).toContain("不会开启 LIVE、armed 或自动交易");
    expect(html).toContain('role="status"');
  });

  it("shows delete feedback", () => {
    hooks.deleteSuccess = true;

    expect(render()).toContain("凭据已删除");
  });

  it("shows safe server feedback without echoing submitted secrets", () => {
    hooks.saveError = "CREDENTIAL_ENCRYPTION_KEY 未正确配置";

    expect(render()).toContain("CREDENTIAL_ENCRYPTION_KEY 未正确配置");
  });
});
