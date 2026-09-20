import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, safeBaseUrl, secureEqual, siteOriginFromInput } from "../src/security";

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

describe("secret encryption", () => {
  it("round trips a client secret without storing plaintext", async () => {
    const encrypted = await encryptSecret("oauth-secret", KEY);

    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain("oauth-secret");
    await expect(decryptSecret(encrypted, KEY)).resolves.toBe("oauth-secret");
  });

  it("rejects a key with the wrong length", async () => {
    await expect(encryptSecret("secret", "c2hvcnQ")).rejects.toThrow("32-byte key");
  });
});

describe("secret comparison", () => {
  it("compares secret values without a direct string comparison", async () => {
    await expect(secureEqual("same-secret", "same-secret")).resolves.toBe(true);
    await expect(secureEqual("same-secret", "different-secret")).resolves.toBe(false);
  });
});

describe("site URL validation", () => {
  it("accepts HTTPS origins", () => {
    expect(safeBaseUrl("https://demo.example.com/")).toBe("https://demo.example.com");
  });

  it("accepts HTTP for local Frappe development", () => {
    expect(safeBaseUrl("http://demo.localhost:8000/")).toBe("http://demo.localhost:8000");
  });

  it.each([
    "http://demo.example.com/",
    "https://demo.example.com/app/home",
    "https://user:password@demo.example.com/",
  ])("rejects an unsafe or non-origin URL: %s", (url) => {
    expect(() => safeBaseUrl(url)).toThrow();
  });

  it("extracts the origin from a NexWave page URL", () => {
    expect(siteOriginFromInput("https://Demo.Example.com/app/home?view=workspace#main")).toBe(
      "https://demo.example.com",
    );
  });

  it("rejects credentials when extracting a site origin", () => {
    expect(() => siteOriginFromInput("https://user:password@demo.example.com/app/home")).toThrow();
  });
});
