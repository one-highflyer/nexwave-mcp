import { frappeGet, frappeList } from "./frappe";
import type { NexWaveAuthProps } from "./types";
import { structuredResult, ToolError } from "./tool-result";

type Row = Record<string, unknown>;
export interface SearchOptions {
  search?: string;
  limit: number;
  offset?: number;
  search_mode?: "ranked" | "literal";
  summary?: "count" | "totals";
  filters?: unknown[];
  orderBy?: string;
  directory?: boolean;
  legalNames?: boolean;
}

export function normaliseName(value: string, legalNames = false): string {
  const words = value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/);
  if (legalNames) {
    while (words.length > 1 && ["limited", "ltd", "incorporated", "inc", "llc", "pty"].includes(words.at(-1)!)) words.pop();
  }
  return words.join(" ");
}

// Escape LIKE metacharacters so user text cannot silently broaden the search.
export function literalLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function searchRecords(
  props: NexWaveAuthProps,
  doctype: string,
  fields: string[],
  searchFields: string[],
  options: SearchOptions,
) {
  const query = options.search?.trim().replace(/\s+/g, " ");
  const offset = options.offset ?? 0;
  const directory = Boolean(query && options.directory && options.search_mode !== "literal");
  const order = options.orderBy ?? "modified desc";
  const base = { filters: options.filters, orderBy: order.split(",").some((part) => part.trim().split(" ")[0] === "name") ? order : `${order}, name asc` };
  const search = async (terms: string[], limit: number) => frappeList<Row>(props, doctype, fields, {
    ...base,
    limit,
    offset: directory ? 0 : offset,
    orFilters: terms.flatMap((term) => searchFields.map((field) => [doctype, field, "like", `%${literalLike(term)}%`])),
  });
  // Candidate retrieval is bounded. A full page must never establish a unique match.
  let rows = await search(query ? [query] : [], directory ? 50 : options.limit);
  const normalized = query ? normaliseName(query, options.legalNames) : "";
  const hasExactMatch = rows.some((row) => Boolean(query && (
    String(row.name).toLowerCase() === query.toLowerCase()
    || searchFields.some((field) => normaliseName(String(row[field] ?? ""), options.legalNames) === normalized)
  )));
  let candidateLimitReached = rows.length === (directory ? 50 : options.limit);
  let broadened = false;
  if (query && directory && !hasExactMatch) {
    const tokens = [...new Set(normaliseName(query, options.legalNames).split(" ").filter((word) => word.length >= 2))];
    const terms = tokens.sort((a, b) => b.length - a.length).slice(0, 3);
    if (terms.length && !(terms.length === 1 && terms[0] === query.toLowerCase())) {
      const fallback = await search(terms, 50);
      const candidates = new Map([...rows, ...fallback].map((row) => [String(row.name), row]));
      rows = [...candidates.values()];
      candidateLimitReached ||= fallback.length === 50 || rows.length >= 50;
      broadened = true;
    }
  }
  const ranked = rows.map((record) => {
    const values = searchFields.map((field) => normaliseName(String(record[field] ?? ""), options.legalNames));
    const exactId = Boolean(query && String(record.name).toLowerCase() === query.toLowerCase());
    const exactName = Boolean(normalized && values.includes(normalized));
    const words = normalized.split(" ").filter(Boolean);
    const score = exactId ? 2 : exactName ? 1 : Math.max(0, ...values.map((value) => {
      const candidateWords = value.split(" ");
      return words.filter((word) => candidateWords.some((candidate) => candidate.startsWith(word))).length / Math.max(words.length, 1);
    })) * 0.9;
    return { record, exactId, exactName, score };
  }).filter((candidate) => !broadened || candidate.score > 0)
    .sort((a, b) => directory ? b.score - a.score : 0);
  const exact = ranked.filter((entry) => entry.exactId || entry.exactName);
  const status = !ranked.length ? "no_match" : !query ? "listed"
    : exact.length === 1 && !candidateLimitReached && offset === 0 ? "matched" : "candidates";
  const records = ranked.slice(directory ? offset : 0, directory ? offset + options.limit : options.limit).map((entry) => entry.record);
  const more = directory ? ranked.length > offset + records.length : candidateLimitReached;
  const truncated = candidateLimitReached || more;
  return {
    records,
    meta: {
      query: query ?? null,
      match_status: status,
      broadened,
      count: records.length,
      scope: directory ? "ranked_candidates" : "literal_matches",
      candidate_retrieval_complete: directory ? !candidateLimitReached : null,
      offset,
      limit: options.limit,
      next_offset: more ? offset + records.length : null,
      truncated,
      complete: offset === 0 && !truncated,
      warning: directory && candidateLimitReached
        ? "Candidate search is bounded. Use search_mode literal with offset 0 to page through literal matches, or narrow the name."
        : truncated || offset > 0 ? "These rows are one page, not all matching records. Do not use page rows as a count or total." : null,
      ...(status === "matched" ? { matched_id: exact[0].record.name } : {}),
      ...(query && status === "candidates" ? { next_action: "Ask the user to confirm a candidate before using its exact ID in a balance or report filter." } : {}),
    },
  };
}

