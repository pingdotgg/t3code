import { Clock3Icon, PauseIcon, PencilIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type {
  HermesCronJob,
  HermesCronMutationInput,
  HermesCronOperation,
  HermesCronProviderProjection,
} from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { usePrimaryEnvironment } from "../../state/environments";
import { hermesEnvironment } from "../../state/hermes";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { randomUUID } from "../../lib/utils";
import { T3_WORK_BACKING_PROJECT_ID } from "../../t3WorkProject";

interface Draft {
  readonly providerInstanceId: string;
  readonly jobIdentity: string | null;
  readonly name: string;
  readonly schedule: string;
  readonly prompt: string;
}

const EMPTY_DRAFT: Draft = {
  providerInstanceId: "",
  jobIdentity: null,
  name: "",
  schedule: "",
  prompt: "",
};

function reportFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
}

function capabilityFor(
  provider: HermesCronProviderProjection,
  operation: HermesCronOperation,
): boolean {
  switch (operation) {
    case "create":
      return provider.capabilities.create;
    case "edit":
      return provider.capabilities.edit;
    case "pause":
      return provider.capabilities.pause;
    case "resume":
      return provider.capabilities.resume;
    case "delete":
      return provider.capabilities.delete;
    case "run_now":
      return provider.capabilities.runNow;
  }
}

