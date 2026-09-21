import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { frappeFiscalYear, frappeRunReport, type FrappeReportResult } from "./frappe";
import { PERIOD_SCHEMA, resolveReportPeriod } from "./report-period";
import { ToolError } from "./tool-result";
import type { NexWaveAuthProps } from "./types";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date in YYYY-MM-DD format.");
const NAME = z.string().trim().min(1).max(140);
const NAMES = z.array(NAME).max(20).optional();
const STOCK_ITEMS = z.array(NAME).min(1).max(20).optional().describe("One or more exact item IDs confirmed by list_items. Omit for all permitted items; never send an empty array.");
const STOCK_WAREHOUSES = z.array(NAME).min(1).max(20).optional().describe("One or more exact warehouse IDs confirmed by list_warehouses. Omit for all permission-visible warehouses; never send an empty array.");
const REPORT_LIMIT = z.number().int().min(1).max(200).default(100);
const AGEING_SUMMARY_LIMIT = z.number().int().min(1).max(10).default(10);
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
        ...PERIOD_SCHEMA,
        item_codes: STOCK_ITEMS,
        warehouses: STOCK_WAREHOUSES,
        item_group: NAME.optional(),
        include_zero_stock_items: z.boolean().default(false),
        limit: REPORT_LIMIT,
      },
    },
    async ({ company, from_date: from, to_date: to, period, as_of_date, item_codes, warehouses, item_group, include_zero_stock_items, limit }) => {
      const props = await getProps();
      const { from_date, to_date } = await resolveReportPeriod(props, company, { from_date: from, to_date: to, period, as_of_date });
      validateDateRange(from_date, to_date);
      return runReport(
        async () => props,
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
        limit,
      );
    },
  );

  server.registerTool(
    "get_stock_ledger",
    {
      description: "Run the standard NexWave Stock Ledger report. Detailed report ranges are limited to 366 days.",
      inputSchema: {
        company: NAME,
        ...PERIOD_SCHEMA,
        item_codes: STOCK_ITEMS,
        warehouses: STOCK_WAREHOUSES,
        item_group: NAME.optional(),
        batch_no: NAME.optional(),
        voucher_no: NAME.optional(),
        project: NAME.optional(),
        limit: REPORT_LIMIT,
      },
    },
    async ({ company, from_date: from, to_date: to, period, as_of_date, item_codes, warehouses, item_group, batch_no, voucher_no, project, limit }) => {
      const props = await getProps();
      const { from_date, to_date } = await resolveReportPeriod(props, company, { from_date: from, to_date: to, period, as_of_date });
      validateDateRange(from_date, to_date, 366);
      return runReport(
        async () => props,
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
        limit,
      );
    },
  );

  server.registerTool(
    "get_profit_and_loss",
    {
      description: "Run the standard NexWave Profit and Loss Statement for a date range.",
      inputSchema: {
        company: NAME,
        ...PERIOD_SCHEMA,
        periodicity: PERIODICITY.default("Yearly"),
        cost_centres: NAMES,
        projects: NAMES,
        presentation_currency: z.string().trim().min(3).max(20).optional(),
        limit: REPORT_LIMIT,
      },
    },
    async ({ company, from_date: from, to_date: to, period, as_of_date, periodicity, cost_centres, projects, presentation_currency, limit }) => {
      const props = await getProps();
      const { from_date, to_date } = await resolveReportPeriod(props, company, { from_date: from, to_date: to, period, as_of_date });
      validateDateRange(from_date, to_date);
      return runReport(
        async () => props,
        "Profit and Loss Statement",
        {
          company,
          filter_based_on: "Date Range",
          period_start_date: from_date,
          period_end_date: to_date,
          periodicity,
          cost_center: cost_centres,
          project: projects,
          presentation_currency,
          accumulated_values: 0,
          include_default_book_entries: 1,
          show_zero_values: 0,
          selected_view: "Report",
        },
        limit,
      );
    },
  );

  server.registerTool(
    "get_trial_balance",
    {
      description: "Run the standard NexWave Trial Balance for one fiscal year and date range.",
      inputSchema: {
        company: NAME,
        fiscal_year: NAME.optional(),
        ...PERIOD_SCHEMA,
        cost_centres: NAMES,
        projects: NAMES,
        finance_book: NAME.optional(),
        presentation_currency: z.string().trim().min(3).max(20).optional(),
        limit: REPORT_LIMIT,
      },
    },
    async ({ company, fiscal_year: fiscalYear, from_date: from, to_date: to, period, as_of_date, cost_centres, projects, finance_book, presentation_currency, limit }) => {
      const props = await getProps();
      const dates = await resolveReportPeriod(props, company, { from_date: from, to_date: to, period, as_of_date });
      const { from_date, to_date } = dates;
      validateDateRange(from_date, to_date);
      const fiscal = await frappeFiscalYear(props, company, to_date, fiscalYear ?? dates.fiscal_year);
      if (from_date < fiscal.from_date || to_date > fiscal.to_date) {
        throw new ToolError("INVALID_ARGUMENT", "Trial Balance requires both dates within the selected fiscal year. Choose a range within that year, or request separate reports for each fiscal year. Dates were not changed and no report was run.");
      }
      const fiscal_year = fiscal.name;
      return runReport(
        async () => props,
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
        limit,
      );
    },
  );

  server.registerTool(
    "get_general_ledger",
    {
      description: "Run the standard NexWave General Ledger report. Detailed report ranges are limited to 366 days.",
      inputSchema: {
        company: NAME,
        ...PERIOD_SCHEMA,
        accounts: NAMES,
        party_type: z.enum(["Customer", "Supplier", "Employee"]).optional(),
        parties: NAMES,
        voucher_no: NAME.optional(),
        cost_centres: NAMES,
        projects: NAMES,
        finance_book: NAME.optional(),
        group_by: z.enum(["voucher", "voucher_consolidated", "account", "party"]).default("voucher_consolidated"),
        limit: REPORT_LIMIT,
      },
    },
    async ({ company, from_date: from, to_date: to, period, as_of_date, accounts, party_type, parties, voucher_no, cost_centres, projects, finance_book, group_by, limit }) => {
      const props = await getProps();
      const { from_date, to_date } = await resolveReportPeriod(props, company, { from_date: from, to_date: to, period, as_of_date });
      validateDateRange(from_date, to_date, 366);
      const groupBy = {
        voucher: "Categorize by Voucher",
        voucher_consolidated: "Categorize by Voucher (Consolidated)",
        account: "Categorize by Account",
        party: "Categorize by Party",
      }[group_by];
      return runReport(
        async () => props,
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
        limit,
      );
    },
  );

  server.registerTool(
    "get_accounts_receivable_summary",
    {
      description: "Return a compact NexWave Accounts Receivable ageing summary with totals and the largest customer balances. Use totals.overdue only when overdue_complete is true; never infer overdue from ageing buckets. Overdue excludes due-today amounts and keeps unallocated credits separate.",
      inputSchema: {
        company: NAME,
        report_date: DATE,
        customers: NAMES,
        customer_groups: NAMES,
        ageing_based_on: z.enum(["Posting Date", "Due Date"]).default("Due Date"),
        ageing_ranges: z.array(z.number().int().min(1).max(3650)).min(1).max(6).default([30, 60, 90, 120]),
        cost_centres: NAMES,
        projects: NAMES,
        limit: AGEING_SUMMARY_LIMIT,
      },
    },
    async ({ company, report_date, customers, customer_groups, ageing_based_on, ageing_ranges, cost_centres, projects, limit }) => {
      validateDateRange(report_date, report_date);
      validateAgeingRanges(ageing_ranges);
      const filters = compactFilters({
        company,
        report_date,
        party_type: "Customer",
        party: customers,
        customer_group: customer_groups,
        ageing_based_on,
        age_as_on: "Report Date",
        range: ageing_ranges.join(", "),
        group_by_party: 1,
        cost_center: cost_centres,
        project: projects,
        show_future_payments: 0,
        show_remarks: 0,
      });
      const data = await frappeRunReport(await getProps(), "Accounts Receivable", filters);
      return textResult(normaliseAgeingSummary("Accounts Receivable", filters, data, ageing_ranges, limit));
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
        ageing_based_on: z.enum(["Posting Date", "Due Date"]).default("Due Date"),
        ageing_ranges: z.array(z.number().int().min(1).max(3650)).min(1).max(6).default([30, 60, 90, 120]),
        group_by_customer: z.boolean().default(false),
        cost_centres: NAMES,
        projects: NAMES,
        limit: REPORT_LIMIT,
      },
    },
    async ({ company, report_date, customers, customer_groups, ageing_based_on, ageing_ranges, group_by_customer, cost_centres, projects, limit }) => {
      validateDateRange(report_date, report_date);
      validateAgeingRanges(ageing_ranges);
      return runReport(
        getProps,
        "Accounts Receivable",
        {
          company,
          report_date,
          party_type: "Customer",
          party: customers,
          customer_group: customer_groups,
          ageing_based_on,
          age_as_on: "Report Date",
          range: ageing_ranges.join(", "),
          group_by_party: group_by_customer ? 1 : 0,
          cost_center: cost_centres,
          project: projects,
          show_future_payments: 0,
          show_remarks: 0,
        },
        limit,
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
        ageing_based_on: z.enum(["Posting Date", "Due Date", "Supplier Invoice Date"]).default("Due Date"),
        ageing_ranges: z.array(z.number().int().min(1).max(3650)).min(1).max(6).default([30, 60, 90, 120]),
        group_by_supplier: z.boolean().default(false),
        cost_centres: NAMES,
        projects: NAMES,
        limit: REPORT_LIMIT,
      },
    },
    async ({ company, report_date, suppliers, supplier_groups, ageing_based_on, ageing_ranges, group_by_supplier, cost_centres, projects, limit }) => {
      validateDateRange(report_date, report_date);
      validateAgeingRanges(ageing_ranges);
      return runReport(
        getProps,
        "Accounts Payable",
        {
          company,
          report_date,
          party_type: "Supplier",
          party: suppliers,
          supplier_group: supplier_groups,
          ageing_based_on,
          age_as_on: "Report Date",
          range: ageing_ranges.join(", "),
          group_by_party: group_by_supplier ? 1 : 0,
          cost_center: cost_centres,
          project: projects,
          show_future_payments: 0,
          show_remarks: 0,
        },
        limit,
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
        include_pos_transactions: z.boolean().default(false),
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
        limit,
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

export function normaliseAgeingSummary(
  report: string,
  filters: Record<string, unknown>,
  data: FrappeReportResult,
  ageingRanges: number[],
  limit: number,
) {
  const allRows = (data.result ?? []).filter((row) => isRecord(row) && row.is_total_row !== true);
  validateAgeingRows(allRows);
  const totalRow = [...allRows].reverse().find(isAgeingTotalRow);
  const groupedRows = allRows.filter((row) => row !== totalRow && isGroupedPartyRow(row));
  const partyRows = groupedRows.length > 0 ? groupedRows : aggregatePartyRows(allRows, totalRow);
  const positiveBalances = partyRows
    .filter((row) => numericValue(row.outstanding) > 0)
    .sort((left, right) => numericValue(right.outstanding) - numericValue(left.outstanding));
  const topCustomers = positiveBalances.slice(0, Math.min(limit, 10)).map((row) => ({
    customer: cleanText(String(row.party)),
    ...(typeof row.currency === "string" ? { currency: cleanText(row.currency) } : {}),
    outstanding: numericValue(row.outstanding),
    ageing: ageingBuckets(row, ageingRanges),
  }));

  const totals = summariseAgeingTotals(totalRow ?? sumAgeingRows(partyRows), ageingRanges);
  const documents = allRows.filter((row) => typeof row.voucher_no === "string" && row.voucher_no.trim());
  const documentTotal = documents.reduce((sum, row) => sum + numericValue(row.outstanding), 0);
  const creditBreakdownComplete = allRows.length === 0
    || (documents.length > 0 && Math.abs(documentTotal - totals.outstanding) < 0.000001);
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  const overdue = confirmedOverdue(documents, groupedRows, filters.report_date, creditBreakdownComplete);
  return {
    report,
    totals: {
      ...totals,
      ...(creditBreakdownComplete ? {
        positive_outstanding: round(documents.reduce((sum, row) => sum + Math.max(0, numericValue(row.outstanding)), 0)),
        credit_balance: round(documents.reduce((sum, row) => sum + Math.max(0, -numericValue(row.outstanding)), 0)),
      } : {}),
      ...(overdue !== undefined ? { overdue: round(overdue) } : {}),
    },
    credit_breakdown_complete: creditBreakdownComplete,
    overdue_complete: overdue !== undefined,
    overdue_basis: "Positive document outstanding with a due date strictly before the report date, before allocation of unallocated credits. Posting date is used only when due date is absent. Amounts due today or later are excluded. If overdue_complete is false, no overdue total can be confirmed.",
    top_customers: topCustomers,
    customer_count: partyRows.length,
    invoice_count: allRows.filter((row) => typeof row.voucher_no === "string" && row.voucher_no.trim()).length,
    truncated: positiveBalances.length > topCustomers.length,
    filters,
    ...(typeof data.execution_time === "number" ? { execution_time: data.execution_time } : {}),
  };
}

function confirmedOverdue(
  documents: Array<Record<string, unknown>>,
  groupedRows: Array<Record<string, unknown>>,
  reportDate: unknown,
  detailsReconcile: boolean,
): number | undefined {
  if (!detailsReconcile || !validDate(reportDate)) return undefined;
  // A matching grand total can hide missing details that cancel across customers.
  if (groupedRows.length) {
    const key = (row: Record<string, unknown>) => JSON.stringify([row.party, row.currency ?? ""]);
    const balances = new Map<string, number>();
    for (const row of documents) {
      balances.set(key(row), (balances.get(key(row)) ?? 0) + numericValue(row.outstanding));
    }
    if (balances.size !== groupedRows.length || groupedRows.some((row) =>
      !balances.has(key(row)) || Math.abs(balances.get(key(row))! - numericValue(row.outstanding)) >= 0.000001,
    )) return undefined;
  }
  return documentOverdue(documents, reportDate);
}

export function documentOverdue(documents: Array<Record<string, unknown>>, reportDate: unknown): number | undefined {
  if (!validDate(reportDate)) return undefined;
  let overdue = 0;
  for (const row of documents) {
    if (numericValue(row.outstanding) <= 0) continue;
    const missingDueDate = row.due_date === undefined || row.due_date === null
      || (typeof row.due_date === "string" && !row.due_date.trim());
    const dueDate = missingDueDate ? row.posting_date : row.due_date;
    if (!validDate(dueDate)) return undefined;
    if (dueDate < reportDate) overdue += numericValue(row.outstanding);
  }
  return overdue;
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function validateDateRange(fromDate: string, toDate: string, maxDays?: number): void {
  const from = parseDate(fromDate);
  const to = parseDate(toDate);
  if (from > to) throw new ToolError("INVALID_ARGUMENT", "From date must be on or before to date.");
  const dayCount = Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
  if (maxDays && dayCount > maxDays) {
    throw new ToolError("INVALID_ARGUMENT", `This detailed report supports a maximum date range of ${maxDays} days.`);
  }
}

function parseDate(value: string): Date {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ToolError("INVALID_ARGUMENT", "Use valid dates in YYYY-MM-DD format.");
  }
  return parsed;
}

function validateAgeingRanges(values: number[]): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] <= values[index - 1]) {
      throw new ToolError("INVALID_ARGUMENT", "Ageing ranges must be in ascending order without duplicates.");
    }
  }
}

