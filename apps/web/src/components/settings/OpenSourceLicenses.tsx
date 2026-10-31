import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
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
import { Badge } from "../ui/badge";
import {
  SettingsLoadingRows,
  SettingsNoMatches,
  SettingsPageContainer,
  SettingsSearchField,
  SettingsSection,
  SettingsToolbar,
} from "./settingsLayout";

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

/** Name over version and bundles, a license chip, and a chevron; the notice expands in place. */
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
        <CollapsibleTrigger className="group flex w-full min-w-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
          <span className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 hover:surface-ghost-hover">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-label text-foreground">{entry.name}</span>
              <span className="block truncate text-meta text-dim-foreground">
                {[entry.version, formatLicenseBundles(entry.bundles)].filter(Boolean).join(" · ")}
              </span>
            </span>
            <Badge
              variant="secondary"
              size="lg"
              className="min-w-0 max-w-2/5"
              title={entry.license}
            >
              <span className="truncate">{entry.license}</span>
            </Badge>
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 shrink-0 text-dim-foreground transition-transform duration-200 group-data-panel-open:rotate-90"
            />
          </span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          {open ? (
            <div className="space-y-3 px-4 pt-1 pb-4">
              {entry.sourceUrl ? (
                <Button
                  render={<a href={entry.sourceUrl} rel="noreferrer noopener" target="_blank" />}
                  size="xs"
                  variant="secondary"
                >
                  <ExternalLinkIcon aria-hidden />
                  Project source
                </Button>
              ) : null}
              <pre className="max-w-[76ch] whitespace-pre-wrap break-words font-mono text-xs/5 text-foreground">
                {entry.noticeText}
              </pre>
            </div>
          ) : null}
        </CollapsiblePanel>
      </article>
    </Collapsible>
  );
}

/** T3 Code's own repository and license, above the third-party notices. */
function ProjectSourceSection() {
  return (
    <SettingsSection title="Project source">
      <a
        href="https://github.com/pingdotgg/t3code"
        rel="noreferrer noopener"
        target="_blank"
        className="flex min-w-0 items-center gap-3 rounded-card px-4 py-3 outline-none hover:surface-ghost-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-label text-foreground">T3 Code</span>
          <span className="block truncate text-meta text-dim-foreground">pingdotgg/t3code</span>
        </span>
        <Badge variant="secondary" size="lg">
          MIT
        </Badge>
      </a>
    </SettingsSection>
  );
}

function LicenseManifestError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 px-3 py-5 sm:px-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-label text-foreground">Open-source notices are unavailable</h3>
        <p className="max-w-[70ch] text-pretty text-meta leading-normal text-muted-foreground">
          {message}
        </p>
      </div>
      <Button type="button" size="xs" variant="secondary" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export function OpenSourceLicensesPanel() {
  const result = useAtomValue(licenseManifestAtom);
  const retry = useAtomRefresh(licenseManifestAtom);
  const [query, setQuery] = useState("");
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
      <SettingsToolbar>
        <SettingsSearchField value={query} onChange={setQuery} placeholder="Search licenses" />
      </SettingsToolbar>
      <ProjectSourceSection />
      <SettingsSection title="Third-party notices">
        {manifest ? (
          <div className="divide-y divide-divider">
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
              <SettingsNoMatches onClear={() => setQuery("")}>
                No licenses match “{query.trim()}”.
              </SettingsNoMatches>
            )}
          </div>
        ) : errorMessage !== null ? (
          <LicenseManifestError message={errorMessage} onRetry={retry} />
        ) : (
          <SettingsLoadingRows label="Loading open-source notices" />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
