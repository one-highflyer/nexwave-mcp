import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { frappeGet, frappeRunReport, type FrappeReportResult } from "./frappe";
import { validateDateRange } from "./report-tools";
import { PERIOD_SCHEMA, resolveReportPeriod } from "./report-period";
import { structuredResult, ToolError } from "./tool-result";
import type { NexWaveAuthProps } from "./types";

const NAME = z.string().trim().min(1).max(140);
const LIMIT = z.number().int().min(1).max(20).default(5);

export function registerInsightTools(server: McpServer, getProps: () => Promise<NexWaveAuthProps>): void {
  server.registerTool("get_sales_summary", {
    description: "Summarise submitted sales invoice net revenue, including returns and excluding tax, by customer, item, item group, or month. Totals and rankings use all permission-visible report rows before the result limit. Use for sales breakdowns or best-selling products/services by revenue. This is not profit, cash receipts or brand analysis.",
    inputSchema: {
      company: NAME, ...PERIOD_SCHEMA,
      group_by: z.enum(["customer", "item", "item_group", "month"]),
      customer: NAME.optional().describe("Confirmed exact customer ID."),
      limit: LIMIT,
    },
  }, async ({ company, from_date: from, to_date: to, period, as_of_date, group_by, customer, limit }) => {
    const props = await getProps();
    const { from_date, to_date } = await resolveReportPeriod(props, company, { from_date: from, to_date: to, period, as_of_date });
    validateDateRange(from_date, to_date, 366);
    const filters = { company, from_date, to_date, ...(customer ? { customer } : {}) };
    const [report, companyRecord] = await Promise.all([
      frappeRunReport(props, "Item-wise Sales Register", filters),
      frappeGet<{ default_currency?: unknown }>(props, "Company", company),
    ]);
    if (typeof companyRecord.default_currency !== "string" || !companyRecord.default_currency.trim()) {
      throw new ToolError("UPSTREAM_INVALID_RESPONSE", "The company currency could not be confirmed.");
    }
    return structuredResult({ company, from_date, to_date, currency: companyRecord.default_currency.trim(), ...summariseSales(report, group_by, limit) });
  });

  server.registerTool("get_stock_risk", {
    description: "Check existing item/warehouse stock rows against configured per-warehouse reorder levels using Stock Projected Qty. Coverage is partial: missing Bins and warehouse-group reorder rules are not assessed. Never conclude all stock is safe. Missing reorder settings mean risk is unknown. No date range is needed. A user-specified quantity_threshold checks actual quantity strictly below that threshold in each item's stock UOM.",
    inputSchema: {
      company: NAME, item_code: NAME.optional(), warehouse: NAME.optional(), item_group: NAME.optional(),
      quantity_threshold: z.number().finite().min(0).optional(), limit: LIMIT,
    },
  }, async ({ company, item_code, warehouse, item_group, quantity_threshold, limit }) => {
    const props = await getProps();
    if (warehouse) {
      const record = await frappeGet<{ company: string }>(props, "Warehouse", warehouse);
      if (record.company !== company) throw new ToolError("INVALID_ARGUMENT", "The selected warehouse does not belong to the requested company.");
    }
    const data = await frappeRunReport(props, "Stock Projected Qty", {
      company, ...(item_code ? { item_code } : {}), ...(warehouse ? { warehouse } : {}), ...(item_group ? { item_group } : {}),
    });
    return structuredResult({ company, snapshot: "current", ...summariseStockRisk(data, limit, quantity_threshold) });
  });
}

