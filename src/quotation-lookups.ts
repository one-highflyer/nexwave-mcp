import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { frappeList } from "./frappe";
import { PDF_DOCTYPES, searchPrintFormats } from "./pdf-tool";
import { validateDateRange } from "./report-tools";
import { listResult } from "./search";
import { registerReadTool } from "./tool-contract";
import { structuredResult, ToolError } from "./tool-result";
import { dateFilters } from "./transaction-filters";
import type { NexWaveAuthProps } from "./types";

const ID = z.string().trim().min(1).max(140);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date in YYYY-MM-DD format.");
const PAGE = {
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().min(1).max(50).default(20),
};
const SEARCH = {
  ...PAGE,
  search: z.string().trim().max(140).optional(),
  search_mode: z.enum(["ranked", "literal"]).optional(),
  summary: z.enum(["count"]).optional(),
};

// Document fields only. Template child rows are handled by documentDetails.
export const QUOTATION_READABLE_DOCTYPES = {
  Lead: ["name", "lead_name", "first_name", "last_name", "company_name", "email_id", "phone", "mobile_no", "status", "company", "territory", "disabled"],
  Prospect: ["name", "company_name", "company", "customer_group", "territory", "industry", "prospect_owner", "website"],
  Quotation: ["name", "modified", "company", "quotation_to", "party_name", "customer_name", "transaction_date", "valid_till", "status", "docstatus", "currency", "selling_price_list", "price_list_currency", "conversion_rate", "plc_conversion_rate", "total", "net_total", "total_taxes_and_charges", "grand_total", "rounded_total", "discount_amount", "additional_discount_percentage", "apply_discount_on", "taxes_and_charges", "tax_category", "payment_terms_template", "tc_name", "terms", "customer_address", "contact_person", "contact_display", "contact_email", "contact_mobile", "address_display", "shipping_address_name", "shipping_address", "letter_head"],
  "Item Price": ["name", "item_code", "item_name", "price_list", "customer", "supplier", "buying", "selling", "currency", "uom", "price_list_rate", "valid_from", "valid_upto", "batch_no", "packing_unit", "lead_time_days"],
  "Price List": ["name", "price_list_name", "buying", "selling", "enabled", "currency", "price_not_uom_dependent"],
  "Sales Taxes and Charges Template": ["name", "title", "company", "disabled", "is_default", "tax_category"],
  "Purchase Taxes and Charges Template": ["name", "title", "company", "disabled", "is_default", "tax_category"],
  "Terms and Conditions": ["name", "title", "terms", "selling", "buying", "disabled"],
  "Payment Terms Template": ["name", "template_name", "allocate_payment_based_on_payment_terms"],
} as const;

