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
        apiKey: credentials.apiKey, apiSecret: credentials.apiSecret }),
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
  assert.equal(tools.length, 30);
  const schemas = new Map(tools.map((tool) => [tool.name, z.fromJSONSchema(tool.outputSchema)]));
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
  assert.ok(upstreamCalls > checks, "Tool calls must reach live Frappe");
  console.log(`${checks} live Frappe tool checks passed (accuracy, currencies, pagination, details, reports, permissions).`);
} finally {
  await mf.dispose();
}
