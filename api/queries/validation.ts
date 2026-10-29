import { desc, eq } from "drizzle-orm";
import { getDb } from "./connection";
import { validationReports } from "@db/schema";
import type { ValidationReport, ValidationReportSummary } from "@contracts/validation";

export async function persistValidationReport(report: ValidationReport) {
  await getDb().insert(validationReports).values({
    id: report.id,
    symbolsJson: JSON.stringify(report.symbols),
    timeframe: report.timeframe,
    bars: report.bars,
    reportJson: JSON.stringify(report),
  });
}

export async function listValidationReports(limit = 8): Promise<ValidationReportSummary[]> {
  const rows = await getDb().select().from(validationReports).orderBy(desc(validationReports.createdAt)).limit(limit);
  return rows.map((row) => {
    const report = JSON.parse(row.reportJson) as ValidationReport;
    return {
      id: row.id,
      symbols: report.symbols,
      timeframe: report.timeframe,
      bars: row.bars,
      createdAt: report.createdAt,
      outOfSample: report.outOfSample,
    };
  });
}

export async function getValidationReport(id: string): Promise<ValidationReport | null> {
  const row = (await getDb().select().from(validationReports).where(eq(validationReports.id, id)).limit(1))[0];
  return row ? JSON.parse(row.reportJson) as ValidationReport : null;
}