function compactFilters(filters: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value !== undefined && value !== "" && (!Array.isArray(value) || value.length > 0)),
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

function isAgeingTotalRow(row: Record<string, unknown>): boolean {
  return typeof row.party === "string" && cleanText(row.party).toLowerCase() === "total"
    && !(typeof row.voucher_no === "string" && row.voucher_no.trim());
}

function validateAgeingRows(rows: Array<Record<string, unknown>>): void {
  const amountFields = ["invoiced", "paid", "credit_note", "outstanding", "range1", "range2", "range3", "range4", "range5", "range6", "range7"];
  let financialRows = 0;
  for (const row of rows) {
    // ERPNext inserts empty spacer rows between party groups.
    if (Object.values(row).every((value) => value === null || value === undefined || value === "")) continue;
    if (typeof row.party !== "string" || !row.party.trim()
      || !(row.bold === 1 || (typeof row.voucher_no === "string" && row.voucher_no.trim()))
      || typeof row.outstanding !== "number" || !Number.isFinite(row.outstanding)
      || amountFields.some((field) => row[field] !== undefined && row[field] !== null
        && (typeof row[field] !== "number" || !Number.isFinite(row[field])))) {
      throw new ToolError("UPSTREAM_INVALID_RESPONSE", "The receivables report contains invalid financial rows. No balance can be confirmed.");
    }
    financialRows++;
  }
  if (rows.length && !financialRows) throw new ToolError("UPSTREAM_INVALID_RESPONSE", "The receivables report contains no recognisable financial rows. No zero balance can be inferred.");
}

