import {
  CheckCircle2Icon,
  PaletteIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
} from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  importOpenVsxThemeExtension,
  searchOpenVsxThemes,
  type OpenVsxThemeExtension,
} from "../../openVsxThemes";
import {
  getCustomThemes,
  replaceCustomThemeCollection,
  type ThemeDefinition,
} from "../../themePalette";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";

const DOWNLOAD_FORMAT = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const SUGGESTED_SEARCHES = ["Dracula", "Catppuccin", "Nord", "Tokyo Night"];

export function ThemeSearchSection({
  open,
  onInstalled,
}: {
  open: boolean;
  onInstalled: (themes: ReadonlyArray<ThemeDefinition>, context: { updated: boolean }) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReadonlyArray<OpenVsxThemeExtension> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<OpenVsxThemeExtension | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    if (open) {
      setQuery("");
      setResults(null);
      setError(null);
      setIsSearching(false);
      setInstallingId(null);
      setPendingUpdate(null);
    }
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
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
    async (extension: OpenVsxThemeExtension, allowUpdate: boolean) => {
      const updated = getCustomThemes().some(
        (theme) => theme.collection?.id === extension.collectionId,
      );
      if (updated && !allowUpdate) {
        setPendingUpdate(extension);
        return;
      }

      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      setInstallingId(extension.id);
      setError(null);
      try {
        const themes = await importOpenVsxThemeExtension(extension, controller.signal);
        if (controller.signal.aborted) return;
        const imported = replaceCustomThemeCollection(extension.collectionId, themes);
        onInstalled(imported, { updated });
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
    [onInstalled],
  );

  return (
    <section className="space-y-3" aria-labelledby="theme-search-heading">
      <div>
        <h3 className="text-sm font-medium" id="theme-search-heading">
          Search community themes
        </h3>
        <p className="mt-0.5 text-muted-foreground text-xs">
          Find open-source themes from Open VSX.
        </p>
      </div>
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
        <Button
          disabled={!query.trim() || isSearching || installingId !== null}
          type="submit"
          variant="outline"
        >
          {isSearching ? <Spinner /> : <SearchIcon />}
          Search
        </Button>
      </form>

      <div className="sr-only" role="status">
        {isSearching
          ? "Finding themes..."
          : results
            ? `${results.length} supported ${results.length === 1 ? "theme" : "themes"} found.`
            : ""}
      </div>

      {error ? (
        <div
          aria-live="polite"
          className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm"
        >
          {error}
        </div>
      ) : null}

      {results === null && !isSearching ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-muted-foreground text-xs">Popular</span>
          {SUGGESTED_SEARCHES.map((suggestion) => (
            <Button
              key={suggestion}
              size="xs"
              variant="ghost"
              onClick={() => void runSearch(suggestion)}
            >
              {suggestion}
            </Button>
          ))}
        </div>
      ) : null}

      {isSearching ? (
        <div className="flex min-h-20 items-center justify-center gap-2 text-muted-foreground text-sm">
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
              const isInstalled = getCustomThemes().some(
                (theme) => theme.collection?.id === extension.collectionId,
              );
              const action = isInstalled ? "Update" : "Add";
              const progressAction = isInstalled ? "Updating" : "Adding";
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
                        {extension.publisher} · {DOWNLOAD_FORMAT.format(extension.downloadCount)}{" "}
                        downloads
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
                      aria-label={`${isInstalling ? progressAction : action} ${extension.name}`}
                      disabled={installingId !== null}
                      size="xs"
                      variant="outline"
                      onClick={() => void handleInstall(extension, false)}
                    >
                      {isInstalling ? <Spinner /> : isInstalled ? <RefreshCwIcon /> : <PlusIcon />}
                      {isInstalling ? `${progressAction}...` : action}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )
      ) : null}

      <div className="flex items-center gap-1.5 text-muted-foreground text-[11px]">
        <CheckCircle2Icon className="size-3" /> Licensed themes only, with package integrity checks
      </div>

      <AlertDialog
        open={pendingUpdate !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setPendingUpdate(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Update “{pendingUpdate?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This replaces its installed variants, including any local edits. Variants no longer in
              the extension will be removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                const extension = pendingUpdate;
                setPendingUpdate(null);
                if (extension) void handleInstall(extension, true);
              }}
            >
              Update theme
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
