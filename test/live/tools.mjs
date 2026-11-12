import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const backend = new URL(process.env.LIVE_FRAPPE_URL);
assert.equal(backend.protocol, "http:");
assert.equal(backend.hostname, "127.0.0.1", "Only the disposable loopback backend is allowed");
const fixture = JSON.parse(await readFile(process.env.LIVE_FRAPPE_FIXTURES, "utf8"));
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const { build } = wranglerRequire("esbuild");
const root = fileURLToPath(new URL("../../", import.meta.url));
const config = JSON.parse(await readFile(new URL("../../wrangler.jsonc", import.meta.url), "utf8"));
const origins = new Map(Object.keys(fixture.credentials).map((role) => [`https://${role}.frappe.example.invalid`, role]));

// Readiness is bounded; an unhealthy backend must fail the job, not skip tests.
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch(new URL("/api/method/ping", backend), {
      headers: { "X-Frappe-Site-Name": "mcp.localhost" }, signal: AbortSignal.timeout(2_000),
    });
    if (response.ok && (await response.json()).message === "pong") { ready = true; break; }
  } catch { /* Start-up only. Tool requests below never retry assertions. */ }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
assert.ok(ready, "Frappe did not become ready within 60 attempts");
const bundle = await build({ entryPoints: [root + "src/index.ts"], bundle: true, format: "esm", write: false,
  external: ["cloudflare:*", "node:*"], });
const adminToken = randomBytes(32).toString("hex");
let upstreamCalls = 0;
const documentUpdates = [];
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
  d1Databases: ["NEXWAVE_MCP_DB"], kvNamespaces: ["OAUTH_KV"],
  bindings: { ADMIN_TOKEN: adminToken, CONFIG_ENCRYPTION_KEY: randomBytes(32).toString("base64url") },
  // Test-only network bridge. Every payload comes from real Frappe; no canned responses.
  outboundService: async (request) => {
    const url = new URL(request.url);
    assert.ok(origins.has(url.origin), "Unexpected outbound origin");
    assert.ok(url.pathname.startsWith("/api/"), "Unexpected upstream path");
    assert.equal(request.headers.get("X-NexWave-Service-Token"), null);
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.set("X-Frappe-Site-Name", "mcp.localhost");
    upstreamCalls++;
    if (request.method === "PUT" && url.pathname.startsWith("/api/resource/")) documentUpdates.push(url.pathname);
    return fetch(new URL(url.pathname + url.search, backend), { method: request.method, headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      redirect: "manual", signal: AbortSignal.timeout(15_000) });
  },
}));

