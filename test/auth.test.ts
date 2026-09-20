import { describe, expect, it } from "vitest";
import { renderConsent } from "../src/consent";

describe("OAuth consent privacy", () => {
  it("asks for a site URL without rendering registered site choices", () => {
    const html = renderConsent(
      { clientName: "Codex" } as Parameters<typeof renderConsent>[0],
      { scope: ["nexwave:read"] } as Parameters<typeof renderConsent>[1],
      "pending-id",
      "csrf-token",
    );

    expect(html).toContain('name="site_url"');
    expect(html).toContain("Registered sites are not listed for privacy.");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("site_id");
  });
});
