import { useOutletContext } from "react-router";
import type { DashboardData } from "@contracts/trading";

export interface TerminalContext {
  data: DashboardData;
  selectedSymbol: string;
  setSelectedSymbol: (symbol: string) => void;
  refresh: () => void;
  refreshing: boolean;
}

export function useTerminal() {
  return useOutletContext<TerminalContext>();
}
