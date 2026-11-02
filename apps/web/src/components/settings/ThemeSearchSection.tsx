import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  ExternalLinkIcon,
  PackagePlusIcon,
  PaletteIcon,
  SearchIcon,
  SearchXIcon,
  WifiOffIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import {
  importOpenVsxThemeExtension,
  searchOpenVsxThemes,
  type OpenVsxThemeExtension,
  type OpenVsxThemeSort,
} from "../../openVsxThemes";
import {
  getCustomThemes,
  getStoredCustomThemeCollection,
  replaceCustomThemeCollection,
  type ThemeDefinition,
} from "../../themePalette";
import { sourceControlIcon } from "../../sourceControlPresentation";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";

const DOWNLOAD_FORMAT = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const SUGGESTED_SEARCHES = ["Dracula", "Catppuccin", "Nord", "Tokyo Night"];
const SORT_OPTIONS: ReadonlyArray<{ value: OpenVsxThemeSort; label: string }> = [
  { value: "downloadCount", label: "Most downloaded" },
  { value: "rating", label: "Best rated" },
  { value: "timestamp", label: "Newest" },
  { value: "relevance", label: "Most relevant" },
];
const SEARCH_DEBOUNCE_MS = 350;

function sourceHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function sourceLinkIcon(url: string): ReactNode {
  const host = sourceHost(url);
  const definition = host === null ? undefined : sourceControlClients.findByPublicDomain(host);
  const Icon = definition ? sourceControlIcon(definition) : ExternalLinkIcon;
  return <Icon className="size-3.5" />;
}

function ThemeExtensionIcon({ extension }: { extension: OpenVsxThemeExtension }) {
  const [failed, setFailed] = useState(false);

  return (
    <div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-dim-foreground">
      {extension.iconUrl && !failed ? (
        <img
          alt=""
          className="size-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          src={extension.iconUrl}
          onError={() => setFailed(true)}
        />
      ) : (
        <PaletteIcon className="size-4" />
      )}
    </div>
  );
}

/** Empty, loading and unreachable states, in the same bordered box as the
 *  add-a-theme file list so the dialog keeps one shape whatever it shows. */
function SearchStateBox({
  icon,
  title,
  description,
  action,
  role,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  role?: "status";
}) {
  return (
    <div
      role={role}
      className="flex flex-col items-center gap-1.5 rounded-xl border border-border/60 px-4 py-6 text-center"
    >
      <span className="text-muted-foreground [&_svg]:size-5">{icon}</span>
      <p className="text-label">{title}</p>
      {description ? <p className="text-meta text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-1.5">{action}</div> : null}
    </div>
  );
}

/** A fetch that never reached Open VSX, as opposed to one it answered badly. */
function isUnreachableError(cause: unknown): boolean {
  return (
    (typeof navigator !== "undefined" && navigator.onLine === false) ||
    (cause instanceof TypeError && /fetch|network|load failed/i.test(cause.message))
  );
}

export interface ThemeSearchView {
  readonly setResults: (results: ReadonlyArray<OpenVsxThemeExtension> | null) => void;
  readonly setError: (error: string | null) => void;
  readonly setIsSearching: (isSearching: boolean) => void;
  readonly setSearchFailure?: (failure: { query: string; unreachable: boolean } | null) => void;
}

type SearchThemes = typeof searchOpenVsxThemes;

/**
 * Owns one dialog session's Open VSX traffic: the input debounce, the request in
 * flight, and which key the shown results belong to. Aborting `signal` (the
 * dialog closing) cancels all of it, including an install.
 */
