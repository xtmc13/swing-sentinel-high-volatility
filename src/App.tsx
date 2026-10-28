import { lazy, Suspense, type ReactNode } from "react";
import { Route, Routes } from "react-router";
import TerminalLayout from "@/components/TerminalLayout";

const Home = lazy(() => import("@/pages/Home"));
const MarketsPage = lazy(() => import("@/pages/MarketsPage"));
const PositionsPage = lazy(() => import("@/pages/PositionsPage"));
const RiskPage = lazy(() => import("@/pages/RiskPage"));
const ReviewPage = lazy(() => import("@/pages/ReviewPage"));
const NotFound = lazy(() => import("@/pages/NotFound"));

function page(element: ReactNode) {
  return <Suspense fallback={<div className="p-6"><div className="panel flex h-40 items-center justify-center text-[11px] tracking-[0.12em] text-[#8290aa]">LOADING TERMINAL MODULE…</div></div>}>{element}</Suspense>;
}

export default function App() {
  return (
    <Routes>
      <Route element={<TerminalLayout />}>
        <Route path="/" element={page(<Home />)} />
        <Route path="/markets" element={page(<MarketsPage />)} />
        <Route path="/positions" element={page(<PositionsPage />)} />
        <Route path="/risk" element={page(<RiskPage />)} />
        <Route path="/review" element={page(<ReviewPage />)} />
        <Route path="*" element={page(<NotFound />)} />
      </Route>
    </Routes>
  );
}
