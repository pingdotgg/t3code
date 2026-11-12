export interface ProjectFaviconRequest {
  readonly cacheKey: string;
  readonly faviconUrl: string;
}

interface ActiveFaviconRequests {
  readonly urls: Map<string, number>;
  currentUrl: string;
}

const MAX_LOADED_FAVICONS = 256;
const activeFaviconRequests = new Map<string, ActiveFaviconRequests>();
const loadedFaviconKeys = new Map<string, true>();

export function createProjectFaviconRequest(
  cacheKey: string,
  faviconUrl: string,
): ProjectFaviconRequest;
export function createProjectFaviconRequest(
  cacheKey: string | null,
  faviconUrl: string | null,
): ProjectFaviconRequest | null;
export function createProjectFaviconRequest(cacheKey: string | null, faviconUrl: string | null) {
  if (!cacheKey || !faviconUrl) return null;
  return { cacheKey, faviconUrl };
}

export function beginProjectFaviconRequest(request: ProjectFaviconRequest) {
  let activeRequests = activeFaviconRequests.get(request.cacheKey);
  if (!activeRequests) {
    activeRequests = { currentUrl: request.faviconUrl, urls: new Map() };
    activeFaviconRequests.set(request.cacheKey, activeRequests);
  }

  const activeCount = activeRequests.urls.get(request.faviconUrl) ?? 0;
  activeRequests.urls.delete(request.faviconUrl);
  activeRequests.urls.set(request.faviconUrl, activeCount + 1);
  activeRequests.currentUrl = request.faviconUrl;

  let ended = false;
  return () => {
    if (ended) return;
    ended = true;

    const remainingCount = (activeRequests.urls.get(request.faviconUrl) ?? 1) - 1;
    if (remainingCount > 0) {
      activeRequests.urls.set(request.faviconUrl, remainingCount);
      return;
    }

    activeRequests.urls.delete(request.faviconUrl);
    if (activeRequests.urls.size === 0) {
      if (activeFaviconRequests.get(request.cacheKey) === activeRequests) {
        activeFaviconRequests.delete(request.cacheKey);
      }
      return;
    }

    if (activeRequests.currentUrl === request.faviconUrl) {
      activeRequests.currentUrl = Array.from(activeRequests.urls.keys()).at(-1)!;
    }
  };
}

export function hasLoadedProjectFavicon(cacheKey: string | null) {
  return cacheKey !== null && loadedFaviconKeys.has(cacheKey);
}

function isCurrentProjectFaviconRequest(request: ProjectFaviconRequest) {
  return activeFaviconRequests.get(request.cacheKey)?.currentUrl === request.faviconUrl;
}

function rememberLoadedProjectFavicon(cacheKey: string) {
  loadedFaviconKeys.delete(cacheKey);
  loadedFaviconKeys.set(cacheKey, true);

  if (loadedFaviconKeys.size > MAX_LOADED_FAVICONS) {
    loadedFaviconKeys.delete(loadedFaviconKeys.keys().next().value!);
  }
}

export function markProjectFaviconLoaded(request: ProjectFaviconRequest) {
  if (!isCurrentProjectFaviconRequest(request)) return false;

  rememberLoadedProjectFavicon(request.cacheKey);
  return true;
}

export function markProjectFaviconFailed(request: ProjectFaviconRequest) {
  if (!isCurrentProjectFaviconRequest(request)) return false;

  loadedFaviconKeys.delete(request.cacheKey);
  return true;
}
