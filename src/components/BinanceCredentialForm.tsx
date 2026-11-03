import { useState } from "react";
import { KeyRound, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/providers/trpc";

export default function BinanceCredentialForm() {
  const utils = trpc.useUtils();
  const status = trpc.credentials.status.useQuery();
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const invalidate = async () => {
    await Promise.all([
      utils.credentials.status.invalidate(),
      utils.trading.dashboard.invalidate(),
    ]);
  };
  const save = trpc.credentials.save.useMutation({
    onSuccess: async () => {
      setApiKey("");
      setApiSecret("");
      toast.success("币安 MAINNET 凭据已保存；交易门控未改变");
      await invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = trpc.credentials.delete.useMutation({
    onSuccess: async () => {
      setApiKey("");
      setApiSecret("");
      toast.success("币安 MAINNET 凭据已删除；交易门控未改变");
      await invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const feedback = save.isSuccess ? "凭据已保存"
    : remove.isSuccess ? "凭据已删除"
      : save.isError ? save.error.message
        : remove.isError ? remove.error.message : null;

  return <section className="panel p-4" aria-labelledby="binance-credentials-title">
    <div className="flex items-center justify-between gap-3">
      <div>
        <h2 id="binance-credentials-title" className="terminal-label">BINANCE · MAINNET CREDENTIALS</h2>
        <p className="reading mt-2 text-[10px] leading-5 text-[#8290aa]">服务器加密保存，只返回配置状态；不会开启 LIVE、armed 或自动交易。</p>
      </div>
      <KeyRound size={17} className="data-warning" aria-hidden="true" />
    </div>
    <div className="mt-3 flex items-center justify-between border border-[#1a2540] bg-[#080e19] px-3 py-2 text-[10px]">
      <span className="text-[#8290aa]">数据库密文（完整环境变量优先）</span>
      <span className={status.data?.configured ? "data-live" : "data-warning"}>
        {status.isLoading ? "读取中" : status.data?.configured ? "已存密文" : "未存密文"}
      </span>
    </div>
    <form className="mt-4 space-y-3" autoComplete="off" onSubmit={(event) => {
      event.preventDefault();
      save.mutate({ apiKey, apiSecret });
    }}>
      <label className="block">
        <span className="terminal-label">API KEY</span>
        <input
          className="terminal-input mt-2 !text-[11px]"
          type="password"
          name="binance-mainnet-api-key"
          autoComplete="new-password"
          required
          minLength={64}
          maxLength={64}
          pattern="[A-Za-z0-9]{64}"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>
      <label className="block">
        <span className="terminal-label">API SECRET</span>
        <input
          className="terminal-input mt-2 !text-[11px]"
          type="password"
          name="binance-mainnet-api-secret"
          autoComplete="new-password"
          required
          minLength={64}
          maxLength={64}
          pattern="[A-Za-z0-9]{64}"
          value={apiSecret}
          onChange={(event) => setApiSecret(event.target.value)}
        />
      </label>
      <button type="submit" className="btn-primary w-full" disabled={save.isPending || remove.isPending}>
        <Save size={13} aria-hidden="true" />{save.isPending ? "加密保存中" : status.data?.configured ? "替换 MAINNET 凭据" : "保存 MAINNET 凭据"}
      </button>
    </form>
    <button
      type="button"
      className="btn-secondary mt-2 w-full !text-[#fca5a5]"
      disabled={!status.data?.configured || save.isPending || remove.isPending}
      onClick={() => {
        if (window.confirm("确认删除币安 MAINNET 凭据？已初始化的主网连接会停止，其他交易门控不变。")) remove.mutate();
      }}
    >
      <Trash2 size={13} aria-hidden="true" />{remove.isPending ? "删除中" : "删除 MAINNET 凭据"}
    </button>
    {feedback && <p
      className={`reading mt-3 border-l-2 px-3 py-2 text-[10px] leading-5 ${save.isError || remove.isError
        ? "border-[#f87171] bg-[#1b1016] text-[#fca5a5]" : "border-[#22d3ee] bg-[#081820] text-[#a8b5c8]"}`}
      role={save.isError || remove.isError ? "alert" : "status"}
    >{feedback}</p>}
  </section>;
}
