import { describe, expect, it } from "vitest";
import { renderConsent, renderErrorPage } from "../src/consent";

describe("OAuth consent privacy", () => {
  it("asks for a site URL without rendering registered site choices", () => {
    const html = renderConsent(
      { clientName: "Codex" } as Parameters<typeof renderConsent>[0],
      { scope: ["nexwave:read"] } as Parameters<typeof renderConsent>[1],
      "pending-id",
      "csrf-token",
      { scriptNonce: "script-nonce" },
    );

    expect(html).toContain('name="site_url"');
    expect(html).toContain("Registered sites are not listed for privacy.");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("site_id");
  });

  it("shows progress and explains where the final result appears", () => {
    const html = renderConsent(
      { clientName: "Codex" },
      { scope: ["nexwave:read"] },
      "pending-id",
      "csrf-token",
      { scriptNonce: "script-nonce" },
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("Connecting to NexWave…");
    expect(html).toContain("Your MCP client will show the final success or failure result");
    expect(html).toContain('nonce="script-nonce"');
    expect(html).toContain('href="/favicon.ico"');
    expect(html).toContain('src="/brand/nexwave-logo.png"');
  });

  it("keeps the submitted URL and shows a safe retry error", () => {
    const html = renderConsent(
      { clientName: "Codex" },
      { scope: ["nexwave:read"] },
      "pending-id",
      "csrf-token",
      {
        scriptNonce: "script-nonce",
        siteUrl: "https://example.com/?a=<unsafe>",
        error: "Check the site URL.",
      },
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Check the site URL.");
    expect(html).toContain("https://example.com/?a=&lt;unsafe&gt;");
    expect(html).not.toContain("<unsafe>");
  });

  it("renders a styled error page without exposing HTML", () => {
    const html = renderErrorPage("Connection failed", "Try again <later>.");

    expect(html).toContain('role="alert"');
    expect(html).toContain("Try again &lt;later&gt;.");
    expect(html).not.toContain("<later>");
  });
});
