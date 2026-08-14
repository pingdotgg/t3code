import { DesktopDeepLinkTarget, EnvironmentId, ThreadId } from "@t3tools/contracts";

type DesktopOpenUrlEvent = {
  readonly preventDefault: () => void;
};

export function createDesktopOpenUrlBuffer() {
  let pendingUrl: string | null = null;
  let listener: ((url: string) => void) | null = null;

  return {
    handle(event: DesktopOpenUrlEvent, url: string) {
      event.preventDefault();
      if (listener === null) {
        pendingUrl = url;
        return;
      }
      listener(url);
    },
    subscribe(next: (url: string) => void) {
      listener = next;
      if (pendingUrl !== null) {
        const url = pendingUrl;
        pendingUrl = null;
        next(url);
      }
      return () => {
        if (listener === next) listener = null;
      };
    },
  };
}

export const desktopOpenUrlBuffer = createDesktopOpenUrlBuffer();

export function parseDesktopDeepLink(
  value: string,
  expectedScheme: string,
): DesktopDeepLinkTarget | null {
  if (value.trim() !== value) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (
    url.protocol !== `${expectedScheme}:` ||
    url.hostname !== "threads" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    return null;
  }

  const parts = url.pathname.split("/");
  if (parts.length !== 3 || parts[0] !== "") return null;

  try {
    const environmentId = decodeURIComponent(parts[1] ?? "");
    const threadId = decodeURIComponent(parts[2] ?? "");
    if (
      environmentId.length === 0 ||
      threadId.length === 0 ||
      environmentId.trim() !== environmentId ||
      threadId.trim() !== threadId
    ) {
      return null;
    }

    return {
      type: "thread",
      environmentId: EnvironmentId.make(environmentId),
      threadId: ThreadId.make(threadId),
    };
  } catch {
    return null;
  }
}

export function findDesktopDeepLink(
  values: ReadonlyArray<string>,
  expectedScheme: string,
): DesktopDeepLinkTarget | null {
  for (const value of values) {
    const target = parseDesktopDeepLink(value, expectedScheme);
    if (target !== null) return target;
  }
  return null;
}

export function filterDesktopDeepLinkArguments(
  values: ReadonlyArray<string>,
  expectedScheme: string,
): string[] {
  return values.filter((value) => parseDesktopDeepLink(value, expectedScheme) === null);
}
