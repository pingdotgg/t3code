import { LayersIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  describeSandboxTemplateNameProblem,
  type EnvironmentId,
  type SandboxProviderInfo,
  type SandboxRecord,
  type SandboxTemplate,
  type SandboxTemplateAllowance,
} from "@t3tools/contracts";

import { serverEnvironment } from "~/state/server";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { describeSandboxFailure, SandboxStartConfirmation } from "./SandboxStartLimits";
import { Alert, AlertDescription } from "../ui/alert";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";

const EMPTY_TEMPLATES: ReadonlyArray<SandboxTemplate> = [];

/** The provider's saved templates, for a configured provider that can save them. */
export function useSandboxTemplates(
  environmentId: EnvironmentId,
  provider: SandboxProviderInfo | undefined,
) {
  const query = useEnvironmentQuery(
    provider !== undefined && provider.configured && provider.capabilities.templates
      ? serverEnvironment.sandboxesTemplates({
          environmentId,
          input: { provider: provider.kind },
        })
      : null,
  );
  return {
    templates: query.data?.templates ?? EMPTY_TEMPLATES,
    allowance: query.data?.templateAllowance,
    error: query.error,
    refresh: () => query.refresh(),
  };
}

const describeAllowance = (allowance: SandboxTemplateAllowance): string => {
  const used = `${Math.min(allowance.used, allowance.included)} of ${allowance.included} free templates used`;
  if (allowance.used < allowance.included || allowance.pricePerExtraDailyDollars === undefined) {
    return `${used}.`;
  }
  return `${used}. Each one past ${allowance.included} costs $${allowance.pricePerExtraDailyDollars.toFixed(3)} a day.`;
};

const formatBytes = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;

const suggestName = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 63)
    .replace(/-+$/u, "");

export function SaveSandboxTemplateDialog({
  environmentId,
  sandbox,
  provider,
  open,
  onOpenChange,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly sandbox: SandboxRecord;
  readonly provider: SandboxProviderInfo;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: () => void;
}) {
  const saveTemplate = useAtomCommand(serverEnvironment.sandboxesSaveTemplate, {
    reportFailure: false,
  });
  const templates = useSandboxTemplates(environmentId, open ? provider : undefined);
  const [name, setName] = useState(() => suggestName(sandbox.label));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const problem = describeSandboxTemplateNameProblem(name);
  const replaces = templates.templates.some((template) => template.name === name);

  const save = async () => {
    if (problem !== null || saving) return;
    setSaving(true);
    const result = await saveTemplate({
      environmentId,
      input: { environmentId: sandbox.environmentId, name },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = describeSandboxFailure(
          squashAtomCommandFailure(result),
          "Could not save template",
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: failure.title,
            description: failure.description,
          }),
        );
        // A failure after the reset changes the sandbox too, so its row has to re-read.
        onSaved();
      }
      return;
    }
    templates.refresh();
    onOpenChange(false);
    onSaved();
    toastManager.add({
      type: "success",
      title: "Template saved",
      description: `${name} is ready and ${sandbox.label} was deleted. Add a sandbox environment and start from ${name} to keep working.`,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (saving ? undefined : onOpenChange(next))}>
      <DialogPopup className="max-w-md" showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>Save as template</DialogTitle>
          <DialogDescription>
            New {provider.label} sandboxes can start from {sandbox.label}'s disk, with its tools,
            repositories, and files already in place.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              setTouched(true);
              void save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="sandbox-template-name">Template name</Label>
              <Input
                id="sandbox-template-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setTouched(true);
                }}
                aria-invalid={touched && problem !== null}
                disabled={saving}
                spellCheck={false}
                autoFocus
              />
              {touched && problem !== null ? (
                <p className="text-2xs text-destructive">{problem}</p>
              ) : replaces ? (
                <p className="text-2xs text-muted-foreground">
                  Replaces the template with this name. Sandboxes already started from it keep their
                  copy.
                </p>
              ) : null}
            </div>
            <Alert variant="warning">
              <AlertDescription>
                <span>
                  Saving resets T3 Code on {sandbox.label} so copies start as new environments, then
                  stops the sandbox and deletes it once the template is ready. Its files live on in
                  the template.
                </span>
                {sandbox.credentialEnvironment === undefined ? null : (
                  <span>
                    It received credentials from {sandbox.credentialEnvironment}. Logins written to
                    its disk are copied into every sandbox started from the template.
                  </span>
                )}
              </AlertDescription>
            </Alert>
            {templates.allowance === undefined ? null : (
              <p className="text-2xs text-muted-foreground tabular-nums">
                {describeAllowance(templates.allowance)}
              </p>
            )}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={saving || problem !== null}
            onClick={() => {
              setTouched(true);
              void save();
            }}
          >
            {saving ? <Spinner className="size-3.5" /> : null}
            {saving ? "Saving template…" : "Save template"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function SandboxTemplateList({
  environmentId,
  provider,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: SandboxProviderInfo;
}) {
  const { templates, allowance, error, refresh } = useSandboxTemplates(environmentId, provider);
  const deleteTemplate = useAtomCommand(serverEnvironment.sandboxesDeleteTemplate, {
    reportFailure: false,
  });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  if (templates.length === 0 && error === null) return null;

  const remove = async (name: string) => {
    setConfirming(null);
    setPending(name);
    const result = await deleteTemplate({
      environmentId,
      input: { provider: provider.kind, name },
    });
    setPending(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = describeSandboxFailure(
          squashAtomCommandFailure(result),
          "Could not delete template",
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: failure.title,
            description: failure.description,
          }),
        );
      }
      return;
    }
    refresh();
  };

  return (
    <div className="space-y-2 rounded-lg border border-border/60 px-4 py-3">
      <div>
        <p className="text-sm font-medium text-foreground">{provider.label} templates</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Start a sandbox from one in Add environment.
          {allowance === undefined ? null : ` ${describeAllowance(allowance)}`}
        </p>
        {error === null ? null : <p className="mt-0.5 text-xs text-destructive">{error}</p>}
      </div>
      {templates.map((template) => {
        const size = provider.sizes.find((candidate) => candidate.id === template.size);
        const details = [
          size?.label,
          template.sizeBytes === undefined ? undefined : formatBytes(template.sizeBytes),
          template.createdAt === undefined
            ? undefined
            : `saved ${new Date(template.createdAt).toLocaleDateString()}`,
        ].filter((part) => part !== undefined);
        return (
          <div key={template.name} className="space-y-2">
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <LayersIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate text-sm text-foreground">{template.name}</p>
                  {details.length === 0 ? null : (
                    <p className="truncate text-xs text-muted-foreground">{details.join(" · ")}</p>
                  )}
                </div>
              </div>
              {confirming === template.name ? null : (
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={pending !== null}
                  onClick={() => setConfirming(template.name)}
                >
                  {pending === template.name ? (
                    <Spinner className="size-3" />
                  ) : (
                    <Trash2Icon className="size-3" />
                  )}
                  Delete
                </Button>
              )}
            </div>
            {confirming === template.name ? (
              <SandboxStartConfirmation
                warnings={[
                  `This deletes ${template.name} at ${provider.label}. Sandboxes already started from it keep their copy.`,
                ]}
                confirmLabel="Delete template"
                destructive
                onConfirm={() => void remove(template.name)}
                onCancel={() => setConfirming(null)}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
