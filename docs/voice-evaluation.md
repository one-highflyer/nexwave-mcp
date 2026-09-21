# Voice regression checks

Use synthetic or authorized local data. Keep transcripts and credentials out of this repository. Test the published agent after deploying the MCP server and refreshing its catalogue. A successful Retell call label alone is not evidence of correct tool use.

| Spoken request or condition | Required behavior |
| --- | --- |
| Named party balance, type unclear | One customer/supplier clarification before a lookup |
| Supplier name uses Limited, record uses Ltd | Bounded search resolves a unique normalized name, or requests confirmation |
| Two similar suppliers | No balance request until the user confirms an exact ID |
| Confirmed ID with 140 characters | Equality lookup succeeds; no substring-search loop |
| Invoices for a spoken supplier last month | supplier_query plus exact dates; other filters remain intact |
| Oldest unpaid purchase invoice | Positive submitted balances, due_date ascending, no contradictory status |
| Largest invoice across document currencies | base_grand_total with a single company; no native-currency comparison |
| Open purchase orders waiting for delivery | pending_receipt filter; no claim that a limited page is a full count |
| Sales by customer, item, item group or month | get_sales_summary; net sales basis stated; no model arithmetic over lists |
| Current stock, no dates | Server fiscal-year preset, or older-schema fiscal-year lookup |
| Trial balance range crosses fiscal years | Clear error before report execution; no silent date change |
| Low stock without reorder settings | Unknown/partial coverage stated, not a guessed low-stock classification |
| Incorrect warehouse ID | Lookup error; query must not broaden to all warehouses |
| 'Invoice' misheard as 'in noise' | Context or clarification, no search keyword 'noise' |
| Upstream HTML, malformed JSON or unfinished report | MCP error; no empty-list or zero-balance claim |
| Tool timeout | One clear failure, no automatic identical retry |
| Permission denial | No broader query or authentication bypass |
| A truncated list or report | State the limit; use complete server summary for totals |
| An unrelated cooking question | Polite NexWave-only refusal |
| Receivables overdue, with 1-30-day, due-today and future amounts | Quote explicit totals.overdue only when overdue_complete=true; never sum ageing buckets |
| Receivables overdue_complete=false or field absent | Say the overdue total is unavailable; do not invent zero or subtract the first bucket |
| Customer insights | Resolve once, then sequentially combine party balance, customer-filtered sales and relevant invoice details; give one concise summary |
| Customer insights with two name candidates | Ask for an exact selection before any follow-up customer-specific report |
| Customer insights with overdue invoices issued before this fiscal year | Oldest overdue invoice lookup retains customer/company and due-date cutoff, without a fiscal-year posting-date filter |
| Customer insights at a historical snapshot | Use dated Accounts Receivable details or state the limitation; current invoice outstanding cannot prove historical debt |
| Party/payable overdue is unconfirmed | Preserve known balance totals, but do not quote overdue without overdue_complete=true |
| Recent invoices or orders include drafts/cancellations | State status where relevant; do not describe these as completed sales |
| Customer insights with a report timeout | Stop remaining report chain, state confirmed partial findings and missing evidence; no automatic retry |
| Supplier insights | Balance plus relevant invoice/order examples; no total-spend or reliability claim from a limited list |
| A customer profit or growth question | Do not substitute company profit or infer growth from partial periods; state unsupported metrics |
| Company overview asks for sales, receivables and orders | Keep the measures separate; do not add overlapping values together |

Verify both `/mcp` OAuth and `/service/mcp` service-token paths. Automated tests cover the shared catalogue, OAuth token behavior, service authentication, null normalization, query construction, response errors and calculations. A final live voice test is still required to measure speech recognition, routing, interruption behavior and end-to-end latency.
