export interface WorkspaceWebPreviewLoadRequest {
  readonly url: string;
  readonly isTopFrame?: boolean;
  readonly navigationType?: string;
}

export type WorkspaceWebPreviewNavigationDecision =
  | { readonly action: "allow" }
  | { readonly action: "open-pdf"; readonly url: string }
  | { readonly action: "open-external"; readonly url: string }
  | { readonly action: "block" };

const withoutFragment = (url: string) => url.split("#", 1)[0];

const isHttpProtocol = (protocol: string) => protocol === "http:" || protocol === "https:";

const parseUrl = (raw: string): URL | null => {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

export function decideWorkspaceWebPreviewNavigation(
  request: WorkspaceWebPreviewLoadRequest,
  initialUri: string,
): WorkspaceWebPreviewNavigationDecision {
  const initialUrl = parseUrl(initialUri);
  const requestUrl = parseUrl(request.url);
  if (initialUrl === null || requestUrl === null) {
    return { action: "block" };
  }

  const isHttp = isHttpProtocol(requestUrl.protocol);
  if (request.isTopFrame === false) {
    if (
      isHttp ||
      requestUrl.href === "about:blank" ||
      requestUrl.href === "about:srcdoc" ||
      requestUrl.protocol === "blob:"
    ) {
      return { action: "allow" };
    }
    return { action: "block" };
  }

  const isSameDocument = withoutFragment(requestUrl.href) === withoutFragment(initialUrl.href);
  if (requestUrl.protocol === "file:") {
    return initialUrl.protocol === "file:" && isSameDocument
      ? { action: "allow" }
      : { action: "block" };
  }

  if (!isHttp) {
    return { action: "block" };
  }

  if (isSameDocument) {
    return { action: "allow" };
  }

  const isSameOrigin =
    isHttpProtocol(initialUrl.protocol) && requestUrl.origin === initialUrl.origin;
  if (isSameOrigin && /\.pdf$/i.test(requestUrl.pathname)) {
    return { action: "open-pdf", url: requestUrl.href };
  }

  if (request.navigationType === "click") {
    return { action: "open-external", url: requestUrl.href };
  }

  return { action: "block" };
}

export function shouldStartWorkspaceWebPreviewLoad(
  request: WorkspaceWebPreviewLoadRequest,
  initialUri: string,
): boolean {
  return decideWorkspaceWebPreviewNavigation(request, initialUri).action === "allow";
}
