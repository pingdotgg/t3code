import { ChevronRightIcon, ExternalLinkIcon, SearchIcon } from "lucide-react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpClient } from "effect/http";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import {
  decodeThirdPartyLicenseManifest,
  filterThirdPartyLicenseEntries,
  formatLicenseBundles,
  thirdPartyLicenseEntryKey,
  type ThirdPartyLicenseEntry,
} from "@t3tools/shared/thirdPartyLicenses";

import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

class LicenseManifestLoadError extends Data.TaggedError("LicenseManifestLoadError")<{
  readonly message: string;
}> {}

// Not keepAlive: a failed load must not stick for the session, so each visit to the page loads
// the manifest again (a static asset the HTTP cache serves).
const licenseManifestAtom = Atom.make(
  Effect.gen(function* () {
    const response = yield* HttpClient.get(
      `${import.meta.env.BASE_URL.replace(/\/$/, "")}/third-party-licenses.json`,
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new LicenseManifestLoadError({
        message: `The license manifest request failed with status ${String(response.status)}.`,
      });
    }
    const body = yield* response.json;
    return yield* Effect.try({
      try: () => decodeThirdPartyLicenseManifest(body),
      catch: (error) =>
        new LicenseManifestLoadError({
          message: error instanceof Error ? error.message : "The license manifest could not load.",
        }),
    });
  }).pipe(
    Effect.catchTags({
      HttpClientError: (error) =>
        Effect.fail(new LicenseManifestLoadError({ message: error.message })),
    }),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(
          new LicenseManifestLoadError({ message: "The license manifest took too long to load." }),
        ),
    }),
    Effect.provide(FetchHttpClient.layer),
  ),
).pipe(Atom.withLabel("settings:open-source-licenses"));

function LicenseNoticeRow({
  entry,
  open,
  onOpenChange,
}: {
  readonly entry: ThirdPartyLicenseEntry;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <article>
        <div className="flex min-h-10 items-center hover:bg-muted/35 sm:min-h-9">
          <CollapsibleTrigger className="group flex min-h-10 min-w-0 flex-1 items-center gap-2.5 px-3 text-left sm:min-h-9 sm:px-4">
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-panel-open:rotate-90"
            />
            <span className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="truncate font-medium text-foreground">{entry.name}</span>
              {entry.version ? (
                <code className="shrink-0 text-xs text-muted-foreground">{entry.version}</code>
              ) : null}
            </span>
            <span className="max-w-[42%] shrink-0 truncate text-xs text-muted-foreground">
              {entry.license} · {formatLicenseBundles(entry.bundles)}
            </span>
          </CollapsibleTrigger>
          {entry.sourceUrl ? (
            <Button
              aria-label={`View project source for ${entry.name}`}
              className="me-3 shrink-0 sm:me-4"
              render={<a href={entry.sourceUrl} rel="noreferrer noopener" target="_blank" />}
              size="icon-micro"
              title="Project source"
              variant="ghost-muted"
            >
              <ExternalLinkIcon aria-hidden className="size-3" />
            </Button>
          ) : null}
        </div>
        <CollapsiblePanel>
          {open ? (
            <div className="px-9 pt-1 pb-4 sm:px-10">
              <pre className="max-w-[76ch] whitespace-pre-wrap break-words font-mono text-xs/5 text-foreground/80">
                {entry.noticeText}
              </pre>
            </div>
          ) : null}
        </CollapsiblePanel>
      </article>
    </Collapsible>
  );
}

function LicenseCount({
  filteredCount,
  totalCount,
}: {
  filteredCount: number;
  totalCount: number;
}) {
  return (
    <p className="whitespace-nowrap text-xs font-normal text-muted-foreground tabular-nums">
      {filteredCount === totalCount
        ? `${String(totalCount)} notices`
        : `${String(filteredCount)} of ${String(totalCount)}`}
    </p>
  );
}

function LicenseHeaderAction({
  query,
  onQueryChange,
  searchOpen,
  onSearchOpenChange,
  filteredCount,
  totalCount,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  filteredCount: number;
  totalCount: number;
}) {
  if (!searchOpen) {
    return (
      <div className="flex items-center gap-1.5">
        <LicenseCount filteredCount={filteredCount} totalCount={totalCount} />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Search open-source licenses"
                onClick={() => onSearchOpenChange(true)}
                size="icon-micro"
                type="button"
                variant="ghost-muted"
              >
                <SearchIcon className="size-3" />
              </Button>
            }
          />
          <TooltipPopup side="top">Search licenses</TooltipPopup>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="hidden sm:block">
        <LicenseCount filteredCount={filteredCount} totalCount={totalCount} />
      </div>
      <InputGroup className="w-36 sm:w-44">
        <InputGroupAddon>
          <SearchIcon aria-hidden className="size-3" />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Search open-source licenses"
          autoFocus
          onBlur={() => {
            if (query.length === 0) onSearchOpenChange(false);
          }}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            onQueryChange("");
            onSearchOpenChange(false);
          }}
          placeholder="Search licenses"
          size="sm"
          type="search"
          value={query}
        />
      </InputGroup>
    </div>
  );
}

function LicenseManifestError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 px-3 py-5 sm:px-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium text-foreground">Open-source notices are unavailable</h3>
        <p className="max-w-[70ch] text-pretty text-xs leading-normal text-muted-foreground/80">
          {message}
        </p>
      </div>
      <Button type="button" size="xs" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export function OpenSourceLicensesPanel() {
  const result = useAtomValue(licenseManifestAtom);
  const retry = useAtomRefresh(licenseManifestAtom);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [openEntryKey, setOpenEntryKey] = useState<string | null>(null);
  const manifest = result._tag === "Success" ? result.value : null;
  const entries = manifest?.entries ?? [];
  const filteredEntries = filterThirdPartyLicenseEntries(entries, query);
  const errorMessage =
    result._tag === "Failure" && !result.waiting
      ? Option.match(Cause.findErrorOption(result.cause), {
          onNone: () => "The license manifest could not load.",
          onSome: (error) => error.message,
        })
      : null;

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Third-party notices"
        headerAction={
          manifest ? (
            <LicenseHeaderAction
              query={query}
              onQueryChange={setQuery}
              searchOpen={searchOpen}
              onSearchOpenChange={setSearchOpen}
              filteredCount={filteredEntries.length}
              totalCount={entries.length}
            />
          ) : null
        }
      >
        {manifest ? (
          <div className="text-base sm:text-sm">
            {filteredEntries.length > 0 ? (
              filteredEntries.map((entry) => {
                const entryKey = thirdPartyLicenseEntryKey(entry);
                return (
                  <LicenseNoticeRow
                    key={entryKey}
                    entry={entry}
                    open={openEntryKey === entryKey}
                    onOpenChange={(open) => setOpenEntryKey(open ? entryKey : null)}
                  />
                );
              })
            ) : (
              <p className="px-3 py-8 text-center text-sm/6 text-muted-foreground sm:px-4">
                No licenses match that search.
              </p>
            )}
          </div>
        ) : errorMessage !== null ? (
          <LicenseManifestError message={errorMessage} onRetry={retry} />
        ) : (
          <p className="px-3 py-5 text-sm/6 text-muted-foreground sm:px-4">
            Loading open-source notices…
          </p>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
