/** App protocols supported by markdown links and the desktop OS handoff. */
export const EXTERNAL_APP_LINK_SCHEMES = ["linear", "slack", "notion", "obsidian"] as const;

const protocols = new Set<string>(EXTERNAL_APP_LINK_SCHEMES.map((scheme) => `${scheme}:`));

export function isExternalAppLink(href: string): boolean {
  const colon = href.indexOf(":");
  return colon > 0 && protocols.has(href.slice(0, colon + 1).toLowerCase());
}
