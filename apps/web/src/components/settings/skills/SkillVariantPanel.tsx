import { matchingSkillRuleForCell } from "@t3tools/client-runtime/state/skills";
import type {
  ProviderDriverKind,
  SkillModelCell,
  SkillVariantMutateInput,
  SkillVariantRevision,
  SkillVariantRule,
} from "@t3tools/contracts";
import { HistoryIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Textarea } from "../../ui/textarea";
import { effectiveModeLabel } from "./skillsSettings.logic";

function targetLabel(rule: SkillVariantRule): string {
  if (rule.driver === null) return "All providers";
  if (rule.model === null) return rule.driver;
  return `${rule.driver} · ${rule.model}`;
}

function matchesCellTarget(rule: SkillVariantRule, cell: SkillModelCell): boolean {
  return rule.driver === cell.driver && rule.model?.toLowerCase() === cell.model.toLowerCase();
}

export function SkillVariantActions({
  skillName,
  cell,
  rule,
  canMutate,
  busy,
  onMutate,
  onFork,
}: {
  readonly skillName: string;
  readonly cell: SkillModelCell;
  readonly rule: SkillVariantRule | null;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly onMutate: (input: SkillVariantMutateInput) => void;
  readonly onFork: () => void;
}) {
  const exactRule = rule !== null && matchesCellTarget(rule, cell);
  const cannotTurnBackOn =
    cell.effectiveMode === "off" &&
    (!exactRule || rule === null || rule.deletedAt !== null || rule.mode !== "off");
  const permissionReason = canMutate ? undefined : "Requires settings-write permission.";
  const turnBackOnReason = cannotTurnBackOn
    ? "This model inherits a broader off rule. Fork a model-specific variant to override it."
    : permissionReason;

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        size="xs"
        variant="outline"
        disabled={busy || !canMutate}
        title={permissionReason}
        onClick={onFork}
      >
        <PlusIcon />
        Fork for model…
      </Button>
      {cell.effectiveMode === "off" ? (
        <Button
          size="xs"
          variant="outline"
          disabled={busy || !canMutate || cannotTurnBackOn || rule === null}
          title={turnBackOnReason}
          onClick={() => rule && onMutate({ action: "delete", ruleId: rule.ruleId })}
        >
          Turn back on
        </Button>
      ) : (
        <Button
          size="xs"
          variant="outline"
          disabled={busy || !canMutate}
          title={permissionReason}
          onClick={() =>
            onMutate({
              action: "set-off",
              skillName,
              driver: cell.driver,
              model: cell.model,
            })
          }
        >
          Turn off for this model
        </Button>
      )}
    </div>
  );
}

