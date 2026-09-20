import { z } from "zod";

const NULL_VALUE = z.null().describe("Use null when this optional value is not supplied.");

export function nullableOptional<T extends z.ZodType>(schema: T) {
  return z.union([schema, NULL_VALUE]).optional();
}

export function nullableDefault<T extends z.ZodType>(schema: T, defaultValue: z.output<T>) {
  return z.union([schema, NULL_VALUE]).default(defaultValue as never);
}