export function HermesCronSettings() {
  const environment = usePrimaryEnvironment();
  const query = useEnvironmentQuery(
    environment
      ? serverEnvironment.hermesCron({
          environmentId: environment.environmentId,
          input: {},
        })
      : null,
  );
  const mutate = useAtomCommand(serverEnvironment.mutateHermesCron, {
    label: "Hermes cron mutation",
  });
  const resetHistory = useAtomCommand(hermesEnvironment.resetHistory, {
    reportFailure: false,
  });
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resettingHistory, setResettingHistory] = useState(false);
  const [historyResetProviderId, setHistoryResetProviderId] = useState("");
  const providers = query.data?.providers ?? [];
  const readyProviders = useMemo(
    () => providers.filter((provider) => provider.status === "ready"),
    [providers],
  );

  const openCreate = useCallback(() => {
    const provider = readyProviders.find((candidate) => candidate.capabilities.create);
    if (!provider) return;
    setDraft({ ...EMPTY_DRAFT, providerInstanceId: provider.providerInstanceId });
    setDialogOpen(true);
  }, [readyProviders]);

  const openEdit = useCallback((provider: HermesCronProviderProjection, job: HermesCronJob) => {
    setDraft({
      providerInstanceId: provider.providerInstanceId,
      jobIdentity: job.identity,
      name: job.name ?? "",
      schedule: job.schedule ?? "",
      prompt: job.prompt ?? "",
    });
    setDialogOpen(true);
  }, []);

  const runMutation = useCallback(
    async (input: Omit<HermesCronMutationInput, "operationId">) => {
      if (!environment) return false;
      const result = await mutate({
        environmentId: environment.environmentId,
        input: { ...input, operationId: randomUUID() },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          reportFailure("Hermes cron operation failed", squashAtomCommandFailure(result));
        }
        return false;
      }
      query.refresh();
      return true;
    },
    [environment, mutate, query],
  );

  const submit = useCallback(async () => {
    if (saving || !draft.name.trim() || !draft.schedule.trim() || !draft.prompt.trim()) return;
    setSaving(true);
    const succeeded = await runMutation({
      providerInstanceId: draft.providerInstanceId,
      operation: draft.jobIdentity ? "edit" : "create",
      ...(draft.jobIdentity ? { jobIdentity: draft.jobIdentity } : {}),
      name: draft.name.trim(),
      schedule: draft.schedule.trim(),
      prompt: draft.prompt.trim(),
    });
    setSaving(false);
    if (succeeded) setDialogOpen(false);
  }, [draft, runMutation, saving]);

  const mutateJob = useCallback(
    async (
      provider: HermesCronProviderProjection,
      job: HermesCronJob,
      operation: Exclude<HermesCronOperation, "create" | "edit">,
    ) => {
      if (job.identityStrength === "missing" || !capabilityFor(provider, operation)) return;
      if (operation === "delete" && !window.confirm(`Delete ${job.name ?? job.identity}?`)) return;
      await runMutation({
        providerInstanceId: provider.providerInstanceId,
        operation,
        jobIdentity: job.identity,
      });
    },
    [runMutation],
  );

  const canCreate = readyProviders.some((provider) => provider.capabilities.create);
  const historyResetProvider =
    readyProviders.find((provider) => provider.providerInstanceId === historyResetProviderId) ??
    readyProviders[0] ??
    null;
  const runHistoryReset = useCallback(async () => {
    if (!environment || historyResetProvider === null || resettingHistory) return;
    setResettingHistory(true);
    const result = await resetHistory({
      environmentId: environment.environmentId,
      input: {
        providerInstanceId: ProviderInstanceId.make(historyResetProvider.providerInstanceId),
        backingProjectId: T3_WORK_BACKING_PROJECT_ID,
        operationId: randomUUID(),
      },
    });
    setResettingHistory(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Could not delete T3 Work history", squashAtomCommandFailure(result));
      }
      return;
    }
    setResetDialogOpen(false);
    toastManager.add({
      type: "success",
      title: "T3 Work history deleted",
      description:
        result.value.deletedThreadCount === 0
          ? "The import ledger was reset. You can run Hermes onboarding again."
          : `${result.value.deletedThreadCount} conversation${
              result.value.deletedThreadCount === 1 ? "" : "s"
            } removed. You can run Hermes onboarding again.`,
    });
  }, [environment, historyResetProvider, resetHistory, resettingHistory]);

  return (
    <SettingsPageContainer className="max-w-4xl">
      <SettingsSection
        title="Hermes native cron"
        icon={<Clock3Icon className="size-3.5" />}
        headerAction={
          <Button size="xs" variant="outline" disabled={!canCreate} onClick={openCreate}>
            <PlusIcon className="size-3.5" />
            New
          </Button>
        }
      >
        <div className="border-b border-border/60 px-5 py-3 text-xs text-muted-foreground">
          These jobs are read and managed directly in Hermes. They are never copied into T3
          scheduled tasks.
        </div>
        {query.error ? (
          <div className="px-5 py-4 text-xs text-destructive">{query.error}</div>
        ) : query.isPending && providers.length === 0 ? (
          <div className="px-5 py-8 text-center text-xs text-muted-foreground">
            Loading Hermes cron inventory…
          </div>
        ) : providers.length === 0 ? (
          <div className="px-5 py-8 text-center text-xs text-muted-foreground">
            No Hermes provider instances are configured.
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {providers.map((provider) => (
              <section key={provider.providerInstanceId} className="space-y-3 px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold">{provider.displayName}</h3>
                  <Badge variant={provider.status === "ready" ? "success" : "outline"}>
                    {provider.status}
                  </Badge>
                  <span className="text-[11px] text-muted-foreground">
                    Profile {provider.profileKey}
                  </span>
                </div>
                {provider.diagnostics.map((diagnostic) => (
                  <p key={diagnostic} className="text-[11px] text-muted-foreground">
                    {diagnostic}
                  </p>
                ))}
                {provider.jobs.length === 0 && provider.status === "ready" ? (
                  <p className="py-3 text-xs text-muted-foreground">No native cron jobs.</p>
                ) : (
                  <div className="space-y-2">
                    {provider.jobs.map((job) => {
                      const paused = job.enabled === false;
                      const addressable = job.identityStrength !== "missing";
                      return (
                        <div
                          key={job.identity}
                          className="grid gap-3 rounded-md border border-border/70 p-3 sm:grid-cols-[minmax(0,1fr)_auto]"
                        >
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-medium">
                                {job.name ?? job.id ?? "Unaddressable job"}
                              </span>
                              <Badge variant={paused ? "outline" : "success"}>
                                {paused ? "Paused" : job.enabled === true ? "Enabled" : "Unknown"}
                              </Badge>
                            </div>
                            <p className="font-mono text-[11px] text-muted-foreground">
                              {job.schedule ?? "Schedule unavailable"}
                            </p>
                            {job.prompt ? (
                              <p className="line-clamp-2 text-xs text-muted-foreground">
                                {job.prompt}
                              </p>
                            ) : null}
                            <p className="text-[11px] text-muted-foreground">
                              Executions: {job.executions.length}
                            </p>
                          </div>
                          <div className="flex items-start gap-1">
                            {provider.capabilities.edit ? (
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                disabled={!addressable}
                                aria-label="Edit Hermes cron job"
                                onClick={() => openEdit(provider, job)}
                              >
                                <PencilIcon className="size-3.5" />
                              </Button>
                            ) : null}
                            {paused && provider.capabilities.resume ? (
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                disabled={!addressable}
                                aria-label="Resume Hermes cron job"
                                onClick={() => void mutateJob(provider, job, "resume")}
                              >
                                <PlayIcon className="size-3.5" />
                              </Button>
                            ) : !paused && provider.capabilities.pause ? (
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                disabled={!addressable}
                                aria-label="Pause Hermes cron job"
                                onClick={() => void mutateJob(provider, job, "pause")}
                              >
                                <PauseIcon className="size-3.5" />
                              </Button>
                            ) : null}
                            {provider.capabilities.runNow ? (
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                disabled={!addressable}
                                aria-label="Run Hermes cron job now"
                                onClick={() => void mutateJob(provider, job, "run_now")}
                              >
                                <PlayIcon className="size-3.5" />
                              </Button>
                            ) : null}
                            {provider.capabilities.delete ? (
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                disabled={!addressable}
                                aria-label="Delete Hermes cron job"
                                onClick={() => void mutateJob(provider, job, "delete")}
                              >
                                <Trash2Icon className="size-3.5" />
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="T3 Work data" icon={<Trash2Icon className="size-3.5" />}>
        <SettingsRow
          title="Delete T3 Work profile history"
          description="Removes local T3 Work conversations owned by the selected Hermes profile and resets its import ledger. Source conversations are not deleted."
          control={
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={!environment || historyResetProvider === null || resettingHistory}
              onClick={() => setResetDialogOpen(true)}
            >
              <Trash2Icon className="size-3.5" />
              Delete history
            </Button>
          }
        />
      </SettingsSection>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {draft.jobIdentity ? "Edit Hermes cron job" : "New Hermes cron job"}
            </DialogTitle>
            <DialogDescription>Hermes owns this job and its execution schedule.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-4 py-4">
              {!draft.jobIdentity && readyProviders.length > 1 ? (
                <label className="block space-y-1 text-xs font-medium">
                  <span>Hermes provider</span>
                  <select
                    className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={draft.providerInstanceId}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        providerInstanceId: event.target.value,
                      }))
                    }
                  >
                    {readyProviders
                      .filter((provider) => provider.capabilities.create)
                      .map((provider) => (
                        <option
                          key={provider.providerInstanceId}
                          value={provider.providerInstanceId}
                        >
                          {provider.displayName}
                        </option>
                      ))}
                  </select>
                </label>
              ) : null}
              <label className="block space-y-1 text-xs font-medium">
                <span>Name</span>
                <Input
                  value={draft.name}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, name: event.target.value }))
                  }
                />
              </label>
              <label className="block space-y-1 text-xs font-medium">
                <span>Cron expression</span>
                <Input
                  className="font-mono"
                  placeholder="0 9 * * 1-5"
                  value={draft.schedule}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, schedule: event.target.value }))
                  }
                />
              </label>
              <label className="block space-y-1 text-xs font-medium">
                <span>Prompt</span>
                <Textarea
                  rows={5}
                  value={draft.prompt}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, prompt: event.target.value }))
                  }
                />
              </label>
            </div>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button
              size="sm"
              disabled={
                saving || !draft.name.trim() || !draft.schedule.trim() || !draft.prompt.trim()
              }
              onClick={() => void submit()}
            >
              {saving ? "Saving…" : "Save in Hermes"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this T3 Work profile history?</DialogTitle>
            <DialogDescription>
              This removes the selected Hermes profile’s owned T3 Work threads and resets their
              import state. It does not delete source conversations.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {readyProviders.length > 1 ? (
              <label className="block space-y-1.5 pt-4 text-sm">
                <span className="font-medium">Hermes profile</span>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3"
                  value={historyResetProvider?.providerInstanceId ?? ""}
                  onChange={(event) => setHistoryResetProviderId(event.target.value)}
                >
                  {readyProviders.map((provider) => (
                    <option key={provider.providerInstanceId} value={provider.providerInstanceId}>
                      {provider.displayName ?? provider.providerInstanceId}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <p className="py-4 text-sm text-muted-foreground">
              Afterward, use the import button in T3 Work to run onboarding and bring the source
              conversations back.
            </p>
          </DialogPanel>
          <DialogFooter>
            <DialogClose
              render={<Button variant="outline" size="sm" disabled={resettingHistory} />}
            >
              Cancel
            </DialogClose>
            <Button
              size="sm"
              variant="destructive"
              disabled={historyResetProvider === null || resettingHistory}
              onClick={() => void runHistoryReset()}
            >
              {resettingHistory ? "Deleting…" : "Delete profile history"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsPageContainer>
  );
}
