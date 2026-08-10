import { describe, expect, it } from "@effect/vitest";

import routeTree from "./routeTree.gen.ts?raw";

import {
  productDomainPath,
  resolveProductDomain,
  resolveProductDomainFromPathname,
} from "./productDomain";

describe("product domain", () => {
  it("defaults missing and unknown values to native Dev", () => {
    expect(resolveProductDomain(undefined)).toBe("dev");
    expect(resolveProductDomain(null)).toBe("dev");
    expect(resolveProductDomain("unknown")).toBe("dev");
    expect(resolveProductDomain("Marketing")).toBe("dev");
    expect(resolveProductDomain("dev")).toBe("dev");
  });

  it("enters Marketing only through its exact route namespace", () => {
    expect(resolveProductDomainFromPathname("/marketing")).toBe("marketing");
    expect(resolveProductDomainFromPathname("/marketing/")).toBe("marketing");
    expect(resolveProductDomainFromPathname("/marketing/sources")).toBe("marketing");

    expect(resolveProductDomainFromPathname("/")).toBe("dev");
    expect(resolveProductDomainFromPathname("/settings")).toBe("dev");
    expect(resolveProductDomainFromPathname("/Marketing")).toBe("dev");
    expect(resolveProductDomainFromPathname("/marketing-tools")).toBe("dev");
  });

  it("provides explicit reversible transition destinations", () => {
    expect(productDomainPath("marketing")).toBe("/marketing");
    expect(productDomainPath("dev")).toBe("/");
    expect(productDomainPath(resolveProductDomain("unknown"))).toBe("/");
  });

  it("keeps the Marketing payload out of the generated Dev startup graph", () => {
    const staticRouteImports = Array.from(
      routeTree.matchAll(/^import .* from ['"](.+)['"]$/gmu),
      (match) => match[1],
    );

    expect(staticRouteImports).not.toContain("./routes/marketing");
    expect(staticRouteImports).not.toContain("./routes/marketing.lazy");
    expect(routeTree).toContain("import('./routes/marketing.lazy')");
  });
});
