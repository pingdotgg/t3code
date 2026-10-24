export function truncate(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, clusterBoundaryBefore(trimmed, maxLength))}...`;
}

// Code points that extend the grapheme cluster before them: ZWJ, skin-tone
// modifiers, emoji tag characters and combining marks (which include variation
// selectors and the keycap mark). Intl.Segmenter would cover all of this, but
// Hermes lacks it and the no-hermes-unsupported-apis lint rule bans it here.
const CLUSTER_EXTENDER = /^(?:‍|[\u{1f3fb}-\u{1f3ff}\u{e0020}-\u{e007f}]|\p{M})$/u;
const REGIONAL_INDICATOR = /^[\u{1f1e6}-\u{1f1ff}]$/u;

// Regional indicators form pairs from the start of their run.
function clusterBoundaryBefore(text: string, limit: number): number {
  let boundary = 0;
  let index = 0;
  let afterJoiner = false;
  let openFlag = false;
  for (const char of text) {
    if (index > limit) break;
    const isRegionalIndicator = REGIONAL_INDICATOR.test(char);
    const joins = afterJoiner || CLUSTER_EXTENDER.test(char) || (openFlag && isRegionalIndicator);
    if (!joins) boundary = index;
    afterJoiner = char === "‍";
    openFlag = isRegionalIndicator && !openFlag;
    index += char.length;
  }
  return boundary;
}
