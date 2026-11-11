import { ANDROID_PLAY_STORE_URL, GITHUB_REPOSITORY_URL, IOS_APP_STORE_URL } from "./site";

export const SITE_ORIGIN = "https://t3.codes";
export const SITE_NAME = "T3 Code";
export const SITE_TAGLINE = "The open-source control plane for coding agents";

// The canonical set of official properties. Search engines and AI answer engines read `sameAs`
// to tie an entity to its real homes, which is the signal a look-alike domain cannot copy.
export const OFFICIAL_PROFILES = [
  GITHUB_REPOSITORY_URL,
  IOS_APP_STORE_URL,
  ANDROID_PLAY_STORE_URL,
  "https://discord.gg/jn4EGJjrvv",
] as const;

export type JsonLd = Record<string, unknown>;

const ORGANIZATION_ID = `${SITE_ORIGIN}/#organization`;
const WEBSITE_ID = `${SITE_ORIGIN}/#website`;
const SOFTWARE_ID = `${SITE_ORIGIN}/#software`;

export const absoluteUrl = (pathname: string): string => new URL(pathname, SITE_ORIGIN).href;

export const organizationJsonLd = (): JsonLd => ({
  "@type": "Organization",
  "@id": ORGANIZATION_ID,
  name: "T3 Tools Inc",
  url: SITE_ORIGIN,
  logo: absoluteUrl("/apple-touch-icon.png"),
  sameAs: ["https://github.com/pingdotgg"],
});

export const websiteJsonLd = (): JsonLd => ({
  "@type": "WebSite",
  "@id": WEBSITE_ID,
  name: SITE_NAME,
  url: SITE_ORIGIN,
  publisher: { "@id": ORGANIZATION_ID },
});

export const softwareJsonLd = (): JsonLd => ({
  "@type": "SoftwareApplication",
  "@id": SOFTWARE_ID,
  name: SITE_NAME,
  description: `${SITE_NAME}. ${SITE_TAGLINE}.`,
  url: SITE_ORIGIN,
  downloadUrl: absoluteUrl("/download"),
  applicationCategory: "DeveloperApplication",
  operatingSystem: "macOS, Windows, Linux, iOS, Android",
  license: "https://opensource.org/license/mit",
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  publisher: { "@id": ORGANIZATION_ID },
  sameAs: [...OFFICIAL_PROFILES],
});

export const breadcrumbJsonLd = (items: ReadonlyArray<{ name: string; path: string }>): JsonLd => ({
  "@type": "BreadcrumbList",
  itemListElement: items.map((item, index) => ({
    "@type": "ListItem",
    position: index + 1,
    name: item.name,
    item: absoluteUrl(item.path),
  })),
});

export const jsonLdGraph = (nodes: ReadonlyArray<JsonLd>): string =>
  // `<` is escaped so page text inside the graph can never close the script tag.
  JSON.stringify({ "@context": "https://schema.org", "@graph": nodes }).replace(/</g, "\\u003c");

// Indexable static pages. The 404 (noindex) and the /95 easter egg stay out of the sitemap.
export const STATIC_PAGES = [
  { path: "/", priority: "1.0" },
  { path: "/download", priority: "0.9" },
  { path: "/legal", priority: "0.3" },
  { path: "/privacy-policy", priority: "0.3" },
  { path: "/security-policy", priority: "0.3" },
  { path: "/terms-of-service", priority: "0.3" },
] as const;
