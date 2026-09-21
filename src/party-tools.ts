import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { frappeGet, frappeList, frappeRunReport, type FrappeReportResult } from "./frappe";
import { searchRecords } from "./search";
import { structuredResult, ToolError } from "./tool-result";
import { documentOverdue, validateDateRange } from "./report-tools";
import type { NexWaveAuthProps } from "./types";

const NAME = z.string().trim().min(1).max(140);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
type PropsProvider = () => Promise<NexWaveAuthProps>;
type PartyType = "Customer" | "Supplier";

export function registerPartyTools(server: McpServer, getProps: PropsProvider): void {
  server.registerTool("get_party_balance", {
    description: "Resolve one customer or supplier by spoken name and return its balance in company currency. Use this for a named party balance instead of list/report chains. If party type is unclear ask the user first. A candidates or no_match result contains no balance. Confirm a candidate then call with its exact ID in party_id.",
    inputSchema: {
      company: NAME,
      party_type: z.enum(["Customer", "Supplier"]),
      query: NAME.optional().describe("Spoken party name or partial name. Supply query or party_id, not both."),
      party_id: NAME.optional().describe("Exact name field returned by a tool and confirmed by the user. Skips fuzzy matching."),
      report_date: DATE.describe("As-of date in the user's timezone."),
    },
  }, async ({ company, party_type, query, party_id, report_date }) => {
    validateDateRange(report_date, report_date);
    if (Boolean(query) === Boolean(party_id)) throw new ToolError("INVALID_ARGUMENT", "Supply query or a confirmed party_id, not both.");
    const props = await getProps();
    const label = party_type === "Supplier" ? "supplier_name" : "customer_name";
    const exact = party_id ? await frappeList<Record<string, unknown>>(props, party_type, ["name", label, "disabled"], {
      filters: [[party_type, "name", "=", party_id], [party_type, "disabled", "=", 0]], limit: 1,
    }) : undefined;
    const found = exact ? {
      records: exact,
      meta: { match_status: exact.length ? "matched" : "no_match", matched_id: exact[0]?.name, truncated: false },
    } : await searchRecords(props, party_type, ["name", label, "disabled"], ["name", label], {
      search: query, limit: 5, directory: true, legalNames: true,
      filters: [[party_type, "disabled", "=", 0]],
    });
    if (found.meta.match_status !== "matched") return structuredResult({
      status: found.meta.match_status, party_type, query: query ?? party_id,
      candidates: found.records, truncated: found.meta.truncated,
      next_action: found.records.length ? "Ask the user to confirm a candidate, then pass its exact name field in party_id." : "Ask for another name or record code. Do not infer a zero balance.",
    });
    const party = String(found.meta.matched_id);
    const summary = await partySummary(props, party_type, company, report_date, [party], 1);
    return structuredResult({
      status: "matched", party_type, party,
      display_name: found.records.find((record) => record.name === party)?.[label],
      ...summary,
    });
  });

  server.registerTool("get_accounts_payable_summary", {
    description: "Return complete supplier payable totals, overdue amounts, credits, and top supplier balances in company currency. Prefer this over detailed payable rows for spoken overviews. Totals cover all report rows, not just the top suppliers.",
    inputSchema: {
      company: NAME,
      report_date: DATE,
      suppliers: z.array(NAME).min(1).max(20).optional().describe("Confirmed exact supplier IDs only. For a spoken name use get_party_balance."),
      limit: z.number().int().min(1).max(10).default(5),
    },
  }, async ({ company, report_date, suppliers, limit }) => {
    validateDateRange(report_date, report_date);
    return structuredResult(await partySummary(await getProps(), "Supplier", company, report_date, suppliers, limit));
  });
}

async function partySummary(
  props: NexWaveAuthProps, partyType: PartyType, company: string, reportDate: string,
  parties: string[] | undefined, limit: number,
) {
  const report = partyType === "Supplier" ? "Accounts Payable" : "Accounts Receivable";
  const filters = {
    company, report_date: reportDate, party_type: partyType,
    ...(parties ? { party: parties } : {}),
    ageing_based_on: "Due Date", age_as_on: "Report Date", range: "30, 60, 90, 120",
    group_by_party: 0, in_party_currency: 0, show_future_payments: 0, show_remarks: 0,
  };
  const [data, companyRecord] = await Promise.all([
    frappeRunReport(props, report, filters),
    frappeGet<{ default_currency?: string }>(props, "Company", company),
  ]);
  if (typeof companyRecord.default_currency !== "string" || !companyRecord.default_currency.trim()) throw new ToolError("UPSTREAM_INVALID_RESPONSE", "The company currency could not be confirmed.");
  return { report, company, report_date: reportDate, ...summarisePartyBalances(data, companyRecord.default_currency, reportDate, limit) };
}

export function summarisePartyBalances(data: FrappeReportResult, currency: string, reportDate: string, limit: number) {
  const balances = new Map<string, { party: string; outstanding: number; positive_outstanding: number; credit_balance: number; overdue: number }>();
  let invoiceCount = 0;
  let overdueComplete = true;
  // group_by_party=0: only document rows can contribute, never report totals.
  for (const row of data.result ?? []) {
    if (row.is_total_row === true) continue;
    if (typeof row.party !== "string" || typeof row.voucher_no !== "string" || !row.voucher_no.trim()) continue;
    if (typeof row.outstanding !== "number" || !Number.isFinite(row.outstanding)) {
      throw new ToolError("UPSTREAM_INVALID_RESPONSE", "The report contains an invalid balance. No total can be confirmed.");
    }
    const balance = balances.get(row.party) ?? { party: row.party, outstanding: 0, positive_outstanding: 0, credit_balance: 0, overdue: 0 };
    balance.outstanding += row.outstanding;
    balance.positive_outstanding += Math.max(0, row.outstanding);
    balance.credit_balance += Math.max(0, -row.outstanding);
    const overdue = documentOverdue([row], reportDate);
    if (overdue === undefined) overdueComplete = false;
    else balance.overdue += overdue;
    balances.set(row.party, balance);
    invoiceCount += 1;
  }
  if ((data.result?.length ?? 0) > 0 && balances.size === 0) {
    throw new ToolError("UPSTREAM_INVALID_RESPONSE", "The report did not contain recognisable document rows. No zero balance can be inferred.");
  }
  const rows = [...balances.values()];
  const total = (field: "outstanding" | "positive_outstanding" | "credit_balance" | "overdue") => round(rows.reduce((sum, row) => sum + row[field], 0));
  return {
    currency,
    totals: { outstanding: total("outstanding"), positive_outstanding: total("positive_outstanding"), credit_balance: total("credit_balance"), ...(overdueComplete ? { overdue: total("overdue") } : {}) },
    top_parties: rows.sort((a, b) => b.outstanding - a.outstanding).slice(0, limit).map(({ overdue, ...row }) => ({
      ...row, outstanding: round(row.outstanding), positive_outstanding: round(row.positive_outstanding), credit_balance: round(row.credit_balance), ...(overdueComplete ? { overdue: round(overdue) } : {}),
    })),
    party_count: rows.length, document_count: invoiceCount, truncated: rows.length > limit,
    totals_complete: true,
    overdue_complete: overdueComplete,
    note: "Credits are shown separately. Overdue is positive document outstanding due strictly before the report date, before allocation of unallocated credits. Posting date is used only when due date is absent. If overdue_complete is false, no overdue total can be confirmed.",
  };
}

function round(value: number): number { return Math.round(value * 1e6) / 1e6; }
