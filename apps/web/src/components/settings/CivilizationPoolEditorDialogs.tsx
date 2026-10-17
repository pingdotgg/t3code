import {
  AuthSettingsWriteScope,
  CIVILIZATION_CONFIG_VERSION,
  type CivilizationConfigOverride,
  type CivilizationEffectiveConfig,
  type CivilizationNamePool,
  type CivilizationProfilePool,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useState } from "react";

import {
  civilizationConfigExpectedRevision,
  type CivilizationConfigActionInput,
} from "../../state/civilization";
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
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";

type ConfigActionResult = {
  readonly effective: CivilizationEffectiveConfig;
  readonly changes?: ReadonlyArray<unknown>;
};

type ConfigRunner = (input: CivilizationConfigActionInput) => Promise<ConfigActionResult>;

interface PoolDialogCommonProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly targetLabel: string;
  readonly effective: CivilizationEffectiveConfig;
  readonly runConfigAction: ConfigRunner;
  readonly refresh: () => void;
  readonly maxPools?: number | undefined;
  readonly maxEntries?: number | undefined;
  readonly maxWeight?: number | undefined;
}

const poolErrorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    if (error._tag === "CivilizationConfigInvalidError") {
      const reason =
        "reason" in error && typeof error.reason === "string" ? error.reason : "invalid_config";
      const message =
        "message" in error && typeof error.message === "string"
          ? error.message
          : "Invalid configuration.";
      return `${reason}: ${message}`;
    }
    if (error._tag === "CivilizationUnavailableError") {
      return "message" in error && typeof error.message === "string"
        ? error.message
        : "Civilization configuration is unavailable.";
    }
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The pool configuration was not saved.";
};

const isConflict = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "CivilizationConfigConflictError";

const probabilityLabel = (
  effective: CivilizationEffectiveConfig,
  kind: "name" | "profile",
  entryId: string,
) => {
  const probabilities =
    kind === "name" ? effective.selectedNameProbabilities : effective.selectedProfileProbabilities;
  const probability = probabilities.find((entry) => entry.id === entryId);
  return probability === undefined ? "—" : `${(probability.probability * 100).toFixed(1)}%`;
};

const moveItem = <T,>(
  items: ReadonlyArray<T>,
  index: number,
  direction: -1 | 1,
): ReadonlyArray<T> => {
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= items.length) return items;
  const next = [...items];
  const current = next[index]!;
  next[index] = next[nextIndex]!;
  next[nextIndex] = current;
  return next;
};

