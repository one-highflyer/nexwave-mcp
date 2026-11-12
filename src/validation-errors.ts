const MISSING_REQUIRED_FIELDS = "NexWave requires one or more missing fields. Check the tool's required inputs. If the tool cannot set a required field, use the normal NexWave form or ask the site administrator.";
const DEFAULTS_REQUIRED = "NexWave could not set a required value from its defaults or calculations. Use the normal NexWave form or ask the site administrator to check the site configuration.";
const UNSUPPORTED_FIELD = "This site requires a field that this tool cannot set. Use the normal NexWave form or ask the site administrator.";

const ITEM_INPUTS = ["item_code", "qty", "uom", "rate", "description", "warehouse", "discount_percentage"];
const TRANSACTION_INPUTS = ["company", "currency", "taxes_and_charges", "payment_terms_template", "tc_name", "items", ...ITEM_INPUTS];
const SELLING_DEFAULTS = ["naming_series", "order_type", "status", "conversion_rate", "price_list_currency", "plc_conversion_rate", "item_name", "conversion_factor"];
const FIELDS = {
  Quotation: {
    inputs: [...TRANSACTION_INPUTS, "quotation_to", "party_name", "transaction_date", "valid_till", "selling_price_list", "customer_address", "shipping_address_name", "contact_person"],
    defaults: [...SELLING_DEFAULTS, "ordered_qty"],
  },
  "Sales Order": {
    inputs: [...TRANSACTION_INPUTS, "customer", "transaction_date", "delivery_date", "selling_price_list", "prevdoc_docname", "quotation_item"],
    defaults: SELLING_DEFAULTS,
  },
  "Purchase Invoice": {
    inputs: [...TRANSACTION_INPUTS, "supplier", "posting_date", "due_date", "bill_no", "bill_date", "buying_price_list", "expense_account", "cost_center", "purchase_order", "po_detail"],
    defaults: ["naming_series", "credit_to", "item_name", "conversion_factor", "stock_qty", "amount", "base_rate", "base_amount"],
  },
  Customer: {
    inputs: ["customer_name", "customer_type", "customer_group", "territory", "default_currency", "default_price_list", "payment_terms", "email_id", "mobile_no", "first_name", "last_name", "lead_name", "prospect_name"],
    defaults: ["naming_series"],
  },
  Lead: {
    inputs: ["first_name", "last_name", "company_name", "email_id", "mobile_no", "territory", "source", "industry"],
    defaults: ["naming_series", "lead_name", "status"],
  },
} satisfies Record<string, { inputs: string[]; defaults: string[] }>;

/** Extract only known field identifiers from the native mandatory-field error shape. */
export function mandatoryValidationMessage(payload: unknown, expectedDoctype: string): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const error = payload as Record<string, unknown>;
  if (error.exc_type !== "MandatoryError") return undefined;
  if (!Object.hasOwn(FIELDS, expectedDoctype)) return MISSING_REQUIRED_FIELDS;
  const exception = error.exception;
  if (typeof exception !== "string" || exception.length > 4096
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(exception)) return MISSING_REQUIRED_FIELDS;

  const prefix = `frappe.exceptions.MandatoryError: [${expectedDoctype}, `;
  if (!exception.startsWith(prefix)) return MISSING_REQUIRED_FIELDS;
  const suffix = exception.slice(prefix.length);
  const separator = suffix.indexOf("]: ");
  if (separator < 1 || separator > 140 || /[\[\]]/.test(suffix.slice(0, separator))) return MISSING_REQUIRED_FIELDS;
  const fields = suffix.slice(separator + 3).split(", ");
  if (fields.length > 50 || fields.some((field) => !/^[a-z][a-z0-9_]{0,139}$/.test(field))) return MISSING_REQUIRED_FIELDS;

  const allowed = FIELDS[expectedDoctype as keyof typeof FIELDS];
  const inputs = [...new Set(fields.filter((field) => allowed.inputs.includes(field)))];
  const messages: string[] = [];
  if (inputs.length) messages.push(`NexWave requires these tool input fields: ${inputs.join(", ")}. Check the header and item inputs.`);
  if (fields.some((field) => allowed.defaults.includes(field))) messages.push(DEFAULTS_REQUIRED);
  if (fields.some((field) => !allowed.inputs.includes(field) && !allowed.defaults.includes(field))) messages.push(UNSUPPORTED_FIELD);
  return messages.join(" ");
}
