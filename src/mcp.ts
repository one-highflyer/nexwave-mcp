import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { frappeGet, ensureFreshToken } from "./frappe";
import { withMcpErrorBoundary } from "./mcp-boundary";
import { listResult, searchRecords } from "./search";
import { structuredResult, ToolError } from "./tool-result";
import { registerPartyTools } from "./party-tools";
import { registerInsightTools } from "./insight-tools";
import { normaliseMcpToolArguments } from "./mcp-request";
import { registerReportTools } from "./report-tools";
import { SALES_INVOICE_STATUS, PURCHASE_INVOICE_STATUS, SALES_ORDER_STATUS, PURCHASE_ORDER_STATUS, DOCSTATUS, ORDER_DATES, statusSchema, dateFilters, invoiceFilters, orderFilters } from "./transaction-filters";
import type { Env, NexWaveAuthProps } from "./types";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date in YYYY-MM-DD format.");
const TOOL_REQUEST_TIMEOUT_MS = 30_000;
const SEARCH = z.string().trim().max(140).optional().describe("Free-text name, partial name, document number or reference spoken by the user. Do not include commands, date phrases or status words. Do not supply SQL wildcards.");
const EXACT_PARTY = z.string().trim().min(1).max(140).optional().describe("Exact party ID returned by a lookup. Resolve spoken names through the appropriate party lookup or customer_query/supplier_query when available.");
const INVOICE_FILTERS = {
  docstatus: DOCSTATUS,
  unpaid_only: z.boolean().optional().describe("True means submitted invoices with positive outstanding, including overdue and partly paid invoices. Use status All or omit status."),
  overdue_as_of: DATE.optional().describe("Submitted positive balances with due date before this date. Use status All or omit status. Do not set unpaid_only to false."),
};
const CURRENCY = z.string().trim().min(3).max(20).optional().describe("Exact document currency. Required when ranking native currency amounts.");

const READABLE_DOCTYPES = {
  Customer: ["name", "customer_name", "customer_group", "territory", "disabled"],
  Item: ["name", "item_name", "item_group", "stock_uom", "disabled"],
  "Sales Order": ["name", "company", "customer", "customer_name", "transaction_date", "delivery_date", "status", "currency", "grand_total", "base_grand_total"],
  "Sales Invoice": ["name", "company", "customer", "customer_name", "posting_date", "due_date", "status", "currency", "grand_total", "base_grand_total", "outstanding_amount"],
  "Purchase Order": ["name", "company", "supplier", "supplier_name", "transaction_date", "schedule_date", "status", "currency", "grand_total", "base_grand_total", "per_received", "per_billed"],
  "Purchase Invoice": ["name", "company", "supplier", "supplier_name", "posting_date", "due_date", "status", "currency", "grand_total", "base_grand_total", "outstanding_amount"],
  "Payment Entry": ["name", "posting_date", "company", "payment_type", "party_type", "party", "party_name", "mode_of_payment", "paid_from", "paid_to", "paid_amount", "received_amount", "unallocated_amount", "reference_no", "reference_date", "status"],
  "Bank Transaction": ["name", "date", "company", "bank_account", "description", "reference_number", "transaction_id", "transaction_type", "currency", "deposit", "withdrawal", "allocated_amount", "unallocated_amount", "status", "party_type", "party"],
} as const;

type ReadableDoctype = keyof typeof READABLE_DOCTYPES;