export function CivilizationNamePoolEditorDialog({
  open,
  onOpenChange,
  environmentId,
  projectId,
  targetLabel,
  effective,
  runConfigAction,
  refresh,
  maxPools,
  maxEntries,
  maxWeight,
}: PoolDialogCommonProps) {
  const [draft, setDraft] = useState<ReadonlyArray<CivilizationNamePool>>(() =>
    effective.config.names.pools.map((pool) => ({
      ...pool,
      entries: pool.entries.map((entry) => ({ ...entry })),
    })),
  );
  const [activePoolId, setActivePoolId] = useState(effective.config.names.selectedPoolId);
  const [expectedRevision, setExpectedRevision] = useState<number>(() =>
    civilizationConfigExpectedRevision(effective, projectId),
  );
  const [previewEffective, setPreviewEffective] = useState<CivilizationEffectiveConfig | null>(
    null,
  );
  const [previewChanges, setPreviewChanges] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [conflictReview, setConflictReview] = useState(false);
  const currentRevision = civilizationConfigExpectedRevision(effective, projectId);
  const conflictRefreshPending = conflictReview && expectedRevision === currentRevision;

  const activePool = draft.find((pool) => pool.id === activePoolId) ?? null;
  const probabilityEffective = previewEffective ?? effective;
  const probabilitiesAvailable = probabilityEffective.config.names.selectedPoolId === activePoolId;

  const invalidatePreview = () => {
    setPreviewEffective(null);
    setPreviewChanges(null);
    if (!conflictReview) setMessage(null);
  };

  const updateActivePool = (update: (pool: CivilizationNamePool) => CivilizationNamePool) => {
    setDraft((current) => current.map((pool) => (pool.id === activePoolId ? update(pool) : pool)));
    invalidatePreview();
  };

  const override = (): CivilizationConfigOverride => ({
    version: CIVILIZATION_CONFIG_VERSION,
    names: { pools: draft },
  });

  const preview = () => {
    if (previewing || saving || conflictRefreshPending) return;
    if (conflictReview && expectedRevision !== currentRevision) {
      setExpectedRevision(currentRevision);
      setConflictReview(false);
    }
    const candidate = override();
    setPreviewing(true);
    setMessage(null);
    void runConfigAction({ environmentId, projectId, type: "validate", override: candidate })
      .then(() => runConfigAction({ environmentId, projectId, type: "diff", override: candidate }))
      .then((result) => {
        setPreviewing(false);
        setPreviewEffective(result.effective);
        setPreviewChanges(result.changes?.length ?? 0);
        setMessage(`${result.changes?.length ?? 0} effective changes in the server preview.`);
      })
      .catch((error: unknown) => {
        setPreviewing(false);
        setPreviewEffective(null);
        setPreviewChanges(null);
        setMessage(poolErrorMessage(error));
      });
  };

  const save = () => {
    if (saving || previewChanges === null || expectedRevision === null) return;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      setMessage("Permission changed before save; settings:write is required.");
      return;
    }
    setSaving(true);
    setMessage(null);
    void runConfigAction({
      environmentId,
      projectId,
      type: "set",
      expectedRevision,
      override: override(),
    })
      .then(() => {
        setSaving(false);
        onOpenChange(false);
        refresh();
      })
      .catch((error: unknown) => {
        setSaving(false);
        if (isConflict(error)) {
          setConflictReview(true);
          setPreviewEffective(null);
          setPreviewChanges(null);
          setMessage("Configuration changed elsewhere; review and save again.");
          refresh();
          return;
        }
        setMessage(poolErrorMessage(error));
      });
  };

  const addPool = () => {
    if (maxPools !== undefined && draft.length >= maxPools) return;
    let suffix = draft.length + 1;
    let id = `name-pool-${suffix}`;
    while (draft.some((pool) => pool.id === id)) id = `name-pool-${++suffix}`;
    setDraft((current) => [...current, { id, entries: [] }]);
    setActivePoolId(id);
    invalidatePreview();
  };

  const removePool = () => {
    if (activePool === null) return;
    const next = draft.filter((pool) => pool.id !== activePool.id);
    setDraft(next);
    setActivePoolId(next[0]?.id ?? "");
    invalidatePreview();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (saving) return;
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Edit name pools</DialogTitle>
          <DialogDescription>
            Edit stable entry IDs, display names, and weights for {targetLabel}. Pool arrays replace
            as a whole; the server validates limits and computes normalized probabilities before
            save.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={activePoolId} onValueChange={(value) => setActivePoolId(value ?? "")}>
              <SelectTrigger aria-label={`Name pool to edit on ${targetLabel}`} size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {draft.map((pool) => (
                  <SelectItem key={pool.id} value={pool.id}>
                    {pool.id}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              size="sm"
              variant="outline"
              disabled={maxPools !== undefined && draft.length >= maxPools}
              onClick={addPool}
            >
              Add pool
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={activePool === null || draft.length <= 1}
              onClick={removePool}
            >
              Remove pool
            </Button>
          </div>
          <div className="text-xs text-muted-foreground">
            Server limits: {maxPools ?? "server"} pools, {maxEntries ?? "server"} entries per pool,
            weight ≤ {maxWeight ?? "server"}.
          </div>
          {activePool === null ? (
            <div className="text-sm text-muted-foreground">No pool selected.</div>
          ) : (
            <div className="space-y-3">
              <div className="text-sm font-medium">{activePool.id}</div>
              {activePool.entries.map((entry, index) => (
                <div
                  key={entry.id}
                  className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_7rem_auto]"
                >
                  <Input
                    aria-label={`Name entry ${index + 1} ID`}
                    size="sm"
                    value={entry.id}
                    onChange={(event) =>
                      updateActivePool((pool) => ({
                        ...pool,
                        entries: pool.entries.map((candidate, candidateIndex) =>
                          candidateIndex === index
                            ? { ...candidate, id: event.currentTarget.value }
                            : candidate,
                        ),
                      }))
                    }
                  />
                  <Input
                    aria-label={`Name entry ${index + 1} display name`}
                    size="sm"
                    value={entry.displayName}
                    onChange={(event) =>
                      updateActivePool((pool) => ({
                        ...pool,
                        entries: pool.entries.map((candidate, candidateIndex) =>
                          candidateIndex === index
                            ? { ...candidate, displayName: event.currentTarget.value }
                            : candidate,
                        ),
                      }))
                    }
                  />
                  <Input
                    aria-label={`Name entry ${index + 1} weight`}
                    type="number"
                    size="sm"
                    value={String(entry.weight)}
                    onChange={(event) => {
                      const weight = Number(event.currentTarget.value);
                      if (!Number.isFinite(weight)) return;
                      updateActivePool((pool) => ({
                        ...pool,
                        entries: pool.entries.map((candidate, candidateIndex) =>
                          candidateIndex === index ? { ...candidate, weight } : candidate,
                        ),
                      }));
                    }}
                  />
                  <div className="flex items-center gap-1">
                    <span className="min-w-12 text-right text-xs text-muted-foreground">
                      {probabilitiesAvailable
                        ? probabilityLabel(probabilityEffective, "name", entry.id)
                        : "—"}
                    </span>
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Move name entry ${index + 1} up`}
                      disabled={index === 0}
                      onClick={() =>
                        updateActivePool((pool) => ({
                          ...pool,
                          entries: moveItem(pool.entries, index, -1),
                        }))
                      }
                    >
                      ↑
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Move name entry ${index + 1} down`}
                      disabled={index === activePool.entries.length - 1}
                      onClick={() =>
                        updateActivePool((pool) => ({
                          ...pool,
                          entries: moveItem(pool.entries, index, 1),
                        }))
                      }
                    >
                      ↓
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Remove name entry ${index + 1}`}
                      onClick={() =>
                        updateActivePool((pool) => ({
                          ...pool,
                          entries: pool.entries.filter(
                            (_, candidateIndex) => candidateIndex !== index,
                          ),
                        }))
                      }
                    >
                      ×
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                size="sm"
                variant="outline"
                disabled={maxEntries !== undefined && activePool.entries.length >= maxEntries}
                onClick={() =>
                  updateActivePool((pool) => {
                    let suffix = pool.entries.length + 1;
                    let id = `name-${suffix}`;
                    while (pool.entries.some((entry) => entry.id === id)) id = `name-${++suffix}`;
                    return {
                      ...pool,
                      entries: [...pool.entries, { id, displayName: "", weight: 1 }],
                    };
                  })
                }
              >
                Add name
              </Button>
              {!probabilitiesAvailable ? (
                <div className="text-xs text-muted-foreground">
                  Server probability output is available for the selected name pool only; no
                  client-side probability is inferred.
                </div>
              ) : null}
            </div>
          )}
          {message !== null ? (
            <div role="status" className="text-sm text-muted-foreground">
              {message}
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={previewing || saving || conflictRefreshPending}
            onClick={preview}
          >
            {previewing
              ? "Previewing…"
              : conflictRefreshPending
                ? "Refreshing…"
                : "Validate & preview"}
          </Button>
          <Button
            disabled={previewChanges === null || previewing || saving || conflictReview}
            onClick={save}
          >
            {saving ? "Saving…" : "Save pools"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function CivilizationProfilePoolEditorDialog({
  open,
  onOpenChange,
  environmentId,
  projectId,
  targetLabel,
  effective,
  runConfigAction,
  refresh,
  maxPools,
  maxEntries,
  maxWeight,
}: PoolDialogCommonProps) {
  const [draft, setDraft] = useState<ReadonlyArray<CivilizationProfilePool>>(() =>
    effective.config.personalities.pools.map((pool) => ({
      ...pool,
      entries: pool.entries.map((entry) => ({
        ...entry,
        traits: [...entry.traits],
        rich: { ...entry.rich, traits: [...entry.rich.traits] },
      })),
    })),
  );
  const [activePoolId, setActivePoolId] = useState(effective.config.personalities.selectedPoolId);
  const [expectedRevision, setExpectedRevision] = useState<number>(() =>
    civilizationConfigExpectedRevision(effective, projectId),
  );
  const [previewEffective, setPreviewEffective] = useState<CivilizationEffectiveConfig | null>(
    null,
  );
  const [previewChanges, setPreviewChanges] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [conflictReview, setConflictReview] = useState(false);
  const currentRevision = civilizationConfigExpectedRevision(effective, projectId);
  const conflictRefreshPending = conflictReview && expectedRevision === currentRevision;

  const activePool = draft.find((pool) => pool.id === activePoolId) ?? null;
  const probabilityEffective = previewEffective ?? effective;
  const probabilitiesAvailable =
    probabilityEffective.config.personalities.selectedPoolId === activePoolId;

  const invalidatePreview = () => {
    setPreviewEffective(null);
    setPreviewChanges(null);
    if (!conflictReview) setMessage(null);
  };

  const updateActivePool = (update: (pool: CivilizationProfilePool) => CivilizationProfilePool) => {
    setDraft((current) => current.map((pool) => (pool.id === activePoolId ? update(pool) : pool)));
    invalidatePreview();
  };

  const override = (): CivilizationConfigOverride => ({
    version: CIVILIZATION_CONFIG_VERSION,
    personalities: { pools: draft },
  });

  const preview = () => {
    if (previewing || saving || conflictRefreshPending) return;
    if (conflictReview && expectedRevision !== currentRevision) {
      setExpectedRevision(currentRevision);
      setConflictReview(false);
    }
    const candidate = override();
    setPreviewing(true);
    setMessage(null);
    void runConfigAction({ environmentId, projectId, type: "validate", override: candidate })
      .then(() => runConfigAction({ environmentId, projectId, type: "diff", override: candidate }))
      .then((result) => {
        setPreviewing(false);
        setPreviewEffective(result.effective);
        setPreviewChanges(result.changes?.length ?? 0);
        setMessage(`${result.changes?.length ?? 0} effective changes in the server preview.`);
      })
      .catch((error: unknown) => {
        setPreviewing(false);
        setPreviewEffective(null);
        setPreviewChanges(null);
        setMessage(poolErrorMessage(error));
      });
  };

  const save = () => {
    if (saving || previewChanges === null || expectedRevision === null) return;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      setMessage("Permission changed before save; settings:write is required.");
      return;
    }
    setSaving(true);
    setMessage(null);
    void runConfigAction({
      environmentId,
      projectId,
      type: "set",
      expectedRevision,
      override: override(),
    })
      .then(() => {
        setSaving(false);
        onOpenChange(false);
        refresh();
      })
      .catch((error: unknown) => {
        setSaving(false);
        if (isConflict(error)) {
          setConflictReview(true);
          setPreviewEffective(null);
          setPreviewChanges(null);
          setMessage("Configuration changed elsewhere; review and save again.");
          refresh();
          return;
        }
        setMessage(poolErrorMessage(error));
      });
  };

  const addPool = () => {
    if (maxPools !== undefined && draft.length >= maxPools) return;
    let suffix = draft.length + 1;
    let id = `profile-pool-${suffix}`;
    while (draft.some((pool) => pool.id === id)) id = `profile-pool-${++suffix}`;
    setDraft((current) => [...current, { id, entries: [] }]);
    setActivePoolId(id);
    invalidatePreview();
  };

  const removePool = () => {
    if (activePool === null) return;
    const next = draft.filter((pool) => pool.id !== activePool.id);
    setDraft(next);
    setActivePoolId(next[0]?.id ?? "");
    invalidatePreview();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (saving) return;
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Edit personality pools</DialogTitle>
          <DialogDescription>
            Edit one stable profile ID with paired mild and rich presentation variants plus its
            weight for {targetLabel}. Rendering strength changes expression only; it does not reroll
            citizen identity. The server validates limits and computes normalized probabilities
            before save.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={activePoolId} onValueChange={(value) => setActivePoolId(value ?? "")}>
              <SelectTrigger aria-label={`Personality pool to edit on ${targetLabel}`} size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {draft.map((pool) => (
                  <SelectItem key={pool.id} value={pool.id}>
                    {pool.id}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              size="sm"
              variant="outline"
              disabled={maxPools !== undefined && draft.length >= maxPools}
              onClick={addPool}
            >
              Add pool
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={activePool === null || draft.length <= 1}
              onClick={removePool}
            >
              Remove pool
            </Button>
          </div>
          <div className="text-xs text-muted-foreground">
            Server limits: {maxPools ?? "server"} pools, {maxEntries ?? "server"} entries per pool,
            weight ≤ {maxWeight ?? "server"}.
          </div>
          {activePool === null ? (
            <div className="text-sm text-muted-foreground">No pool selected.</div>
          ) : (
            <div className="space-y-3">
              <div className="text-sm font-medium">{activePool.id}</div>
              {activePool.entries.map((entry, index) => (
                <div key={entry.id} className="space-y-2 rounded-lg border p-3">
                  <div className="grid gap-2 sm:grid-cols-[1fr_1fr_7rem_auto]">
                    <Input
                      aria-label={`Profile entry ${index + 1} ID`}
                      size="sm"
                      value={entry.id}
                      onChange={(event) =>
                        updateActivePool((pool) => ({
                          ...pool,
                          entries: pool.entries.map((candidate, candidateIndex) =>
                            candidateIndex === index
                              ? { ...candidate, id: event.currentTarget.value }
                              : candidate,
                          ),
                        }))
                      }
                    />
                    <Input
                      aria-label={`Profile entry ${index + 1} label`}
                      size="sm"
                      value={entry.label}
                      onChange={(event) =>
                        updateActivePool((pool) => ({
                          ...pool,
                          entries: pool.entries.map((candidate, candidateIndex) =>
                            candidateIndex === index
                              ? { ...candidate, label: event.currentTarget.value }
                              : candidate,
                          ),
                        }))
                      }
                    />
                    <Input
                      aria-label={`Profile entry ${index + 1} weight`}
                      type="number"
                      size="sm"
                      value={String(entry.weight)}
                      onChange={(event) => {
                        const weight = Number(event.currentTarget.value);
                        if (!Number.isFinite(weight)) return;
                        updateActivePool((pool) => ({
                          ...pool,
                          entries: pool.entries.map((candidate, candidateIndex) =>
                            candidateIndex === index ? { ...candidate, weight } : candidate,
                          ),
                        }));
                      }}
                    />
                    <div className="flex items-center gap-1">
                      <span className="min-w-12 text-right text-xs text-muted-foreground">
                        {probabilitiesAvailable
                          ? probabilityLabel(probabilityEffective, "profile", entry.id)
                          : "—"}
                      </span>
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={`Move profile entry ${index + 1} up`}
                        disabled={index === 0}
                        onClick={() =>
                          updateActivePool((pool) => ({
                            ...pool,
                            entries: moveItem(pool.entries, index, -1),
                          }))
                        }
                      >
                        ↑
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={`Move profile entry ${index + 1} down`}
                        disabled={index === activePool.entries.length - 1}
                        onClick={() =>
                          updateActivePool((pool) => ({
                            ...pool,
                            entries: moveItem(pool.entries, index, 1),
                          }))
                        }
                      >
                        ↓
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={`Remove profile entry ${index + 1}`}
                        onClick={() =>
                          updateActivePool((pool) => ({
                            ...pool,
                            entries: pool.entries.filter(
                              (_, candidateIndex) => candidateIndex !== index,
                            ),
                          }))
                        }
                      >
                        ×
                      </Button>
                    </div>
                  </div>
                  <Input
                    aria-label={`Profile entry ${index + 1} traits`}
                    size="sm"
                    value={entry.traits.join(", ")}
                    onChange={(event) =>
                      updateActivePool((pool) => ({
                        ...pool,
                        entries: pool.entries.map((candidate, candidateIndex) =>
                          candidateIndex === index
                            ? {
                                ...candidate,
                                traits: event.currentTarget.value
                                  .split(",")
                                  .map((trait) => trait.trim())
                                  .filter(Boolean),
                              }
                            : candidate,
                        ),
                      }))
                    }
                  />
                  <Textarea
                    aria-label={`Profile entry ${index + 1} style text`}
                    size="sm"
                    value={entry.styleText}
                    onChange={(event) =>
                      updateActivePool((pool) => ({
                        ...pool,
                        entries: pool.entries.map((candidate, candidateIndex) =>
                          candidateIndex === index
                            ? { ...candidate, styleText: event.currentTarget.value }
                            : candidate,
                        ),
                      }))
                    }
                  />
                  <div className="text-xs font-medium text-muted-foreground">Rich archetype</div>
                  <Input
                    aria-label={`Profile entry ${index + 1} rich label`}
                    size="sm"
                    value={entry.rich.label}
                    onChange={(event) =>
                      updateActivePool((pool) => ({
                        ...pool,
                        entries: pool.entries.map((candidate, candidateIndex) =>
                          candidateIndex === index
                            ? {
                                ...candidate,
                                rich: { ...candidate.rich, label: event.currentTarget.value },
                              }
                            : candidate,
                        ),
                      }))
                    }
                  />
                  <Input
                    aria-label={`Profile entry ${index + 1} rich traits`}
                    size="sm"
                    value={entry.rich.traits.join(", ")}
                    onChange={(event) =>
                      updateActivePool((pool) => ({
                        ...pool,
                        entries: pool.entries.map((candidate, candidateIndex) =>
                          candidateIndex === index
                            ? {
                                ...candidate,
                                rich: {
                                  ...candidate.rich,
                                  traits: event.currentTarget.value
                                    .split(",")
                                    .map((trait) => trait.trim())
                                    .filter(Boolean),
                                },
                              }
                            : candidate,
                        ),
                      }))
                    }
                  />
                  <Input
                    aria-label={`Profile entry ${index + 1} rich axiom`}
                    size="sm"
                    value={entry.rich.axiom}
                    onChange={(event) =>
                      updateActivePool((pool) => ({
                        ...pool,
                        entries: pool.entries.map((candidate, candidateIndex) =>
                          candidateIndex === index
                            ? {
                                ...candidate,
                                rich: { ...candidate.rich, axiom: event.currentTarget.value },
                              }
                            : candidate,
                        ),
                      }))
                    }
                  />
                  <Input
                    aria-label={`Profile entry ${index + 1} rich voice`}
                    size="sm"
                    value={entry.rich.voice}
                    onChange={(event) =>
                      updateActivePool((pool) => ({
                        ...pool,
                        entries: pool.entries.map((candidate, candidateIndex) =>
                          candidateIndex === index
                            ? {
                                ...candidate,
                                rich: { ...candidate.rich, voice: event.currentTarget.value },
                              }
                            : candidate,
                        ),
                      }))
                    }
                  />
                  <Textarea
                    aria-label={`Profile entry ${index + 1} rich style text`}
                    size="sm"
                    value={entry.rich.styleText}
                    onChange={(event) =>
                      updateActivePool((pool) => ({
                        ...pool,
                        entries: pool.entries.map((candidate, candidateIndex) =>
                          candidateIndex === index
                            ? {
                                ...candidate,
                                rich: { ...candidate.rich, styleText: event.currentTarget.value },
                              }
                            : candidate,
                        ),
                      }))
                    }
                  />
                </div>
              ))}
              <Button
                size="sm"
                variant="outline"
                disabled={maxEntries !== undefined && activePool.entries.length >= maxEntries}
                onClick={() =>
                  updateActivePool((pool) => {
                    let suffix = pool.entries.length + 1;
                    let id = `profile-${suffix}`;
                    while (pool.entries.some((entry) => entry.id === id))
                      id = `profile-${++suffix}`;
                    return {
                      ...pool,
                      entries: [
                        ...pool.entries,
                        {
                          id,
                          label: "",
                          traits: [],
                          styleText: "",
                          rich: { label: "", traits: [], axiom: "", voice: "", styleText: "" },
                          weight: 1,
                        },
                      ],
                    };
                  })
                }
              >
                Add profile
              </Button>
              {!probabilitiesAvailable ? (
                <div className="text-xs text-muted-foreground">
                  Server probability output is available for the selected personality pool only; no
                  client-side probability is inferred.
                </div>
              ) : null}
            </div>
          )}
          {message !== null ? (
            <div role="status" className="text-sm text-muted-foreground">
              {message}
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={previewing || saving || conflictRefreshPending}
            onClick={preview}
          >
            {previewing
              ? "Previewing…"
              : conflictRefreshPending
                ? "Refreshing…"
                : "Validate & preview"}
          </Button>
          <Button
            disabled={previewChanges === null || previewing || saving || conflictReview}
            onClick={save}
          >
            {saving ? "Saving…" : "Save pools"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
