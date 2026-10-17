import { useAtomSet } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type CivilizationEffectiveConfig,
  type CivilizationProjectDataExport,
  type CivilizationPurgePreview,
  type CivilizationPurgeProgress,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useState } from "react";

import { civilizationDataAction, refreshCivilizationOverview } from "../../state/civilization";
import { readEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { SettingsRow, SettingsSection } from "./settingsLayout";

interface RetentionPolicy {
  readonly noteRetentionDays: number;
  readonly diagnosticRetentionDays: number;
  readonly tombstoneRetentionDays: number;
}

interface RetentionPreview {
  readonly projectId: ProjectId;
  readonly previewToken: string;
  readonly environmentRevision: number;
  readonly projectRevision: number;
  readonly current: RetentionPolicy;
  readonly configured: RetentionPolicy;
  readonly proposed: RetentionPolicy;
  readonly newlyEligible: {
    readonly resolvedNotes: number;
    readonly resolvedNoteBodyBytes: number;
    readonly diagnosticReferences: number;
    readonly diagnosticInspections: number;
    readonly tombstones: number;
  };
  readonly samples: {
    readonly noteIds: ReadonlyArray<string>;
    readonly contextReferenceIds: ReadonlyArray<string>;
    readonly contextInspectionIds: ReadonlyArray<string>;
    readonly tombstoneThreadIds: ReadonlyArray<string>;
    readonly partial: boolean;
  };
  readonly warnings: ReadonlyArray<string>;
}

const describeError = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    if ("message" in error && typeof error.message === "string") return error.message;
    if ("_tag" in error && error._tag === "CivilizationPurgeConflictError") {
      return "The purge preview is stale. Review a new preview before trying again.";
    }
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The Civilization data operation could not be completed.";
};

function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function PolicySummary({
  label,
  policy,
}: {
  readonly label: string;
  readonly policy: RetentionPolicy;
}) {
  return (
    <div className="rounded-lg border border-border/70 p-3 text-xs text-muted-foreground">
      <div className="mb-1 font-medium text-foreground">{label}</div>
      <div>Resolved notes: {policy.noteRetentionDays} days</div>
      <div>Diagnostics: {policy.diagnosticRetentionDays} days</div>
      <div>Tombstones: {policy.tombstoneRetentionDays} days</div>
    </div>
  );
}