function isGroupedPartyRow(row: Record<string, unknown>): boolean {
  return row.bold === 1
    && typeof row.party === "string"
    && !(typeof row.voucher_no === "string" && row.voucher_no.trim());
}

function aggregatePartyRows(
  rows: Array<Record<string, unknown>>,
  totalRow?: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const totals = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (row === totalRow || typeof row.party !== "string" || !row.party.trim()) continue;
    const party = cleanText(row.party);
    const currency = typeof row.currency === "string" ? cleanText(row.currency) : "";
    const key = `${party}\u0000${currency}`;
    const current = totals.get(key) ?? { party, ...(currency ? { currency } : {}) };
    for (const field of ["invoiced", "paid", "credit_note", "outstanding", "range1", "range2", "range3", "range4", "range5", "range6", "range7"]) {
      current[field] = numericValue(current[field]) + numericValue(row[field]);
    }
    totals.set(key, current);
  }
  return [...totals.values()];
}

function sumAgeingRows(rows: Array<Record<string, unknown>>): Record<string, unknown> {
  const total: Record<string, unknown> = {};
  for (const row of rows) {
    if (!total.currency && typeof row.currency === "string") total.currency = cleanText(row.currency);
    for (const field of ["invoiced", "paid", "credit_note", "outstanding", "range1", "range2", "range3", "range4", "range5", "range6", "range7"]) {
      total[field] = numericValue(total[field]) + numericValue(row[field]);
    }
  }
  return total;
}

function summariseAgeingTotals(row: Record<string, unknown>, ageingRanges: number[]) {
  return {
    ...(typeof row.currency === "string" ? { currency: cleanText(row.currency) } : {}),
    invoiced: numericValue(row.invoiced),
    paid: numericValue(row.paid),
    credit_note: numericValue(row.credit_note),
    outstanding: numericValue(row.outstanding),
    ageing: ageingBuckets(row, ageingRanges),
  };
}

function ageingBuckets(row: Record<string, unknown>, ageingRanges: number[]): Record<string, number> {
  const labels = ageingRanges.map((upper, index) => index === 0 ? `0_to_${upper}_days` : `${ageingRanges[index - 1] + 1}_to_${upper}_days`);
  labels.push(`over_${ageingRanges.at(-1)}_days`);
  return Object.fromEntries(labels.map((label, index) => [label, numericValue(row[`range${index + 1}`])]));
}

function numericValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
