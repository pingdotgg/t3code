import { DESKTOP_HOST, getDesktopScheme } from "../electron/ElectronProtocol.ts";

export interface DesktopThreadLink {
  readonly environmentId: string;
  readonly threadId: string;
}

export function buildDesktopThreadLink(input: {
  readonly isDevelopment: boolean;
  readonly environmentId: string;
  readonly threadId: string;
}): string {
  const scheme = getDesktopScheme(input.isDevelopment);
  return `${scheme}://${DESKTOP_HOST}/#/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

function decodeThreadLinkSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.trim() === decoded && decoded.length > 0 && !decoded.includes("/")
      ? decoded
      : null;
  } catch {
    return null;
  }
}

export function parseDesktopThreadLink(input: {
  readonly isDevelopment: boolean;
  readonly value: string;
}): DesktopThreadLink | null {
  let url: URL;
  try {
    url = new URL(input.value);
  } catch {
    return null;
  }

  if (
    url.protocol !== `${getDesktopScheme(input.isDevelopment)}:` ||
    url.host !== DESKTOP_HOST ||
    url.pathname !== "/" ||
    url.search.length > 0
  ) {
    return null;
  }

  const parts = url.hash.slice(1).split("/");
  if (parts.length !== 3 || parts[0] !== "") {
    return null;
  }

  const environmentId = decodeThreadLinkSegment(parts[1] ?? "");
  const threadId = decodeThreadLinkSegment(parts[2] ?? "");
  return environmentId === null || threadId === null ? null : { environmentId, threadId };
}
