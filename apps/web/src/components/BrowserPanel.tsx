/* eslint-disable react/iframe-missing-sandbox -- allow-same-origin is intentional: enables Vite HMR WebSocket for localhost dev preview */
import { useCallback, useEffect, useRef, useState } from "react";
import { GlobeIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const BROWSER_URL_STORAGE_PREFIX = "t3code:browser-url";

function storageKeyForProject(projectId: string | undefined): string {
  return projectId ? `${BROWSER_URL_STORAGE_PREFIX}:${projectId}` : BROWSER_URL_STORAGE_PREFIX;
}

export function readBrowserUrl(projectId: string | undefined): string {
  try {
    return localStorage.getItem(storageKeyForProject(projectId)) ?? "";
  } catch {
    return "";
  }
}

export function saveBrowserUrl(projectId: string | undefined, url: string): void {
  try {
    localStorage.setItem(storageKeyForProject(projectId), url);
  } catch {
    // Ignore storage write failures (private mode, quota exceeded, etc.)
  }
}

interface BrowserPanelProps {
  mode?: "sidebar" | "sheet";
  projectId?: string | undefined;
}

export default function BrowserPanel({ mode: _mode = "sidebar", projectId }: BrowserPanelProps) {
  const [inputUrl, setInputUrl] = useState(() => readBrowserUrl(projectId));
  const [loadedUrl, setLoadedUrl] = useState(() => readBrowserUrl(projectId));
  const [refreshKey, setRefreshKey] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // When projectId changes, load that project's saved URL
  useEffect(() => {
    const url = readBrowserUrl(projectId);
    setInputUrl(url);
    setLoadedUrl(url);
    setRefreshKey((k) => k + 1);
  }, [projectId]);

  // Re-check localStorage shortly after mount — handles the race where auto-detection
  // saved a URL before this component mounted (lazy-loaded via Suspense).
  const loadedUrlRef = useRef(loadedUrl);
  loadedUrlRef.current = loadedUrl;
  useEffect(() => {
    const timer = setTimeout(() => {
      if (loadedUrlRef.current.length > 0) return;
      const url = readBrowserUrl(projectId);
      if (url.length === 0) return;
      setInputUrl(url);
      setLoadedUrl(url);
      setRefreshKey((k) => k + 1);
    }, 100);
    return () => clearTimeout(timer);
  }, [projectId]);

  // Listen for URL updates from dev server auto-detection (same-tab custom event)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId: string | undefined }>).detail;
      if (detail.projectId !== projectId) return;
      const url = readBrowserUrl(projectId);
      if (url === loadedUrl) return;
      setInputUrl(url);
      setLoadedUrl(url);
      setRefreshKey((k) => k + 1);
    };
    window.addEventListener("t3code:browser-url-updated", handler);
    return () => window.removeEventListener("t3code:browser-url-updated", handler);
  }, [projectId, loadedUrl]);

  const navigateTo = useCallback(
    (url: string) => {
      const trimmed = url.trim();
      const normalized = trimmed.startsWith("http") ? trimmed : `http://${trimmed}`;
      setLoadedUrl(normalized);
      setInputUrl(normalized);
      saveBrowserUrl(projectId, normalized);
      setRefreshKey((k) => k + 1);
    },
    [projectId],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    navigateTo(inputUrl);
  };

  const handleRefresh = () => {
    setRefreshKey((k) => k + 1);
  };

  const hasUrl = loadedUrl.length > 0;

  return (
    <div className="flex h-full flex-col bg-card text-foreground">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
        <form className="min-w-0 flex-1" onSubmit={handleSubmit}>
          <Input
            ref={inputRef}
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            className="h-7 text-xs"
            spellCheck={false}
            placeholder="http://localhost:3000"
            aria-label="Browser URL"
          />
        </form>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="shrink-0 text-muted-foreground/70 hover:text-foreground"
          onClick={handleRefresh}
          disabled={!hasUrl}
          aria-label="Refresh page"
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      {/* Content */}
      <div className="min-h-0 flex-1 bg-white">
        {hasUrl ? (
          <iframe
            key={refreshKey}
            src={loadedUrl}
            className="h-full w-full border-none"
            title="Browser preview"
            sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-pointer-lock"
          />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-center">
            <div className="space-y-2 text-muted-foreground">
              <GlobeIcon className="mx-auto size-8 opacity-30" />
              <p className="text-sm">No dev server running</p>
              <p className="text-xs opacity-70">
                Start a dev server script or type a URL above
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
