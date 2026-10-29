import { useCallback, useEffect, useState, type FormEvent } from "react";
import { LoaderCircle, LockKeyhole, UnlockKeyhole } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/providers/trpc";
import { clearAdminToken, getAdminToken, setAdminToken } from "@/lib/adminAuth";

export default function AdminAccess() {
  const utils = trpc.useUtils();
  const [secret, setSecret] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [pending, setPending] = useState(false);
  const verify = useCallback(async (candidate: string, notify = true) => {
    setPending(true);
    setAdminToken(candidate);
    try {
      await utils.trading.adminStatus.fetch();
      setUnlocked(true);
      setSecret("");
      if (notify) toast.success("管理员控制已解锁；关闭标签页后会自动锁定");
      return true;
    } catch (error) {
      clearAdminToken();
      setUnlocked(false);
      if (notify) toast.error(error instanceof Error ? error.message : "管理员令牌验证失败");
      return false;
    } finally {
      setPending(false);
    }
  }, [utils]);
  useEffect(() => {
    const saved = getAdminToken();
    if (saved) void verify(saved, false);
  }, [verify]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (secret && !pending) void verify(secret);
  };
  const lock = () => {
    clearAdminToken();
    setUnlocked(false);
    setSecret("");
    toast.info("已退出管理员控制，当前为只读模式");
  };
  return (
    <section className="border-b border-[#1a2540] bg-[#080e19] px-3 py-2 sm:px-5" aria-label="管理员访问控制">
      {unlocked ? (
        <div className="flex min-h-9 flex-wrap items-center justify-between gap-2 text-[11px]">
          <span className="flex items-center gap-2 text-[#67e8f9]"><UnlockKeyhole size={14} aria-hidden="true" />管理员控制已解锁<span className="text-[#8290aa]">· 令牌仅保留在当前标签页</span></span>
          <button type="button" className="btn-secondary !min-h-9 !px-3 !text-[10px]" onClick={lock}><LockKeyhole size={13} />退出控制</button>
        </div>
      ) : (
        <form className="flex flex-wrap items-center gap-2" onSubmit={submit}>
          <span className="flex items-center gap-2 text-[11px] text-[#a8b5c8]"><LockKeyhole size={14} className="text-[#fbbf24]" aria-hidden="true" />只读模式</span>
          <label className="sr-only" htmlFor="admin-secret">管理员令牌</label>
          <input id="admin-secret" className="terminal-input !min-h-9 min-w-0 flex-1 sm:max-w-xs !text-[11px]" type="password" autoComplete="current-password" minLength={32} required value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="输入 APP_SECRET 解锁控制" />
          <button type="submit" className="btn-secondary !min-h-9 !px-3 !text-[10px]" disabled={pending || secret.length < 32}>
            {pending ? <LoaderCircle size={13} className="animate-spin" /> : <UnlockKeyhole size={13} />}
            {pending ? "正在验证" : "解锁控制"}
          </button>
        </form>
      )}
    </section>
  );
}
