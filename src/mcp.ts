import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { frappeGet, frappeList, ensureFreshToken } from "./frappe";
import { registerReportTools, validateDateRange } from "./report-tools";
import type { NexWaveAuthProps } from "./types";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date in YYYY-MM-DD format.");

const READABLE_DOCTYPES = {
  Customer: ["name", "customer_name", "customer_group", "territory", "disabled"],
  Item: ["name", "item_name", "item_group", "stock_uom", "disabled"],
  "Sales Order": ["name", "customer", "customer_name", "transaction_date", "delivery_date", "status", "currency", "grand_total"],
  "Sales Invoice": ["name", "company", "customer", "customer_name", "posting_date", "due_date", "status", "currency", "grand_total", "outstanding_amount"],
  "Purchase Order": ["name", "supplier", "supplier_name", "transaction_date", "schedule_date", "status", "currency", "grand_total"],
  "Purchase Invoice": ["name", "company", "supplier", "supplier_name", "posting_date", "due_date", "status", "currency", "grand_total", "outstanding_amount"],
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
      inputSchema: { limit: z.number().int().min(1).max(50).default(20) },
    },
    async ({ limit }) => {
      const props = await currentProps();
      const data = await frappeList<Record<string, unknown>>(
        props,
        "Company",
        ["name", "company_name", "abbr", "default_currency", "country"],
        { limit, orderBy: "modified desc" },
      );
      return textResult(data);
    },
  );

  server.registerTool(
    "list_customers",
    {
      description: "List customers visible to the signed-in NexWave user.",
      inputSchema: {
        search: z.string().trim().max(100).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    async ({ search, limit }) => {
      const props = await currentProps();
      const orFilters = search
        ? [["Customer", "name", "like", `%${search}%`], ["Customer", "customer_name", "like", `%${search}%`]]
        : undefined;
      const data = await frappeList<Record<string, unknown>>(
        props,
        "Customer",
        [...READABLE_DOCTYPES.Customer],
        { limit, orFilters, orderBy: "modified desc" },
      );
      return textResult(data);
    },
  );

  server.registerTool(
    "list_items",
    {
      description: "List items visible to the signed-in NexWave user.",
      inputSchema: {
        search: z.string().trim().max(100).optional(),
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
      const orFilters = search
        ? [["Item", "name", "like", `%${search}%`], ["Item", "item_name", "like", `%${search}%`]]
        : undefined;
      const data = await frappeList<Record<string, unknown>>(
        props,
        "Item",
        [...READABLE_DOCTYPES.Item],
        { limit, filters, orFilters, orderBy: "modified desc" },
      );
      return textResult(data);
    },
  );

  registerLookupTool(server, "list_suppliers", "Supplier", {
    description: "List suppliers visible to the signed-in NexWave user.",
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
    description: "List projects for a NexWave company.",
    fields: ["name", "project_name", "company", "status", "expected_start_date", "expected_end_date", "percent_complete"],
    searchFields: ["name", "project_name"],
    extraSchema: {
      company: z.string().trim().min(1).max(140),
      status: z.enum(["Open", "Completed", "Cancelled"]).optional(),
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
    description: "List sales invoices visible to the signed-in NexWave user.",
    fields: [...READABLE_DOCTYPES["Sales Invoice"]],
    searchFields: ["name", "customer_name"],
    extraSchema: {
      company: z.string().trim().min(1).max(140).optional(),
      customer: z.string().trim().min(1).max(140).optional(),
      status: z.string().trim().min(1).max(50).optional(),
      from_date: DATE.optional(),
      to_date: DATE.optional(),
    },
    filters: ({ company, customer, status, from_date, to_date }) => [
      ...(company ? [["Sales Invoice", "company", "=", company]] : []),
      ...(customer ? [["Sales Invoice", "customer", "=", customer]] : []),
      ...(status ? [["Sales Invoice", "status", "=", status]] : []),
      ...dateFilters("Sales Invoice", "posting_date", from_date, to_date),
    ],
    orderBy: "posting_date desc",
  });

  registerLookupTool(server, "list_purchase_invoices", "Purchase Invoice", {
    description: "List purchase invoices visible to the signed-in NexWave user.",
    fields: [...READABLE_DOCTYPES["Purchase Invoice"]],
    searchFields: ["name", "supplier_name"],
    extraSchema: {
      company: z.string().trim().min(1).max(140).optional(),
      supplier: z.string().trim().min(1).max(140).optional(),
      status: z.string().trim().min(1).max(50).optional(),
      from_date: DATE.optional(),
      to_date: DATE.optional(),
    },
    filters: ({ company, supplier, status, from_date, to_date }) => [
      ...(company ? [["Purchase Invoice", "company", "=", company]] : []),
      ...(supplier ? [["Purchase Invoice", "supplier", "=", supplier]] : []),
      ...(status ? [["Purchase Invoice", "status", "=", status]] : []),
      ...dateFilters("Purchase Invoice", "posting_date", from_date, to_date),
    ],
    orderBy: "posting_date desc",
  });

  registerLookupTool(server, "list_payments", "Payment Entry", {
    description: "List payment entries visible to the signed-in NexWave user.",
    fields: [...READABLE_DOCTYPES["Payment Entry"]],
    searchFields: ["name", "party_name", "reference_no"],
    extraSchema: {
      company: z.string().trim().min(1).max(140).optional(),
      payment_type: z.enum(["Receive", "Pay", "Internal Transfer"]).optional(),
      party_type: z.string().trim().min(1).max(140).optional(),
      party: z.string().trim().min(1).max(140).optional(),
      status: z.enum(["Draft", "Submitted", "Cancelled"]).optional(),
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
  });

  registerLookupTool(server, "list_bank_transactions", "Bank Transaction", {
    description: "List imported bank transactions visible to the signed-in NexWave user.",
    fields: [...READABLE_DOCTYPES["Bank Transaction"]],
    searchFields: ["name", "description", "reference_number"],
    extraSchema: {
      company: z.string().trim().min(1).max(140).optional(),
      bank_account: z.string().trim().min(1).max(140).optional(),
      status: z.enum(["Pending", "Settled", "Unreconciled", "Reconciled", "Cancelled"]).optional(),
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
  });

  server.registerTool(
    "list_sales_orders",
    {
      description: "List recent sales orders visible to the signed-in NexWave user.",
      inputSchema: {
        status: z.string().trim().max(50).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    async ({ status, limit }) => {
      const props = await currentProps();
      const filters = status ? [["Sales Order", "status", "=", status]] : undefined;
      const data = await frappeList<Record<string, unknown>>(
        props,
        "Sales Order",
        [...READABLE_DOCTYPES["Sales Order"]],
        { limit, filters, orderBy: "modified desc" },
      );
      return textResult(data);
    },
  );

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

  return server;
}

export const mcpHandler = createMcpHandler(createNexWaveServer, {
  route: "/mcp",
  legacy: "stateless",
});

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
  return ensureFreshToken(getAuthProps());
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
  },
): void {
  server.registerTool(
    toolName,
    {
      description: options.description,
      inputSchema: {
        search: z.string().trim().max(100).optional(),
        limit: z.number().int().min(1).max(50).default(20),
        ...options.extraSchema,
      },
    },
    async (input) => {
      const props = await currentProps();
      const search = typeof input.search === "string" ? input.search : undefined;
      const limit = typeof input.limit === "number" ? input.limit : 20;
      const orFilters = search
        ? options.searchFields.map((field) => [doctype, field, "like", `%${search}%`])
        : undefined;
      const data = await frappeList<Record<string, unknown>>(
        props,
        doctype,
        options.fields,
        { limit, filters: options.filters(input), orFilters, orderBy: options.orderBy ?? "modified desc" },
      );
      return textResult(data);
    },
  );
}

function dateFilters(
  doctype: string,
  field: string,
  fromDate: unknown,
  toDate: unknown,
): unknown[] {
  const from = typeof fromDate === "string" ? fromDate : undefined;
  const to = typeof toDate === "string" ? toDate : undefined;
  const start = from ?? to;
  const end = to ?? from;
  if (start && end) validateDateRange(start, end);
  return [
    ...(from ? [[doctype, field, ">=", from]] : []),
    ...(to ? [[doctype, field, "<=", to]] : []),
  ];
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
