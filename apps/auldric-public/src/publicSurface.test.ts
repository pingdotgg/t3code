import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const appRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const repoRoot = NodePath.resolve(appRoot, "../..");
const sourceRoot = NodePath.join(appRoot, "src");
const pageRoot = NodePath.join(sourceRoot, "pages");

function read(relativePath: string): string {
  return NodeFS.readFileSync(NodePath.join(appRoot, relativePath), "utf8");
}

function walk(root: string): ReadonlyArray<string> {
  return NodeFS.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(root, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const publicSourceFiles = [...walk(sourceRoot), ...walk(NodePath.join(appRoot, "public"))].filter(
  (path) =>
    !path.endsWith(".test.ts") &&
    (path.endsWith(".astro") ||
      path.endsWith(".ts") ||
      path.endsWith(".css") ||
      path.endsWith(".svg")),
);
const publicSource = publicSourceFiles.map((path) => NodeFS.readFileSync(path, "utf8")).join("\n");

describe("Auldric public surface", () => {
  it("implements only the issue #14 public requirements from the pinned donor evidence", () => {
    const inventory = JSON.parse(
      NodeFS.readFileSync(
        NodePath.join(repoRoot, "docs/auldric-system/legacy-donor-inventory.json"),
        "utf8",
      ),
    ) as {
      source: { commit: string };
      entries: ReadonlyArray<{
        id: string;
        classification: string;
        owner: { issues: ReadonlyArray<number> };
        integration: { supportedSeam: string | null };
      }>;
    };
    expect(inventory.source.commit).toBe("cf6400e77dfaf9569f1ce6eaca4421deb0b2bf23");

    const entries = new Map(inventory.entries.map((entry) => [entry.id, entry]));
    expect(entries.get("public-marketing-content-and-assets")).toMatchObject({
      classification: "keep-rebuild",
      owner: { issues: [3, 27] },
      integration: {
        supportedSeam:
          "A separately named public application/deployment selected by #27; never overwrite T3 apps/marketing.",
      },
    });
    expect(entries.get("public-marketing-delivery-scaffolding")).toMatchObject({
      classification: "split",
      owner: { issues: [3, 27] },
    });
    expect(entries.get("marketing-copy-and-brand-validation-scripts")).toMatchObject({
      classification: "keep-rebuild",
      owner: { issues: [3, 27] },
    });
  });

  it("keeps the product definition stable while isolating launch state to availability copy", () => {
    const siteSource = read("src/lib/site.ts");
    const homeSource = read("src/pages/index.astro");
    expect(siteSource).toContain("Auldric is a Marketing and Strategy workspace");
    expect(siteSource).not.toContain("being built");
    expect(homeSource).toContain("Product access is not open");
    expect(homeSource).toContain("sources become evidence");
    expect(homeSource).toContain("decisions become reviewable next work");
  });

  it("does not publish unshipped claims, prices, integrations, or T3 runtime identity", () => {
    for (const forbidden of [
      /autonomous(?:ly)?/iu,
      /guarantee(?:d|s)?\s+(?:growth|revenue|results?)/iu,
      /closed[- ]loop\s+(?:growth|measurement|marketing)/iu,
      /instant(?:ly)?\s+(?:build|create|generate|strategy)/iu,
      /unlimited\s+(?:users|workspaces|campaigns)/iu,
      /connects?\s+to\s+(?:every|all|hundreds)/iu,
      /\$\d|£\d|€\d/u,
      /https?:\/\/(?:[^/]+\.)?t3\.codes/iu,
      /\b(?:RAG|MCP|WebSocket|provider CLI)\b/iu,
    ]) {
      expect(publicSource).not.toMatch(forbidden);
    }
  });

  it("provides every public route, legal route, recovery route, and metadata asset", () => {
    for (const relativePath of [
      "src/pages/index.astro",
      "src/pages/product.astro",
      "src/pages/access.astro",
      "src/pages/pricing.astro",
      "src/pages/waitlist.astro",
      "src/pages/download.astro",
      "src/pages/privacy.astro",
      "src/pages/terms.astro",
      "src/pages/404.astro",
      "src/pages/robots.txt.ts",
      "src/pages/sitemap.xml.ts",
      "public/favicon.svg",
      "public/social-card.svg",
    ]) {
      expect(NodeFS.existsSync(NodePath.join(appRoot, relativePath)), relativePath).toBe(true);
    }

    const layout = read("src/layouts/SiteLayout.astro");
    for (const metadata of [
      'name="description"',
      'name="robots"',
      'rel="canonical"',
      'property="og:title"',
      'property="og:description"',
      'name="twitter:card"',
      'type="application/ld+json"',
    ]) {
      expect(layout).toContain(metadata);
    }
  });

  it("keeps literal internal links attached to a real route or asset", () => {
    const routeOutputs = new Set([
      "/",
      "/product",
      "/access",
      "/pricing",
      "/waitlist",
      "/download",
      "/privacy",
      "/terms",
      "/404",
      "/favicon.svg",
      "/social-card.svg",
    ]);
    const literalLinks = [...publicSource.matchAll(/href="(\/[^"#?]*)"/gu)].map(
      (match) => match[1],
    );
    expect(literalLinks.length).toBeGreaterThan(10);
    for (const link of literalLinks) expect(routeOutputs.has(link ?? ""), link).toBe(true);
  });

  it("includes keyboard, landmark, form-label, responsive, and reduced-motion treatment", () => {
    const layout = read("src/layouts/SiteLayout.astro");
    const styles = read("src/styles/global.css");
    const waitlist = read("src/pages/waitlist.astro");

    expect(layout).toContain('<html lang="en">');
    expect(layout).toContain('class="skip-link"');
    expect(layout).toContain('href="#main-content"');
    expect(layout).toContain('aria-label="Primary navigation"');
    expect(layout).toContain('<main id="main-content">');
    expect(layout).toContain('aria-label="Footer navigation"');
    expect(styles).toContain(":focus-visible");
    expect(styles).toContain("@media (max-width:");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(waitlist).toContain('label for="waitlist-email"');
    expect(waitlist).toContain('id="waitlist-email"');
    expect(waitlist).toContain('id="waitlist-consent"');
    expect(waitlist).toContain('name="consentVersion"');
    expect(waitlist).toContain("required");
    expect(waitlist).toContain('aria-live="polite"');

    for (const pagePath of walk(pageRoot).filter((path) => path.endsWith(".astro"))) {
      const page = NodeFS.readFileSync(pagePath, "utf8");
      expect([...page.matchAll(/<h1(?:\s|>)/gu)], pagePath).toHaveLength(1);
      expect(page, pagePath).toContain("<SiteLayout");
    }
  });

  it("keeps native T3 marketing byte-for-byte invariant", () => {
    const trackedFiles = NodeChildProcess.execFileSync(
      "git",
      ["ls-files", "-z", "--", "apps/marketing"],
      { cwd: repoRoot, encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean)
      .sort();
    const digest = NodeCrypto.createHash("sha256");
    for (const relativePath of trackedFiles) {
      digest.update(relativePath);
      digest.update("\0");
      digest.update(NodeFS.readFileSync(NodePath.join(repoRoot, relativePath)));
      digest.update("\0");
    }

    expect(trackedFiles).toHaveLength(53);
    expect(digest.digest("hex")).toBe(
      "4f474bf18381c7baac8a2351d2aea95b2e3be27eca25b2d0ee77218d11fbd675",
    );
    expect(JSON.parse(read("../marketing/package.json"))).toMatchObject({
      name: "@t3tools/marketing",
    });
  });
});
