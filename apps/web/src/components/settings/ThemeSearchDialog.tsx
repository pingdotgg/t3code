import { CheckCircle2Icon, PaletteIcon, PlusIcon, SearchIcon, ShieldCheckIcon } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  importOpenVsxThemeExtension,
  searchOpenVsxThemes,
  type OpenVsxThemeExtension,
} from "../../openVsxThemes";
import {
  getCustomThemes,
  installCustomTheme,
  removeCustomTheme,
  type ThemeDefinition,
} from "../../themePalette";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";

const DOWNLOAD_FORMAT = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const SUGGESTED_SEARCHES = ["Dracula", "Catppuccin", "Nord", "Tokyo Night"];

export function ThemeSearchDialog({
  open,
  onOpenChange,
  onInstalled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled: (themes: ReadonlyArray<ThemeDefinition>) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReadonlyArray<OpenVsxThemeExtension> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    if (!open) return;
    setQuery("");
    setResults(null);
    setError(null);
    setIsSearching(false);
    setInstallingId(null);
  }, [open]);

  const runSearch = useCallback(async (searchText: string) => {
    const trimmed = searchText.trim();
    if (!trimmed) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setQuery(trimmed);
    setIsSearching(true);
    setError(null);
    setResults(null);
    try {
      const nextResults = await searchOpenVsxThemes(trimmed, controller.signal);
      if (!controller.signal.aborted) setResults(nextResults);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "Open VSX search failed.");
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setIsSearching(false);
      }
    }
  }, []);

  const handleSearch = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void runSearch(query);
    },
    [query, runSearch],
  );

  const handleInstall = useCallback(
    async (extension: OpenVsxThemeExtension) => {
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      setInstallingId(extension.id);
      setError(null);
      try {
        const themes = await importOpenVsxThemeExtension(extension, controller.signal);
        if (controller.signal.aborted) return;
        const existingIds = new Set(getCustomThemes().map((theme) => theme.id));
        const duplicates = themes.filter((theme) => existingIds.has(theme.id));
        if (duplicates.length > 0) {
          throw new Error(`${duplicates.map((theme) => theme.label).join(", ")} is already added.`);
        }

        const installed: ThemeDefinition[] = [];
        try {
          for (const theme of themes) installed.push(installCustomTheme(theme));
        } catch (cause) {
          for (const theme of installed) {
            try {
              removeCustomTheme(theme.id);
            } catch {
              // Best effort rollback. The original storage failure is clearer.
            }
          }
          throw cause;
        }
        onInstalled(installed);
        onOpenChange(false);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "That theme could not be added.");
        }
      } finally {
        if (requestRef.current === controller) {
          requestRef.current = null;
          setInstallingId(null);
        }
      }
    },
    [onInstalled, onOpenChange],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) requestRef.current?.abort();
        onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-2xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Search themes</DialogTitle>
          <DialogDescription>
            Find community themes from Open VSX and add them in one click.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <form className="relative flex gap-2" onSubmit={handleSearch}>
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search Open VSX themes"
              className="rounded-xl [&_input]:pl-9"
              autoFocus
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="try dracula, nord, catppuccin..."
              size="lg"
              type="search"
              value={query}
            />
            <Button disabled={!query.trim() || isSearching || installingId !== null} type="submit">
              {isSearching ? <Spinner /> : <SearchIcon />}
              Search
            </Button>
          </form>

          {error ? (
            <div
              aria-live="polite"
              className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm"
            >
              {error}
            </div>
          ) : null}

          {results === null && !isSearching ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-border/70 bg-muted/15 px-6 text-center">
              <div>
                <p className="text-sm font-medium">What theme are you looking for?</p>
                <p className="mt-1 text-muted-foreground text-xs">
                  Only themes with a supported open-source license are shown.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTED_SEARCHES.map((suggestion) => (
                  <Button
                    key={suggestion}
                    size="xs"
                    variant="outline"
                    onClick={() => void runSearch(suggestion)}
                  >
                    {suggestion}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}

          {isSearching ? (
            <div className="flex min-h-48 items-center justify-center gap-2 text-muted-foreground text-sm">
              <Spinner /> Finding themes...
            </div>
          ) : null}

          {results ? (
            results.length === 0 ? (
              <div className="flex min-h-40 flex-col items-center justify-center rounded-2xl border border-dashed text-center">
                <p className="text-sm font-medium">No supported open-source themes found</p>
                <p className="mt-1 text-muted-foreground text-xs">Try a broader search.</p>
              </div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {results.map((extension) => {
                  const isInstalling = installingId === extension.id;
                  return (
                    <article
                      className="group flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-card/60 p-3 transition-colors hover:bg-accent/20"
                      key={extension.id}
                    >
                      <div className="flex min-w-0 gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                          <PaletteIcon className="size-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <h4 className="truncate text-sm font-medium">{extension.name}</h4>
                          <p className="truncate text-muted-foreground text-xs">
                            {extension.publisher} ·{" "}
                            {DOWNLOAD_FORMAT.format(extension.downloadCount)} downloads
                          </p>
                        </div>
                      </div>
                      <p className="line-clamp-2 min-h-8 text-muted-foreground text-xs leading-4">
                        {extension.description || "A community color theme for your editor."}
                      </p>
                      <div className="mt-auto flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1 text-muted-foreground text-[11px]">
                          <ShieldCheckIcon className="size-3" /> {extension.license}
                        </span>
                        <Button
                          disabled={installingId !== null}
                          size="xs"
                          variant="outline"
                          onClick={() => void handleInstall(extension)}
                        >
                          {isInstalling ? <Spinner /> : <PlusIcon />}
                          {isInstalling ? "Adding..." : "Add"}
                        </Button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )
          ) : null}

          <div className="flex items-center justify-center gap-1.5 text-muted-foreground text-[11px]">
            <CheckCircle2Icon className="size-3" /> Sourced from Open VSX, with license and package
            integrity checks
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