export function registerQuotationLookups(server: McpServer, currentProps: () => Promise<NexWaveAuthProps>): void {
  registerReadTool(server, "list_item_prices", {
    description: "List saved Item Price records, not final quotation rates after Pricing Rules. Filters require exact IDs from lookups. Customer/supplier filters return only explicitly assigned prices, not general fallback prices. valid_on includes open-ended validity dates. Follow next_offset with the same filters; an empty page is not a calculated quotation price.",
    inputSchema: {
      ...PAGE,
      item_code: ID.optional(), price_list: ID.optional(), customer: ID.optional(), supplier: ID.optional(),
      buying: z.boolean().optional(), selling: z.boolean().optional(), currency: ID.optional(), uom: ID.optional(),
      batch_no: ID.optional(), valid_on: DATE.optional(),
    },
  }, async (input) => {
    if (input.valid_on) validateDateRange(input.valid_on, input.valid_on);
    const filters = exactFilters("Item Price", input, ["item_code", "price_list", "customer", "supplier", "currency", "uom", "batch_no"]);
    filters.push(...booleanFilters("Item Price", input, ["buying", "selling"]));
    // v15 applies the minimum-date fallback to <= Date filters, including unset valid_from.
    if (input.valid_on) filters.push(["Item Price", "valid_from", "<=", input.valid_on]);
    const rows = await frappeList<Record<string, unknown>>(await currentProps(), "Item Price", [...QUOTATION_READABLE_DOCTYPES["Item Price"]], {
      limit: input.limit, offset: input.offset, filters, orderBy: "valid_from desc, name asc",
      orFilters: input.valid_on ? [["Item Price", "valid_upto", ">=", input.valid_on], ["Item Price", "valid_upto", "is", "not set"]] : [],
    });
    const truncated = rows.length === input.limit;
    const meta = {
      count: rows.length, offset: input.offset, limit: input.limit,
      next_offset: truncated ? input.offset + rows.length : null,
      truncated, complete: input.offset === 0 && !truncated,
      warning: truncated || input.offset > 0 ? "These prices are one page. Follow next_offset with unchanged filters; pages are not a snapshot." : null,
    };
    const result = structuredResult({ records: rows, meta, basis: "Saved Item Price records. Pricing Rules and general party-price fallback have not been applied." }, rows);
    result.content.push({ type: "text", text: JSON.stringify({ meta, basis: result.structuredContent.basis }) });
    return result;
  });

  registerLookup("list_price_lists", "Price List", ["name", "price_list_name"], {
    buying: z.boolean().optional(), selling: z.boolean().optional(), currency: ID.optional(), enabled: z.boolean().default(true),
  }, (input) => [...exactFilters("Price List", input, ["currency"]), ...booleanFilters("Price List", input, ["buying", "selling", "enabled"])],
  "Find buying, selling, or dual-purpose price lists. enabled defaults to true; false lists disabled price lists. Buying and selling are independent flags.");

  registerLookup("list_leads", "Lead", ["name", "lead_name", "company_name", "email_id"], {
    company: ID.optional(), status: z.enum(["Lead", "Open", "Replied", "Opportunity", "Quotation", "Lost Quotation", "Interested", "Converted", "Do Not Contact"]).optional(),
    email_id: z.string().trim().email().max(254).optional(), include_disabled: z.boolean().default(false),
  }, (input) => [...exactFilters("Lead", input, ["company", "status", "email_id"]), ...(!input.include_disabled ? [["Lead", "disabled", "=", 0]] : [])],
  "Find existing leads before creating another prospect. Confirm a candidate before using its exact ID in a quotation.");

  registerLookup("list_prospects", "Prospect", ["name", "company_name"], {
    company: ID.optional(), lead_name: ID.optional(), customer_group: ID.optional(), territory: ID.optional(),
  }, (input) => {
    if (input.lead_name && input.summary) throw new ToolError("INVALID_ARGUMENT", "Prospect counts with Lead membership filters are not supported. List and confirm the matching Prospects instead.");
    return [...exactFilters("Prospect", input, ["company", "customer_group", "territory"]),
      ...(input.lead_name ? [["Prospect Lead", "lead", "=", input.lead_name]] : [])];
  }, "Find existing Prospects visible to the signed-in user. lead_name filters exact native Lead membership; count summaries are not supported with that filter. Confirm an exact Prospect ID before linking a new Customer. Use get_document for its Lead links.");

  registerLookup("list_quotations", "Quotation", ["name", "customer_name", "party_name"], {
    company: ID.optional(), quotation_to: z.enum(["Customer", "Lead"]).optional(), party_name: ID.optional(),
    docstatus: z.number().int().min(0).max(2).optional(), currency: ID.optional(),
    from_date: DATE.optional(), to_date: DATE.optional(),
  }, (input) => {
    if (input.party_name && !input.quotation_to) throw new ToolError("INVALID_ARGUMENT", "party_name requires quotation_to so Customer and Lead IDs cannot be confused.");
    return [...exactFilters("Quotation", input, ["company", "quotation_to", "party_name", "currency", "docstatus"]), ...dateFilters("Quotation", "transaction_date", input.from_date, input.to_date)];
  }, "Find quotations addressed to Customers or Leads. docstatus is 0 draft, 1 submitted, or 2 cancelled. Dates filter transaction_date. Use get_document for item, tax, and payment rows.", false,
  ["name", "modified", "company", "quotation_to", "party_name", "customer_name", "transaction_date", "valid_till", "docstatus", "status", "currency", "grand_total", "selling_price_list"]);

  registerReadTool(server, "list_tax_templates", {
    description: "Find Sales or Purchase Taxes and Charges Templates for one company. Quotations use Sales templates. Get the selected template with get_document to inspect its tax rows. Disabled templates are excluded by default.",
    inputSchema: { ...SEARCH, type: z.enum(["Sales", "Purchase"]), company: ID, include_disabled: z.boolean().default(false), tax_category: ID.optional() },
  }, async (input) => {
    const doctype = input.type === "Sales" ? "Sales Taxes and Charges Template" : "Purchase Taxes and Charges Template";
    return listResult(await currentProps(), doctype, [...QUOTATION_READABLE_DOCTYPES[doctype]], ["name", "title"], {
      ...input, directory: true, filters: [...exactFilters(doctype, input, ["company", "tax_category"]), ...(!input.include_disabled ? [[doctype, "disabled", "=", 0]] : [])], orderBy: "is_default desc",
    });
  });

  registerReadTool(server, "list_print_formats", {
    description: "Find enabled saved PDF print formats through the user's normal Link-field selection access. Returns a bounded candidate search, not a pageable catalogue or count; narrow search when the bound is reached. The built-in Standard format is returned as default_format metadata, not as a stored Print Format row. No template HTML or CSS is returned.",
    inputSchema: { doctype: z.enum(PDF_DOCTYPES), search: z.string().trim().max(140).optional(), limit: PAGE.limit },
  }, async (input) => {
    const records = await searchPrintFormats(await currentProps(), { doctype: input.doctype, search: input.search, limit: input.limit });
    const truncated = records.length === input.limit;
    const meta = { count: records.length, offset: 0, limit: input.limit, next_offset: null, truncated, complete: !truncated, scope: "ranked_candidates", warning: truncated ? "Print Format selection is bounded. Narrow search to find other formats; no full count or next page is available." : null };
    const metadata = { meta, default_format: "Standard", doctype: input.doctype };
    const result = structuredResult({ records, ...metadata }, records);
    result.content.push({ type: "text", text: JSON.stringify(metadata) });
    return result;
  });

  registerLookup("list_terms_and_conditions", "Terms and Conditions", ["name", "title"], {
    selling: z.boolean().optional(), buying: z.boolean().optional(), include_disabled: z.boolean().default(false),
  }, (input) => [...booleanFilters("Terms and Conditions", input, ["selling", "buying"]), ...(!input.include_disabled ? [["Terms and Conditions", "disabled", "=", 0]] : [])],
  "Find enabled Terms and Conditions templates. Filter selling=true for quotations. Get the selected template with get_document for its terms text.", true, ["name", "title", "selling", "buying", "disabled"]);

  registerLookup("list_payment_terms_templates", "Payment Terms Template", ["name", "template_name"], {}, () => [],
  "Find Payment Terms Templates. Use get_document to inspect the selected template's payment schedule rules.");

  function registerLookup(
    tool: string, doctype: keyof typeof QUOTATION_READABLE_DOCTYPES, searchFields: string[], extraSchema: Record<string, z.ZodType>,
    filters: (input: Record<string, unknown>) => unknown[], description: string, directory = true, fields?: string[],
  ): void {
    registerReadTool(server, tool, {
      description: `${description} Exact filters require confirmed IDs. Follow next_offset with unchanged filters; one page is not the full result. Use summary=count for all matching records and search_mode=literal when counting a text search.`,
      inputSchema: { ...SEARCH, ...extraSchema },
    }, async (input) => {
      const safeFilters = filters(input);
      return listResult(await currentProps(), doctype, fields ?? [...QUOTATION_READABLE_DOCTYPES[doctype]], searchFields, {
        search: typeof input.search === "string" ? input.search : undefined,
        search_mode: input.search_mode as "ranked" | "literal" | undefined,
        summary: input.summary as "count" | undefined,
        offset: Number(input.offset), limit: Number(input.limit), directory, filters: safeFilters, orderBy: "modified desc",
      });
    });
  }
}

function exactFilters(doctype: string, input: Record<string, unknown>, fields: string[]): unknown[] {
  return fields.filter((field) => input[field] !== undefined).map((field) => [doctype, field, "=", input[field]]);
}

function booleanFilters(doctype: string, input: Record<string, unknown>, fields: string[]): unknown[] {
  return fields.filter((field) => input[field] !== undefined).map((field) => [doctype, field, "=", input[field] ? 1 : 0]);
}