export function createNexWaveServer(): McpServer {
  const server = new McpServer({ name: "NexWave", version: "0.1.0" });

  server.registerTool(
    "get_current_user",
    { description: "Show the NexWave site and user connected to this MCP session." },
    async () => {
      const props = getAuthProps();
      return textResult({ site: props.siteName, site_url: props.baseUrl, user: props.user });
    },
  );

  server.registerTool(
    "list_companies",
    {
      description: "List companies that the signed-in NexWave user can access.",
      inputSchema: { search: SEARCH, limit: z.number().int().min(1).max(50).default(20) },
    },
    async ({ search, limit }) => {
      const props = await currentProps();
      return listResult(
        props,
        "Company",
        ["name", "company_name", "abbr", "default_currency", "country"],
        ["name", "company_name"],
        { search, limit, directory: true, legalNames: true },
      );
    },
  );

  server.registerTool(
    "list_customers",
    {
      description: "Search customers by spoken name, partial name or exact code. Confirm candidates before using an ID. For a customer's balance prefer get_party_balance. Unspecified filters must be omitted.",
      inputSchema: {
        search: SEARCH,
        include_disabled: z.boolean().optional().describe("Set only when the user explicitly requests disabled customers. Omit to preserve the existing customer-list scope."),
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    async ({ search, limit, include_disabled }) => {
      const props = await currentProps();
      return listResult(
        props,
        "Customer",
        [...READABLE_DOCTYPES.Customer],
        ["name", "customer_name"],
        { search, limit, directory: true, legalNames: true, filters: include_disabled === false ? [["Customer", "disabled", "=", 0]] : [] },
      );
    },
  );

  server.registerTool(
    "list_items",
    {
      description: "Search items by spoken name, partial name or exact code. item_group is an exact group ID. Confirm candidates before using an item ID in reports. This is not a stock balance or sales ranking.",
      inputSchema: {
        search: SEARCH,
        item_group: z.string().trim().min(1).max(140).optional(),
        include_disabled: z.boolean().default(false),
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    async ({ search, item_group, include_disabled, limit }) => {
      const props = await currentProps();
      const filters: unknown[] = [];
      if (item_group) filters.push(["Item", "item_group", "=", item_group]);
      if (!include_disabled) filters.push(["Item", "disabled", "=", 0]);
      return listResult(
        props,
        "Item",
        [...READABLE_DOCTYPES.Item],
        ["name", "item_name"],
        { search, limit, filters, directory: true },
      );
    },
  );

  registerLookupTool(server, "list_suppliers", "Supplier", {
    description: "Search active suppliers by spoken name, partial name or exact code. Confirm candidates before using an ID. For balances prefer get_party_balance. Only include disabled suppliers when explicitly requested.",
    directory: true,
    legalNames: true,
    fields: ["name", "supplier_name", "supplier_group", "supplier_type", "country", "disabled"],
    searchFields: ["name", "supplier_name"],
    extraSchema: {
      supplier_group: z.string().trim().min(1).max(140).optional(),
      include_disabled: z.boolean().default(false),
    },
    filters: ({ supplier_group, include_disabled }) => [
      ...(supplier_group ? [["Supplier", "supplier_group", "=", supplier_group]] : []),
      ...(!include_disabled ? [["Supplier", "disabled", "=", 0]] : []),
    ],
  });

  registerLookupTool(server, "list_warehouses", "Warehouse", {
    directory: true,
    description: "List warehouses for a NexWave company.",
    fields: ["name", "warehouse_name", "company", "parent_warehouse", "warehouse_type", "is_group", "disabled"],
    searchFields: ["name", "warehouse_name"],
    extraSchema: {
      company: z.string().trim().min(1).max(140),
      include_disabled: z.boolean().default(false),
    },
    filters: ({ company, include_disabled }) => [
      ["Warehouse", "company", "=", company],
      ...(!include_disabled ? [["Warehouse", "disabled", "=", 0]] : []),
    ],
  });

  registerLookupTool(server, "list_accounts", "Account", {
    directory: true,
    description: "List accounts for a NexWave company for use in financial reports.",
    fields: ["name", "account_name", "account_number", "company", "parent_account", "root_type", "account_type", "account_currency", "is_group", "disabled"],
    searchFields: ["name", "account_name", "account_number"],
    extraSchema: {
      company: z.string().trim().min(1).max(140),
      root_type: z.enum(["Asset", "Liability", "Income", "Expense", "Equity"]).optional(),
      account_type: z.string().trim().min(1).max(140).optional(),
      include_disabled: z.boolean().default(false),
    },
    filters: ({ company, root_type, account_type, include_disabled }) => [
      ["Account", "company", "=", company],
      ...(root_type ? [["Account", "root_type", "=", root_type]] : []),
      ...(account_type ? [["Account", "account_type", "=", account_type]] : []),
      ...(!include_disabled ? [["Account", "disabled", "=", 0]] : []),
    ],
  });

  registerLookupTool(server, "list_cost_centres", "Cost Center", {
    directory: true,
    description: "List cost centres for a NexWave company.",
    fields: ["name", "cost_center_name", "company", "parent_cost_center", "is_group", "disabled"],
    searchFields: ["name", "cost_center_name"],
    extraSchema: {
      company: z.string().trim().min(1).max(140),
      include_disabled: z.boolean().default(false),
    },
    filters: ({ company, include_disabled }) => [
      ["Cost Center", "company", "=", company],
      ...(!include_disabled ? [["Cost Center", "disabled", "=", 0]] : []),
    ],
  });

  registerLookupTool(server, "list_projects", "Project", {
    directory: true,
    description: "List projects for a NexWave company.",
    fields: ["name", "project_name", "company", "status", "expected_start_date", "expected_end_date", "percent_complete"],
    searchFields: ["name", "project_name"],
    extraSchema: {
      company: z.string().trim().min(1).max(140),
      status: statusSchema(["Open", "Completed", "Cancelled"]),
    },
    filters: ({ company, status }) => [
      ["Project", "company", "=", company],
      ...(status ? [["Project", "status", "=", status]] : []),
    ],
  });

  registerLookupTool(server, "list_fiscal_years", "Fiscal Year", {
    description: "List enabled NexWave fiscal years, optionally limited to the fiscal year containing a date.",
    fields: ["name", "year_start_date", "year_end_date", "disabled"],
    searchFields: ["name"],
    extraSchema: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() },
    filters: ({ date }) => [
      ["Fiscal Year", "disabled", "=", 0],
      ...(date ? [["Fiscal Year", "year_start_date", "<=", date], ["Fiscal Year", "year_end_date", ">=", date]] : []),
    ],
  });

  registerLookupTool(server, "list_sales_invoices", "Sales Invoice", {
    party: { doctype: "Customer", field: "customer" },
    description: "List sales invoices visible to the signed-in NexWave user.",
    fields: [...READABLE_DOCTYPES["Sales Invoice"]],
    searchFields: ["name", "customer_name"],
    extraSchema: {
      company: z.string().trim().min(1).max(140).optional(),
      customer: EXACT_PARTY,
      status: SALES_INVOICE_STATUS,
      currency: CURRENCY,
      ...INVOICE_FILTERS,
      from_date: DATE.optional(),
      to_date: DATE.optional(),
    },
    filters: ({ company, customer, status, from_date, to_date, unpaid_only, overdue_as_of, docstatus }) => [
      ...(company ? [["Sales Invoice", "company", "=", company]] : []),
      ...(customer ? [["Sales Invoice", "customer", "=", customer]] : []),
      ...(status ? [["Sales Invoice", "status", "=", status]] : []),
      ...dateFilters("Sales Invoice", "posting_date", from_date, to_date),
      ...invoiceFilters("Sales Invoice", { status, unpaid_only, overdue_as_of, docstatus }),
    ],
    orderBy: "posting_date desc",
    sortFields: ["posting_date", "due_date", "base_grand_total", "grand_total", "outstanding_amount", "name"],
  });

  registerLookupTool(server, "list_purchase_invoices", "Purchase Invoice", {
    party: { doctype: "Supplier", field: "supplier" },
    description: "List purchase invoices visible to the signed-in NexWave user.",
    fields: [...READABLE_DOCTYPES["Purchase Invoice"]],
    searchFields: ["name", "supplier_name"],
    extraSchema: {
      company: z.string().trim().min(1).max(140).optional(),
      supplier: EXACT_PARTY,
      status: PURCHASE_INVOICE_STATUS,
      currency: CURRENCY,
      ...INVOICE_FILTERS,
      from_date: DATE.optional(),
      to_date: DATE.optional(),
    },
    filters: ({ company, supplier, status, from_date, to_date, unpaid_only, overdue_as_of, docstatus }) => [
      ...(company ? [["Purchase Invoice", "company", "=", company]] : []),
      ...(supplier ? [["Purchase Invoice", "supplier", "=", supplier]] : []),
      ...(status ? [["Purchase Invoice", "status", "=", status]] : []),
      ...dateFilters("Purchase Invoice", "posting_date", from_date, to_date),
      ...invoiceFilters("Purchase Invoice", { status, unpaid_only, overdue_as_of, docstatus }),
    ],
    orderBy: "posting_date desc",
    sortFields: ["posting_date", "due_date", "base_grand_total", "grand_total", "outstanding_amount", "name"],
  });

  registerLookupTool(server, "list_purchase_orders", "Purchase Order", {
    party: { doctype: "Supplier", field: "supplier" },
    description: "List purchase orders visible to the signed-in NexWave user. Order-level records only; item delivery dates and remaining item receipts are not checked.",
    fields: [...READABLE_DOCTYPES["Purchase Order"]],
    searchFields: ["name", "supplier_name"],
    extraSchema: {
      company: z.string().trim().min(1).max(140).optional(),
      supplier: EXACT_PARTY,
      status: PURCHASE_ORDER_STATUS,
      docstatus: DOCSTATUS,
      currency: CURRENCY,
      pending_receipt: z.boolean().optional().describe("Only submitted, open orders with less than 100 percent received. Use status All or omit status to include both To Receive and To Receive and Bill."),
      ...ORDER_DATES,
    },
    filters: (args) => [
      ...(args.company ? [["Purchase Order", "company", "=", args.company]] : []),
      ...(args.supplier ? [["Purchase Order", "supplier", "=", args.supplier]] : []),
      ...(args.status ? [["Purchase Order", "status", "=", args.status]] : []),
      ...orderFilters("Purchase Order", args),
    ],
    orderBy: "transaction_date desc",
    sortFields: ["transaction_date", "schedule_date", "base_grand_total", "grand_total", "name"],
  });

  registerLookupTool(server, "list_payments", "Payment Entry", {
    description: "List payment entries visible to the signed-in NexWave user.",
    fields: [...READABLE_DOCTYPES["Payment Entry"]],
    searchFields: ["name", "party_name", "reference_no"],
    extraSchema: {
      company: z.string().trim().min(1).max(140).optional(),
      payment_type: z.enum(["Receive", "Pay", "Internal Transfer"]).optional(),
      party_type: z.enum(["Customer", "Supplier", "Employee", "Shareholder"]).optional(),
      party: EXACT_PARTY,
      status: statusSchema(["Draft", "Submitted", "Cancelled"]),
      from_date: DATE.optional(),
      to_date: DATE.optional(),
    },
    filters: ({ company, payment_type, party_type, party, status, from_date, to_date }) => [
      ...(company ? [["Payment Entry", "company", "=", company]] : []),
      ...(payment_type ? [["Payment Entry", "payment_type", "=", payment_type]] : []),
      ...(party_type ? [["Payment Entry", "party_type", "=", party_type]] : []),
      ...(party ? [["Payment Entry", "party", "=", party]] : []),
      ...(status ? [["Payment Entry", "status", "=", status]] : []),
      ...dateFilters("Payment Entry", "posting_date", from_date, to_date),
    ],
    orderBy: "posting_date desc",
    sortFields: ["posting_date", "name"],
  });

  registerLookupTool(server, "list_bank_transactions", "Bank Transaction", {
    description: "List imported bank transactions visible to the signed-in NexWave user.",
    fields: [...READABLE_DOCTYPES["Bank Transaction"]],
    searchFields: ["name", "description", "reference_number"],
    extraSchema: {
      company: z.string().trim().min(1).max(140).optional(),
      bank_account: z.string().trim().min(1).max(140).optional(),
      status: statusSchema(["Pending", "Settled", "Unreconciled", "Reconciled", "Cancelled"]),
      from_date: DATE.optional(),
      to_date: DATE.optional(),
    },
    filters: ({ company, bank_account, status, from_date, to_date }) => [
      ...(company ? [["Bank Transaction", "company", "=", company]] : []),
      ...(bank_account ? [["Bank Transaction", "bank_account", "=", bank_account]] : []),
      ...(status ? [["Bank Transaction", "status", "=", status]] : []),
      ...dateFilters("Bank Transaction", "date", from_date, to_date),
    ],
    orderBy: "date desc",
    sortFields: ["date", "name"],
  });

  registerLookupTool(server, "list_sales_orders", "Sales Order", {
    description: "Search sales orders by order number or customer, with date, status and company filters. Order-level records only; item delivery dates and remaining item deliveries are not checked.",
    fields: [...READABLE_DOCTYPES["Sales Order"]],
    searchFields: ["name", "customer_name"],
    party: { doctype: "Customer", field: "customer" },
    extraSchema: {
      company: z.string().trim().min(1).max(140).optional(), customer: EXACT_PARTY,
      status: SALES_ORDER_STATUS, docstatus: DOCSTATUS, currency: CURRENCY,
      pending_delivery: z.boolean().optional().describe("Only submitted, open orders with less than 100 percent delivered and delivery required. Use status All or omit status to include both To Deliver and To Deliver and Bill."),
      ...ORDER_DATES,
    },
    filters: (args) => [
      ...(args.company ? [["Sales Order", "company", "=", args.company]] : []),
      ...(args.customer ? [["Sales Order", "customer", "=", args.customer]] : []),
      ...(args.status ? [["Sales Order", "status", "=", args.status]] : []),
      ...orderFilters("Sales Order", args),
    ],
    orderBy: "modified desc",
    sortFields: ["transaction_date", "delivery_date", "base_grand_total", "grand_total", "name"],
  });

  server.registerTool(
    "get_document",
    {
      description: "Get one read-only NexWave business document by its type and exact name.",
      inputSchema: {
        doctype: z.enum([
          "Customer",
          "Item",
          "Sales Order",
          "Sales Invoice",
          "Purchase Order",
          "Purchase Invoice",
          "Payment Entry",
          "Bank Transaction",
        ]),
        name: z.string().trim().min(1).max(140),
      },
    },
    async ({ doctype, name }) => {
      const props = await currentProps();
      const data = await frappeGet<Record<string, unknown>>(props, doctype, name);
      return textResult(selectFields(data, READABLE_DOCTYPES[doctype as ReadableDoctype]));
    },
  );

  registerReportTools(server, currentProps);
  registerPartyTools(server, currentProps);
  registerInsightTools(server, currentProps);

  return server;
}

const baseMcpHandler = createMcpHandler(createNexWaveServer, {
  route: "/mcp",
  legacy: "stateless",
});

export async function mcpHandler(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  return withMcpErrorBoundary(request, async () => baseMcpHandler(await normaliseMcpToolArguments(request), env, ctx));
}

function getAuthProps(): NexWaveAuthProps {
  const props = getMcpAuthContext()?.props as NexWaveAuthProps | undefined;
  if (!props?.siteId || !hasUpstreamAuthentication(props)) {
    throw new Error("This MCP request does not have a valid NexWave connection.");
  }
  return props;
}

function hasUpstreamAuthentication(props: NexWaveAuthProps): boolean {
  if (props.authType === "api_token") {
    return Boolean(props.upstreamApiKey && props.upstreamApiSecret);
  }
  return Boolean(props.upstreamAccessToken);
}

async function currentProps(): Promise<NexWaveAuthProps> {
  const props = getAuthProps();
  const requestDeadline = Date.now() + TOOL_REQUEST_TIMEOUT_MS;
  return ensureFreshToken({ ...props, requestDeadline });
}

function registerLookupTool(
  server: McpServer,
  toolName: string,
  doctype: string,
  options: {
    description: string;
    fields: string[];
    searchFields: string[];
    extraSchema: Record<string, z.ZodType>;
    filters: (input: Record<string, unknown>) => unknown[];
    orderBy?: string;
    directory?: boolean;
    legalNames?: boolean;
    sortFields?: [string, ...string[]];
    party?: { doctype: "Customer" | "Supplier"; field: "customer" | "supplier" };
  },
): void {
  server.registerTool(
    toolName,
    {
      description: `${options.description} Use search for ${options.directory ? "names or record codes" : "document text"}; exact filters require IDs returned by tools. ${options.party ? `For a spoken party name use ${options.party.field}_query; the server resolves it before filtering. ` : ""}Omit unspecified filters. List rows are examples, never an aggregate total.${options.sortFields?.includes("base_grand_total") ? " For largest invoices or orders use base_grand_total with company, so currencies are comparable." : ""}`,
      inputSchema: {
        search: SEARCH,
        limit: z.number().int().min(1).max(50).default(20),
        ...options.extraSchema,
        ...(options.party ? { [`${options.party.field}_query`]: z.string().trim().min(1).max(140).optional().describe("Spoken party name. Resolves to an exact party filter or asks for confirmation. Do not also set the exact party filter.") } : {}),
        ...(options.sortFields ? {
          sort_by: z.enum(options.sortFields).optional().describe("Server-side ordering across matching records, before the result limit."),
          sort_order: z.enum(["asc", "desc"]).optional(),
        } : {}),
      },
    },
    async (input) => {
      const args: Record<string, unknown> = { ...input };
      if (args.status === "All") delete args.status;
      // Reject invalid combinations before token refresh or party lookup can use the deadline.
      options.filters(args);
      if (options.party && args[`${options.party.field}_query`] && args[options.party.field]) {
        throw new ToolError("INVALID_ARGUMENT", `Use ${options.party.field}_query or ${options.party.field}, not both.`);
      }
      const search = typeof input.search === "string" ? input.search : undefined;
      const limit = typeof input.limit === "number" ? input.limit : 20;
      const defaultOrder = options.orderBy ?? "modified desc";
      const sortBy = typeof input.sort_by === "string" ? input.sort_by : defaultOrder.split(" ")[0];
      const sortOrder = input.sort_order ?? defaultOrder.split(" ")[1];
      if (["grand_total", "outstanding_amount"].includes(sortBy) && !args.currency) {
        throw new ToolError("INVALID_ARGUMENT", "Ranking native amounts requires currency. For invoice or order value across currencies use base_grand_total and company.");
      }
      if (sortBy === "base_grand_total" && !args.company) throw new ToolError("INVALID_ARGUMENT", "Ranking company-currency amounts requires one company.");
      const props = await currentProps();
      if (options.party) {
        const { doctype: partyType, field } = options.party;
        const query = args[`${field}_query`];
        if (typeof query === "string") {
          const found = await searchRecords(props, partyType, ["name", `${field}_name`], ["name", `${field}_name`], {
            search: query, limit: 5, directory: true, legalNames: true, filters: [[partyType, "disabled", "=", 0]],
          });
          if (found.meta.match_status !== "matched") return structuredResult({
            status: found.meta.match_status, candidates: found.records, truncated: found.meta.truncated,
            next_action: `Confirm a candidate, then repeat with its exact name in ${field} and omit ${field}_query. No transaction search has been run.`,
          });
          args[field] = found.meta.matched_id;
        }
      }
      const filters = options.filters(args);
      if (args.currency) filters.push([doctype, "currency", "=", args.currency]);
      const result = await listResult(
        props,
        doctype,
        options.fields,
        options.searchFields,
        { search, limit, filters, orderBy: `${sortBy} ${sortOrder}`, directory: options.directory, legalNames: options.legalNames },
      );
      if ((doctype === "Sales Order" || doctype === "Purchase Order")
        && (args.pending_receipt || args.pending_delivery || args.delivery_from_date || args.delivery_to_date || args.overdue_as_of)) {
        const deliveryScope = {
          basis: doctype === "Purchase Order" ? "Order header schedule_date (earliest item date)." : "Order header delivery_date (latest item date).",
          item_delivery_check_complete: false,
          note: "These are order-level examples. Item delivery dates and item receipt/delivery completion were not checked. Even an empty result cannot establish that there are no overdue item deliveries.",
        };
        result.structuredContent = { ...result.structuredContent, delivery_scope: deliveryScope };
        // Keep the first legacy array unchanged, and make the limit visible to text-only clients too.
        result.content.push({ type: "text", text: JSON.stringify({ delivery_scope: deliveryScope }) });
      }
      if (sortBy === "base_grand_total") {
        const company = await frappeGet<{ default_currency: string }>(props, "Company", String(args.company));
        if (typeof company.default_currency !== "string" || !company.default_currency.trim()) throw new ToolError("UPSTREAM_INVALID_RESPONSE", "The company currency could not be confirmed.");
        result.structuredContent = { ...result.structuredContent, ranking: { field: sortBy, currency: company.default_currency, company: args.company } };
      }
      return result;
    },
  );
}

function selectFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(fields.filter((field) => field in value).map((field) => [field, value[field]]));
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}
