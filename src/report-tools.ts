import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { frappeRunReport, type FrappeReportResult } from "./frappe";
import type { NexWaveAuthProps } from "./types";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date in YYYY-MM-DD format.");
const NAME = z.string().trim().min(1).max(140);
const NAMES = z.array(NAME).max(20).nullish();
const REPORT_LIMIT = z.number().int().min(1).max(200).nullable().default(100);
const PERIODICITY = z.enum(["Monthly", "Quarterly", "Half-Yearly", "Yearly"]);
const STRUCTURAL_FIELDS = new Set([
  "indent",
  "parent_account",
  "parent_section",
  "account",
  "accounts",
  "account_name",
  "account_type",
  "currency",
  "is_group",
  "is_total_row",
  "has_value",
  "warn_if_negative",
]);

type PropsProvider = () => Promise<NexWaveAuthProps>;

export function registerReportTools(server: McpServer, getProps: PropsProvider): void {
  server.registerTool(
    "get_stock_balance",
    {
      description: "Run the standard NexWave Stock Balance report for a company and date range.",
      inputSchema: {
        company: NAME,
        from_date: DATE,
        to_date: DATE,
        item_codes: NAMES,
        warehouses: NAMES,
        item_group: NAME.nullish(),
        include_zero_stock_items: z.boolean().nullable().default(false),
        limit: REPORT_LIMIT,
      },
    },
    async ({ company, from_date, to_date, item_codes, warehouses, item_group, include_zero_stock_items, limit }) => {
      validateDateRange(from_date, to_date);
      return runReport(
        getProps,
        "Stock Balance",
        {
          company,
          from_date,
          to_date,
          item_code: item_codes,
          warehouse: warehouses,
          item_group,
          include_zero_stock_items: include_zero_stock_items ? 1 : 0,
          ignore_closing_balance: 0,
          valuation_field_type: "Currency",
        },
        limit ?? 100,
      );
    },
  );

  server.registerTool(
    "get_stock_ledger",
    {
      description: "Run the standard NexWave Stock Ledger report. Detailed report ranges are limited to 366 days.",
      inputSchema: {
        company: NAME,
        from_date: DATE,
        to_date: DATE,
        item_codes: NAMES,
        warehouses: NAMES,
        item_group: NAME.nullish(),
        batch_no: NAME.nullish(),
        voucher_no: NAME.nullish(),
        project: NAME.nullish(),
        limit: REPORT_LIMIT,
      },
    },
    async ({ company, from_date, to_date, item_codes, warehouses, item_group, batch_no, voucher_no, project, limit }) => {
      validateDateRange(from_date, to_date, 366);
      return runReport(
        getProps,
        "Stock Ledger",
        {
          company,
          from_date,
          to_date,
          item_code: item_codes,
          warehouse: warehouses,
          item_group,
          batch_no,
          voucher_no,
          project,
          valuation_field_type: "Currency",
          segregate_serial_batch_bundle: 0,
        },
        limit ?? 100,
      );
    },
  );

  server.registerTool(
    "get_profit_and_loss",
    {
      description: "Run the standard NexWave Profit and Loss Statement for a date range.",
      inputSchema: {
        company: NAME,
        from_date: DATE,
        to_date: DATE,
        periodicity: PERIODICITY.nullable().default("Yearly"),
        cost_centres: NAMES,
        projects: NAMES,
        presentation_currency: z.string().trim().min(3).max(20).nullish(),
        limit: REPORT_LIMIT,
      },
    },
    async ({ company, from_date, to_date, periodicity, cost_centres, projects, presentation_currency, limit }) => {
      validateDateRange(from_date, to_date);
      return runReport(
        getProps,
        "Profit and Loss Statement",
        {
          company,
          filter_based_on: "Date Range",
          period_start_date: from_date,
          period_end_date: to_date,
          periodicity: periodicity ?? "Yearly",
          cost_center: cost_centres,
          project: projects,
          presentation_currency,
          accumulated_values: 0,
          include_default_book_entries: 1,
          show_zero_values: 0,
          selected_view: "Report",
        },
        limit ?? 100,
      );
    },
  );

  server.registerTool(
    "get_trial_balance",
    {
      description: "Run the standard NexWave Trial Balance for one fiscal year and date range.",
      inputSchema: {
        company: NAME,
        fiscal_year: NAME,
        from_date: DATE,
        to_date: DATE,
        cost_centres: NAMES,
        projects: NAMES,
        finance_book: NAME.nullish(),
        presentation_currency: z.string().trim().min(3).max(20).nullish(),
        limit: REPORT_LIMIT,
      },
    },
    async ({ company, fiscal_year, from_date, to_date, cost_centres, projects, finance_book, presentation_currency, limit }) => {
      validateDateRange(from_date, to_date);
      return runReport(
        getProps,
        "Trial Balance",
        {
          company,
          fiscal_year,
          from_date,
          to_date,
          cost_center: cost_centres,
          project: projects,
          finance_book,
          presentation_currency,
          with_period_closing_entry_for_opening: 1,
          with_period_closing_entry_for_current_period: 1,
          include_default_book_entries: 1,
          show_net_values: 1,
          show_group_accounts: 1,
          show_zero_values: 0,
        },
        limit ?? 100,
      );
    },
  );

  server.registerTool(
    "get_general_ledger",
    {
      description: "Run the standard NexWave General Ledger report. Detailed report ranges are limited to 366 days.",
      inputSchema: {
        company: NAME,
        from_date: DATE,
        to_date: DATE,
        accounts: NAMES,
        party_type: z.enum(["Customer", "Supplier", "Employee"]).nullish(),
        parties: NAMES,
        voucher_no: NAME.nullish(),
        cost_centres: NAMES,
        projects: NAMES,
        finance_book: NAME.nullish(),
        group_by: z.enum(["voucher", "voucher_consolidated", "account", "party"]).nullable().default("voucher_consolidated"),
        limit: REPORT_LIMIT,
      },
    },
    async ({ company, from_date, to_date, accounts, party_type, parties, voucher_no, cost_centres, projects, finance_book, group_by, limit }) => {
      validateDateRange(from_date, to_date, 366);
      const groupBy = {
        voucher: "Categorize by Voucher",
        voucher_consolidated: "Categorize by Voucher (Consolidated)",
        account: "Categorize by Account",
        party: "Categorize by Party",
      }[group_by ?? "voucher_consolidated"];
      return runReport(
        getProps,
        "General Ledger",
        {
          company,
          from_date,
          to_date,
          account: accounts,
          party_type,
          party: parties,
          voucher_no,
          cost_center: cost_centres,
          project: projects,
          finance_book,
          categorize_by: groupBy,
          include_default_book_entries: 1,
          show_cancelled_entries: 0,
          show_remarks: 0,
        },
        limit ?? 100,
      );
    },
  );

  server.registerTool(
    "get_accounts_receivable",
    {
      description: "Run the standard NexWave Accounts Receivable ageing report as at a report date.",
      inputSchema: {
        company: NAME,
        report_date: DATE,
        customers: NAMES,
        customer_groups: NAMES,
        ageing_based_on: z.enum(["Posting Date", "Due Date"]).nullable().default("Due Date"),
        ageing_ranges: z.array(z.number().int().min(1).max(3650)).min(1).max(6).nullable().default([30, 60, 90, 120]),
        group_by_customer: z.boolean().nullable().default(false),
        cost_centres: NAMES,
        projects: NAMES,
        limit: REPORT_LIMIT,
      },
    },
    async ({ company, report_date, customers, customer_groups, ageing_based_on, ageing_ranges, group_by_customer, cost_centres, projects, limit }) => {
      validateDateRange(report_date, report_date);
      const ranges = ageing_ranges ?? [30, 60, 90, 120];
      validateAgeingRanges(ranges);
      return runReport(
        getProps,
        "Accounts Receivable",
        {
          company,
          report_date,
          party_type: "Customer",
          party: customers,
          customer_group: customer_groups,
          ageing_based_on: ageing_based_on ?? "Due Date",
          age_as_on: "Report Date",
          range: ranges.join(", "),
          group_by_party: group_by_customer ? 1 : 0,
          cost_center: cost_centres,
          project: projects,
          show_future_payments: 0,
          show_remarks: 0,
        },
        limit ?? 100,
      );
    },
  );

  server.registerTool(
    "get_accounts_payable",
    {
      description: "Run the standard NexWave Accounts Payable ageing report as at a report date.",
      inputSchema: {
        company: NAME,
        report_date: DATE,
        suppliers: NAMES,
        supplier_groups: NAMES,
        ageing_based_on: z.enum(["Posting Date", "Due Date", "Supplier Invoice Date"]).nullable().default("Due Date"),
        ageing_ranges: z.array(z.number().int().min(1).max(3650)).min(1).max(6).nullable().default([30, 60, 90, 120]),
        group_by_supplier: z.boolean().nullable().default(false),
        cost_centres: NAMES,
        projects: NAMES,
        limit: REPORT_LIMIT,
      },
    },
    async ({ company, report_date, suppliers, supplier_groups, ageing_based_on, ageing_ranges, group_by_supplier, cost_centres, projects, limit }) => {
      validateDateRange(report_date, report_date);
      const ranges = ageing_ranges ?? [30, 60, 90, 120];
      validateAgeingRanges(ranges);
      return runReport(
        getProps,
        "Accounts Payable",
        {
          company,
          report_date,
          party_type: "Supplier",
          party: suppliers,
          supplier_group: supplier_groups,
          ageing_based_on: ageing_based_on ?? "Due Date",
          age_as_on: "Report Date",
          range: ranges.join(", "),
          group_by_party: group_by_supplier ? 1 : 0,
          cost_center: cost_centres,
          project: projects,
          show_future_payments: 0,
          show_remarks: 0,
        },
        limit ?? 100,
      );
    },
  );

  server.registerTool(
    "get_bank_reconciliation_statement",
    {
      description: "Run the standard NexWave Bank Reconciliation Statement for a bank or cash ledger as at a report date.",
      inputSchema: {
        company: NAME,
        account: NAME,
        report_date: DATE,
        include_pos_transactions: z.boolean().nullable().default(false),
        limit: REPORT_LIMIT,
      },
    },
    async ({ company, account, report_date, include_pos_transactions, limit }) => {
      validateDateRange(report_date, report_date);
      return runReport(
        getProps,
        "Bank Reconciliation Statement",
        {
          company,
          account,
          report_date,
          include_pos_transactions: include_pos_transactions ? 1 : 0,
        },
        limit ?? 100,
      );
    },
  );
}