export function createThemeSearch(
  view: ThemeSearchView,
  signal: AbortSignal,
  search: SearchThemes = searchOpenVsxThemes,
) {
  let query = "";
  let sortBy: OpenVsxThemeSort = "downloadCount";
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let request: AbortController | null = null;
  let install: AbortController | null = null;
  // Record successful searches only; rerun after install only for changed query/sort to preserve install
  // errors.
  let shownKey: string | null = null;
  let handledKey: string | null = null;
  let interrupted = false;

  const keyOf = () => `${query}\u0000${sortBy}`;
  const abortRequest = () => {
    request?.abort();
    request = null;
  };
  const cancelDebounce = () => {
    if (debounce !== null) clearTimeout(debounce);
    debounce = null;
  };

  const fetchResults = () => {
    abortRequest();
    const controller = new AbortController();
    request = controller;
    const key = keyOf();
    const searchQuery = query;
    void search(searchQuery, { signal: controller.signal, sortBy })
      .then(
        (results) => {
          if (controller.signal.aborted) return;
          view.setSearchFailure?.(null);
          view.setResults(results);
          shownKey = key;
        },
        (cause: unknown) => {
          if (controller.signal.aborted) return;
          view.setSearchFailure?.({ query: searchQuery, unreachable: isUnreachableError(cause) });
          view.setResults(null);
          shownKey = null;
          view.setError(cause instanceof Error ? cause.message : "Open VSX search failed.");
        },
      )
      .then(() => {
        if (request !== controller) return;
        request = null;
        view.setIsSearching(false);
      });
  };

  const clear = () => {
    cancelDebounce();
    abortRequest();
    shownKey = null;
    handledKey = null;
    view.setResults(null);
    view.setError(null);
    view.setSearchFailure?.(null);
    view.setIsSearching(false);
  };

  const settle = () => {
    if (install !== null || signal.aborted || query === "") return;
    const key = keyOf();
    const keyChanged = handledKey !== key;
    if (!keyChanged && !interrupted) return;
    handledKey = key;
    interrupted = false;
    const shouldFetch = shownKey !== key;
    if (shouldFetch || keyChanged) {
      view.setError(null);
      view.setSearchFailure?.(null);
    }
    view.setIsSearching(shouldFetch);
    if (shouldFetch) fetchResults();
    else abortRequest();
  };

  signal.addEventListener(
    "abort",
    () => {
      cancelDebounce();
      abortRequest();
      install?.abort();
    },
    { once: true },
  );

  return {
    /** An unsettled query would hit Open VSX for text that is no longer visible, so typing waits. */
    setQuery(nextQuery: string) {
      const trimmed = nextQuery.trim();
      if (trimmed === query) return;
      query = trimmed;
      cancelDebounce();
      if (trimmed === "") {
        if (install === null) clear();
        return;
      }
      debounce = setTimeout(() => {
        debounce = null;
        settle();
      }, SEARCH_DEBOUNCE_MS);
    },
    setSortBy(nextSort: OpenVsxThemeSort) {
      sortBy = nextSort;
      if (debounce === null) settle();
    },
    /** Enter or re-picking the current suggestion searches again even for the shown key. */
    searchNow() {
      if (install !== null || signal.aborted || query === "") return;
      // A pending debounce for the same key would otherwise restart this search.
      cancelDebounce();
      handledKey = keyOf();
      interrupted = false;
      view.setError(null);
      view.setSearchFailure?.(null);
      view.setIsSearching(true);
      fetchResults();
    },
    beginInstall(): AbortSignal {
      abortRequest();
      install?.abort();
      install = new AbortController();
      interrupted = true;
      view.setIsSearching(false);
      return install.signal;
    },
    endInstall(installSignal: AbortSignal): boolean {
      if (install?.signal !== installSignal) return false;
      install = null;
      if (query === "") clear();
      else if (debounce === null) settle();
      return true;
    },
  };
}

