import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { frappeGet, frappeList, ensureFreshToken } from "./frappe";
import type { NexWaveAuthProps } from "./types";

const READABLE_DOCTYPES = {
  Customer: ["name", "customer_name", "customer_group", "territory", "disabled"],
  Item: ["name", "item_name", "item_group", "stock_uom", "disabled"],
  "Sales Order": ["name", "customer", "customer_name", "transaction_date", "delivery_date", "status", "currency", "grand_total"],
  "Sales Invoice": ["name", "customer", "customer_name", "posting_date", "due_date", "status", "currency", "grand_total", "outstanding_amount"],
  "Purchase Order": ["name", "supplier", "supplier_name", "transaction_date", "schedule_date", "status", "currency", "grand_total"],
  "Purchase Invoice": ["name", "supplier", "supplier_name", "posting_date", "due_date", "status", "currency", "grand_total", "outstanding_amount"],
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
      const filters = search ? [["Customer", "customer_name", "like", `%${search}%`]] : undefined;
      const data = await frappeList<Record<string, unknown>>(
        props,
        "Customer",
        [...READABLE_DOCTYPES.Customer],
        { limit, filters, orderBy: "modified desc" },
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
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    async ({ search, limit }) => {
      const props = await currentProps();
      const filters = search
        ? [["Item", "item_name", "like", `%${search}%`]]
        : undefined;
      const data = await frappeList<Record<string, unknown>>(
        props,
        "Item",
        [...READABLE_DOCTYPES.Item],
        { limit, filters, orderBy: "modified desc" },
      );
      return textResult(data);
    },
  );

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

  return server;
}

export const mcpHandler = createMcpHandler(createNexWaveServer, {
  route: "/mcp",
  legacy: "stateless",
});

function getAuthProps(): NexWaveAuthProps {
  const props = getMcpAuthContext()?.props as NexWaveAuthProps | undefined;
  if (!props?.siteId || !props.upstreamAccessToken) {
    throw new Error("This MCP request does not have a valid NexWave connection.");
  }
  return props;
}

async function currentProps(): Promise<NexWaveAuthProps> {
  return ensureFreshToken(getAuthProps());
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