async function runReport(
  getProps: PropsProvider,
  reportName: string,
  filters: Record<string, unknown>,
  limit: number,
) {
  const cleanFilters = compactFilters(filters);
  const data = await frappeRunReport(await getProps(), reportName, cleanFilters);
  return textResult(normaliseReportResult(reportName, cleanFilters, data, limit));
}

export function normaliseReportResult(
  report: string,
  filters: Record<string, unknown>,
  data: FrappeReportResult,
  limit: number,
) {
  const columns = (data.columns ?? []).slice(0, 100).flatMap((column) => {
    if (!column.fieldname || !column.label) return [];
    return [{
      fieldname: cleanText(column.fieldname),
      label: cleanText(column.label),
      ...(column.fieldtype ? { fieldtype: cleanText(column.fieldtype) } : {}),
      ...(column.options ? { options: cleanText(column.options) } : {}),
      ...(typeof column.width === "number" ? { width: column.width } : {}),
    }];
  });
  const allowedFields = new Set(columns.map((column) => column.fieldname));
  const allRows = (data.result ?? []).filter(isRecord);
  const rows = allRows.slice(0, limit).map((row) => sanitiseRow(row, allowedFields));
  const summary = (data.report_summary ?? []).slice(0, 20).map(sanitiseSummary);

  return {
    report,
    filters,
    columns,
    rows,
    summary,
    row_count: allRows.length,
    truncated: allRows.length > rows.length,
    ...(typeof data.execution_time === "number" ? { execution_time: data.execution_time } : {}),
  };
}

