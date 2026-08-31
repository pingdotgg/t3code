import { ChevronRightIcon, ExternalLinkIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  decodeThirdPartyLicenseManifest,
  filterThirdPartyLicenseEntries,
  formatLicenseBundles,
  type ThirdPartyLicenseEntry,
  type ThirdPartyLicenseManifest,
} from "@t3tools/shared/thirdPartyLicenses";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsPageContainer } from "./settingsLayout";

type LicenseManifestState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly manifest: ThirdPartyLicenseManifest };

async function loadLicenseManifest(signal: AbortSignal): Promise<ThirdPartyLicenseManifest> {
  const response = await fetch(
    `${import.meta.env.BASE_URL.replace(/\/$/, "")}/third-party-licenses.json`,
    { signal },
  );
  if (!response.ok) {
    throw new Error(`The license manifest request failed with status ${String(response.status)}.`);
  }
  return decodeThirdPartyLicenseManifest((await response.json()) as unknown);
}

function LicenseNoticeRow({ entry }: { readonly entry: ThirdPartyLicenseEntry }) {
  const [open, setOpen] = useState(false);
  const panelId = `license-notice-${encodeURIComponent(`${entry.kind}-${entry.name}-${entry.version ?? "custom"}`)}`;
  const versionLabel = entry.version ? ` ${entry.version}` : "";

  return (
    <article>
      <button
        type="button"
        aria-controls={panelId}
        aria-expanded={open}
        className="cursor-pointer flex min-h-14 w-full items-start gap-3 px-3 py-3 text-left hover:bg-foreground/4 sm:px-4"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-150",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="min-w-0 break-words font-medium text-foreground">{entry.name}</span>
            {entry.version ? (
              <code className="font-medium text-muted-foreground">{entry.version}</code>
            ) : null}
          </span>
          <span className="text-muted-foreground">
            {entry.license} · {formatLicenseBundles(entry.bundles)}
          </span>
        </span>
      </button>
      {open ? (
        <div
          id={panelId}
          className="border-t border-foreground/10 bg-foreground/2 px-3 py-4 sm:px-4"
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-medium text-foreground sm:text-sm">
                {entry.name}
                {versionLabel}
              </h2>
              {entry.sourceUrl ? (
                <a
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-base font-medium text-muted-foreground hover:bg-foreground/5 hover:text-foreground sm:text-sm"
                  href={entry.sourceUrl}
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  Project source
                  <ExternalLinkIcon aria-hidden className="size-4 shrink-0" />
                </a>
              ) : null}
            </div>
            <pre className="max-w-full whitespace-pre-wrap break-words font-mono text-base/7 text-foreground/85 sm:text-sm/6">
              {entry.noticeText}
            </pre>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function LicenseManifestError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 border-y border-foreground/10 px-3 py-5 sm:px-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium text-foreground sm:text-sm">
          Open-source notices are unavailable
        </h2>
        <p className="max-w-[70ch] text-pretty text-base/7 text-muted-foreground sm:text-sm/6">
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
  const [state, setState] = useState<LicenseManifestState>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [requestVersion, setRequestVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void loadLicenseManifest(controller.signal).then(
      (manifest) => setState({ status: "ready", manifest }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "The license manifest could not load.",
        });
      },
    );
    return () => controller.abort();
  }, [requestVersion]);

  const entries = state.status === "ready" ? state.manifest.entries : [];
  const filteredEntries = useMemo(
    () => filterThirdPartyLicenseEntries(entries, query),
    [entries, query],
  );
  const retry = useCallback(() => setRequestVersion((value) => value + 1), []);

  return (
    <SettingsPageContainer width="wide" className="gap-6">
      <header className="flex flex-col gap-2 px-3 sm:px-4">
        <h1 className="text-balance text-2xl font-semibold tracking-tight text-foreground">
          Open source licenses
        </h1>
        <p className="max-w-[70ch] text-pretty text-base/7 text-muted-foreground sm:text-sm/6">
          Third-party notices for dependencies and assets included in T3 Code.
        </p>
      </header>

      {state.status === "ready" ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 px-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
            <label className="relative min-w-0 flex-1 sm:max-w-sm">
              <SearchIcon
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 z-1 size-4 shrink-0 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                nativeInput
                type="search"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search packages"
                aria-label="Search open-source licenses"
                className="[&_[data-slot=input]]:pl-8"
              />
            </label>
            <p className="text-base text-muted-foreground tabular-nums sm:text-sm">
              {filteredEntries.length === entries.length
                ? `${String(entries.length)} notices`
                : `${String(filteredEntries.length)} of ${String(entries.length)} notices`}
            </p>
          </div>

          <div className="overflow-hidden rounded-xl border border-foreground/10 divide-y divide-foreground/10 text-base sm:text-sm">
            {filteredEntries.length > 0 ? (
              filteredEntries.map((entry) => (
                <LicenseNoticeRow
                  key={`${entry.kind}:${entry.name}:${entry.version ?? "custom"}`}
                  entry={entry}
                />
              ))
            ) : (
              <p className="px-3 py-8 text-center text-base/7 text-muted-foreground sm:px-4 sm:text-sm/6">
                No licenses match that search.
              </p>
            )}
          </div>
        </div>
      ) : state.status === "error" ? (
        <LicenseManifestError message={state.message} onRetry={retry} />
      ) : (
        <p className="border-y border-foreground/10 px-3 py-5 text-base/7 text-muted-foreground sm:px-4 sm:text-sm/6">
          Loading open-source notices…
        </p>
      )}
    </SettingsPageContainer>
  );
}
