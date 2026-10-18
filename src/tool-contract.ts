import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const ROW = z.record(z.string(), z.unknown());
const ROWS = z.array(ROW);
const COUNT = z.number().int().nonnegative();
const CANDIDATES = z.looseObject({ status: z.enum(["candidates", "no_match"]), candidates: ROWS, truncated: z.boolean(), next_action: z.string() });
const RANKING = z.object({ field: z.string(), currency: z.string(), currency_field: z.enum(["currency", "party_account_currency", "default_currency"]), company: z.string().optional() });
const PAGE = z.looseObject({ ranking: RANKING.optional(), records: ROWS, meta: z.looseObject({ count: COUNT, offset: COUNT, limit: COUNT, next_offset: COUNT.nullable(), truncated: z.boolean(), complete: z.boolean() }) });
const AGGREGATE = z.looseObject({ currency: z.string().optional(), company: z.string().optional(), doctype: z.string(), count: COUNT, totals: z.record(z.string(), z.number()), complete: z.literal(true), totals_complete: z.literal(true) });
const REPORT = z.looseObject({ report: z.string(), filters: ROW, columns: ROWS, rows: ROWS, summary: ROWS, row_count: COUNT, offset: COUNT, next_offset: COUNT.nullable(), truncated: z.boolean(), complete: z.boolean() });
const BALANCE = z.looseObject({ currency: z.string(), totals: z.looseObject({ outstanding: z.number(), positive_outstanding: z.number(), credit_balance: z.number() }), top_parties: ROWS, party_count: COUNT, document_count: COUNT, totals_complete: z.literal(true), overdue_complete: z.boolean() });
const REPORT_TOOLS = new Set(["get_stock_balance", "get_stock_ledger", "get_profit_and_loss", "get_trial_balance", "get_general_ledger", "get_accounts_receivable", "get_accounts_payable", "get_bank_reconciliation_statement"]);
const OUTPUTS = {
  get_current_user: z.looseObject({ site: z.string(), site_url: z.string(), user: z.string() }),
  get_document: z.looseObject({ detail_meta: ROW }),
  get_accounts_receivable_summary: z.looseObject({ report: z.string(), totals: z.looseObject({ outstanding: z.number() }), top_customers: ROWS, customer_count: COUNT, invoice_count: COUNT, truncated: z.boolean(), overdue_complete: z.boolean() }),
  get_accounts_payable_summary: BALANCE,
  get_party_balance: z.union([CANDIDATES, BALANCE.extend({ status: z.literal("matched"), party: z.string(), party_type: z.enum(["Customer", "Supplier"]) })]).meta({ type: "object" }),
  get_sales_summary: z.looseObject({ group_by: z.enum(["customer", "item", "item_group", "month"]), currency: z.string(), total_net_sales: z.number(), groups: ROWS, group_count: COUNT, line_count: COUNT, truncated: z.boolean(), totals_complete: z.literal(true) }),
  get_stock_risk: z.looseObject({ checked_rows: COUNT, missing_threshold_rows: COUNT, risk_count: COUNT, rows: ROWS, truncated: z.boolean(), coverage_complete: z.literal(false), note: z.string() }),
};
const FAILURE = z.object({ status: z.literal("error"), ok: z.literal(false), error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }) });
const LIST_OUTPUT = z.union([PAGE, AGGREGATE, CANDIDATES]).meta({ type: "object" });

// Keep object roots for legacy MCP clients and validate every successful result family.
export function registerReadTool<Shape extends Record<string, z.ZodType>>(
  server: McpServer,
  name: string,
  config: { description: string; inputSchema: Shape },
  handler: (args: z.output<z.ZodObject<Shape>>) => Promise<CallToolResult>,
) {
  const successSchema = name.startsWith("list_") ? LIST_OUTPUT : REPORT_TOOLS.has(name) ? REPORT : OUTPUTS[name as keyof typeof OUTPUTS];
  if (!successSchema) throw new Error(`Missing output contract for ${name}.`);
  return server.registerTool(name, {
    ...config,
    inputSchema: z.object(config.inputSchema),
    outputSchema: z.union([successSchema, FAILURE]).meta({ type: "object" }),
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, handler);
}
