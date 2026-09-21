import { z } from "zod";
import { frappeFiscalYear } from "./frappe";
import { ToolError } from "./tool-result";
import type { NexWaveAuthProps } from "./types";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const PERIOD_SCHEMA = {
  from_date: DATE.optional(),
  to_date: DATE.optional(),
  period: z.enum(["current_fiscal_year", "last_month", "last_90_days"]).optional().describe("Use instead of from_date/to_date. Requires as_of_date. Default report period is current_fiscal_year when dates are not specified."),
  as_of_date: DATE.optional().describe("Today's calendar date in the user's timezone, used to resolve period. Never guess or hardcode this date."),
};

export async function resolveReportPeriod(props: NexWaveAuthProps, company: string, input: z.infer<z.ZodObject<typeof PERIOD_SCHEMA>>) {
  if (input.from_date && input.to_date && !input.period && !input.as_of_date) return { from_date: input.from_date, to_date: input.to_date, fiscal_year: undefined };
  if (input.from_date || input.to_date || !input.as_of_date) {
    throw new ToolError("INVALID_ARGUMENT", "Supply both from_date and to_date, or period and as_of_date. Do not mix explicit dates with a period.");
  }
  const today = new Date(`${input.as_of_date}T00:00:00Z`);
  if (Number.isNaN(today.getTime()) || today.toISOString().slice(0, 10) !== input.as_of_date) throw new ToolError("INVALID_ARGUMENT", "as_of_date must be a valid calendar date.");
  if (!input.period || input.period === "current_fiscal_year") {
    const fiscal = await frappeFiscalYear(props, company, input.as_of_date);
    if (fiscal.from_date > input.as_of_date || fiscal.to_date < input.as_of_date) throw new ToolError("UPSTREAM_INVALID_RESPONSE", "The returned fiscal year does not contain the requested date.");
    return { from_date: fiscal.from_date, to_date: input.as_of_date, fiscal_year: fiscal.name };
  }
  if (input.period === "last_month") {
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    return { from_date: start.toISOString().slice(0, 10), to_date: end.toISOString().slice(0, 10), fiscal_year: undefined };
  }
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - 89);
  return { from_date: start.toISOString().slice(0, 10), to_date: input.as_of_date, fiscal_year: undefined };
}