let checks = 0;
try {
  const db = await mf.getD1Database("NEXWAVE_MCP_DB");
  for (const file of (await readdir(root + "migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = await readFile(root + "migrations/" + file, "utf8");
    for (const statement of sql.split(";").filter((part) => part.trim())) await db.prepare(statement).run();
  }
  const tokens = {};
  for (const [origin, role] of origins) {
    const credentials = fixture.credentials[role];
    const response = await mf.dispatchFetch("https://gateway.example.invalid/api/admin/sites", {
      method: "POST", headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: `CI ${role}`, baseUrl: origin, authType: "api_token",
        apiKey: credentials.apiKey, apiSecret: credentials.apiSecret,
        writeCapabilities: role === "readonly" ? [] : role === "restricted" ? ["quotations"]
          : ["quotations", "leads", "customers", "sales_orders", "purchase_invoices", "submissions"] }),
    });
    assert.equal(response.status, 201, `Register valid ${role} API credentials`);
    const registered = await response.json();
    assert.equal(registered.apiUser, credentials.user);
    assert.equal(typeof registered.serviceToken, "string");
    tokens[role] = registered.serviceToken;
  }
  let requestId = 0;
  async function rpc(role, method, params) {
    const response = await mf.dispatchFetch("https://gateway.example.invalid/service/mcp", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        "X-NexWave-Service-Token": tokens[role] },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    });
    assert.equal(response.status, 200, `${method} HTTP status`);
    const text = await response.text();
    const body = JSON.parse(text.startsWith("event:") || text.startsWith("data:")
      ? text.split("\n").find((line) => line.startsWith("data: ")).slice(6) : text);
    assert.equal(body.error, undefined, `${method} protocol error`);
    return body.result;
  }
  const tools = (await rpc("all", "tools/list", {})).tools;
  assert.equal(tools.length, 52);
  const schemas = new Map(tools.map((tool) => [tool.name, z.fromJSONSchema(tool.outputSchema)]));
  for (const tool of ["list_work_orders", "list_boms", "list_job_cards", "list_item_prices", "list_price_lists",
    "list_leads", "list_prospects", "list_quotations", "list_tax_templates", "list_print_formats", "list_terms_and_conditions",
    "list_payment_terms_templates", "create_customer", "create_lead", "create_draft_quotation", "update_draft_quotation",
    "create_draft_sales_order", "update_draft_sales_order", "create_draft_purchase_invoice", "update_draft_purchase_invoice",
    "submit_document", "get_document_pdf"]) assert.ok(schemas.has(tool), `${tool} must be advertised`);
  assert.equal(schemas.has("preview_quotation"), false);
  async function call(role, name, args = {}, errorCode) {
    const result = await rpc(role, "tools/call", { name, arguments: args });
    if (errorCode) {
      assert.equal(result.isError, true, `${role} ${name} must fail`);
      assert.equal(JSON.parse(result.content[0].text).error.code, errorCode, `${role} ${name} failure code`);
    } else {
      assert.notEqual(result.isError, true, `${role} ${name}: ${result.content?.[0]?.text}`);
      assert.ok(schemas.get(name).safeParse(result.structuredContent).success, `${name} output contract`);
      const content = result.structuredContent;
      if (name.startsWith("list_") && content.records) {
        assert.deepEqual(JSON.parse(result.content[0].text), content.records, `${name} legacy rows`);
        const { records, ...metadata } = content;
        assert.deepEqual(JSON.parse(result.content[1].text), metadata, `${name} text metadata and warnings`);
      } else assert.deepEqual(JSON.parse(result.content[0].text), content, `${name} text/structured parity`);
    }
    checks++;
    return result.structuredContent;
  }
  // Direct fixture verification stays on the disposable loopback site and uses its
  // generated credentials. These reads confirm native effects outside tool allowlists.
  async function backendRequest(role, path, options = {}) {
    assert.ok(path.startsWith("/api/resource/"));
    const credentials = role === "workflow_admin" ? fixture.workflow_admin : fixture.credentials[role];
    const response = await fetch(new URL(path, backend), {
      method: options.method ?? "GET", headers: { "X-Frappe-Site-Name": "mcp.localhost",
        Authorization: `token ${credentials.apiKey}:${credentials.apiSecret}`, "Content-Type": "application/json" },
      body: options.body ? JSON.stringify(options.body) : undefined,
      redirect: "manual", signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, 200, `Disposable backend ${options.method ?? "GET"} ${path.split("?")[0]}`);
    return (await response.json()).data;
  }
  const company = "MCP Alpha";
  const dates = { from_date: "2025-01-01", to_date: "2025-01-31" };
  const invoiceArgs = { company, docstatus: 1, sort_by: "name", sort_order: "asc" };
  assert.equal((await call("restricted", "get_current_user")).user, fixture.credentials.restricted.user);
  assert.deepEqual((await call("restricted", "list_companies")).records.map((row) => row.name), [company]);
  assert.deepEqual(new Set((await call("all", "list_companies")).records.map((row) => row.name)), new Set([company, "MCP Hidden"]));

  // Four known submitted invoices. Follow the advertised offsets, including exact-full-page end detection.
  const ids = [];
  let offset = 0;
  do {
    const page = await call("restricted", "list_sales_invoices", { ...invoiceArgs, limit: 2, offset });
    ids.push(...page.records.map((row) => row.name));
    if (page.meta.next_offset !== null) {
      assert.equal(page.meta.complete, false);
      assert.ok(page.meta.warning);
      assert.ok(page.meta.next_offset > offset);
    }
    offset = page.meta.next_offset;
    assert.ok(ids.length <= 4, "No duplicate pages or hidden/draft invoices");
  } while (offset !== null);
  assert.deepEqual(ids, [fixture.sales, fixture.usd, fixture.future, fixture.credit].sort());
  assert.equal((await call("restricted", "list_sales_invoices", { summary: "count" })).count, 5);
  assert.equal((await call("all", "list_sales_invoices", { summary: "count" })).count, 6);
  assert.equal((await call("restricted", "list_sales_invoices", { company, docstatus: 0, summary: "count" })).count, 1);
  assert.equal((await call("restricted", "list_sales_invoices", { ...invoiceArgs, ...dates, summary: "count" })).count, 4);
  const totals = await call("restricted", "list_sales_invoices", { ...invoiceArgs, currency: "NZD", summary: "totals", limit: 1, offset: 99 });
  assert.equal(totals.count, 3);
  assert.equal(totals.totals.grand_total, 160); // 100 + 80 - 20; draft 900 excluded.
  assert.equal(totals.currency, "NZD");
  const usdTotals = await call("restricted", "list_sales_invoices", { ...invoiceArgs, currency: "USD", summary: "totals" });
  assert.equal(usdTotals.count, 1);
  assert.equal(usdTotals.totals.grand_total, 50);
  const ranked = await call("restricted", "list_sales_invoices", { company, unpaid_only: true, party_account_currency: "NZD", sort_by: "outstanding_amount", sort_order: "desc" });
  assert.deepEqual(ranked.records.map((row) => [row.name, row.outstanding_amount]), [[fixture.usd, 100], [fixture.future, 80], [fixture.sales, 70]]);
  assert.equal(ranked.ranking.currency, "NZD");
  const foreign = ranked.records[0];
  assert.equal(foreign.currency, "USD");
  assert.equal(foreign.party_account_currency, "NZD");
  assert.equal(foreign.grand_total, 50);
  assert.equal(foreign.base_grand_total, 100);
  const overdue = await call("restricted", "list_sales_invoices", { company, overdue_as_of: "2025-01-31" });
  assert.deepEqual(overdue.records.map((row) => row.name), [fixture.sales]);
  const empty = await call("restricted", "list_sales_invoices", { company, from_date: "2025-02-01", to_date: "2025-02-02" });
  assert.deepEqual(empty.records, []);
  assert.equal(empty.meta.complete, true);

  const document = await call("restricted", "get_document", { doctype: "Sales Invoice", name: fixture.sales, detail_limit: 1 });
  assert.deepEqual(document.items.map((row) => [row.item_code, row.qty, row.rate, row.amount]), [["MCP Service A", 2, 30, 60]]);
  assert.equal(document.detail_meta.items.next_offset, 1);
  assert.equal(document.detail_meta.items.complete, false);
  const detailPage = await call("restricted", "get_document", { doctype: "Sales Invoice", name: fixture.sales, detail_limit: 1, detail_offset: 1 });
  assert.deepEqual(detailPage.items.map((row) => [row.item_code, row.qty, row.rate, row.amount]), [["MCP Service B", 1, 40, 40]]);
  assert.equal(detailPage.detail_meta.items.next_offset, null);
  assert.ok(detailPage.detail_meta.items.warning);
  const payment = await call("restricted", "get_document", { doctype: "Payment Entry", name: fixture.received });
  assert.deepEqual(payment.references.map((row) => [row.reference_doctype, row.reference_name, row.allocated_amount]), [["Sales Invoice", fixture.sales, 30]]);
  assert.equal(payment.paid_from_account_currency, "NZD");
  const payments = await call("restricted", "list_payments", { company, summary: "totals" });
  assert.equal(payments.count, 2);
  assert.equal(payments.currency, "NZD");
  assert.deepEqual(payments.totals, { base_paid_amount: 40, base_received_amount: 40 });
  const purchases = await call("restricted", "list_purchase_invoices", { company, docstatus: 1, currency: "USD", summary: "totals" });
  assert.equal(purchases.count, 1);
  assert.equal(purchases.totals.grand_total, 25);

  const receivables = await call("restricted", "get_accounts_receivable", { company, report_date: "2025-01-31" });
  const receivableRows = receivables.rows.filter((row) => row.voucher_no);
  assert.equal(receivableRows.length, 4);
  assert.equal(receivableRows.reduce((sum, row) => sum + row.outstanding, 0), 230);
  const ageing = await call("restricted", "get_accounts_receivable_summary", { company, report_date: "2025-01-31" });
  assert.equal(ageing.totals.outstanding, 230);
  assert.equal(ageing.totals.overdue, 70);
  assert.equal(ageing.overdue_complete, true);
  assert.equal(ageing.invoice_count, 4);
  assert.equal(ageing.customer_count, 3);
  const balance = await call("restricted", "get_party_balance", { company, party_type: "Customer", party_id: "MCP Buyer", report_date: "2025-01-31" });
  assert.equal(balance.currency, "NZD");
  assert.equal(balance.totals.outstanding, 170); // NZD 70 + USD 50 at 2 NZD/USD.
  assert.equal(balance.totals.overdue, 70); // USD invoice is due today.
  assert.equal(balance.overdue_complete, true);
  const creditBalance = await call("restricted", "get_party_balance", { company, party_type: "Customer", party_id: "MCP Credit", report_date: "2025-01-31" });
  assert.equal(creditBalance.totals.outstanding, -20);
  assert.equal(creditBalance.totals.credit_balance, 20);
  const payable = await call("restricted", "get_accounts_payable_summary", { company, report_date: "2025-01-31" });
  assert.equal(payable.currency, "NZD");
  assert.equal(payable.totals.outstanding, 100);
  assert.equal(payable.totals.overdue, 50);
  const sales = await call("restricted", "get_sales_summary", { company, ...dates, group_by: "item", limit: 1 });
  assert.equal(sales.currency, "NZD");
  assert.equal(sales.total_net_sales, 260);
  assert.equal(sales.truncated, true);
  assert.equal(sales.totals_complete, true);
  assert.deepEqual(sales.groups.map((row) => [row.name, row.net_sales]), [["MCP Service A", 220]]);

  const ledgerArgs = { company, ...dates, accounts: [fixture.receivable], group_by: "voucher" };
  const ledger = await call("restricted", "get_general_ledger", ledgerArgs);
  const entries = ledger.rows.filter((row) => typeof row.voucher_no === "string" && row.voucher_no);
  assert.equal(entries.reduce((sum, row) => sum + row.debit - row.credit, 0), 230);
  assert.deepEqual(new Set(entries.map((row) => row.voucher_no)), new Set([fixture.sales, fixture.usd, fixture.future, fixture.credit, fixture.received]));
  const ledgerPage = await call("restricted", "get_general_ledger", { ...ledgerArgs, limit: 2 });
  assert.equal(ledgerPage.row_count, ledger.row_count);
  assert.equal(ledgerPage.complete, false);
  assert.ok(ledgerPage.warning);
  assert.equal(ledgerPage.next_offset, 2);
  const continued = await call("restricted", "get_general_ledger", { ...ledgerArgs, offset: 2 });
  assert.deepEqual([...ledgerPage.rows, ...continued.rows], ledger.rows);

  // Positive control proves the hidden fixture exists, then exercise the same ID with restricted credentials.
  assert.equal((await call("all", "get_document", { doctype: "Sales Invoice", name: fixture.hidden })).grand_total, 777);
  assert.equal((await call("restricted", "list_sales_invoices", { company: "MCP Hidden", summary: "count" })).count, 0);
  const hiddenTotals = await call("restricted", "list_sales_invoices", { company: "MCP Hidden", currency: "NZD", summary: "totals" });
  assert.equal(hiddenTotals.count, 0);
  assert.equal(hiddenTotals.totals.grand_total, 0);
  await call("restricted", "get_document", { doctype: "Sales Invoice", name: fixture.hidden }, "PERMISSION_DENIED");
  const hiddenLedgerArgs = { company: "MCP Hidden", ...dates };
  const visibleHiddenLedger = await call("all", "get_general_ledger", hiddenLedgerArgs);
  assert.ok(visibleHiddenLedger.rows.some((row) => row.voucher_no === fixture.hidden));
  const hiddenLedger = await call("restricted", "get_general_ledger", hiddenLedgerArgs);
  // ERPNext returns Opening/Total/Closing rows even when permissions hide all entries.
  assert.equal(hiddenLedger.rows.length, 3);
  for (const row of hiddenLedger.rows) {
    assert.ok(!row.voucher_no, "No hidden-company vouchers");
    assert.deepEqual([row.debit, row.credit, row.balance], [0, 0, 0], "No hidden-company totals");
  }
  assert.equal((await call("denied", "get_current_user")).user, fixture.credentials.denied.user);
  await call("denied", "list_sales_invoices", {}, "PERMISSION_DENIED");
  await call("denied", "list_sales_invoices", { summary: "count" }, "PERMISSION_DENIED");
  await call("denied", "list_sales_invoices", { company, currency: "NZD", summary: "totals" }, "PERMISSION_DENIED");
  await call("denied", "get_document", { doctype: "Sales Invoice", name: fixture.sales }, "PERMISSION_DENIED");
  await call("denied", "get_general_ledger", { company, ...dates }, "PERMISSION_DENIED");

  // Read-only pricing and quotation setup use the actual v15 master records and permissions.
  const lists = await call("all", "list_price_lists", { buying: true, selling: true, currency: "NZD" });
  assert.ok(lists.records.some((row) => row.name === "MCP NZD" && row.buying === 1 && row.selling === 1));
  const prices = await call("all", "list_item_prices", { item_code: fixture.quote_items[0], price_list: "MCP NZD", valid_on: "2025-01-15" });
  assert.deepEqual(new Set(prices.records.map((row) => row.name)), new Set([fixture.quote_prices[0], fixture.customer_price, fixture.supplier_price]));
  const openDates = await call("all", "list_item_prices", { item_code: fixture.quote_items[1], price_list: "MCP NZD", valid_on: "2025-01-15" });
  assert.deepEqual(openDates.records.map((row) => row.name), [fixture.quote_prices[1]], "Unset start and end dates remain valid");
  const customerPrices = await call("all", "list_item_prices", { item_code: fixture.quote_items[0], price_list: "MCP NZD", customer: "MCP Buyer", selling: true, valid_on: "2025-01-15" });
  assert.deepEqual(customerPrices.records.map((row) => [row.name, row.price_list_rate]), [[fixture.customer_price, 20]]);
  const supplierPrices = await call("all", "list_item_prices", { item_code: fixture.quote_items[0], price_list: "MCP NZD", supplier: "MCP Supplier", buying: true });
  assert.deepEqual(supplierPrices.records.map((row) => [row.name, row.price_list_rate]), [[fixture.supplier_price, 10]]);
  const expiredPrices = await call("all", "list_item_prices", { item_code: fixture.quote_items[0], price_list: "MCP USD", valid_on: "2025-01-15" });
  assert.deepEqual(expiredPrices.records.map((row) => [row.name, row.price_list_rate]), [[fixture.usd_quote_prices[0], 12]]);
  assert.ok(expiredPrices.records.every((row) => row.name !== fixture.expired_price), "Expired prices remain excluded beside current prices");
  const leads = await call("all", "list_leads", { email_id: "mcp-seed-prospect@example.invalid" });
  assert.deepEqual(leads.records.map((row) => row.name), [fixture.lead]);
  const taxTemplates = await call("all", "list_tax_templates", { type: "Sales", company });
  assert.ok(taxTemplates.records.some((row) => row.name === fixture.sales_tax));
  assert.ok(taxTemplates.records.some((row) => row.name === fixture.alternate_sales_tax));
  const purchaseTaxTemplates = await call("all", "list_tax_templates", { type: "Purchase", company });
  assert.ok(purchaseTaxTemplates.records.some((row) => row.name === fixture.purchase_tax));
  const taxDetail = await call("all", "get_document", { doctype: "Sales Taxes and Charges Template", name: fixture.sales_tax });
  assert.deepEqual(taxDetail.taxes.map((row) => [row.charge_type, row.rate]), [["On Net Total", 15]]);
  assert.ok((await call("all", "list_terms_and_conditions", { selling: true })).records.some((row) => row.name === fixture.terms));
  assert.ok((await call("all", "list_payment_terms_templates")).records.some((row) => row.name === fixture.payment_terms));
  const printFormats = await call("all", "list_print_formats", { doctype: "Quotation" });
  assert.equal(printFormats.default_format, "Standard");

  const createCustomer = { request_key: "live-customer-create-0001", customer_name: "MCP Mobile Customer",
    customer_group: "Commercial", territory: "New Zealand", default_currency: "NZD", default_price_list: "MCP NZD",
    email_id: "mcp-mobile-customer@example.invalid", first_name: "MCP", last_name: "Mobile Buyer" };
  const beforeDeniedWrite = upstreamCalls;
  await call("readonly", "create_customer", createCustomer, "PERMISSION_DENIED");
  await call("restricted", "create_customer", createCustomer, "PERMISSION_DENIED");
  assert.equal(upstreamCalls, beforeDeniedWrite, "Read-only and quotation-only capabilities must block customer writes before Frappe");
  // This connection is opted in at the gateway but its ERP user has no business-record permissions.
  await call("denied", "create_customer", createCustomer, "PERMISSION_DENIED");
  const customerCreated = await call("all", "create_customer", createCustomer);
  assert.equal(customerCreated.document.customer_name, createCustomer.customer_name);
  assert.equal(customerCreated.replayed, false);
  const customerReplay = await call("all", "create_customer", createCustomer);
  assert.equal(customerReplay.name, customerCreated.name);
  assert.equal(customerReplay.replayed, true);
  const customerContact = await call("all", "get_document", { doctype: "Customer", name: customerCreated.name });
  assert.equal(customerContact.email_id, createCustomer.email_id);
  assert.equal(typeof customerContact.customer_primary_contact, "string");
  assert.ok(customerContact.customer_primary_contact.length > 0, "Customer creation uses the native primary Contact hook");
  await call("all", "create_customer", { ...createCustomer, request_key: "live-customer-duplicate-0002" }, "CONFLICT");
  const createdCustomers = await call("all", "list_customers", { search: createCustomer.customer_name, search_mode: "literal" });
  assert.deepEqual(createdCustomers.records.map((row) => row.name), [customerCreated.name]);

  const conversionArgs = { request_key: "live-customer-conversion-0001", customer_name: "MCP Converted Customer",
    customer_group: "Commercial", territory: "New Zealand", lead_name: fixture.conversion_lead };
  const prospects = await call("all", "list_prospects", { search: "MCP Conversion Prospect", search_mode: "literal" });
  assert.deepEqual(prospects.records.map((row) => row.name), [fixture.conversion_prospect]);
  const sourceProspect = await call("all", "get_document", { doctype: "Prospect", name: fixture.conversion_prospect });
  assert.equal(sourceProspect.company_name, "MCP Conversion Prospect");
  assert.ok(sourceProspect.leads.some((row) => row.lead === fixture.conversion_lead));
  await call("all", "create_customer", { ...conversionArgs, request_key: "live-customer-source-mismatch",
    prospect_name: fixture.prospect_only }, "INVALID_ARGUMENT");
  await call("all", "create_customer", { ...conversionArgs, request_key: "live-customer-ambiguous-source",
    lead_name: fixture.ambiguous_lead }, "CONFLICT");
  await call("crm_restricted", "create_customer", { ...conversionArgs, request_key: "live-customer-inaccessible-source",
    lead_name: fixture.hidden_lead }, "PERMISSION_DENIED");
  const convertedCustomer = await call("all", "create_customer", conversionArgs);
  assert.equal(convertedCustomer.document.lead_name, fixture.conversion_lead);
  assert.equal(convertedCustomer.document.prospect_name, fixture.conversion_prospect,
    "A unique Prospect must be derived from the selected Lead's native membership");
  const savedConvertedCustomer = await call("all", "get_document", { doctype: "Customer", name: convertedCustomer.name });
  assert.equal(savedConvertedCustomer.lead_name, fixture.conversion_lead);
  assert.equal(savedConvertedCustomer.prospect_name, fixture.conversion_prospect);
  const convertedLead = await call("all", "get_document", { doctype: "Lead", name: fixture.conversion_lead });
  assert.equal(convertedLead.status, "Converted", "The normal Customer hook must convert its source Lead");
  for (const [doctype, name] of [["Contact", fixture.conversion_contact], ["Address", fixture.conversion_address]]) {
    const source = await backendRequest("all", `/api/resource/${doctype}/${encodeURIComponent(name)}`);
    assert.ok(source.links.some((row) => row.link_doctype === "Lead" && row.link_name === fixture.conversion_lead));
    assert.ok(source.links.some((row) => row.link_doctype === "Prospect" && row.link_name === fixture.conversion_prospect));
    assert.equal(source.links.filter((row) => row.link_doctype === "Customer" && row.link_name === convertedCustomer.name).length, 1,
      `Native ${doctype} conversion retains the Lead/Prospect links and adds one Customer link`);
  }
  assert.equal((await call("all", "create_customer", conversionArgs)).replayed, true);
  await call("all", "create_customer", { ...conversionArgs, request_key: "live-customer-converted-lead-duplicate",
    customer_name: "MCP Duplicate Conversion" }, "CONFLICT");
  const prospectCustomer = await call("all", "create_customer", { request_key: "live-customer-prospect-only",
    customer_name: "MCP Prospect Only Customer", customer_group: "Commercial", territory: "New Zealand",
    prospect_name: fixture.prospect_only });
  assert.equal(prospectCustomer.document.prospect_name, fixture.prospect_only);
  assert.ok(!prospectCustomer.document.lead_name, "A Prospect link must not silently choose a Lead to convert");
  assert.equal((await call("all", "get_document", { doctype: "Lead", name: fixture.prospect_only_lead })).status, "Lead");

  const createLead = { request_key: "live-lead-create-0001", first_name: "MCP", last_name: "Mobile Prospect",
    company_name: "MCP New Prospect Company", email_id: "mcp-mobile-prospect@example.invalid", territory: "New Zealand" };
  const leadCreated = await call("all", "create_lead", createLead);
  assert.equal(leadCreated.document.email_id, createLead.email_id);
  assert.equal((await call("all", "create_lead", createLead)).name, leadCreated.name);
  await call("all", "create_lead", { ...createLead, request_key: "live-lead-duplicate-0002" }, "CONFLICT");

  const quoteArgs = { request_key: "live-quote-customer-0001", company, quotation_to: "Customer", party_name: customerCreated.name,
    transaction_date: "2025-01-15", valid_till: "2025-02-15", selling_price_list: "MCP NZD", currency: "NZD",
    taxes_and_charges: fixture.sales_tax, payment_terms_template: fixture.payment_terms, tc_name: fixture.terms,
    items: [{ item_code: fixture.quote_items[0], qty: 2, uom: "Nos" }, { item_code: fixture.quote_items[1], qty: 1, uom: "Nos" }] };
  const readonlyCalls = upstreamCalls;
  await call("readonly", "create_draft_quotation", quoteArgs, "PERMISSION_DENIED");
  assert.equal(upstreamCalls, readonlyCalls, "Read-only quotation writes must not reach Frappe");
  const quote = await call("all", "create_draft_quotation", quoteArgs);
  assert.equal(quote.document.docstatus, 0);
  assert.equal(quote.document.quotation_to, "Customer");
  assert.equal(quote.document.party_name, customerCreated.name);
  assert.deepEqual(quote.document.items.map((row) => [row.item_code, row.qty, row.rate, row.amount]), [
    [fixture.quote_items[0], 2, 25, 50], [fixture.quote_items[1], 1, 40, 40],
  ], "Omitted rates must be fetched by real v15 quotation validation");
  assert.equal(quote.document.net_total, 90);
  assert.equal(quote.document.total_taxes_and_charges, 13.5);
  assert.equal(quote.document.grand_total, 103.5);
  assert.equal(quote.document.taxes_and_charges, fixture.sales_tax);
  assert.equal(quote.document.payment_terms_template, fixture.payment_terms);
  const quoteReplay = await call("all", "create_draft_quotation", quoteArgs);
  assert.equal(quoteReplay.name, quote.name);
  assert.equal(quoteReplay.replayed, true);
  await call("all", "create_draft_quotation", { ...quoteArgs, valid_till: "2025-03-01" }, "CONFLICT");
  const savedQuote = await call("all", "get_document", { doctype: "Quotation", name: quote.name });
  assert.equal(typeof savedQuote.modified, "string");
  assert.deepEqual(savedQuote.items.map((row) => row.rate), [25, 40]);
  assert.equal(savedQuote.tc_name, fixture.terms);
  assert.ok(!savedQuote.terms, "Terms are rendered by NexWave at print time");
  const updateArgs = { request_key: "live-quote-update-0001", name: quote.name, expected_modified: savedQuote.modified,
    items: [{ item_code: fixture.quote_items[0], qty: 4, uom: "Nos" }, { item_code: fixture.quote_items[1], qty: 1, uom: "Nos" }] };
  const updatedQuote = await call("all", "update_draft_quotation", updateArgs);
  assert.equal(updatedQuote.name, quote.name);
  assert.equal(updatedQuote.document.docstatus, 0);
  assert.equal(updatedQuote.document.net_total, 140);
  assert.equal(updatedQuote.document.total_taxes_and_charges, 21);
  assert.equal(updatedQuote.document.grand_total, 161);
  assert.equal((await call("all", "update_draft_quotation", updateArgs)).replayed, true);
  await call("all", "update_draft_quotation", { request_key: "live-quote-stale-0002", name: quote.name,
    expected_modified: savedQuote.modified, valid_till: "2025-03-01" }, "CONFLICT");
  const currentQuote = await call("all", "get_document", { doctype: "Quotation", name: quote.name });
  await call("all", "update_draft_quotation", { request_key: "live-quote-price-context-0003", name: quote.name,
    expected_modified: currentQuote.modified, transaction_date: "2025-01-16" }, "INVALID_ARGUMENT");
  const changedDate = await call("all", "update_draft_quotation", { request_key: "live-quote-price-context-0004", name: quote.name,
    expected_modified: currentQuote.modified, transaction_date: "2025-01-16", items: updateArgs.items });
  assert.equal(changedDate.document.grand_total, 161);
  const beforeTaxChange = await call("all", "get_document", { doctype: "Quotation", name: quote.name });
  const changedTax = await call("all", "update_draft_quotation", { request_key: "live-quote-tax-change-0005", name: quote.name,
    expected_modified: beforeTaxChange.modified, taxes_and_charges: fixture.alternate_sales_tax });
  assert.equal(changedTax.document.taxes_and_charges, fixture.alternate_sales_tax);
  assert.deepEqual(changedTax.document.taxes.map((row) => row.rate), [5], "A replacement template must replace old rows");
  assert.equal(changedTax.document.net_total, 140);
  assert.equal(changedTax.document.total_taxes_and_charges, 7);
  assert.equal(changedTax.document.grand_total, 147);
  const beforeCurrencyChange = await call("all", "get_document", { doctype: "Quotation", name: quote.name });
  const usdQuote = await call("all", "update_draft_quotation", { request_key: "live-quote-currency-change-0006", name: quote.name,
    expected_modified: beforeCurrencyChange.modified, currency: "USD", selling_price_list: "MCP USD", items: updateArgs.items });
  assert.equal(usdQuote.document.currency, "USD");
  assert.equal(usdQuote.document.conversion_rate, 2, "A currency change must replace the old NZD conversion rate");
  assert.deepEqual(usdQuote.document.items.map((row) => [row.item_code, row.rate, row.amount]), [
    [fixture.quote_items[0], 12, 48], [fixture.quote_items[1], 18, 18],
  ]);
  assert.equal(usdQuote.document.net_total, 66);
  assert.equal(usdQuote.document.total_taxes_and_charges, 3.3);
  assert.equal(usdQuote.document.grand_total, 69.3);
  const discountedQuote = await call("all", "create_draft_quotation", { request_key: "live-quote-pricing-rule-0007", company,
    quotation_to: "Customer", party_name: "MCP Future", transaction_date: "2025-01-15", valid_till: "2025-02-15",
    selling_price_list: "MCP NZD", currency: "NZD", taxes_and_charges: fixture.sales_tax,
    items: [{ item_code: fixture.quote_items[0], qty: 10, uom: "Nos" }] });
  assert.equal(discountedQuote.document.items[0].price_list_rate, 25);
  assert.equal(discountedQuote.document.items[0].discount_percentage, 10);
  assert.equal(discountedQuote.document.items[0].rate, 22.5, "v15 must apply its quantity Pricing Rule when saving");
  assert.equal(discountedQuote.document.net_total, 225);
  assert.equal(discountedQuote.document.total_taxes_and_charges, 33.75);
  assert.equal(discountedQuote.document.grand_total, 258.75);
  const leadQuote = await call("restricted", "create_draft_quotation", { request_key: "live-quote-lead-0001", company,
    quotation_to: "Lead", party_name: leadCreated.name, transaction_date: "2025-01-15", valid_till: "2025-02-15",
    selling_price_list: "MCP NZD", currency: "NZD", taxes_and_charges: fixture.sales_tax,
    items: [{ item_code: fixture.quote_items[0], qty: 3, uom: "Nos" }] });
  assert.equal(leadQuote.document.quotation_to, "Lead");
  assert.equal(leadQuote.document.party_name, leadCreated.name);
  assert.equal(leadQuote.document.items[0].rate, 25);
  assert.equal(leadQuote.document.grand_total, 86.25);
  assert.deepEqual((await call("all", "list_quotations", { company, quotation_to: "Customer", party_name: customerCreated.name, docstatus: 0 })).records.map((row) => row.name), [quote.name]);
  assert.deepEqual((await call("restricted", "list_quotations", { company, quotation_to: "Lead", party_name: leadCreated.name, docstatus: 0 })).records.map((row) => row.name), [leadQuote.name]);
  const recipientQuote = await call("all", "create_draft_quotation", { ...quoteArgs, request_key: "live-quote-recipient-create", party_name: "MCP Future",
    contact_person: fixture.quote_contacts[1], customer_address: fixture.quote_addresses[1], shipping_address_name: fixture.quote_addresses[1] });
  assert.equal(recipientQuote.document.contact_person, fixture.quote_contacts[1]);
  assert.equal(recipientQuote.document.contact_email, "", "A selected contact without email cannot borrow the default contact's email");
  assert.match(recipientQuote.document.contact_display, /Alternate/);
  assert.match(recipientQuote.document.address_display, /2 Synthetic Street/);
  assert.match(recipientQuote.document.shipping_address, /2 Synthetic Street/);
  const primaryRecipient = await call("all", "update_draft_quotation", { request_key: "live-quote-recipient-primary", name: recipientQuote.name,
    expected_modified: recipientQuote.document.modified, contact_person: fixture.quote_contacts[0],
    customer_address: fixture.quote_addresses[0], shipping_address_name: fixture.quote_addresses[0] });
  assert.equal(primaryRecipient.document.contact_email, "mcp-primary@example.invalid");
  assert.match(primaryRecipient.document.address_display, /1 Synthetic Street/);
  assert.match(primaryRecipient.document.shipping_address, /1 Synthetic Street/);
  const alternateRecipient = await call("all", "update_draft_quotation", { request_key: "live-quote-recipient-alternate", name: recipientQuote.name,
    expected_modified: primaryRecipient.document.modified, contact_person: fixture.quote_contacts[1],
    customer_address: fixture.quote_addresses[1], shipping_address_name: fixture.quote_addresses[1] });
  assert.equal(alternateRecipient.document.contact_email, "");
  assert.match(alternateRecipient.document.contact_display, /Alternate/);
  assert.match(alternateRecipient.document.address_display, /2 Synthetic Street/);
  assert.match(alternateRecipient.document.shipping_address, /2 Synthetic Street/);

  const sourceQuote = await call("all", "get_document", { doctype: "Quotation", name: fixture.source_quotation });
  assert.equal(sourceQuote.docstatus, 1);
  assert.deepEqual(sourceQuote.items.map((row) => row.item_code), [fixture.quote_items[1], fixture.quote_items[1]]);
  assert.deepEqual(sourceQuote.items.map((row) => row.name), fixture.source_quotation_rows);
  const salesOrderArgs = { request_key: "live-sales-order-linked-create", company, customer: "MCP Buyer",
    transaction_date: "2025-01-15", delivery_date: "2025-01-20", currency: "NZD", selling_price_list: "MCP NZD",
    items: [{ item_code: fixture.quote_items[1], qty: 3, uom: "Nos",
      prevdoc_docname: sourceQuote.name, quotation_item: sourceQuote.items[1].name }] };
  const beforeOrderDenied = upstreamCalls;
  await call("readonly", "create_draft_sales_order", salesOrderArgs, "PERMISSION_DENIED");
  await call("restricted", "create_draft_sales_order", salesOrderArgs, "PERMISSION_DENIED");
  assert.equal(upstreamCalls, beforeOrderDenied, "Quotation permission alone cannot create a Sales Order");
  await call("denied", "create_draft_sales_order", salesOrderArgs, "PERMISSION_DENIED");
  const salesOrder = await call("all", "create_draft_sales_order", salesOrderArgs);
  assert.equal(salesOrder.document.docstatus, 0);
  assert.equal(salesOrder.document.additional_discount_percentage, 10);
  assert.equal(salesOrder.document.grand_total, 121.5, "Partial quotation conversion must retain its percentage document discount");
  assert.deepEqual(salesOrder.document.items.map((row) => [row.qty, row.prevdoc_docname, row.quotation_item]), [
    [3, sourceQuote.name, sourceQuote.items[1].name],
  ], "A partial order must reference the selected duplicate source row");
  assert.equal((await call("all", "create_draft_sales_order", salesOrderArgs)).replayed, true);
  const savedSalesOrder = await call("all", "get_document", { doctype: "Sales Order", name: salesOrder.name });
  assert.equal(savedSalesOrder.items[0].quotation_item, sourceQuote.items[1].name);
  const salesOrderUpdate = { request_key: "live-sales-order-linked-update", name: salesOrder.name,
    expected_modified: savedSalesOrder.modified,
    items: [{ name: savedSalesOrder.items[0].name, item_code: fixture.quote_items[1], qty: 4 }] };
  await call("readonly", "update_draft_sales_order", salesOrderUpdate, "PERMISSION_DENIED");
  const updatedSalesOrder = await call("all", "update_draft_sales_order", salesOrderUpdate);
  assert.equal(updatedSalesOrder.document.additional_discount_percentage, 10);
  assert.equal(updatedSalesOrder.document.grand_total, 162);
  assert.deepEqual(updatedSalesOrder.document.items.map((row) => [row.name, row.qty, row.prevdoc_docname, row.quotation_item]), [
    [savedSalesOrder.items[0].name, 4, sourceQuote.name, sourceQuote.items[1].name],
  ], "A quantity update must preserve the target child name and omitted source references");
  assert.equal((await call("all", "update_draft_sales_order", salesOrderUpdate)).replayed, true);
  await call("all", "update_draft_sales_order", { ...salesOrderUpdate, request_key: "live-sales-order-stale-update" }, "CONFLICT");
  const currentSalesOrder = await call("all", "get_document", { doctype: "Sales Order", name: salesOrder.name });
  assert.deepEqual(currentSalesOrder.items.map((row) => [row.name, row.prevdoc_docname, row.quotation_item]), [
    [savedSalesOrder.items[0].name, sourceQuote.name, sourceQuote.items[1].name],
  ]);
  await call("all", "update_draft_sales_order", { request_key: "live-sales-order-relink-rejected", name: salesOrder.name,
    expected_modified: currentSalesOrder.modified, items: [{ name: currentSalesOrder.items[0].name,
      item_code: fixture.quote_items[1], qty: 4, prevdoc_docname: sourceQuote.name, quotation_item: sourceQuote.items[0].name }] }, "INVALID_ARGUMENT");
  const standaloneSalesOrder = await call("all", "create_draft_sales_order", {
    request_key: "live-sales-order-standalone-create", company, customer: "MCP Future",
    transaction_date: "2025-01-15", delivery_date: "2025-01-20", currency: "NZD", selling_price_list: "MCP NZD",
    items: [{ item_code: fixture.quote_items[1], qty: 1, uom: "Nos", rate: 40 }] });
  assert.equal(standaloneSalesOrder.document.docstatus, 0);
  assert.ok(!standaloneSalesOrder.document.items[0].quotation_item);

  const sourcePurchaseOrder = await call("all", "get_document", { doctype: "Purchase Order", name: fixture.source_purchase_order });
  assert.equal(sourcePurchaseOrder.docstatus, 1);
  assert.deepEqual(sourcePurchaseOrder.items.map((row) => row.item_code), [fixture.quote_items[1], fixture.quote_items[1]]);
  assert.deepEqual(sourcePurchaseOrder.items.map((row) => row.name), fixture.source_purchase_order_rows);
  const purchaseInvoiceArgs = { request_key: "live-purchase-invoice-linked-create", company, supplier: "MCP Supplier",
    posting_date: "2025-01-15", due_date: "2025-01-31", bill_no: "MCP-SUPPLIER-BILL-001", bill_date: "2025-01-12",
    currency: "NZD", buying_price_list: "MCP NZD",
    items: [{ item_code: fixture.quote_items[1], qty: 2, uom: "Nos",
      purchase_order: sourcePurchaseOrder.name, po_detail: sourcePurchaseOrder.items[1].name }] };
  const beforeInvoiceDenied = upstreamCalls;
  await call("readonly", "create_draft_purchase_invoice", purchaseInvoiceArgs, "PERMISSION_DENIED");
  await call("restricted", "create_draft_purchase_invoice", purchaseInvoiceArgs, "PERMISSION_DENIED");
  assert.equal(upstreamCalls, beforeInvoiceDenied, "Quotation permission alone cannot create a Purchase Invoice");
  await call("denied", "create_draft_purchase_invoice", purchaseInvoiceArgs, "PERMISSION_DENIED");
  const purchaseInvoice = await call("all", "create_draft_purchase_invoice", purchaseInvoiceArgs);
  assert.equal(purchaseInvoice.document.docstatus, 0);
  assert.equal(purchaseInvoice.document.additional_discount_percentage, 10);
  assert.equal(purchaseInvoice.document.grand_total, 39.6, "Partial PO conversion must retain its percentage document discount");
  assert.equal(purchaseInvoice.document.bill_no, purchaseInvoiceArgs.bill_no);
  assert.equal(purchaseInvoice.document.bill_date, purchaseInvoiceArgs.bill_date);
  assert.deepEqual(purchaseInvoice.document.items.map((row) => [row.qty, row.purchase_order, row.po_detail]), [
    [2, sourcePurchaseOrder.name, sourcePurchaseOrder.items[1].name],
  ], "A partial bill must reference the selected duplicate PO row");
  assert.equal((await call("all", "create_draft_purchase_invoice", purchaseInvoiceArgs)).replayed, true);
  const savedPurchaseInvoice = await call("all", "get_document", { doctype: "Purchase Invoice", name: purchaseInvoice.name });
  assert.equal(savedPurchaseInvoice.items[0].po_detail, sourcePurchaseOrder.items[1].name);
  const purchaseInvoiceUpdate = { request_key: "live-purchase-invoice-linked-update", name: purchaseInvoice.name,
    expected_modified: savedPurchaseInvoice.modified,
    items: [{ name: savedPurchaseInvoice.items[0].name, item_code: fixture.quote_items[1], qty: 3 }] };
  await call("readonly", "update_draft_purchase_invoice", purchaseInvoiceUpdate, "PERMISSION_DENIED");
  const updatedPurchaseInvoice = await call("all", "update_draft_purchase_invoice", purchaseInvoiceUpdate);
  assert.equal(updatedPurchaseInvoice.document.additional_discount_percentage, 10);
  assert.equal(updatedPurchaseInvoice.document.grand_total, 59.4);
  assert.deepEqual(updatedPurchaseInvoice.document.items.map((row) => [row.name, row.qty, row.purchase_order, row.po_detail]), [
    [savedPurchaseInvoice.items[0].name, 3, sourcePurchaseOrder.name, sourcePurchaseOrder.items[1].name],
  ], "A bill quantity update must preserve the target child name and omitted source references");
  assert.equal((await call("all", "update_draft_purchase_invoice", purchaseInvoiceUpdate)).replayed, true);
  await call("all", "update_draft_purchase_invoice", { ...purchaseInvoiceUpdate, request_key: "live-purchase-invoice-stale-update" }, "CONFLICT");
  const currentPurchaseInvoice = await call("all", "get_document", { doctype: "Purchase Invoice", name: purchaseInvoice.name });
  assert.deepEqual(currentPurchaseInvoice.items.map((row) => [row.name, row.purchase_order, row.po_detail]), [
    [savedPurchaseInvoice.items[0].name, sourcePurchaseOrder.name, sourcePurchaseOrder.items[1].name],
  ]);
  await call("all", "update_draft_purchase_invoice", { request_key: "live-purchase-invoice-relink-rejected", name: purchaseInvoice.name,
    expected_modified: currentPurchaseInvoice.modified, items: [{ name: currentPurchaseInvoice.items[0].name,
      item_code: fixture.quote_items[1], qty: 3, purchase_order: sourcePurchaseOrder.name, po_detail: sourcePurchaseOrder.items[0].name }] }, "INVALID_ARGUMENT");
  const standalonePurchaseInvoice = await call("all", "create_draft_purchase_invoice", {
    request_key: "live-purchase-invoice-standalone-create", company, supplier: "MCP Supplier",
    posting_date: "2025-01-15", due_date: "2025-01-31", bill_no: "MCP-SUPPLIER-BILL-002", bill_date: "2025-01-12",
    currency: "NZD", buying_price_list: "MCP NZD",
    items: [{ item_code: fixture.quote_items[1], qty: 1, uom: "Nos", rate: 22 }] });
  assert.equal(standalonePurchaseInvoice.document.docstatus, 0);
  assert.ok(!standalonePurchaseInvoice.document.items[0].po_detail);

  // Submit only after the fixed balance and report assertions above. Native accounting
  // effects are verified by voucher so they cannot change unrelated report fixtures.
  const submitArgs = (doctype, doc, request_key) => ({ doctype, name: doc.name,
    expected_modified: doc.modified, request_key, confirm_submission: true });
  const quoteBeforeSubmit = await call("all", "get_document", { doctype: "Quotation", name: quote.name });
  const quoteSubmission = submitArgs("Quotation", quoteBeforeSubmit, "live-submit-quotation-0001");
  const deniedSubmissionCalls = upstreamCalls;
  await call("readonly", "submit_document", quoteSubmission, "PERMISSION_DENIED");
  await call("restricted", "submit_document", quoteSubmission, "PERMISSION_DENIED");
  assert.equal(upstreamCalls, deniedSubmissionCalls, "The separate submissions capability must gate native calls");
  await call("nosubmit", "submit_document", { ...quoteSubmission, request_key: "live-submit-native-denied" }, "PERMISSION_DENIED");
  assert.equal((await call("all", "get_document", { doctype: "Quotation", name: quote.name })).docstatus, 0,
    "A Frappe user with read/write but no submit permission must leave the draft unchanged");
  await call("all", "submit_document", { ...quoteSubmission, request_key: "live-submit-stale-quotation",
    expected_modified: savedQuote.modified }, "CONFLICT");
  const quoteSubmitPath = `/api/resource/Quotation/${encodeURIComponent(quote.name)}`;
  const quoteWritesBefore = documentUpdates.filter((path) => path === quoteSubmitPath).length;
  const submittedQuote = await call("all", "submit_document", quoteSubmission);
  assert.equal(submittedQuote.document.docstatus, 1);
  assert.equal(submittedQuote.document.grand_total, quoteBeforeSubmit.grand_total);
  assert.deepEqual(submittedQuote.document.items.map((row) => [row.name, row.item_code, row.qty]),
    quoteBeforeSubmit.items.map((row) => [row.name, row.item_code, row.qty]));
  assert.equal((await call("all", "submit_document", quoteSubmission)).replayed, true);
  assert.equal(documentUpdates.filter((path) => path === quoteSubmitPath).length, quoteWritesBefore + 1,
    "A completed submission replay must never send a second PUT");

  const orderBeforeSubmit = await call("all", "get_document", { doctype: "Sales Order", name: salesOrder.name });
  const submittedOrder = await call("all", "submit_document", submitArgs("Sales Order", orderBeforeSubmit, "live-submit-sales-order-0001"));
  assert.equal(submittedOrder.document.docstatus, 1);
  assert.deepEqual(submittedOrder.document.items.map((row) => [row.name, row.qty, row.prevdoc_docname, row.quotation_item]),
    orderBeforeSubmit.items.map((row) => [row.name, row.qty, row.prevdoc_docname, row.quotation_item]),
    "Submitting a Sales Order must retain the exact quoted source line");
  const invoiceBeforeSubmit = await call("all", "get_document", { doctype: "Purchase Invoice", name: purchaseInvoice.name });
  const submittedInvoice = await call("all", "submit_document", submitArgs("Purchase Invoice", invoiceBeforeSubmit, "live-submit-purchase-invoice-0001"));
  assert.equal(submittedInvoice.document.docstatus, 1);
  assert.deepEqual(submittedInvoice.document.items.map((row) => [row.name, row.qty, row.purchase_order, row.po_detail]),
    invoiceBeforeSubmit.items.map((row) => [row.name, row.qty, row.purchase_order, row.po_detail]),
    "Submitting a Purchase Invoice must retain the exact ordered source line");
  const ledgerQuery = new URLSearchParams({ fields: JSON.stringify(["name", "company", "voucher_type", "voucher_no", "account", "debit", "credit", "is_cancelled"]),
    filters: JSON.stringify([["company", "=", company], ["voucher_type", "=", "Purchase Invoice"],
      ["voucher_no", "=", purchaseInvoice.name], ["is_cancelled", "=", 0]]), limit_page_length: "50" });
  const invoiceEntries = await backendRequest("all", `/api/resource/GL%20Entry?${ledgerQuery}`);
  assert.ok(invoiceEntries.length >= 2 && invoiceEntries.length < 50,
    "Native Purchase Invoice submission must create a complete, bounded set of ledger entries");
  assert.ok(invoiceEntries.every((row) => row.company === company && row.voucher_type === "Purchase Invoice"
    && row.voucher_no === purchaseInvoice.name && row.is_cancelled === 0));
  assert.equal(Math.round(invoiceEntries.reduce((sum, row) => sum + (row.debit || 0), 0) * 100) / 100, submittedInvoice.document.grand_total);
  assert.equal(Math.round(invoiceEntries.reduce((sum, row) => sum + (row.credit || 0), 0) * 100) / 100, submittedInvoice.document.grand_total);

  await backendRequest("workflow_admin", `/api/resource/Workflow/${encodeURIComponent(fixture.submission_workflow)}`,
    { method: "PUT", body: { is_active: 1 } });
  const workflowQuote = await call("all", "get_document", { doctype: "Quotation", name: recipientQuote.name });
  const workflowQuotePath = `/api/resource/Quotation/${encodeURIComponent(workflowQuote.name)}`;
  const workflowWritesBefore = documentUpdates.filter((path) => path === workflowQuotePath).length;
  await call("all", "submit_document", submitArgs("Quotation", workflowQuote, "live-submit-workflow-refused"), "WORKFLOW_REQUIRED");
  assert.equal(documentUpdates.filter((path) => path === workflowQuotePath).length, workflowWritesBefore,
    "An active approval workflow must be rejected before the submit mutation");
  assert.equal((await call("all", "get_document", { doctype: "Quotation", name: workflowQuote.name })).docstatus, 0);
  assert.ok(upstreamCalls > checks, "Tool calls must reach live Frappe");
  console.log(`${checks} live Frappe tool checks passed (accuracy, CRM links, draft writes, native submissions, source line links, replay, permissions, workflows).`);
} finally {
  await mf.dispose();
}
