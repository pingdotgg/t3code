import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { type ReleaseManifest, resolvePublicCapabilities } from "../src/lib/capabilities.ts";

const appRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const distRoot = NodePath.join(appRoot, "dist");
const releaseManifest = JSON.parse(
  NodeFS.readFileSync(NodePath.join(appRoot, "src/content/verified-releases.json"), "utf8"),
) as ReleaseManifest;
const capabilities = resolvePublicCapabilities(process.env, releaseManifest);
const routeFiles = [
  "index.html",
  "product/index.html",
  "access/index.html",
  "pricing/index.html",
  "waitlist/index.html",
  "download/index.html",
  "privacy/index.html",
  "terms/index.html",
  "404.html",
] as const;

function fail(message: string): never {
  throw new Error(`Auldric built-site verification: ${message}`);
}

function count(content: string, pattern: RegExp): number {
  return [...content.matchAll(pattern)].length;
}

function outputPathForUrl(pathname: string): string {
  if (pathname === "/") return NodePath.join(distRoot, "index.html");
  if (NodePath.extname(pathname)) return NodePath.join(distRoot, pathname.slice(1));
  return NodePath.join(distRoot, pathname.slice(1), "index.html");
}

for (const routeFile of routeFiles) {
  const absolutePath = NodePath.join(distRoot, routeFile);
  if (!NodeFS.existsSync(absolutePath)) fail(`missing route output ${routeFile}`);

  const html = NodeFS.readFileSync(absolutePath, "utf8");
  if (!/<html\s+lang="en"/u.test(html)) fail(`${routeFile} is missing the document language`);
  if (!/<meta\s+name="description"\s+content="[^"]+"/u.test(html)) {
    fail(`${routeFile} is missing its description metadata`);
  }
  if (!/<link\s+rel="canonical"\s+href="https:\/\/[^\x22]+"/u.test(html)) {
    fail(`${routeFile} is missing an HTTPS canonical URL`);
  }
  const expectedRobots = capabilities.legal.publicationReady
    ? "index,follow,max-image-preview:large"
    : "noindex,nofollow";
  if (!html.includes(`name="robots" content="${expectedRobots}"`)) {
    fail(`${routeFile} does not match the resolved publication state`);
  }
  if (!html.includes('href="#main-content"') || !html.includes('id="main-content"')) {
    fail(`${routeFile} is missing the skip-link target`);
  }
  if (count(html, /<h1(?:\s|>)/gu) !== 1) fail(`${routeFile} must contain exactly one h1`);
  if (/https?:\/\/(?:[^/]+\.)?t3\.codes/iu.test(html)) {
    fail(`${routeFile} leaks a T3-owned host`);
  }

  for (const match of html.matchAll(/(?:href|src)="(\/[^"]*)"/gu)) {
    const rawPath = match[1];
    if (!rawPath || rawPath.startsWith("//") || rawPath.startsWith("/#")) continue;
    const pathname = decodeURIComponent(rawPath.split(/[?#]/u, 1)[0] ?? "/");
    const outputPath = outputPathForUrl(pathname);
    if (!NodePath.resolve(outputPath).startsWith(`${NodePath.resolve(distRoot)}${NodePath.sep}`)) {
      fail(`${routeFile} contains an escaping internal link: ${rawPath}`);
    }
    if (!NodeFS.existsSync(outputPath)) {
      fail(`${routeFile} links to missing output ${rawPath}`);
    }
  }
}

const defaultWaitlist = NodeFS.readFileSync(NodePath.join(distRoot, "waitlist/index.html"), "utf8");
const hasWaitlistForm =
  /<form(?:\s|>)/u.test(defaultWaitlist) && /<input(?:\s|>)/u.test(defaultWaitlist);
if ((capabilities.waitlist.kind === "open") !== hasWaitlistForm) {
  fail("waitlist output does not match the resolved collection capability");
}
if (
  capabilities.waitlist.kind === "open" &&
  !defaultWaitlist.includes(`action="${capabilities.waitlist.endpoint}"`)
) {
  fail("open waitlist output does not use the resolved collection endpoint");
}

const accessPage = NodeFS.readFileSync(NodePath.join(distRoot, "access/index.html"), "utf8");
if (
  capabilities.access.kind === "available"
    ? !accessPage.includes(`href="${capabilities.access.url}"`)
    : accessPage.includes(">Open Auldric")
) {
  fail("access output does not match the resolved product destination");
}

const defaultDownload = NodeFS.readFileSync(NodePath.join(distRoot, "download/index.html"), "utf8");
const hasDownloadLink =
  /href="https:\/\/github\.com\/AuldricAI\/auldrics\/releases\/download\//u.test(defaultDownload);
if ((capabilities.download.kind === "available") !== hasDownloadLink) {
  fail("download output does not match the verified release capability");
}
if (
  capabilities.download.kind === "available" &&
  (!defaultDownload.includes(`href="${capabilities.download.url}"`) ||
    !defaultDownload.includes(capabilities.download.sha256))
) {
  fail("available download output is missing its exact artifact or checksum");
}

const robots = NodeFS.readFileSync(NodePath.join(distRoot, "robots.txt"), "utf8");
if (
  capabilities.legal.publicationReady
    ? !robots.includes("Allow: /")
    : !robots.includes("Disallow: /")
) {
  fail("crawler policy does not match the resolved publication state");
}
if (!NodeFS.existsSync(NodePath.join(distRoot, "sitemap.xml"))) fail("missing sitemap.xml");

console.log(`Verified ${routeFiles.length} Auldric public route outputs and their internal links.`);