export function summariseSales(data: FrappeReportResult, groupBy: "customer" | "item" | "item_group" | "month", limit: number) {
  const groups = new Map<string, { name: string; label: string; net_sales: number }>();
  let lineCount = 0;
  for (const row of data.result ?? []) {
    if (row.is_total_row === true) continue;
    // The standard report's total row has no invoice ID.
    if (typeof row.invoice !== "string" || !row.invoice.trim()) continue;
    const field = groupBy === "item" ? "item_code" : groupBy === "month" ? "posting_date" : groupBy;
    const rawName = row[field];
    if (typeof rawName !== "string" || !rawName.trim() || typeof row.amount !== "number" || !Number.isFinite(row.amount)) {
      throw new ToolError("UPSTREAM_INVALID_RESPONSE", "Sales rows cannot be grouped safely. No total can be confirmed.");
    }
    if (groupBy === "month") validateDateRange(rawName, rawName);
    const name = groupBy === "month" ? rawName.slice(0, 7) : rawName;
    const label = groupBy === "customer" ? row.customer_name : groupBy === "item" ? row.item_name : name;
    const group = groups.get(name) ?? { name, label: clean(String(label || name)), net_sales: 0 };
    group.net_sales += row.amount;
    groups.set(name, group);
    lineCount++;
  }
  if ((data.result?.length ?? 0) > 0 && !lineCount) throw new ToolError("UPSTREAM_INVALID_RESPONSE", "The sales report did not contain recognisable invoice rows.");
  const unroundedRows = [...groups.values()];
  const totalNetSales = round(unroundedRows.reduce((sum, row) => sum + row.net_sales, 0));
  unroundedRows.sort((a, b) => groupBy === "month" ? a.name.localeCompare(b.name) : b.net_sales - a.net_sales);
  const rows = unroundedRows.map((row) => ({ ...row, net_sales: round(row.net_sales) }));
  return {
    group_by: groupBy, basis: "Submitted invoice net amounts in company currency; returns included; tax excluded.",
    total_net_sales: totalNetSales,
    groups: rows.slice(0, limit), group_count: rows.length, line_count: lineCount,
    truncated: rows.length > limit, totals_complete: true,
  };
}

export function summariseStockRisk(data: FrappeReportResult, limit: number, threshold?: number) {
  let checked = 0;
  let unknown = 0;
  const risks: Array<Record<string, unknown>> = [];
  for (const row of data.result ?? []) {
    if (row.is_total_row === true) continue;
    if (typeof row.item_code !== "string" || typeof row.warehouse !== "string" || !row.warehouse) continue;
    if (![row.actual_qty, row.projected_qty, row.re_order_level, row.re_order_qty].every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new ToolError("UPSTREAM_INVALID_RESPONSE", "The stock report lacks valid quantities or reorder settings.");
    }
    checked++;
    // ERPNext treats either a reorder level or reorder quantity as a configured rule.
    const configured = threshold !== undefined || row.re_order_level !== 0 || row.re_order_qty !== 0;
    if (!configured) { unknown++; continue; }
    const quantity = Number(threshold === undefined ? row.projected_qty : row.actual_qty);
    const level = threshold ?? Number(row.re_order_level);
    if (threshold === undefined ? quantity > level : quantity >= level) continue;
    risks.push({
      item_code: row.item_code, item_name: clean(String(row.item_name ?? row.item_code)), warehouse: row.warehouse,
      stock_uom: row.stock_uom, actual_qty: row.actual_qty, projected_qty: row.projected_qty,
      threshold: level, shortage_qty: round(level - quantity),
    });
  }
  if ((data.result?.length ?? 0) > 0 && !checked) throw new ToolError("UPSTREAM_INVALID_RESPONSE", "The stock report did not contain recognisable item and warehouse rows.");
  return {
    basis: threshold === undefined ? "Projected quantity at or below configured per-warehouse reorder level." : "Actual quantity below the user-specified threshold in each item's stock UOM.",
    checked_rows: checked, missing_threshold_rows: unknown, risk_count: risks.length,
    rows: risks.slice(0, limit), truncated: risks.length > limit,
    coverage_complete: false,
    note: "Only existing item/warehouse stock rows are assessed. Missing stock rows and warehouse-group reorder rules are not assessed. Missing settings mean unknown risk. Never conclude all stock is safe. This is not a demand or lead-time forecast. Do not add quantities across different units.",
  };
}

function clean(value: string): string { return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }
function round(value: number): number { return Math.round(value * 1e6) / 1e6; }
