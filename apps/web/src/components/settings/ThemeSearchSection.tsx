import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { ExternalLinkIcon, PackagePlusIcon, PaletteIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
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
import { translateMessage, type MessageKey } from "@t3tools/client-runtime/i18n";
import { getUiLocale, useT } from "../../hooks/useI18n";

const DOWNLOAD_FORMAT = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const SUGGESTED_SEARCHES = ["Dracula", "Catppuccin", "Nord", "Tokyo Night"];
const SORT_OPTIONS: ReadonlyArray<{ value: OpenVsxThemeSort; label: MessageKey }> = [
  { value: "downloadCount", label: "settings.system.themeSearch.sort.downloadCount" },
  { value: "rating", label: "settings.system.themeSearch.sort.rating" },
  { value: "timestamp", label: "settings.system.themeSearch.sort.timestamp" },
  { value: "relevance", label: "settings.system.themeSearch.sort.relevance" },
];

function translateNow(key: MessageKey): string {
  try {
    return translateMessage(getUiLocale(), key);
  } catch {
    return translateMessage("en", key);
  }
}
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
    <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
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

export interface ThemeSearchView {
  readonly setResults: (results: ReadonlyArray<OpenVsxThemeExtension> | null) => void;
  readonly setError: (error: string | null) => void;
  readonly setIsSearching: (isSearching: boolean) => void;
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
    void search(query, { signal: controller.signal, sortBy })
      .then(
        (results) => {
          if (controller.signal.aborted) return;
          view.setResults(results);
          shownKey = key;
        },
        (cause: unknown) => {
          if (controller.signal.aborted) return;
          view.setResults(null);
          shownKey = null;
          view.setError(
            cause instanceof Error
              ? cause.message
              : translateNow("settings.system.themeSearch.searchFailed"),
          );
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
    if (shouldFetch || keyChanged) view.setError(null);
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
  const t = useT();
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<OpenVsxThemeSort>("downloadCount");
  const [results, setResults] = useState<ReadonlyArray<OpenVsxThemeExtension> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<OpenVsxThemeExtension | null>(null);
  const [themeSearch] = useState(() =>
    createThemeSearch({ setResults, setError, setIsSearching }, signal),
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
    let installedCollection: ReadonlyArray<ThemeDefinition>;
    try {
      installedCollection = getStoredCustomThemeCollection(extension.collectionId);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("settings.system.themeSearch.readFailed"),
      );
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
        setError(
          cause instanceof Error ? cause.message : t("settings.system.themeSearch.addFailed"),
        );
      }
    }
    if (themeSearch.endInstall(installSignal)) setInstallingId(null);
  };

  return (
    <section className="space-y-3" aria-labelledby="theme-search-heading">
      <div>
        <h3 className="text-sm font-medium" id="theme-search-heading">
          {t("settings.system.themeSearch.heading")}
        </h3>
        <p className="mt-0.5 text-muted-foreground text-xs">
          {t("settings.system.themeSearch.subheading")}
        </p>
      </div>
      <InputGroup>
        <InputGroupAddon>
          {isSearching ? <Spinner aria-hidden /> : <SearchIcon aria-hidden />}
        </InputGroupAddon>
        <InputGroupInput
          aria-label={t("settings.system.themeSearch.searchAria")}
          autoFocus
          onChange={(event) => changeQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter" && !isSearching && installingId === null)
              themeSearch.searchNow();
          }}
          placeholder={t("settings.system.themeSearch.placeholder")}
          size="lg"
          type="search"
          value={query}
        />
      </InputGroup>

      {!isSearching || results !== null ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <p className="text-muted-foreground text-xs">
              {t("settings.system.themeSearch.popular")}
            </p>
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
            <div className="flex shrink-0 items-center justify-end gap-2">
              <p className="text-muted-foreground text-xs">
                {t("settings.system.themeSearch.sortLabel")}
              </p>
              <Select
                disabled={installingId !== null}
                value={sortBy}
                onValueChange={handleSortChange}
              >
                <SelectTrigger
                  size="sm"
                  className="w-40"
                  aria-label={t("settings.system.themeSearch.sortAria")}
                >
                  <SelectValue>
                    {(() => {
                      const sortLabel = SORT_OPTIONS.find(
                        (option) => option.value === sortBy,
                      )?.label;
                      return sortLabel ? t(sortLabel) : null;
                    })()}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {SORT_OPTIONS.map((option) => (
                    <SelectItem key={option.value} hideIndicator value={option.value}>
                      {t(option.label)}
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
          ? t("settings.system.themeSearch.searching")
          : results
            ? t(
                results.length === 1
                  ? "settings.system.themeSearch.foundOne"
                  : "settings.system.themeSearch.foundMany",
                { count: results.length },
              )
            : ""}
      </div>

      {error ? (
        <Alert variant="error" role="status" aria-live="polite">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {isSearching && results === null ? (
        <div className="flex min-h-20 items-center justify-center gap-2 text-muted-foreground text-sm">
          <Spinner /> {t("settings.system.themeSearch.searching")}
        </div>
      ) : null}

      {results ? (
        results.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center rounded-2xl border border-dashed text-center">
            <p className="text-sm font-medium">{t("settings.system.themeSearch.noneTitle")}</p>
            <p className="mt-1 text-muted-foreground text-xs">
              {t("settings.system.themeSearch.noneBody")}
            </p>
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {results.map((extension) => {
              const isInstalling = installingId === extension.id;
              const isInstalled = getCustomThemes().some(
                (theme) => theme.collection?.id === extension.collectionId,
              );
              const action = isInstalled
                ? t("settings.system.themeSearch.update")
                : t("settings.system.themeSearch.install");
              const progressAction = isInstalled
                ? t("settings.system.themeSearch.updating")
                : t("settings.system.themeSearch.installing");
              return (
                <article
                  className="group flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-card/60 p-3 transition-colors hover:bg-accent/20"
                  key={extension.id}
                >
                  <div className="flex min-w-0 gap-3">
                    <ThemeExtensionIcon key={extension.iconUrl} extension={extension} />
                    <div className="min-w-0 flex-1">
                      <h4 className="truncate text-sm font-medium">{extension.name}</h4>
                      <p className="truncate text-muted-foreground text-xs">
                        {t("settings.system.themeSearch.downloads", {
                          publisher: extension.publisher,
                          count: DOWNLOAD_FORMAT.format(extension.downloadCount),
                        })}
                      </p>
                    </div>
                  </div>
                  <p className="line-clamp-2 min-h-8 text-muted-foreground text-xs leading-4">
                    {extension.description || t("settings.system.themeSearch.defaultDescription")}
                  </p>
                  <div className="mt-auto flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {extension.sourceUrl ? (
                        <Button
                          aria-label={t("settings.system.themeSearch.viewSourceAria", {
                            name: extension.name,
                          })}
                          render={<a href={extension.sourceUrl} rel="noreferrer" target="_blank" />}
                          size="icon-micro"
                          variant="ghost-muted"
                        >
                          {sourceLinkIcon(extension.sourceUrl)}
                        </Button>
                      ) : null}
                    </div>
                    <Button
                      aria-label={t("settings.system.themeSearch.actionAria", {
                        action: isInstalling ? progressAction : action,
                        name: extension.name,
                      })}
                      disabled={installingId !== null}
                      size="xs"
                      variant="outline"
                      onClick={() => void handleInstall(extension, false)}
                    >
                      {isInstalling ? (
                        <Spinner />
                      ) : isInstalled ? (
                        <RefreshIcon />
                      ) : (
                        <PackagePlusIcon />
                      )}
                      {isInstalling
                        ? t("settings.system.themeSearch.progress", { action: progressAction })
                        : action}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )
      ) : null}

      <AlertDialog
        open={pendingUpdate !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setPendingUpdate(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.system.themeSearch.updateQ", { name: pendingUpdate?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.system.themeSearch.updateBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {t("settings.system.themeSearch.cancel")}
            </AlertDialogClose>
            <Button
              onClick={() => {
                const extension = pendingUpdate;
                setPendingUpdate(null);
                if (extension) void handleInstall(extension, true);
              }}
            >
              {t("settings.system.themeSearch.updateTheme")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