function ForkVariantDialog({
  open,
  skillName,
  cell,
  rules,
  busy,
  onOpenChange,
  onMutate,
}: {
  readonly open: boolean;
  readonly skillName: string;
  readonly cell: SkillModelCell;
  readonly rules: readonly SkillVariantRule[];
  readonly busy: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onMutate: (input: SkillVariantMutateInput) => void;
}) {
  const sources = rules.filter(
    (rule) => rule.deletedAt === null && rule.mode === "variant" && rule.body !== null,
  );
  const [driver, setDriver] = useState<ProviderDriverKind>(cell.driver);
  const [model, setModel] = useState(cell.model);
  const [source, setSource] = useState<string>(cell.ruleId ?? "base");
  const sourceRule = sources.find((rule) => rule.ruleId === source) ?? null;

  const submit = () => {
    const trimmedModel = model.trim();
    if (!trimmedModel) return;
    onMutate({
      action: "fork",
      skillName,
      driver,
      model: trimmedModel,
      forkedFromRuleId: sourceRule?.ruleId ?? null,
      ...(sourceRule?.body === null || sourceRule?.body === undefined
        ? {}
        : { body: sourceRule.body }),
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Fork for model</DialogTitle>
          <DialogDescription>
            Create a complete model-specific copy. Future edits do not change its source.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="skill-fork-provider">Provider</Label>
              <Input
                id="skill-fork-provider"
                value={driver}
                onChange={(event) => setDriver(event.currentTarget.value as ProviderDriverKind)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="skill-fork-model">Model</Label>
              <Input
                id="skill-fork-model"
                value={model}
                onChange={(event) => setModel(event.currentTarget.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="skill-fork-source">Source</Label>
              <Select value={source} onValueChange={(value) => setSource(value ?? "base")}>
                <SelectTrigger id="skill-fork-source">
                  <SelectValue>
                    {sourceRule ? `Rule · ${targetLabel(sourceRule)}` : "Base skill"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="base">Base skill</SelectItem>
                  {sources.map((candidate) => (
                    <SelectItem key={candidate.ruleId} value={candidate.ruleId}>
                      Rule · {targetLabel(candidate)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {sourceRule === null ? (
                <p className="text-xs text-muted-foreground">
                  The server copies the current base SKILL.md into the new variant.
                </p>
              ) : null}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || !model.trim()} onClick={submit}>
            Create variant
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function SkillVariantPanel({
  skillName,
  cell,
  rules,
  revisions,
  canMutate,
  busy,
  onMutate,
}: {
  readonly skillName: string;
  readonly cell: SkillModelCell;
  readonly rules: readonly SkillVariantRule[];
  readonly revisions: readonly SkillVariantRevision[];
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly onMutate: (input: SkillVariantMutateInput) => void;
}) {
  const [forkOpen, setForkOpen] = useState(false);
  const rule = matchingSkillRuleForCell(cell, rules);
  const draftKey = rule ? `${rule.ruleId}:${rule.revision}` : "base";
  const [draft, setDraft] = useState({ key: draftKey, body: rule?.body ?? "" });
  if (draft.key !== draftKey) {
    setDraft({ key: draftKey, body: rule?.body ?? "" });
  }
  const ruleRevisions = rule
    ? revisions.filter((revision) => revision.ruleId === rule.ruleId).slice(0, 20)
    : [];
  const removed = rules.filter((candidate) => candidate.deletedAt !== null);
  const editable = rule?.mode === "variant" && rule.deletedAt === null;
  const permissionReason = canMutate ? undefined : "Requires settings-write permission.";

  return (
    <section className="space-y-4" aria-labelledby="skill-variant-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="skill-variant-heading" className="text-sm font-semibold">
            Variant
          </h3>
          <p className="text-xs text-muted-foreground">
            {cell.driver} · {cell.model} · {effectiveModeLabel(cell)}
          </p>
        </div>
        <SkillVariantActions
          skillName={skillName}
          cell={cell}
          rule={rule}
          canMutate={canMutate}
          busy={busy}
          onMutate={onMutate}
          onFork={() => setForkOpen(true)}
        />
      </div>

      {!canMutate ? (
        <Alert variant="warning">
          <AlertTitle>Read only</AlertTitle>
          <AlertDescription>
            This connection lacks settings-write permission, so variant actions are disabled.
          </AlertDescription>
        </Alert>
      ) : null}

      {rule ? (
        <div className="space-y-3 rounded-xl border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={rule.deletedAt ? "error" : rule.enabled ? "success" : "outline"}>
              {rule.deletedAt ? "Removed" : rule.enabled ? "Enabled" : "Disabled"}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {targetLabel(rule)} · revision {rule.revision}
            </span>
          </div>
          {rule.mode === "variant" ? (
            <Textarea
              aria-label="Variant body"
              value={draft.body}
              disabled={!editable || busy || !canMutate}
              onChange={(event) => setDraft({ key: draft.key, body: event.currentTarget.value })}
            />
          ) : (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              This rule turns the skill off and has no replacement body.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {rule.mode === "variant" && rule.deletedAt === null ? (
              <Button
                size="xs"
                disabled={
                  busy || !canMutate || !draft.body.trim() || draft.body === (rule.body ?? "")
                }
                title={permissionReason}
                onClick={() => onMutate({ action: "edit", ruleId: rule.ruleId, body: draft.body })}
              >
                Save
              </Button>
            ) : null}
            {rule.deletedAt === null ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy || !canMutate || rule.revision <= 1}
                title={rule.revision <= 1 ? "No previous revision." : permissionReason}
                onClick={() => onMutate({ action: "revert", ruleId: rule.ruleId })}
              >
                Revert to previous revision
              </Button>
            ) : null}
            {rule.deletedAt === null ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy || !canMutate}
                title={permissionReason}
                onClick={() =>
                  onMutate({ action: rule.enabled ? "disable" : "enable", ruleId: rule.ruleId })
                }
              >
                {rule.enabled ? "Disable" : "Enable"}
              </Button>
            ) : null}
            <Button
              size="xs"
              variant={rule.deletedAt ? "outline" : "destructive"}
              disabled={busy || !canMutate}
              title={permissionReason}
              onClick={() =>
                onMutate({
                  action: rule.deletedAt ? "restore" : "delete",
                  ruleId: rule.ruleId,
                })
              }
            >
              {rule.deletedAt ? "Restore" : "Delete"}
            </Button>
          </div>
        </div>
      ) : (
        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
          This model uses the base skill. Fork it to create a model-specific body.
        </p>
      )}

      {ruleRevisions.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <HistoryIcon className="size-3.5" />
            Revisions (latest 20)
          </div>
          <ol className="divide-y rounded-xl border">
            {ruleRevisions.map((revision) => (
              <li
                key={`${revision.ruleId}:${revision.revision}`}
                className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
              >
                <span>
                  Revision {revision.revision} · {revision.action}
                </span>
                <span className="text-muted-foreground">
                  {revision.deleted ? "removed" : revision.enabled ? revision.mode : "disabled"}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {removed.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground">Removed</h4>
          <div className="divide-y rounded-xl border">
            {removed.map((candidate) => (
              <div
                key={candidate.ruleId}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
              >
                <span className="text-xs">{targetLabel(candidate)}</span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || !canMutate}
                  title={permissionReason}
                  onClick={() => onMutate({ action: "restore", ruleId: candidate.ruleId })}
                >
                  Restore
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <ForkVariantDialog
        key={`${cell.driver}:${cell.model}`}
        open={forkOpen}
        skillName={skillName}
        cell={cell}
        rules={rules}
        busy={busy}
        onOpenChange={setForkOpen}
        onMutate={onMutate}
      />
    </section>
  );
}
