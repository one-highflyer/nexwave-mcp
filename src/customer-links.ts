import { frappeGet, frappeList } from "./frappe";
import { ToolError } from "./tool-result";
import type { NexWaveAuthProps } from "./types";

interface CustomerLinks {
  lead_name?: string;
  prospect_name?: string;
}

// Use native Customer links so its normal insert hooks retain CRM and contact links.
// Matching names and email addresses do not establish a source relationship.
export async function resolveCustomerLinks(props: NexWaveAuthProps, selected: CustomerLinks): Promise<CustomerLinks> {
  const links = { ...selected };
  if (links.lead_name) {
    const lead = await getSource(props, "Lead", links.lead_name);
    if (lead.disabled) throw new ToolError("INVALID_ARGUMENT", "Use an enabled Lead when creating a Customer.");
    const customers = await frappeList<Record<string, unknown>>(props, "Customer", ["name"], {
      filters: [["Customer", "lead_name", "=", links.lead_name]], limit: 1,
    });
    if (customers.length || lead.status === "Converted") {
      throw new ToolError("CONFLICT", "This Lead already has a Customer or is converted. Find and use the existing Customer before creating another.");
    }
    if (!links.prospect_name) {
      const candidates = await frappeList<Record<string, unknown>>(props, "Prospect", ["name"], {
        filters: [["Prospect Lead", "lead", "=", links.lead_name]], limit: 3, orderBy: "name asc",
      });
      const names = [...new Set(candidates.map((row) => String(row.name)))];
      if (names.length > 1 || candidates.length === 3) {
        throw new ToolError("CONFLICT", "The Lead's Prospect link is ambiguous or the lookup is incomplete. Confirm one Prospect and supply its exact prospect_name.");
      }
      links.prospect_name = names[0];
    }
  }
  if (links.prospect_name) {
    const prospect = await getSource(props, "Prospect", links.prospect_name);
    if (links.lead_name) {
      const rows = prospect.leads;
      if (!Array.isArray(rows) || !rows.every((row) => row && typeof row === "object"
        && !Array.isArray(row) && typeof row.lead === "string" && row.lead.trim())) {
        throw new ToolError("UPSTREAM_INVALID_RESPONSE", "The Prospect's Lead links could not be confirmed. Read the Prospect before creating the Customer.");
      }
      if (!rows.some((row) => row.lead === links.lead_name)) {
        throw new ToolError("INVALID_ARGUMENT", "The selected Lead does not belong to the selected Prospect. Confirm the source links before creating the Customer.");
      }
    }
  }
  return links;
}

async function getSource(props: NexWaveAuthProps, doctype: "Lead" | "Prospect", name: string) {
  const source = await frappeGet<Record<string, unknown>>(props, doctype, name);
  if (source.name !== name || (source.doctype !== undefined && source.doctype !== doctype)) {
    throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave returned an unexpected Customer source record.");
  }
  return source;
}
