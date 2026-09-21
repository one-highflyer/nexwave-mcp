import { frappeList } from "./frappe";
import type { NexWaveAuthProps } from "./types";
import { structuredResult } from "./tool-result";

type Row = Record<string, unknown>;
export interface SearchOptions {
  search?: string;
  limit: number;
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
  const base = { filters: options.filters, orderBy: options.orderBy ?? "modified desc" };
  const search = async (terms: string[], limit: number) => frappeList<Row>(props, doctype, fields, {
    ...base,
    limit,
    orFilters: terms.flatMap((term) => searchFields.map((field) => [doctype, field, "like", `%${literalLike(term)}%`])),
  });
  // Candidate retrieval is bounded. A full page must never establish a unique match.
  let rows = await search(query ? [query] : [], query && options.directory ? 50 : options.limit);
  let broadened = false;
  if (query && options.directory && rows.length === 0) {
    const tokens = [...new Set(normaliseName(query, options.legalNames).split(" ").filter((word) => word.length >= 2))];
    const terms = tokens.sort((a, b) => b.length - a.length).slice(0, 3);
    if (terms.length && !(terms.length === 1 && terms[0] === query.toLowerCase())) {
      rows = await search(terms, 50);
      broadened = true;
    }
  }
  const candidateLimitReached = rows.length === (query && options.directory ? 50 : options.limit);
  const normalized = query ? normaliseName(query, options.legalNames) : "";
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
    .sort((a, b) => options.directory ? b.score - a.score : 0);
  const exact = ranked.filter((entry) => entry.exactId || entry.exactName);
  const status = !ranked.length ? "no_match" : !query ? "listed"
    : exact.length === 1 && !candidateLimitReached ? "matched" : "candidates";
  const records = ranked.slice(0, options.limit).map((entry) => entry.record);
  return {
    records,
    meta: {
      query: query ?? null,
      match_status: status,
      broadened,
      count: records.length,
      truncated: candidateLimitReached || ranked.length > records.length,
      ...(status === "matched" ? { matched_id: exact[0].record.name } : {}),
      ...(query && status === "candidates" ? { next_action: "Ask the user to confirm a candidate before using its exact ID in a balance or report filter." } : {}),
    },
  };
}

export async function listResult(
  props: NexWaveAuthProps, doctype: string, fields: string[], searchFields: string[], options: SearchOptions,
) {
  const result = await searchRecords(props, doctype, fields, searchFields, options);
  // Preserve the existing array in text content for current MCP clients.
  return structuredResult(result, result.records);
}