export async function listResult(
  props: NexWaveAuthProps, doctype: string, fields: string[], searchFields: string[], options: SearchOptions,
) {
  if (options.summary) {
    if (options.directory && options.search?.trim() && options.search_mode !== "literal") throw new ToolError("INVALID_ARGUMENT", "Counts require search_mode literal or no search. Ranked candidates are not a complete match set.");
    return structuredResult(await summariseRecords(props, doctype, searchFields, options));
  }
  const result = await searchRecords(props, doctype, fields, searchFields, options);
  // Preserve the existing array in text content for current MCP clients.
  const response = structuredResult(result, result.records);
  response.content.push({ type: "text", text: JSON.stringify({ meta: result.meta }) });
  return response;
}

// Expressions and monetary fields are owned by the server, never supplied as SQL by clients.
const TOTAL_FIELDS: Record<string, string[]> = {
  "Sales Invoice": ["grand_total"],
  "Purchase Invoice": ["grand_total"],
  "Sales Order": ["grand_total"], "Purchase Order": ["grand_total"],
  "Payment Entry": ["base_paid_amount", "base_received_amount"],
  "Bank Transaction": ["deposit", "withdrawal", "unallocated_amount"],
};

async function summariseRecords(props: NexWaveAuthProps, doctype: string, searchFields: string[], options: SearchOptions) {
  const filters = options.filters ?? [];
  const exactFilter = (field: string) => filters.find((filter): filter is unknown[] => Array.isArray(filter) && filter[0] === doctype && filter[1] === field && filter[2] === "=" && typeof filter[3] === "string")?.[3];
  const totalFields = options.summary === "totals" ? TOTAL_FIELDS[doctype] : [];
  if (!totalFields) throw new ToolError("INVALID_ARGUMENT", "Totals are not supported for this document type. Use summary count.");
  const company = exactFilter("company");
  const currency = exactFilter("currency");
  if (totalFields.length && (!company || (doctype !== "Payment Entry" && !currency))) throw new ToolError("INVALID_ARGUMENT", "Totals require one company and one currency. Payment totals require company and use company currency.");
  const query = options.search?.trim().replace(/\s+/g, " ");
  const fields = ["count(name) as record_count", ...totalFields.map((field) => `sum(${field}) as total_${field}`)];
  const rows = await frappeList<Row>(props, doctype, fields, {
    limit: 1, filters, orderBy: "count(name) asc",
    orFilters: query ? searchFields.map((field) => [doctype, field, "like", `%${literalLike(query)}%`]) : [],
  });
  const row = rows[0];
  if (rows.length !== 1 || !Number.isSafeInteger(row?.record_count) || Number(row.record_count) < 0) throw new ToolError("UPSTREAM_INVALID_RESPONSE", "The record count could not be confirmed.");
  const totals: Record<string, number> = {};
  for (const field of totalFields) {
    const value = row[`total_${field}`];
    if (value === null && row.record_count === 0) totals[field] = 0;
    else if (typeof value === "number" && Number.isFinite(value)) totals[field] = value;
    else throw new ToolError("UPSTREAM_INVALID_RESPONSE", "A requested total could not be confirmed. Check field permissions.");
  }
  let totalCurrency = currency;
  if (totalFields.length && doctype === "Payment Entry") {
    const record = await frappeGet<Row>(props, "Company", String(company));
    if (typeof record.default_currency !== "string" || !record.default_currency.trim()) throw new ToolError("UPSTREAM_INVALID_RESPONSE", "The company currency could not be confirmed.");
    totalCurrency = record.default_currency;
  }
  return { doctype, query: query ?? null, filters, count: row.record_count, totals, ...(totalFields.length ? { company, currency: totalCurrency } : {}), complete: true, totals_complete: true,
    basis: "All permission-visible records matching the filters and literal search, independent of offset and limit. Current document amounts; not historical balances, recognised revenue, or net cash. Invoice balance totals require the receivables/payables tools; payment totals include internal transfers." };
}
