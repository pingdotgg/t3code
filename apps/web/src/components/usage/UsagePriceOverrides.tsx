import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon, PlusIcon, RotateCcwIcon, XIcon } from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useRef, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { environmentSession } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import type { EnvironmentUsageStatus } from "../../state/usage";
import {
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
} from "../settings/ProviderSettingsPanel.logic";
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
import { Menu, MenuCheckboxItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { USAGE_PRICE_FIELDS } from "./usagePriceForm";
import {
  isEmptyUsagePriceDraft,
  usagePriceCell,
  usagePriceTableChanges,
  usagePriceTableErrors,
  type UsagePriceDraft,
  type UsagePriceField,
} from "./usagePriceTable";
import {
  writeUsagePrices,
  type UsagePriceTarget,
  type UsagePriceWriteResult,
} from "./usagePriceTargets";

const priceTargetsAtom = Atom.make((get): readonly UsagePriceTarget[] =>
  [...get(environmentPresentations.presentationsAtom)].map(([environmentId, environment]) => {
    const settings = get(serverEnvironment.settingsValueAtom(environmentId));
    const session = get(environmentSession.sessionStateAtom(environmentId));
    const sessionAccess = {
      session: Option.getOrNull(AsyncResult.value(session)),
      isPending: session.waiting,
      hasError: session._tag === "Failure",
    };
    const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
    const access = isPrimary
      ? resolvePrimaryOperateAccess({ ...sessionAccess, isPrimary, hasDesktopBridge: isElectron })
      : resolveRemoteOperateAccess(sessionAccess);
    return {
      environmentId,
      label: environment.entry.target.label,
      prices: settings?.usagePriceOverrides ?? null,
      unavailable:
        environment.connection.phase !== "connected"
          ? "Offline"
          : settings === null
            ? "Prices not loaded"
            : environment.serverConfig?.environment.capabilities.usagePriceOverrides !== true
              ? "Update server to edit prices"
              : access === "pending"
                ? "Checking permissions…"
                : access === "denied"
                  ? "Read-only access"
                  : null,
    };
  }),
);

type SaveAttempt = {
  readonly drafts: readonly UsagePriceDraft[];
  readonly destinations: readonly {
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }[];
  readonly results: ReadonlyMap<
    EnvironmentId,
    UsagePriceWriteResult | { readonly status: "saving" }
  >;
};

export function UsagePriceOverrides({
  usage,
  initialSelectedEnvironmentIds,
  onOpenChange,
}: {
  readonly usage: readonly EnvironmentUsageStatus[];
  readonly initialSelectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const environments = useAtomValue(priceTargetsAtom);
  const [selectedIds, setSelectedIds] = useState(initialSelectedEnvironmentIds);
  const selected = environments.filter(
    (environment) => selectedIds === null || selectedIds.has(environment.environmentId),
  );
  const [drafts, setDrafts] = useState<readonly UsagePriceDraft[]>([]);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState<SaveAttempt | null>(null);
  const focusRowRef = useRef<string | null>(null);
  const nextRowId = useRef(0);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const customModels = [
    ...new Set(selected.flatMap((environment) => Object.keys(environment.prices ?? {}))),
  ].sort();
  const models = [
    ...new Set([
      ...customModels,
      ...usage
        .filter((environment) =>
          selected.some((target) => target.environmentId === environment.environmentId),
        )
        .flatMap((environment) => environment.summary?.buckets.map((bucket) => bucket.model) ?? []),
    ]),
  ].sort();
  // Keep new rows in place while successful environments publish their updated settings.
  const newModels = new Set(
    drafts.filter((draft) => draft.isNew).map((draft) => draft.model.trim()),
  );
  const rows: readonly UsagePriceDraft[] = [
    ...customModels
      .filter((model) => attempt === null || !newModels.has(model))
      .map(
        (model) =>
          drafts.find((draft) => draft.id === `model:${model}`) ?? {
            id: `model:${model}`,
            model,
            isNew: false,
            values: {},
          },
      ),
    ...drafts.filter((draft) => draft.isNew),
  ];
  const stagedDrafts = drafts.filter((draft) => !isEmptyUsagePriceDraft(draft));
  const errors = usagePriceTableErrors(selected, stagedDrafts);
  for (const draft of stagedDrafts) {
    if (!draft.isNew) continue;
    if (draft.model.trim() === "") errors.set(draft.id, "Enter a model ID.");
    else if (
      attempt === null &&
      (customModels.includes(draft.model.trim()) ||
        drafts.some((other) => other.id !== draft.id && other.model.trim() === draft.model.trim()))
    )
      errors.set(draft.id, "This model already has a row. Edit its prices there.");
  }
  const failedDestinations =
    attempt?.destinations.filter(
      (destination) => attempt.results.get(destination.environmentId)?.status === "failed",
    ) ?? [];
  const locked = pending || failedDestinations.length > 0;
  const hasChanges = stagedDrafts.length > 0;
  const destinationLabel =
    selected.length === 1 ? selected[0]!.label : `${selected.length} environments`;
  const selectionLabel = selectedIds === null ? "All environments" : destinationLabel;
  const discard = () => {
    setDrafts([]);
    setAttempt(null);
  };
  const selectEnvironments = (ids: ReadonlySet<EnvironmentId> | null) => {
    setSelectedIds(ids);
    setAttempt(null);
  };
  const updateDraft = (draft: UsagePriceDraft) => {
    setDrafts((previous) =>
      previous.some((entry) => entry.id === draft.id)
        ? previous.map((entry) => (entry.id === draft.id ? draft : entry))
        : [...previous, draft],
    );
    setAttempt(null);
  };
  const editCell = (row: UsagePriceDraft, field: UsagePriceField, value: string) => {
    const values = { ...row.values, [field]: value };
    const original = usagePriceCell(selected, row.model, field);
    if (
      !row.isNew &&
      original.placeholder !== "Mixed" &&
      original.placeholder !== "Unavailable" &&
      value === original.value
    )
      delete values[field];
    if (!row.isNew && Object.keys(values).length === 0)
      setDrafts((previous) => previous.filter((entry) => entry.id !== row.id));
    else updateDraft({ ...row, values });
  };
  const save = async (retry = false) => {
    if (pending) return;
    const destinations = retry ? failedDestinations : selected;
    const edits = retry && attempt ? attempt.drafts : stagedDrafts;
    if (destinations.length === 0 || edits.length === 0) return;
    const targets = destinations.map(
      (destination) =>
        environments.find(
          (environment) => environment.environmentId === destination.environmentId,
        ) ?? { ...destination, prices: null, unavailable: "Environment removed" },
    );
    const changes = new Map(
      targets.map((target) => [target.environmentId, usagePriceTableChanges(target, edits)]),
    );
    setPending(true);
    setAttempt((previous) => ({
      drafts: edits,
      destinations: retry && previous ? previous.destinations : targets,
      results: new Map([
        ...(retry && previous ? previous.results : []),
        ...targets.map((target) => [target.environmentId, { status: "saving" } as const] as const),
      ]),
    }));
    let failed = false;
    await writeUsagePrices({
      targets: targets.map((target) => ({
        ...target,
        unavailable:
          target.unavailable ?? [...changes.get(target.environmentId)!.errors.values()][0] ?? null,
      })),
      changes: new Map([...changes].map(([id, plan]) => [id, plan.changes])),
      write: updateSettings,
      onResult: (environmentId, result) => {
        if (result.status === "failed") failed = true;
        setAttempt((previous) =>
          previous === null
            ? null
            : { ...previous, results: new Map(previous.results).set(environmentId, result) },
        );
      },
    });
    setPending(false);
    if (!failed) setDrafts([]);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!pending) onOpenChange(open);
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Custom model prices</DialogTitle>
          <DialogDescription>
            Prices apply to all past and future usage on the environments you select.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Label id="usage-prices-apply-label" className="shrink-0">
                Apply to
              </Label>
              <Menu>
                <MenuTrigger
                  render={<Button variant="outline" size="sm" className="min-w-0" />}
                  aria-labelledby="usage-prices-apply-label usage-prices-selection"
                  disabled={pending || hasChanges}
                >
                  <span id="usage-prices-selection" className="truncate">
                    {selectionLabel}
                  </span>
                  <ChevronDownIcon className="size-3.5 shrink-0" aria-hidden />
                </MenuTrigger>
                <MenuPopup align="start" className="w-80 max-w-[calc(100vw-2rem)]">
                  <MenuCheckboxItem
                    checked={selectedIds === null}
                    closeOnClick={false}
                    onCheckedChange={(checked) => selectEnvironments(checked ? null : new Set())}
                  >
                    All environments
                  </MenuCheckboxItem>
                  <MenuSeparator />
                  {environments.map((environment) => (
                    <MenuCheckboxItem
                      key={environment.environmentId}
                      checked={selectedIds === null || selectedIds.has(environment.environmentId)}
                      closeOnClick={false}
                      onCheckedChange={(checked) => {
                        const next = new Set(selected.map((target) => target.environmentId));
                        if (checked) next.add(environment.environmentId);
                        else next.delete(environment.environmentId);
                        selectEnvironments(next.size === environments.length ? null : next);
                      }}
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="min-w-0 flex-1 truncate">{environment.label}</span>
                        {environment.unavailable ? (
                          <span className="text-xs text-muted-foreground">
                            {environment.unavailable}
                          </span>
                        ) : null}
                      </span>
                    </MenuCheckboxItem>
                  ))}
                </MenuPopup>
              </Menu>
            </div>
            <span className="text-xs text-muted-foreground">USD / million tokens</span>
          </div>
          {selected.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {environments.length === 0
                ? "Connect an environment to set model prices."
                : "Select an environment to see and change its model prices."}
            </p>
          ) : (
            <>
              <div className="min-w-0 overflow-hidden rounded-lg border border-border">
                <Table className="min-w-160 table-fixed" aria-label="Custom model prices">
                  <colgroup>
                    <col className="w-[34%]" />
                    {USAGE_PRICE_FIELDS.map((field) => (
                      <col key={field.key} />
                    ))}
                    <col className="w-10" />
                  </colgroup>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="pl-3">Model ID</TableHead>
                      {USAGE_PRICE_FIELDS.map((field) => (
                        <TableHead key={field.key}>{field.label}</TableHead>
                      ))}
                      <TableHead className="px-1">
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label="Add model price"
                          disabled={locked}
                          onClick={() => {
                            const id = `new:${nextRowId.current++}`;
                            focusRowRef.current = id;
                            updateDraft({ id, model: "", isNew: true, values: {} });
                          }}
                        >
                          <PlusIcon aria-hidden />
                        </Button>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.length === 0 ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell
                          colSpan={6}
                          className="py-8 text-center whitespace-normal text-muted-foreground"
                        >
                          {selected.some((environment) => environment.prices === null)
                            ? "Some environment prices are unavailable."
                            : "No custom prices. Add a row to override automatic pricing."}
                        </TableCell>
                      </TableRow>
                    ) : (
                      rows.map((row) => (
                        <TableRow
                          key={row.id}
                          data-row-id={row.id}
                          className="hover:bg-transparent"
                        >
                          <TableCell className="pl-3 whitespace-normal">
                            {row.isNew ? (
                              <Input
                                size="compact"
                                value={row.model}
                                ref={(node) => {
                                  if (node && focusRowRef.current === row.id) {
                                    node.focus();
                                    focusRowRef.current = null;
                                  }
                                }}
                                aria-label="New model ID"
                                aria-invalid={
                                  (row.model.trim() !== "" && errors.has(row.id)) || undefined
                                }
                                list="usage-price-models"
                                placeholder="Model ID"
                                autoComplete="off"
                                spellCheck={false}
                                disabled={locked}
                                onChange={(event) =>
                                  updateDraft({ ...row, model: event.target.value })
                                }
                              />
                            ) : (
                              <span
                                className={cn(
                                  "block break-all",
                                  row.removed && "text-muted-foreground line-through",
                                )}
                              >
                                {row.model}
                              </span>
                            )}
                            {errors.has(row.id) &&
                            (row.model.trim() !== "" ||
                              Object.values(row.values).some((value) => value !== "")) ? (
                              <p role="alert" className="mt-1 text-xs text-destructive">
                                {errors.get(row.id)}
                              </p>
                            ) : null}
                          </TableCell>
                          {row.removed ? (
                            <TableCell colSpan={4} className="text-muted-foreground">
                              Automatic pricing after saving
                            </TableCell>
                          ) : (
                            USAGE_PRICE_FIELDS.map((field) => {
                              const cell = usagePriceCell(selected, row.model, field.key);
                              return (
                                <TableCell key={field.key} className="px-1">
                                  <Input
                                    size="compact"
                                    inputMode="decimal"
                                    aria-label={`${field.label} price for ${row.model || "new model"}`}
                                    value={row.values[field.key] ?? (row.isNew ? "" : cell.value)}
                                    placeholder={
                                      row.isNew
                                        ? field.optional
                                          ? "Input rate"
                                          : "0.00"
                                        : cell.placeholder
                                    }
                                    autoComplete="off"
                                    disabled={locked}
                                    className="tabular-nums"
                                    onChange={(event) =>
                                      editCell(row, field.key, event.target.value)
                                    }
                                  />
                                </TableCell>
                              );
                            })
                          )}
                          <TableCell className="px-1">
                            <Tooltip>
                              <TooltipTrigger
                                render={<Button size="icon-xs" variant="ghost" />}
                                disabled={locked}
                                aria-label={
                                  row.removed
                                    ? `Undo reset for ${row.model}`
                                    : row.isNew
                                      ? "Remove new model"
                                      : `Reset price for ${row.model} to automatic`
                                }
                                onClick={() => {
                                  if (row.isNew)
                                    setDrafts((previous) =>
                                      previous.filter((entry) => entry.id !== row.id),
                                    );
                                  else if (row.removed) {
                                    if (Object.keys(row.values).length === 0)
                                      setDrafts((previous) =>
                                        previous.filter((entry) => entry.id !== row.id),
                                      );
                                    else updateDraft({ ...row, removed: false });
                                  } else updateDraft({ ...row, removed: true });
                                }}
                              >
                                {row.isNew ? <XIcon aria-hidden /> : <RotateCcwIcon aria-hidden />}
                              </TooltipTrigger>
                              <TooltipPopup>
                                {row.removed
                                  ? "Undo reset"
                                  : row.isNew
                                    ? "Remove row"
                                    : "Reset to automatic"}
                              </TooltipPopup>
                            </Tooltip>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
              <datalist id="usage-price-models">
                {models
                  .filter((model) => !customModels.includes(model))
                  .map((model) => (
                    <option key={model} value={model} />
                  ))}
              </datalist>
              <p className="text-xs text-muted-foreground">
                Blank cache rates use the input price. Enter 0 for free tokens.
                {selected.length > 1
                  ? " Mixed cells keep each environment’s rate until you edit them."
                  : ""}
              </p>
            </>
          )}
          {attempt ? (
            <div role="status" className="grid gap-1 text-xs">
              {attempt.destinations.map((destination) => {
                const result = attempt.results.get(destination.environmentId);
                return (
                  <div key={destination.environmentId} className="flex justify-between gap-3">
                    <span className="truncate text-muted-foreground">{destination.label}</span>
                    <span
                      className={
                        result?.status === "failed"
                          ? "text-right text-destructive"
                          : "text-muted-foreground"
                      }
                    >
                      {result?.status === "failed"
                        ? `Not saved · ${result.error}`
                        : result?.status === "saved"
                          ? "Saved"
                          : "Saving…"}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter variant="bare" className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {hasChanges ? `Changes apply to ${destinationLabel}` : ""}
          </span>
          <div className="flex w-full flex-wrap justify-end gap-2 sm:w-auto">
            {hasChanges ? (
              <Button variant="ghost" disabled={pending} onClick={discard}>
                {failedDestinations.length > 0 ? "Discard pending changes" : "Discard changes"}
              </Button>
            ) : null}
            <Button
              disabled={
                pending ||
                (!hasChanges && failedDestinations.length === 0) ||
                (failedDestinations.length === 0 && (errors.size > 0 || selected.length === 0))
              }
              onClick={() => void save(failedDestinations.length > 0)}
            >
              {pending
                ? "Saving…"
                : failedDestinations.length > 0
                  ? "Retry failed saves"
                  : "Save changes"}
            </Button>
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