export function validateDateRange(fromDate: string, toDate: string, maxDays?: number): void {
  const from = parseDate(fromDate);
  const to = parseDate(toDate);
  if (from > to) throw new Error("From date must be on or before to date.");
  const dayCount = Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
  if (maxDays && dayCount > maxDays) {
    throw new Error(`This detailed report supports a maximum date range of ${maxDays} days.`);
  }
}

function parseDate(value: string): Date {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("Use valid dates in YYYY-MM-DD format.");
  }
  return parsed;
}

function validateAgeingRanges(values: number[]): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] <= values[index - 1]) {
      throw new Error("Ageing ranges must be in ascending order without duplicates.");
    }
  }
}

function compactFilters(filters: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value != null && value !== "" && (!Array.isArray(value) || value.length > 0)),
  );
}

function sanitiseRow(row: Record<string, unknown>, allowedFields: Set<string>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!allowedFields.has(key) && !STRUCTURAL_FIELDS.has(key)) continue;
    const safe = safeValue(value);
    if (safe !== undefined) clean[key] = safe;
  }
  return clean;
}

function sanitiseSummary(summary: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const key of ["label", "value", "datatype", "currency", "indicator", "type"]) {
    const safe = safeValue(summary[key]);
    if (safe !== undefined) clean[key] = safe;
  }
  return clean;
}

function safeValue(value: unknown): string | number | boolean | null | Array<string | number | boolean | null> | undefined {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) {
    return value.slice(0, 20).flatMap((item) => {
      const safe = safeValue(item);
      return safe === undefined || Array.isArray(safe) ? [] : [safe];
    });
  }
  return undefined;
}

function cleanText(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
