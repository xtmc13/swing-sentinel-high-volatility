import { Link } from "react-router";

export default function NotFound() {
  return <div className="p-6"><div className="panel mx-auto mt-20 max-w-lg p-8 text-center"><div className="terminal-label data-negative">404 / ROUTE NOT FOUND</div><h1 className="mt-3 text-xl">这个终端页面不存在</h1><p className="reading mt-3 text-[13px] text-[#91a0b8]">返回交易总览，继续查看行情、持仓和系统状态。</p><Link to="/" className="btn-primary mt-5">返回交易总览</Link></div></div>;
}