export function ThemeSearchSection({
  signal,
  onInstalled,
}: {
  signal: AbortSignal;
  onInstalled: (themes: ReadonlyArray<ThemeDefinition>, context: { updated: boolean }) => void;
}) {
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<OpenVsxThemeSort>("downloadCount");
  const [results, setResults] = useState<ReadonlyArray<OpenVsxThemeExtension> | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Search failures replace the results area; install failures sit above the
  // results, which stay usable.
  const [searchFailure, setSearchFailure] = useState<{
    query: string;
    unreachable: boolean;
  } | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<OpenVsxThemeExtension | null>(null);
  const [themeSearch] = useState(() =>
    createThemeSearch({ setResults, setError, setIsSearching, setSearchFailure }, signal),
  );

  const changeQuery = (nextQuery: string) => {
    setQuery(nextQuery);
    themeSearch.setQuery(nextQuery);
  };

  const handleSortChange = (value: OpenVsxThemeSort | null) => {
    const nextSort = SORT_OPTIONS.find((option) => option.value === value)?.value;
    if (!nextSort) return;
    setSortBy(nextSort);
    themeSearch.setSortBy(nextSort);
  };

  const handleInstall = async (extension: OpenVsxThemeExtension, allowUpdate: boolean) => {
    setError(null);
    setSearchFailure(null);
    let installedCollection: ReadonlyArray<ThemeDefinition>;
    try {
      installedCollection = getStoredCustomThemeCollection(extension.collectionId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Installed themes could not be read.");
      return;
    }
    const updated = installedCollection.length > 0;
    if (updated && !allowUpdate) {
      setPendingUpdate(extension);
      return;
    }

    const installSignal = themeSearch.beginInstall();
    setInstallingId(extension.id);
    try {
      const themes = await importOpenVsxThemeExtension(extension, installSignal);
      if (!installSignal.aborted) {
        const imported = replaceCustomThemeCollection(extension.collectionId, themes, {
          expectedCollection: installedCollection,
        });
        onInstalled(imported, { updated });
      }
    } catch (cause) {
      if (!installSignal.aborted) {
        setError(cause instanceof Error ? cause.message : "That theme could not be added.");
      }
    }
    if (themeSearch.endInstall(installSignal)) setInstallingId(null);
  };

  return (
    <section className="space-y-3" aria-labelledby="theme-search-heading">
      <div>
        <h3 className="text-label text-strong-foreground" id="theme-search-heading">
          Search community themes
        </h3>
        <p className="mt-0.5 text-meta text-muted-foreground">
          Find open-source themes from Open VSX.
        </p>
      </div>
      <InputGroup>
        <InputGroupAddon>
          {isSearching ? <Spinner aria-hidden /> : <SearchIcon aria-hidden />}
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Search Open VSX themes"
          autoFocus
          onChange={(event) => changeQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter" && !isSearching && installingId === null)
              themeSearch.searchNow();
          }}
          placeholder="Search themes..."
          size="lg"
          type="search"
          value={query}
        />
      </InputGroup>

      {!isSearching || results !== null ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <p className="text-meta text-dim-foreground">Popular</p>
            {SUGGESTED_SEARCHES.map((suggestion) => (
              <Button
                key={suggestion}
                disabled={installingId !== null}
                size="xs"
                variant="ghost"
                onClick={() => {
                  if (query.trim() === suggestion) {
                    themeSearch.searchNow();
                  } else {
                    changeQuery(suggestion);
                  }
                }}
              >
                {suggestion}
              </Button>
            ))}
          </div>
          {results && results.length > 0 ? (
            <div className="ml-auto flex shrink-0 items-center justify-end gap-2">
              <p className="text-meta text-dim-foreground">Sort</p>
              <Select
                disabled={installingId !== null}
                value={sortBy}
                onValueChange={handleSortChange}
              >
                <SelectTrigger size="sm" className="w-44" aria-label="Sort themes">
                  <SelectValue>
                    {SORT_OPTIONS.find((option) => option.value === sortBy)?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {SORT_OPTIONS.map((option) => (
                    <SelectItem key={option.value} hideIndicator value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="sr-only" role="status">
        {isSearching
          ? "Searching themes..."
          : results
            ? `${results.length} supported ${results.length === 1 ? "theme" : "themes"} found.`
            : ""}
      </div>

      {error && !searchFailure ? (
        <Alert variant="error" role="status" aria-live="polite">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {error && searchFailure && !isSearching ? (
        <SearchStateBox
          role="status"
          action={
            <Button
              size="xs"
              variant="secondary"
              onClick={() => {
                changeQuery(searchFailure.query);
                themeSearch.searchNow();
              }}
            >
              <RefreshIcon />
              Try again
            </Button>
          }
          description={searchFailure.unreachable ? "Check your connection, then try again." : error}
          icon={<WifiOffIcon />}
          title={searchFailure.unreachable ? "Can’t reach Open VSX" : "Search didn’t finish"}
        />
      ) : isSearching && results === null ? (
        <SearchStateBox icon={<Spinner />} title="Searching Open VSX…" />
      ) : results === null ? (
        <SearchStateBox
          description="Type a name or pick a popular one."
          icon={<PaletteIcon />}
          title="Open-source VS Code themes"
        />
      ) : results.length === 0 ? (
        <SearchStateBox
          description="Only open-source color themes show up. Try a broader search."
          icon={<SearchXIcon />}
          title={`No themes match “${query.trim()}”`}
        />
      ) : (
        <ul className="divide-y divide-border/50 rounded-xl border border-border/60">
          {results.map((extension) => {
            const isInstalling = installingId === extension.id;
            const isInstalled = getCustomThemes().some(
              (theme) => theme.collection?.id === extension.collectionId,
            );
            const action = isInstalled ? "Update" : "Install";
            const progressAction = isInstalled ? "Updating" : "Installing";
            return (
              <li className="flex min-w-0 items-center gap-2.5 px-3 py-2.5" key={extension.id}>
                <ThemeExtensionIcon key={extension.iconUrl} extension={extension} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-label">{extension.name}</p>
                  <p className="truncate text-meta text-muted-foreground">
                    {extension.publisher} · {DOWNLOAD_FORMAT.format(extension.downloadCount)}{" "}
                    downloads
                    {extension.description ? ` · ${extension.description}` : ""}
                  </p>
                </div>
                {extension.sourceUrl ? (
                  <Button
                    aria-label={`View source for ${extension.name}`}
                    render={<a href={extension.sourceUrl} rel="noreferrer" target="_blank" />}
                    size="icon-micro"
                    variant="ghost-muted"
                  >
                    {sourceLinkIcon(extension.sourceUrl)}
                  </Button>
                ) : null}
                <Button
                  aria-label={`${isInstalling ? progressAction : action} ${extension.name}`}
                  disabled={installingId !== null}
                  size="xs"
                  variant="secondary"
                  onClick={() => void handleInstall(extension, false)}
                >
                  {isInstalling ? <Spinner /> : isInstalled ? <RefreshIcon /> : <PackagePlusIcon />}
                  {isInstalling ? `${progressAction}...` : action}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

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
            <AlertDialogClose render={<Button variant="secondary" />}>Cancel</AlertDialogClose>
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
