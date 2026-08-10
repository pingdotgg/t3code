import { describe, expect, it } from "@effect/vitest";

import routeTree from "./routeTree.gen.ts?raw";
import { stripPairingTokenFromUrl } from "./pairingUrl";

import {
  parsePairRouteSearch,
  productDomainPath,
  resolveProductDomain,
  resolveProductDomainFromRouteIds,
  resolveMarketingReturnPath,
} from "./productDomain";

describe("product domain", () => {
  it("defaults missing and unknown values to native Dev", () => {
    expect(resolveProductDomain(undefined)).toBe("dev");
    expect(resolveProductDomain(null)).toBe("dev");
    expect(resolveProductDomain("unknown")).toBe("dev");
    expect(resolveProductDomain("Marketing")).toBe("dev");
    expect(resolveProductDomain("dev")).toBe("dev");
  });

  it("enters Marketing only when its structural parent route matched", () => {
    expect(resolveProductDomainFromRouteIds(["__root__", "/marketing", "/marketing/"])).toBe(
      "marketing",
    );
    expect(resolveProductDomainFromRouteIds(["__root__", "/marketing", "/marketing/$"])).toBe(
      "marketing",
    );

    expect(resolveProductDomainFromRouteIds([])).toBe("dev");
    expect(resolveProductDomainFromRouteIds(["__root__", "/_chat"])).toBe("dev");
    expect(resolveProductDomainFromRouteIds(["__root__", "/marketing-tools"])).toBe("dev");
  });

  it("provides explicit reversible transition destinations", () => {
    expect(productDomainPath("marketing")).toBe("/marketing");
    expect(productDomainPath("dev")).toBe("/");
    expect(productDomainPath(resolveProductDomain("unknown"))).toBe("/");
  });

  it("accepts only canonical local Marketing paths for post-pair return", () => {
    expect(resolveMarketingReturnPath("/marketing")).toBe("/marketing");
    expect(resolveMarketingReturnPath("/marketing/sources")).toBe("/marketing/sources");
    expect(resolveMarketingReturnPath("/marketing/")).toBe("/marketing");

    for (const value of [
      undefined,
      "/",
      "/Marketing",
      "/marketing-tools",
      "/marketing/../settings",
      "/marketing/%2e%2e/settings",
      "/marketing/sources?secret=1",
      "/marketing/sources/",
      "https://attacker.example/marketing",
    ]) {
      expect(resolveMarketingReturnPath(value)).toBeUndefined();
    }
    expect(parsePairRouteSearch({ marketingReturnTo: "/marketing/sources" })).toEqual({
      marketingReturnTo: "/marketing/sources",
    });
    expect(parsePairRouteSearch({ marketingReturnTo: "/settings" })).toEqual({});
  });

  it("strips a pairing token without losing the validated Marketing return", () => {
    const stripped = stripPairingTokenFromUrl(
      new URL("https://app.example/pair?marketingReturnTo=%2Fmarketing#token=secret"),
    );

    expect(stripped.searchParams.get("marketingReturnTo")).toBe("/marketing");
    expect(stripped.hash).toBe("");
  });

  it("keeps the Marketing payload out of the generated Dev startup graph", () => {
    const staticRouteImports = Array.from(
      routeTree.matchAll(/^import .* from ['"](.+)['"]$/gmu),
      (match) => match[1],
    );

    expect(staticRouteImports).toContain("./routes/marketing");
    expect(staticRouteImports).not.toContain("./routes/marketing.index.lazy");
    expect(staticRouteImports).not.toContain("./routes/marketing.$.lazy");
    expect(routeTree).toContain("import('./routes/marketing.index.lazy')");
    expect(routeTree).toContain("import('./routes/marketing.$.lazy')");
  });
});