export function CivilizationDataRetention({
  environmentId,
  projectId,
  environmentLabel,
  effective,
  enabled,
  refreshProjectData,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly environmentLabel: string;
  readonly effective: CivilizationEffectiveConfig;
  readonly enabled: boolean;
  readonly refreshProjectData: () => void;
}) {
  const runDataAction = useAtomSet(civilizationDataAction, { mode: "promise" });
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<CivilizationProjectDataExport | null>(null);
  const [retentionPolicy, setRetentionPolicy] = useState<RetentionPolicy | null>(null);
  const [retentionPreview, setRetentionPreview] = useState<RetentionPreview | null>(null);
  const [retentionConfirmOpen, setRetentionConfirmOpen] = useState(false);
  const [purgePreview, setPurgePreview] = useState<CivilizationPurgePreview | null>(null);
  const [purgeConfirmOpen, setPurgeConfirmOpen] = useState(false);
  const [purgeProgress, setPurgeProgress] = useState<CivilizationPurgeProgress | null>(null);

  const requirePermission = (): boolean => {
    if (readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return true;
    setMessage("Permission changed; settings:write is required for this operation.");
    return false;
  };

  const refreshAfterMutation = () => {
    refreshCivilizationOverview(environmentId, projectId);
    refreshProjectData();
  };

  const exportProject = () => {
    if (working || !enabled || !requirePermission()) return;
    setWorking(true);
    setMessage(null);
    void runDataAction({ environmentId, projectId, type: "export" })
      .then((result) => {
        setWorking(false);
        const exported = result as CivilizationProjectDataExport;
        setExportResult(exported);
        downloadJson(`civilization-${projectId}.json`, exported);
      })
      .catch((error: unknown) => {
        setWorking(false);
        setMessage(describeError(error));
      });
  };

  const loadRetention = () => {
    if (working || !enabled || !requirePermission()) return;
    setWorking(true);
    setMessage(null);
    void runDataAction({ environmentId, projectId, type: "retentionGet" })
      .then((result) => {
        setWorking(false);
        setRetentionPolicy(result as RetentionPolicy);
      })
      .catch((error: unknown) => {
        setWorking(false);
        setMessage(describeError(error));
      });
  };

  const previewRetention = () => {
    if (working || !enabled || !requirePermission()) return;
    setWorking(true);
    setMessage(null);
    void runDataAction({ environmentId, projectId, type: "retentionPreview" })
      .then((result) => {
        setWorking(false);
        setRetentionPreview(result as RetentionPreview);
        setRetentionConfirmOpen(true);
      })
      .catch((error: unknown) => {
        setWorking(false);
        setMessage(describeError(error));
      });
  };

  const applyRetention = () => {
    if (working || retentionPreview === null || !requirePermission()) return;
    const expectedPreviewToken = retentionPreview.previewToken;
    setWorking(true);
    setMessage(null);
    void runDataAction({
      environmentId,
      projectId,
      type: "retentionApply",
      expectedPreviewToken,
    })
      .then((result) => {
        setWorking(false);
        setRetentionConfirmOpen(false);
        setRetentionPreview(null);
        const applied = result as { readonly applied: RetentionPolicy };
        setRetentionPolicy(applied.applied);
        setMessage("Retention reduction applied. Eligible data will be removed by cleanup policy.");
        refreshAfterMutation();
      })
      .catch((error: unknown) => {
        setWorking(false);
        setRetentionConfirmOpen(false);
        setRetentionPreview(null);
        setMessage(`${describeError(error)} Review a new preview before applying again.`);
      });
  };

  const previewPurge = () => {
    if (working || !enabled || !requirePermission()) return;
    setWorking(true);
    setMessage(null);
    setPurgeProgress(null);
    void runDataAction({ environmentId, projectId, type: "purgePreview" })
      .then((result) => {
        setWorking(false);
        setPurgePreview(result as CivilizationPurgePreview);
        setPurgeConfirmOpen(true);
      })
      .catch((error: unknown) => {
        setWorking(false);
        setMessage(describeError(error));
      });
  };

  const applyPurge = () => {
    if (working || purgePreview === null || !requirePermission()) return;
    const expectedPreviewToken = purgePreview.previewToken;
    const batchSize = effective.config.operations.cleanupBatch;
    setWorking(true);
    setMessage(null);

    const run = async () => {
      let progress: CivilizationPurgeProgress;
      do {
        if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
          throw new Error(
            "Permission changed during purge; settings:write is required to continue.",
          );
        }
        progress = (await runDataAction({
          environmentId,
          projectId,
          type: "purgeApply",
          expectedPreviewToken,
          batchSize,
        })) as CivilizationPurgeProgress;
        setPurgeProgress(progress);
      } while (!progress.complete);

      setWorking(false);
      setPurgeConfirmOpen(false);
      setPurgePreview(null);
      setMessage("Civilization project purge completed.");
      refreshAfterMutation();
    };

    void run().catch((error: unknown) => {
      setWorking(false);
      setPurgeConfirmOpen(false);
      setPurgePreview(null);
      setMessage(
        `${describeError(error)} The purge stopped; a new preview is required before continuing.`,
      );
    });
  };

  return (
    <SettingsSection title="Data & retention" id="civilization-data-retention">
      {!enabled ? (
        <SettingsRow
          title="Advanced project operations"
          description="Select one writable environment before export, retention, or purge operations."
          control={<span className="text-sm text-muted-foreground">Choose environment</span>}
        />
      ) : (
        <>
          <SettingsRow
            title="Project data export"
            description="Downloads a typed inspection/backup JSON. It is explicitly not a restorable project snapshot."
            control={
              <Button size="sm" variant="outline" disabled={working} onClick={exportProject}>
                Export JSON
              </Button>
            }
          />
          {exportResult === null ? null : (
            <div className="space-y-1 px-3 text-xs text-muted-foreground sm:px-4">
              <div>Inspection/backup only · restorable: no</div>
              <div>Excluded: {exportResult.limitations.excluded.join(", ") || "None listed"}</div>
            </div>
          )}

          <SettingsRow
            title="Applied retention policy"
            description="Read the currently applied policy separately from the configured policy."
            control={
              <Button size="sm" variant="outline" disabled={working} onClick={loadRetention}>
                Read policy
              </Button>
            }
          />
          {retentionPolicy === null ? null : (
            <div className="px-3 sm:px-4">
              <PolicySummary label="Applied policy" policy={retentionPolicy} />
            </div>
          )}

          <SettingsRow
            title="Reduce retention"
            description="Preview newly eligible data first. Apply always uses the exact preview token you reviewed."
            control={
              <Button size="sm" variant="outline" disabled={working} onClick={previewRetention}>
                Preview reduction
              </Button>
            }
          />

          <SettingsRow
            title="Purge Civilization project data"
            description="Destructive and batched. Preview counts and erasure limitations before any deletion begins."
            control={
              <Button size="sm" variant="destructive" disabled={working} onClick={previewPurge}>
                Preview purge
              </Button>
            }
          />
          {purgeProgress === null ? null : (
            <div className="px-3 text-xs text-muted-foreground sm:px-4">
              {purgeProgress.progressState}: deleted {purgeProgress.deletedThisBatch} this batch;{" "}
              {purgeProgress.remaining} remaining.
            </div>
          )}
        </>
      )}
      {message === null ? null : (
        <div className="px-3 text-sm text-muted-foreground sm:px-4">{message}</div>
      )}

      <Dialog open={retentionConfirmOpen} onOpenChange={setRetentionConfirmOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Apply retention reduction?</DialogTitle>
            <DialogDescription>
              Project {projectId} on {environmentLabel}. The exact reviewed preview token will be
              applied once; conflicts do not auto-preview or retry.
            </DialogDescription>
          </DialogHeader>
          {retentionPreview === null ? null : (
            <DialogPanel>
              <div className="grid gap-2 sm:grid-cols-3">
                <PolicySummary label="Current" policy={retentionPreview.current} />
                <PolicySummary label="Configured" policy={retentionPreview.configured} />
                <PolicySummary label="Proposed" policy={retentionPreview.proposed} />
              </div>
              <div className="text-sm">
                Newly eligible: {retentionPreview.newlyEligible.resolvedNotes} resolved notes (
                {retentionPreview.newlyEligible.resolvedNoteBodyBytes} bytes),{" "}
                {retentionPreview.newlyEligible.diagnosticReferences} diagnostic references,{" "}
                {retentionPreview.newlyEligible.diagnosticInspections} context inspections,{" "}
                {retentionPreview.newlyEligible.tombstones} tombstones.
              </div>
              <div className="text-xs text-muted-foreground">
                Samples: notes {retentionPreview.samples.noteIds.join(", ") || "none"}; contexts{" "}
                {retentionPreview.samples.contextReferenceIds.join(", ") || "none"}; tombstones{" "}
                {retentionPreview.samples.tombstoneThreadIds.join(", ") || "none"}
                {retentionPreview.samples.partial ? " · sample list is partial" : ""}.
              </div>
              {retentionPreview.warnings.map((warning) => (
                <div key={warning} className="text-sm text-destructive">
                  {warning}
                </div>
              ))}
            </DialogPanel>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRetentionConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={working || retentionPreview === null}
              onClick={applyRetention}
            >
              Apply reduction
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog open={purgeConfirmOpen} onOpenChange={setPurgeConfirmOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Purge Civilization project data?</DialogTitle>
            <DialogDescription>
              Destructive purge for project {projectId} on {environmentLabel}. This does not claim
              system-wide erasure: provider transcripts, copied data, and backups follow their own
              stores.
            </DialogDescription>
          </DialogHeader>
          {purgePreview === null ? null : (
            <DialogPanel>
              <div className="grid gap-2 text-sm sm:grid-cols-2">
                <div>Citizens: {purgePreview.counts.citizens}</div>
                <div>
                  Notes: {purgePreview.counts.notes} ({purgePreview.counts.noteBodyBytes} bytes)
                </div>
                <div>
                  Messages: {purgePreview.counts.messages} ({purgePreview.counts.messageBodyBytes}{" "}
                  bytes)
                </div>
                <div>Context references: {purgePreview.counts.contextReferences}</div>
                <div>Receipts: {purgePreview.counts.receipts}</div>
                <div>Quota windows: {purgePreview.counts.quotaWindows}</div>
              </div>
              <div className="text-xs text-muted-foreground">
                Not erased by this operation:{" "}
                {purgePreview.limitations.excluded.join(", ") || "None listed"}.
              </div>
              {purgePreview.warnings.map((warning) => (
                <div key={warning} className="text-sm text-destructive">
                  {warning}
                </div>
              ))}
              {purgeProgress === null ? null : (
                <div className="text-sm">
                  Progress: {purgeProgress.deletedThisBatch} deleted this batch;{" "}
                  {purgeProgress.remaining} remaining.
                </div>
              )}
            </DialogPanel>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={working} onClick={() => setPurgeConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={working || purgePreview === null}
              onClick={applyPurge}
            >
              Purge this project
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}
