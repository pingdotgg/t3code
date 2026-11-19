/**
 * Request blocking for the Entertainment browser profile. Rules match a host (and its
 * subdomains), optionally narrowed to a path prefix. The lists are Continuum's own, kept short and
 * focused on well-known ad, tracking, and analytics endpoints.
 */
export interface BlockRule {
  readonly host: string;
  readonly pathPrefix?: string;
}

export interface FilterList {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly rules: ReadonlyArray<BlockRule>;
}

const hosts = (...names: string[]): BlockRule[] => names.map((host) => ({ host }));

export const BUILT_IN_FILTER_LISTS: ReadonlyArray<FilterList> = [
  {
    id: "trackers",
    name: "Trackers and analytics",
    description: "Analytics, session recording, and cross-site tracking scripts.",
    rules: hosts(
      "google-analytics.com",
      "googletagmanager.com",
      "analytics.google.com",
      "connect.facebook.net",
      "scorecardresearch.com",
      "hotjar.com",
      "hotjar.io",
      "cdn.segment.com",
      "api.segment.io",
      "mixpanel.com",
      "api.amplitude.com",
      "cdn.amplitude.com",
      "quantserve.com",
      "chartbeat.com",
      "chartbeat.net",
      "bam.nr-data.net",
      "fullstory.com",
      "mouseflow.com",
      "clarity.ms",
      "analytics.tiktok.com",
      "bat.bing.com",
      "static.ads-twitter.com",
      "api2.branch.io",
      "sb.scorecardresearch.com",
      "pixel.wp.com",
      "stats.wp.com",
    ),
  },
  {
    id: "ads",
    name: "Ad networks",
    description: "Display ad networks and ad exchanges.",
    rules: hosts(
      "doubleclick.net",
      "googlesyndication.com",
      "googleadservices.com",
      "adservice.google.com",
      "adnxs.com",
      "amazon-adsystem.com",
      "taboola.com",
      "outbrain.com",
      "criteo.com",
      "criteo.net",
      "rubiconproject.com",
      "pubmatic.com",
      "openx.net",
      "casalemedia.com",
      "moatads.com",
      "adsrvr.org",
      "adform.net",
      "smartadserver.com",
      "yieldmo.com",
      "teads.tv",
      "media.net",
    ),
  },
  {
    id: "youtube-ads",
    name: "YouTube ad requests",
    description:
      "YouTube's ad, ad-stats, and tracking endpoints. Some video ads still play, because YouTube serves them like regular video.",
    rules: [
      { host: "youtube.com", pathPrefix: "/api/stats/ads" },
      { host: "youtube.com", pathPrefix: "/pagead/" },
      { host: "youtube.com", pathPrefix: "/ptracking" },
      { host: "youtube.com", pathPrefix: "/get_midroll_info" },
      { host: "youtube.com", pathPrefix: "/youtubei/v1/log_event" },
      { host: "googleads.g.doubleclick.net" },
      { host: "static.doubleclick.net" },
      { host: "imasdk.googleapis.com" },
    ],
  },
];

export interface ContentBlockingConfig {
  readonly enabled: boolean;
  readonly lists: ReadonlyArray<string>;
  /** Extra hosts to block, one per entry (`ads.example.com`). */
  readonly customHosts: ReadonlyArray<string>;
  /** Sites where nothing is blocked, matched against the page's host. */
  readonly allowlist: ReadonlyArray<string>;
}

function hostMatches(host: string, rule: string): boolean {
  return host === rule || host.endsWith(`.${rule}`);
}

export function normalizeHostEntry(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "") return null;
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`)
      .hostname;
    return host.includes(".") ? host.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

/**
 * Builds the matcher the desktop browser session consults for every request. `pageUrl` is the
 * top-level page (for the allowlist); null when unknown, such as a service worker request.
 */
export function createContentBlocker(config: ContentBlockingConfig) {
  const rules: ReadonlyArray<BlockRule> = config.enabled
    ? [
        ...BUILT_IN_FILTER_LISTS.filter((list) => config.lists.includes(list.id)).flatMap(
          (list) => list.rules,
        ),
        ...config.customHosts.flatMap((entry) => {
          const host = normalizeHostEntry(entry);
          return host === null ? [] : [{ host } satisfies BlockRule];
        }),
      ]
    : [];
  const allowlist = config.allowlist.flatMap((entry) => {
    const host = normalizeHostEntry(entry);
    return host === null ? [] : [host];
  });
  return {
    active: rules.length > 0,
    shouldBlock(requestUrl: string, pageUrl: string | null): boolean {
      if (rules.length === 0) return false;
      let request: URL;
      try {
        request = new URL(requestUrl);
      } catch {
        return false;
      }
      if (request.protocol !== "https:" && request.protocol !== "http:") return false;
      if (pageUrl !== null) {
        try {
          const page = new URL(pageUrl).hostname;
          if (allowlist.some((host) => hostMatches(page, host))) return false;
        } catch {
          // An unparseable page URL is not on the allowlist.
        }
      }
      const host = request.hostname.toLowerCase();
      return rules.some(
        (rule) =>
          hostMatches(host, rule.host) &&
          (rule.pathPrefix === undefined || request.pathname.startsWith(rule.pathPrefix)),
      );
    },
  };
}
