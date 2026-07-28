import type {
  EnvironmentId,
  HermesSessionDiscoveryResult,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  DEFAULT_HERMES_SESSION_IMPORT_AGE_DAYS,
  MAX_HERMES_SESSION_IMPORT_AGE_DAYS,
  MIN_HERMES_SESSION_IMPORT_AGE_DAYS,
} from "@t3tools/contracts";
import { LoaderCircleIcon } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { hermesEnvironment } from "../state/hermes";
import { useAtomCommand } from "../state/use-atom-command";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { stackedThreadToast, toastManager } from "./ui/toast";
import {
  describeHermesImportStatus,
  hermesTransportLabel,
  summarizeHermesImportSessions,
} from "./HermesImportOnboarding.logic";

interface HermesImportOnboardingProps {
  readonly environmentId: EnvironmentId | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly backingProjectId: ProjectId | null;
  readonly autoOpenEnabled: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

function failureDescription(result: { readonly cause: unknown }): string {
  const error = squashAtomCommandFailure(result as Parameters<typeof squashAtomCommandFailure>[0]);
  return error instanceof Error ? error.message : "Hermes conversations could not be loaded.";
}

export function HermesImportOnboarding(props: HermesImportOnboardingProps) {
  const discover = useAtomCommand(hermesEnvironment.discoverSessions, {
    reportFailure: false,
  });
  const importSessions = useAtomCommand(hermesEnvironment.importSessions, {
    reportFailure: false,
  });
  const [discovery, setDiscovery] = useState<HermesSessionDiscoveryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [activeWithinDays, setActiveWithinDays] = useState(DEFAULT_HERMES_SESSION_IMPORT_AGE_DAYS);
  const ageSliderId = useId();
  const autoCheckedKeyRef = useRef<string | null>(null);
  const discoveryRequestIdRef = useRef(0);

  const loadDiscovery = useCallback(
    async (autoOpen: boolean) => {
      if (props.environmentId === null || props.providerInstanceId === null) return;
      const requestId = ++discoveryRequestIdRef.current;
      setDiscovery(null);
      setLoading(true);
      const result = await discover({
        environmentId: props.environmentId,
        input: { providerInstanceId: props.providerInstanceId, limit: 10_000 },
      });
      if (requestId !== discoveryRequestIdRef.current) return;
      setLoading(false);
      if (result._tag === "Success") {
        setDiscovery(result.value);
        if (autoOpen && result.value.mainThreadId === null) props.onOpenChange(true);
        return;
      }
      if (!isAtomCommandInterrupted(result) && !autoOpen) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not load Hermes conversations",
            description: failureDescription(result),
          }),
        );
      }
    },
    [discover, props.environmentId, props.onOpenChange, props.providerInstanceId],
  );

  useEffect(
    () => () => {
      discoveryRequestIdRef.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (
      !props.autoOpenEnabled ||
      props.environmentId === null ||
      props.providerInstanceId === null ||
      props.backingProjectId === null
    ) {
      return;
    }
    const key = `${props.environmentId}:${props.providerInstanceId}`;
    if (autoCheckedKeyRef.current === key) return;
    autoCheckedKeyRef.current = key;
    void loadDiscovery(true);
  }, [
    loadDiscovery,
    props.autoOpenEnabled,
    props.backingProjectId,
    props.environmentId,
    props.providerInstanceId,
  ]);

  useEffect(() => {
    if (props.open) void loadDiscovery(false);
  }, [loadDiscovery, props.open]);

  const summary = useMemo(
    () => summarizeHermesImportSessions(discovery?.sessions ?? [], activeWithinDays, Date.now()),
    [activeWithinDays, discovery],
  );
  const ageLabel = `${activeWithinDays} ${activeWithinDays === 1 ? "day" : "days"}`;
  const importStatus = describeHermesImportStatus(summary, ageLabel);

  const runImport = useCallback(async () => {
    if (
      props.environmentId === null ||
      props.providerInstanceId === null ||
      props.backingProjectId === null
    ) {
      return;
    }
    setImporting(true);
    const result = await importSessions({
      environmentId: props.environmentId,
      input: {
        providerInstanceId: props.providerInstanceId,
        backingProjectId: props.backingProjectId,
        selection: { type: "all" },
        activeWithinDays,
        ensureMain: true,
      },
    });
    setImporting(false);
    if (result._tag === "Success") {
      const newlyImported = result.value.imported.filter(
        (item) => item.status === "imported",
      ).length;
      props.onOpenChange(false);
      toastManager.add({
        type: "success",
        title: newlyImported === 0 ? "Hermes is up to date" : "Hermes conversations imported",
        description:
          newlyImported === 0
            ? "No new transport conversations were found for this Hermes profile."
            : `${newlyImported} conversation${newlyImported === 1 ? "" : "s"} added to T3 Work.`,
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Hermes import failed",
          description: failureDescription(result),
        }),
      );
    }
  }, [
    importSessions,
    activeWithinDays,
    props.backingProjectId,
    props.environmentId,
    props.onOpenChange,
    props.providerInstanceId,
  ]);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-[30rem]">
        <DialogHeader className="gap-1.5 p-5 pb-3 pe-12 max-sm:p-5 max-sm:pb-3">
          <DialogTitle className="text-lg">Import Hermes conversations</DialogTitle>
          <DialogDescription>
            Choose how far back to bring this profile’s transport history into T3 Work.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4 px-5 pt-1 pb-4">
          {loading && discovery === null ? (
            <div
              aria-live="polite"
              className="flex min-h-28 items-center justify-center gap-2 text-sm text-muted-foreground"
              role="status"
            >
              <LoaderCircleIcon className="size-4 animate-spin" />
              Looking for conversations…
            </div>
          ) : (
            <>
              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-4">
                  <label className="text-sm font-medium text-foreground" htmlFor={ageSliderId}>
                    Started within
                  </label>
                  <output
                    className="rounded-md bg-muted px-2 py-1 font-mono text-xs font-medium tabular-nums text-foreground"
                    htmlFor={ageSliderId}
                  >
                    {ageLabel}
                  </output>
                </div>
                <input
                  aria-valuetext={ageLabel}
                  className="block w-full accent-foreground"
                  id={ageSliderId}
                  max={MAX_HERMES_SESSION_IMPORT_AGE_DAYS}
                  min={MIN_HERMES_SESSION_IMPORT_AGE_DAYS}
                  onChange={(event) => setActiveWithinDays(Number(event.currentTarget.value))}
                  step={1}
                  type="range"
                  value={activeWithinDays}
                />
                <div
                  aria-hidden="true"
                  className="flex justify-between text-[11px] text-muted-foreground"
                >
                  <span>{MIN_HERMES_SESSION_IMPORT_AGE_DAYS} day</span>
                  <span>{MAX_HERMES_SESSION_IMPORT_AGE_DAYS} days</span>
                </div>
              </div>

              <div aria-live="polite" className="border-t border-border/60 pt-3">
                <p className="text-sm font-medium text-foreground">{importStatus.title}</p>
                <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
                  {importStatus.description}
                </p>
                {summary.total === 0 ? (
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Messaging transports appear after this profile has sessions.
                  </p>
                ) : null}
              </div>

              {summary.transports.length > 0 ? (
                <div className="flex items-start gap-3 text-xs">
                  <span className="shrink-0 pt-0.5 font-medium text-muted-foreground">
                    Transports
                  </span>
                  <ul className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-foreground">
                    {summary.transports.map((transport) => (
                      <li key={transport.source}>
                        {hermesTransportLabel(transport.source)}{" "}
                        <span className="tabular-nums text-muted-foreground">
                          {transport.count}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {discovery?.capabilities.activityTimestamp.limitation ? (
                <p className="border-t border-border/60 pt-3 text-xs leading-5 text-muted-foreground">
                  {discovery.capabilities.activityTimestamp.limitation}
                </p>
              ) : null}
            </>
          )}
        </DialogPanel>
        <DialogFooter variant="bare" className="px-5 pt-2 pb-5">
          <Button variant="ghost" onClick={() => props.onOpenChange(false)} disabled={importing}>
            Cancel
          </Button>
          <Button onClick={() => void runImport()} disabled={loading || importing}>
            {importing ? <LoaderCircleIcon className="animate-spin" /> : null}
            {summary.total === 0
              ? "Set up T3 Work"
              : summary.ready === 0
                ? "Check for updates"
                : "Import conversations"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
