import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  CIVILIZATION_CONFIG_VERSION,
  type CivilizationConfigOverride,
  type CivilizationEffectiveConfig,
  type CivilizationProviderCapability,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomSet } from "@effect/atom-react";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import {
  applyCivilizationConfigFanout,
  civilizationConfigAction,
  type CivilizationContextInspectionFilters,
  civilizationConfigExpectedRevision,
  prepareCivilizationImportPreview,
  refreshCivilizationOverview,
  type CivilizationConfigActionInput,
  useCivilizationConfigTargets,
  useCivilizationOverview,
} from "../../state/civilization";
import {
  readEnvironmentScope,
  useEnvironmentsWithScope,
  useEnvironmentScope,
} from "../../state/session";
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
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  CivilizationNamePoolEditorDialog,
  CivilizationProfilePoolEditorDialog,
} from "./CivilizationPoolEditorDialogs";
import { CivilizationContextInspector } from "./CivilizationContextInspector";
import { CivilizationProjectInspection } from "./CivilizationProjectInspection";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

type CivilizationTarget = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly projectId: ProjectId | null;
};

const sourceLabel = (
  effective: CivilizationEffectiveConfig,
  path: string,
): "Built in" | "Environment override" | "Project override" => {
  const source = effective.provenance.find((entry) => entry.path === path)?.source ?? "builtin";
  switch (source) {
    case "environment":
      return "Environment override";
    case "project":
      return "Project override";
    default:
      return "Built in";
  }
};

const supportLabel = (capability: CivilizationProviderCapability) => {
  switch (capability.support) {
    case "full":
      return "Full";
    case "metadata_only":
      return "Metadata only";
    case "unsupported":
      return "Unsupported";
  }
};

function ReadOnlyValue({ children }: { readonly children: string }) {
  return <span className="text-sm font-medium text-foreground">{children}</span>;
}

type ParticipationDraft = Pick<
  CivilizationEffectiveConfig["config"]["participation"],
  "enabled" | "emergencyOff" | "adoption"
>;

const participationDraftFromEffective = (
  effective: CivilizationEffectiveConfig,
): ParticipationDraft => ({
  enabled: effective.config.participation.enabled,
  emergencyOff: effective.config.participation.emergencyOff,
  adoption: effective.config.participation.adoption,
});

type IdentityDraft = {
  readonly selectedNamePoolId: string;
  readonly automaticTitles: boolean;
  readonly titleTemplate: string;
  readonly adoptionTitlePolicy: CivilizationEffectiveConfig["config"]["names"]["adoptionTitlePolicy"];
  readonly selectedProfilePoolId: string;
  readonly rendering: CivilizationEffectiveConfig["config"]["personalities"]["rendering"];
};

const identityDraftFromEffective = (effective: CivilizationEffectiveConfig): IdentityDraft => ({
  selectedNamePoolId: effective.config.names.selectedPoolId,
  automaticTitles: effective.config.names.automaticTitles,
  titleTemplate: effective.config.names.titleTemplate,
  adoptionTitlePolicy: effective.config.names.adoptionTitlePolicy,
  selectedProfilePoolId: effective.config.personalities.selectedPoolId,
  rendering: effective.config.personalities.rendering,
});

type ContextDraft = {
  readonly knowledge: CivilizationEffectiveConfig["config"]["knowledge"];
  readonly context: CivilizationEffectiveConfig["config"]["context"];
};

const contextDraftFromEffective = (effective: CivilizationEffectiveConfig): ContextDraft => ({
  knowledge: {
    ...effective.config.knowledge,
    noteCategories: [...effective.config.knowledge.noteCategories],
  },
  context: { ...effective.config.context },
});

type MessagingDraft = CivilizationEffectiveConfig["config"]["messaging"];
const messagingDraftFromEffective = (effective: CivilizationEffectiveConfig): MessagingDraft => ({
  ...effective.config.messaging,
  eligibleThreadKinds: [...effective.config.messaging.eligibleThreadKinds],
});

type OperationsDraft = CivilizationEffectiveConfig["config"]["operations"];
const operationsDraftFromEffective = (effective: CivilizationEffectiveConfig): OperationsDraft => ({
  ...effective.config.operations,
});

const configActionErrorMessage = (error: unknown): string => {
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
    : "The Civilization configuration was not saved.";
};

type CivilizationConfigActionResult = {
  readonly effective: CivilizationEffectiveConfig;
  readonly changes?: ReadonlyArray<unknown>;
  readonly json?: string;
  readonly revision?: number;
};

type CivilizationConfigRunner = (
  input: CivilizationConfigActionInput,
) => Promise<CivilizationConfigActionResult>;

interface CivilizationSectionEditor<T> {
  readonly draft: T | null;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly message: string | null;
  readonly capturedRevision: number | null;
  readonly conflictRefreshPending: boolean;
  readonly update: (updater: (current: T) => T) => void;
  readonly save: () => void;
}

function useCivilizationSectionEditor<T>(input: {
  readonly target: CivilizationTarget;
  readonly effective: CivilizationEffectiveConfig | null;
  readonly runConfigAction: CivilizationConfigRunner;
  readonly refresh: () => void;
  readonly select: (effective: CivilizationEffectiveConfig) => T;
  readonly buildOverride: (draft: T, baseline: T) => CivilizationConfigOverride;
}): CivilizationSectionEditor<T> {
  const initial = input.effective === null ? null : input.select(input.effective);
  const [draftState, setDraftState] = useState<T | null>(() => initial);
  const [baselineState, setBaselineState] = useState<T | null>(() => initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [conflictReviewRequired, setConflictReviewRequired] = useState(false);
  const [capturedRevisionState, setCapturedRevisionState] = useState<number | null>(() =>
    input.effective === null
      ? null
      : civilizationConfigExpectedRevision(input.effective, input.target.projectId),
  );
  const [awaitingRevision, setAwaitingRevision] = useState<number | null>(null);
  const serverDraft = input.effective === null ? null : input.select(input.effective);
  const currentRevision =
    input.effective === null
      ? null
      : civilizationConfigExpectedRevision(input.effective, input.target.projectId);
  const waitingForCommittedRefresh =
    awaitingRevision !== null && currentRevision !== null && currentRevision < awaitingRevision;
  const settledServerDraft = waitingForCommittedRefresh ? draftState : serverDraft;
  const draft = dirty ? draftState : settledServerDraft;
  const baseline = dirty ? baselineState : settledServerDraft;
  const refreshedConflictRevision =
    conflictReviewRequired &&
    currentRevision !== null &&
    capturedRevisionState !== null &&
    currentRevision !== capturedRevisionState
      ? currentRevision
      : null;
  const capturedRevision = dirty
    ? (refreshedConflictRevision ?? capturedRevisionState)
    : waitingForCommittedRefresh
      ? awaitingRevision
      : currentRevision;

  const conflictRefreshPending =
    conflictReviewRequired &&
    currentRevision !== null &&
    capturedRevisionState !== null &&
    capturedRevisionState === currentRevision;

  const update = (updater: (current: T) => T) => {
    const current = draft ?? (input.effective === null ? null : input.select(input.effective));
    if (current === null) return;
    if (!dirty) {
      setBaselineState(current);
      setCapturedRevisionState(capturedRevision);
    }
    setDraftState(updater(current));
    setDirty(true);
    if (!conflictReviewRequired) setMessage(null);
  };

  const save = () => {
    if (
      draft === null ||
      baseline === null ||
      capturedRevision === null ||
      saving ||
      conflictRefreshPending
    )
      return;
    const override = input.buildOverride(draft, baseline);
    setSaving(true);
    setMessage(null);
    void (async () => {
      try {
        await input.runConfigAction({
          environmentId: input.target.environmentId,
          projectId: input.target.projectId,
          type: "validate",
          override,
        });
      } catch (error) {
        setSaving(false);
        setMessage(configActionErrorMessage(error));
        return;
      }
      if (!readEnvironmentScope(input.target.environmentId, AuthSettingsWriteScope)) {
        setSaving(false);
        setMessage("Permission changed before save; settings:write is required.");
        return;
      }
      try {
        const committed = await input.runConfigAction({
          environmentId: input.target.environmentId,
          projectId: input.target.projectId,
          type: "set",
          expectedRevision: capturedRevision,
          override,
        });
        const nextRevision = civilizationConfigExpectedRevision(
          committed.effective,
          input.target.projectId,
        );
        setSaving(false);
        const committedDraft = input.select(committed.effective);
        setDraftState(committedDraft);
        setBaselineState(committedDraft);
        setCapturedRevisionState(nextRevision);
        setAwaitingRevision(nextRevision);
        setDirty(false);
        setConflictReviewRequired(false);
        setMessage("Saved.");
        input.refresh();
      } catch (error) {
        setSaving(false);
        if (
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          error._tag === "CivilizationConfigConflictError"
        ) {
          setConflictReviewRequired(true);
          setMessage("Configuration changed elsewhere; review and save again.");
          input.refresh();
          return;
        }
        setMessage(configActionErrorMessage(error));
      }
    })();
  };

  return { draft, dirty, saving, message, capturedRevision, conflictRefreshPending, update, save };
}

function SectionSaveRow<T>({
  title,
  editor,
  canWrite,
  target,
}: {
  readonly title: string;
  readonly editor: CivilizationSectionEditor<T>;
  readonly canWrite: boolean;
  readonly target: CivilizationTarget;
}) {
  if (!canWrite && !editor.dirty && editor.message === null) return null;
  return (
    <SettingsRow
      title={title}
      description={
        editor.message ??
        (editor.dirty
          ? `Unsaved draft against ${target.projectId === null ? "environment" : "project"} revision ${editor.capturedRevision ?? "unknown"}.`
          : "No unsaved changes.")
      }
      control={
        canWrite ? (
          <Button
            size="sm"
            disabled={!editor.dirty || editor.saving || editor.conflictRefreshPending}
            onClick={editor.save}
          >
            {editor.saving ? "Saving…" : editor.conflictRefreshPending ? "Refreshing…" : "Save"}
          </Button>
        ) : (
          <ReadOnlyValue>Read only</ReadOnlyValue>
        )
      }
    />
  );
}

function NumberEditor({
  value,
  onChange,
  label,
  disabled,
}: {
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly label: string;
  readonly disabled: boolean;
}) {
  return (
    <Input
      aria-label={label}
      type="number"
      size="sm"
      value={String(value)}
      disabled={disabled}
      onChange={(event) => {
        const next = Number(event.currentTarget.value);
        if (Number.isFinite(next)) onChange(next);
      }}
    />
  );
}

type MultiParticipationDraft = {
  readonly enabled: boolean | null;
  readonly adoption: ParticipationDraft["adoption"] | null;
};

const civilizationTargetKey = (target: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
}) => `${target.environmentId}\u0000${target.projectId ?? "environment"}`;

function CivilizationMultiTargetParticipation({
  targets,
}: {
  readonly targets: ReadonlyArray<CivilizationTarget>;
}) {
  const readable = useEnvironmentsWithScope(targets, AuthOrchestrationReadScope);
  const writable = useEnvironmentsWithScope(targets, AuthSettingsWriteScope);
  const scopedTargets = targets
    .filter((target) => readable.has(target.environmentId))
    .map(({ environmentId, projectId }) => ({ environmentId, projectId }));
  const overview = useCivilizationConfigTargets(scopedTargets);
  const runConfigAction: CivilizationConfigRunner = useAtomSet(civilizationConfigAction, {
    mode: "promise",
  });
  const [draftState, setDraftState] = useState<MultiParticipationDraft>({
    enabled: null,
    adoption: null,
  });
  const [dirty, setDirty] = useState(false);
  const [capturedRevisions, setCapturedRevisions] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reviewRequired, setReviewRequired] = useState(false);

  const resolvedDraft: MultiParticipationDraft = (() => {
    if (overview.data === null || overview.data.length === 0)
      return { enabled: null, adoption: null };
    const enabled = new Set(
      overview.data.map(({ overview: value }) => value.effective.config.participation.enabled),
    );
    const adoption = new Set(
      overview.data.map(({ overview: value }) => value.effective.config.participation.adoption),
    );
    return {
      enabled: enabled.size === 1 ? [...enabled][0]! : null,
      adoption: adoption.size === 1 ? [...adoption][0]! : null,
    };
  })();
  const draft = dirty ? draftState : resolvedDraft;
  const currentRevisions = (() => {
    const next: Record<string, number> = {};
    for (const entry of overview.data ?? []) {
      next[civilizationTargetKey(entry)] = civilizationConfigExpectedRevision(
        entry.overview.effective,
        entry.projectId,
      );
    }
    return next;
  })();
  const conflictRefreshComplete =
    reviewRequired &&
    Object.entries(capturedRevisions).some(
      ([key, revision]) =>
        currentRevisions[key] !== undefined && currentRevisions[key] !== revision,
    );
  const conflictRefreshPending = reviewRequired && !conflictRefreshComplete;
  const effectiveCapturedRevisions = conflictRefreshComplete ? currentRevisions : capturedRevisions;

  if (targets.length < 2) return null;

  const labelByKey = new Map(
    targets.map((target) => [civilizationTargetKey(target), target.label]),
  );
  const canFanout =
    overview.data !== null &&
    overview.data.length === targets.length &&
    targets.every((target) => writable.has(target.environmentId));

  const captureCurrentRevisions = () => {
    if (overview.data === null) return;
    const next: Record<string, number> = {};
    for (const entry of overview.data) {
      next[civilizationTargetKey(entry)] = civilizationConfigExpectedRevision(
        entry.overview.effective,
        entry.projectId,
      );
    }
    setCapturedRevisions(next);
  };

  const updateDraft = (patch: Partial<MultiParticipationDraft>) => {
    if (!dirty) captureCurrentRevisions();
    setDraftState((current) => ({ ...(dirty ? current : resolvedDraft), ...patch }));
    setDirty(true);
    setMessage(null);
  };

  const save = () => {
    if (!dirty || saving || overview.data === null) return;
    const override: CivilizationConfigOverride = {
      version: CIVILIZATION_CONFIG_VERSION,
      participation: {
        ...(draft.enabled === null ? {} : { enabled: draft.enabled }),
        ...(draft.adoption === null ? {} : { adoption: draft.adoption }),
      },
    };
    const fanoutTargets = overview.data.map((entry) => ({
      environmentId: entry.environmentId,
      label: labelByKey.get(civilizationTargetKey(entry)) ?? entry.environmentId,
      value: {
        projectId: entry.projectId,
        expectedRevision:
          effectiveCapturedRevisions[civilizationTargetKey(entry)] ??
          civilizationConfigExpectedRevision(entry.overview.effective, entry.projectId),
      },
    }));
    setSaving(true);
    setMessage(null);
    void applyCivilizationConfigFanout<
      { readonly projectId: ProjectId | null; readonly expectedRevision: number },
      unknown
    >(fanoutTargets, async (fanoutTarget) => {
      await runConfigAction({
        environmentId: fanoutTarget.environmentId,
        projectId: fanoutTarget.value.projectId,
        type: "validate",
        override,
      });
      if (!readEnvironmentScope(fanoutTarget.environmentId, AuthSettingsWriteScope)) {
        throw new Error("settings:write permission changed before save.");
      }
      return runConfigAction({
        environmentId: fanoutTarget.environmentId,
        projectId: fanoutTarget.value.projectId,
        type: "set",
        expectedRevision: fanoutTarget.value.expectedRevision,
        override,
      });
    }).then((result) => {
      setSaving(false);
      for (const applied of result.applied) {
        refreshCivilizationOverview(applied.target.environmentId, applied.target.value.projectId);
      }
      if (result.failed === null) {
        setDirty(false);
        setReviewRequired(false);
        setMessage(
          `Saved on ${result.applied.map(({ target: applied }) => applied.label).join(", ")}.`,
        );
        overview.refresh();
        return;
      }
      refreshCivilizationOverview(
        result.failed.target.environmentId,
        result.failed.target.value.projectId,
      );
      const succeeded = result.applied.map(({ target: applied }) => applied.label);
      const failure = result.failed.error;
      const conflict =
        typeof failure === "object" &&
        failure !== null &&
        "_tag" in failure &&
        failure._tag === "CivilizationConfigConflictError";
      const prefix = conflict
        ? "Configuration changed elsewhere; review and save again."
        : configActionErrorMessage(failure);
      setMessage(
        `${prefix}${succeeded.length > 0 ? ` Saved on ${succeeded.join(", ")}.` : ""} Failed on ${result.failed.target.label}; later environments were not changed.`,
      );
      if (result.applied.length === 0) {
        setReviewRequired(conflict);
      } else {
        setDirty(false);
        setReviewRequired(false);
      }
      overview.refresh();
    });
  };

  const breakdown =
    overview.data?.map((entry) => {
      const config = entry.overview.effective.config.participation;
      return `${labelByKey.get(civilizationTargetKey(entry)) ?? entry.environmentId}: ${config.enabled ? "enabled" : "disabled"}, ${config.adoption.replaceAll("_", " ")}`;
    }) ?? [];

  return (
    <SettingsSection title="Selected environments" id="civilization-mixed-selection">
      <SettingsRow
        title="Enabled"
        description={
          draft.enabled === null
            ? `Mixed · ${breakdown.join(" · ")}`
            : `One explicit value will be applied sequentially to each selected environment. ${breakdown.join(" · ")}`
        }
        control={
          <Switch
            aria-label="Civilization enabled across selected environments"
            checked={draft.enabled ?? false}
            mixed={draft.enabled === null}
            disabled={!canFanout || saving}
            onCheckedChange={(checked) => updateDraft({ enabled: checked })}
          />
        }
      />
      <SettingsRow
        title="Adoption"
        description={
          draft.adoption === null
            ? "Mixed across selected environments."
            : "Explicit fan-out value."
        }
        control={
          <Select
            value={draft.adoption}
            disabled={!canFanout || saving}
            onValueChange={(value) =>
              updateDraft({ adoption: value as ParticipationDraft["adoption"] })
            }
          >
            <SelectTrigger
              aria-label="Civilization adoption across selected environments"
              size="sm"
            >
              {draft.adoption === null ? <span>Mixed</span> : <SelectValue />}
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="future_only">Future only</SelectItem>
              <SelectItem value="all_existing">All existing</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Apply to selection"
        description={
          message ??
          (canFanout
            ? "Each environment uses its own captured revision. The sequence stops at the first failure and never rolls back earlier independent commits."
            : "All selected environments need orchestration:read and settings:write access before fan-out is available.")
        }
        control={
          <Button
            size="sm"
            disabled={!canFanout || !dirty || saving || conflictRefreshPending}
            onClick={save}
          >
            {saving ? "Saving…" : conflictRefreshPending ? "Refreshing…" : "Apply"}
          </Button>
        }
      />
    </SettingsSection>
  );
}

function CivilizationTargetOverview({
  target,
  allowSensitiveProjectActions,
  initialInspectionFilters,
}: {
  readonly target: CivilizationTarget;
  readonly allowSensitiveProjectActions: boolean;
  readonly initialInspectionFilters?: CivilizationContextInspectionFilters | undefined;
}) {
  const canRead = useEnvironmentScope(target.environmentId, AuthOrchestrationReadScope);
  const canWrite = useEnvironmentScope(target.environmentId, AuthSettingsWriteScope);
  const runConfigAction: CivilizationConfigRunner = useAtomSet(civilizationConfigAction, {
    mode: "promise",
  });
  const overview = useCivilizationOverview(
    canRead ? target.environmentId : null,
    canRead ? target.projectId : null,
  );
  const effectiveSnapshot = overview.data?.effective ?? null;
  const participationEditor = useCivilizationSectionEditor<ParticipationDraft>({
    target,
    effective: effectiveSnapshot,
    runConfigAction,
    refresh: overview.refresh,
    select: participationDraftFromEffective,
    buildOverride: (draft, baseline) => ({
      version: CIVILIZATION_CONFIG_VERSION,
      participation: {
        ...(draft.enabled === baseline.enabled ? {} : { enabled: draft.enabled }),
        ...(draft.emergencyOff === baseline.emergencyOff
          ? {}
          : { emergencyOff: draft.emergencyOff }),
        ...(draft.adoption === baseline.adoption ? {} : { adoption: draft.adoption }),
      },
    }),
  });
  const identityEditor = useCivilizationSectionEditor<IdentityDraft>({
    target,
    effective: effectiveSnapshot,
    runConfigAction,
    refresh: overview.refresh,
    select: identityDraftFromEffective,
    buildOverride: (draft, baseline) => ({
      version: CIVILIZATION_CONFIG_VERSION,
      names: {
        ...(draft.selectedNamePoolId === baseline.selectedNamePoolId
          ? {}
          : { selectedPoolId: draft.selectedNamePoolId }),
        ...(draft.automaticTitles === baseline.automaticTitles
          ? {}
          : { automaticTitles: draft.automaticTitles }),
        ...(draft.titleTemplate === baseline.titleTemplate
          ? {}
          : { titleTemplate: draft.titleTemplate }),
        ...(draft.adoptionTitlePolicy === baseline.adoptionTitlePolicy
          ? {}
          : { adoptionTitlePolicy: draft.adoptionTitlePolicy }),
      },
      personalities: {
        ...(draft.selectedProfilePoolId === baseline.selectedProfilePoolId
          ? {}
          : { selectedPoolId: draft.selectedProfilePoolId }),
        ...(draft.rendering === baseline.rendering ? {} : { rendering: draft.rendering }),
      },
    }),
  });
  const contextEditor = useCivilizationSectionEditor<ContextDraft>({
    target,
    effective: effectiveSnapshot,
    runConfigAction,
    refresh: overview.refresh,
    select: contextDraftFromEffective,
    buildOverride: (draft, baseline) => ({
      version: CIVILIZATION_CONFIG_VERSION,
      knowledge: {
        ...(JSON.stringify(draft.knowledge.noteCategories) ===
        JSON.stringify(baseline.knowledge.noteCategories)
          ? {}
          : { noteCategories: draft.knowledge.noteCategories }),
        ...(draft.knowledge.noteBytes === baseline.knowledge.noteBytes
          ? {}
          : { noteBytes: draft.knowledge.noteBytes }),
        ...(draft.knowledge.activeNotes === baseline.knowledge.activeNotes
          ? {}
          : { activeNotes: draft.knowledge.activeNotes }),
        ...(draft.knowledge.retentionDays === baseline.knowledge.retentionDays
          ? {}
          : { retentionDays: draft.knowledge.retentionDays }),
        ...(draft.knowledge.packetInclusion === baseline.knowledge.packetInclusion
          ? {}
          : { packetInclusion: draft.knowledge.packetInclusion }),
        ...(draft.knowledge.ancestorReads === baseline.knowledge.ancestorReads
          ? {}
          : { ancestorReads: draft.knowledge.ancestorReads }),
        ...(draft.knowledge.showGeneration === baseline.knowledge.showGeneration
          ? {}
          : { showGeneration: draft.knowledge.showGeneration }),
        ...(draft.knowledge.showParent === baseline.knowledge.showParent
          ? {}
          : { showParent: draft.knowledge.showParent }),
      },
      context: {
        ...(draft.context.packetBytes === baseline.context.packetBytes
          ? {}
          : { packetBytes: draft.context.packetBytes }),
        ...(draft.context.rosterCount === baseline.context.rosterCount
          ? {}
          : { rosterCount: draft.context.rosterCount }),
        ...(draft.context.noteCount === baseline.context.noteCount
          ? {}
          : { noteCount: draft.context.noteCount }),
        ...(draft.context.inboxExcerptCount === baseline.context.inboxExcerptCount
          ? {}
          : { inboxExcerptCount: draft.context.inboxExcerptCount }),
        ...(draft.context.selection === baseline.context.selection
          ? {}
          : { selection: draft.context.selection }),
      },
    }),
  });
  const messagingEditor = useCivilizationSectionEditor<MessagingDraft>({
    target,
    effective: effectiveSnapshot,
    runConfigAction,
    refresh: overview.refresh,
    select: messagingDraftFromEffective,
    buildOverride: (draft, baseline) => ({
      version: CIVILIZATION_CONFIG_VERSION,
      messaging: {
        ...(draft.enabled === baseline.enabled ? {} : { enabled: draft.enabled }),
        ...(JSON.stringify(draft.eligibleThreadKinds) ===
        JSON.stringify(baseline.eligibleThreadKinds)
          ? {}
          : { eligibleThreadKinds: draft.eligibleThreadKinds }),
        ...(draft.allowControllableChildren === baseline.allowControllableChildren
          ? {}
          : { allowControllableChildren: draft.allowControllableChildren }),
        ...(draft.messageBytes === baseline.messageBytes
          ? {}
          : { messageBytes: draft.messageBytes }),
        ...(draft.pendingPerRecipient === baseline.pendingPerRecipient
          ? {}
          : { pendingPerRecipient: draft.pendingPerRecipient }),
        ...(draft.senderPerMinute === baseline.senderPerMinute
          ? {}
          : { senderPerMinute: draft.senderPerMinute }),
        ...(draft.projectPerMinute === baseline.projectPerMinute
          ? {}
          : { projectPerMinute: draft.projectPerMinute }),
        ...(draft.retainedMessageCount === baseline.retainedMessageCount
          ? {}
          : { retainedMessageCount: draft.retainedMessageCount }),
        ...(draft.retainedBodyBytes === baseline.retainedBodyBytes
          ? {}
          : { retainedBodyBytes: draft.retainedBodyBytes }),
        ...(draft.unreadTtlDays === baseline.unreadTtlDays
          ? {}
          : { unreadTtlDays: draft.unreadTtlDays }),
        ...(draft.repliesEnabled === baseline.repliesEnabled
          ? {}
          : { repliesEnabled: draft.repliesEnabled }),
      },
    }),
  });
  const operationsEditor = useCivilizationSectionEditor<OperationsDraft>({
    target,
    effective: effectiveSnapshot,
    runConfigAction,
    refresh: overview.refresh,
    select: operationsDraftFromEffective,
    buildOverride: (draft, baseline) => ({
      version: CIVILIZATION_CONFIG_VERSION,
      operations: {
        ...(draft.terminalRetentionDays === baseline.terminalRetentionDays
          ? {}
          : { terminalRetentionDays: draft.terminalRetentionDays }),
        ...(draft.operationReceiptRetentionDays === baseline.operationReceiptRetentionDays
          ? {}
          : { operationReceiptRetentionDays: draft.operationReceiptRetentionDays }),
        ...(draft.diagnosticRetentionDays === baseline.diagnosticRetentionDays
          ? {}
          : { diagnosticRetentionDays: draft.diagnosticRetentionDays }),
        ...(draft.tombstoneRetentionDays === baseline.tombstoneRetentionDays
          ? {}
          : { tombstoneRetentionDays: draft.tombstoneRetentionDays }),
        ...(draft.cleanupCadenceMinutes === baseline.cleanupCadenceMinutes
          ? {}
          : { cleanupCadenceMinutes: draft.cleanupCadenceMinutes }),
        ...(draft.cleanupBatch === baseline.cleanupBatch
          ? {}
          : { cleanupBatch: draft.cleanupBatch }),
        ...(draft.censusPageSize === baseline.censusPageSize
          ? {}
          : { censusPageSize: draft.censusPageSize }),
        ...(draft.inboxPageSize === baseline.inboxPageSize
          ? {}
          : { inboxPageSize: draft.inboxPageSize }),
        ...(draft.responseBodyBytes === baseline.responseBodyBytes
          ? {}
          : { responseBodyBytes: draft.responseBodyBytes }),
        ...(draft.diagnostics === baseline.diagnostics ? {} : { diagnostics: draft.diagnostics }),
      },
    }),
  });
  const [resettingTier, setResettingTier] = useState(false);
  const [namePoolOpen, setNamePoolOpen] = useState(false);
  const [profilePoolOpen, setProfilePoolOpen] = useState(false);
  const [configToolMessage, setConfigToolMessage] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importJson, setImportJson] = useState("");
  const [importExpectedRevision, setImportExpectedRevision] = useState<number | null>(null);
  const [importPreviewChanges, setImportPreviewChanges] = useState<number | null>(null);
  const [importPreviewing, setImportPreviewing] = useState(false);
  const [importSaving, setImportSaving] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importConflictReview, setImportConflictReview] = useState(false);
  const effectiveSnapshotRevision =
    effectiveSnapshot === null
      ? null
      : civilizationConfigExpectedRevision(effectiveSnapshot, target.projectId);

  const importConflictRefreshPending =
    importOpen &&
    importConflictReview &&
    effectiveSnapshotRevision !== null &&
    effectiveSnapshotRevision === importExpectedRevision;

  if (!canRead) {
    return (
      <SettingsSection title={target.label} id="civilization-status">
        <SettingsRow
          title="Civilization"
          description="This client does not have orchestration:read permission for this environment."
          control={<ReadOnlyValue>Unavailable</ReadOnlyValue>}
        />
      </SettingsSection>
    );
  }

  if (overview.data === null && overview.isPending) {
    return (
      <SettingsSection title={target.label} id="civilization-status">
        <SettingsRow
          title="Civilization"
          description="Loading server-owned status, capabilities, and effective configuration."
          control={<ReadOnlyValue>Loading…</ReadOnlyValue>}
        />
      </SettingsSection>
    );
  }

  if (overview.data === null) {
    return (
      <SettingsSection
        title={target.label}
        id="civilization-status"
        headerAction={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Refresh ${target.label}`}
            onClick={overview.refresh}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        }
      >
        <SettingsRow
          title="Civilization"
          description={overview.error ?? "The environment did not return Civilization data."}
          control={<ReadOnlyValue>Unavailable</ReadOnlyValue>}
        />
      </SettingsSection>
    );
  }

  const { status, capabilities, description, effective } = overview.data;
  const fullProviders = capabilities.providers.filter(
    (provider) => provider.support === "full",
  ).length;
  const limitedProviders = capabilities.providers.length - fullProviders;
  const config = effective.config;
  const tierRevision = civilizationConfigExpectedRevision(effective, target.projectId);
  const importByteLimit = description.limits.importBytes ?? null;

  const resetTier = () => {
    if (resettingTier || !canWrite) return;
    if (!readEnvironmentScope(target.environmentId, AuthSettingsWriteScope)) {
      setConfigToolMessage("Permission changed before reset; settings:write is required.");
      return;
    }
    setResettingTier(true);
    setConfigToolMessage(null);
    void runConfigAction({
      environmentId: target.environmentId,
      projectId: target.projectId,
      type: "reset",
      expectedRevision: tierRevision,
    })
      .then(() => {
        setResettingTier(false);
        setConfigToolMessage(
          target.projectId === null
            ? "Environment override reset; built-in values now apply where no higher tier exists."
            : "Project override reset; environment values now apply where configured.",
        );
        overview.refresh();
      })
      .catch((error: unknown) => {
        setResettingTier(false);
        if (
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          error._tag === "CivilizationConfigConflictError"
        ) {
          setConfigToolMessage("Configuration changed elsewhere; review and save again.");
          overview.refresh();
          return;
        }
        setConfigToolMessage(configActionErrorMessage(error));
      });
  };

  const exportConfig = () => {
    setConfigToolMessage(null);
    void runConfigAction({
      environmentId: target.environmentId,
      projectId: target.projectId,
      type: "export",
    })
      .then((result) => {
        if (typeof result.json !== "string") {
          setConfigToolMessage("The server did not return a canonical configuration export.");
          return;
        }
        const blob = new Blob([result.json], { type: "application/json" });
        const href = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.download = `civilization-${target.environmentId}-${target.projectId ?? "environment"}.json`;
        anchor.click();
        URL.revokeObjectURL(href);
        setConfigToolMessage("Canonical configuration export downloaded.");
      })
      .catch((error: unknown) => setConfigToolMessage(configActionErrorMessage(error)));
  };

  const openImport = () => {
    setImportJson("");
    setImportExpectedRevision(tierRevision);
    setImportPreviewChanges(null);
    setImportMessage(null);
    setImportConflictReview(false);
    setImportOpen(true);
  };

  const previewImport = () => {
    if (importPreviewing || importSaving) return;
    if (importConflictRefreshPending) return;
    if (
      importConflictReview &&
      effectiveSnapshotRevision !== null &&
      effectiveSnapshotRevision !== importExpectedRevision
    ) {
      setImportExpectedRevision(effectiveSnapshotRevision);
      setImportConflictReview(false);
    }
    if (importByteLimit === null) {
      setImportMessage("The server did not advertise a configuration import byte limit.");
      setImportPreviewChanges(null);
      return;
    }
    const candidate = prepareCivilizationImportPreview(importJson, importByteLimit);
    if (!candidate.ok) {
      setImportMessage(candidate.message);
      setImportPreviewChanges(null);
      return;
    }
    setImportPreviewing(true);
    setImportMessage(null);
    void runConfigAction({
      environmentId: target.environmentId,
      projectId: target.projectId,
      type: "validate",
      override: candidate.override,
    })
      .then(() =>
        runConfigAction({
          environmentId: target.environmentId,
          projectId: target.projectId,
          type: "diff",
          override: candidate.override,
        }),
      )
      .then((result) => {
        setImportPreviewing(false);
        setImportPreviewChanges(result.changes?.length ?? 0);
        setImportMessage(
          `${result.changes?.length ?? 0} effective configuration changes in the current server preview.`,
        );
      })
      .catch((error: unknown) => {
        setImportPreviewing(false);
        setImportPreviewChanges(null);
        setImportMessage(configActionErrorMessage(error));
      });
  };

  const applyImport = () => {
    if (
      importSaving ||
      importPreviewing ||
      importPreviewChanges === null ||
      importExpectedRevision === null
    )
      return;
    if (!readEnvironmentScope(target.environmentId, AuthSettingsWriteScope)) {
      setImportMessage("Permission changed before import; settings:write is required.");
      return;
    }
    setImportSaving(true);
    setImportMessage(null);
    void runConfigAction({
      environmentId: target.environmentId,
      projectId: target.projectId,
      type: "import",
      expectedRevision: importExpectedRevision,
      json: importJson,
    })
      .then(() => {
        setImportSaving(false);
        setImportOpen(false);
        setConfigToolMessage("Configuration import committed.");
        overview.refresh();
      })
      .catch((error: unknown) => {
        setImportSaving(false);
        if (
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          error._tag === "CivilizationConfigConflictError"
        ) {
          setImportConflictReview(true);
          setImportPreviewChanges(null);
          setImportMessage("Configuration changed elsewhere; review and save again.");
          overview.refresh();
          return;
        }
        setImportMessage(configActionErrorMessage(error));
      });
  };

  return (
    <div className="space-y-8">
      <SettingsSection
        title={target.label}
        id="civilization-status"
        headerAction={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Refresh ${target.label}`}
            onClick={overview.refresh}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        }
      >
        <SettingsRow
          title="Status"
          description={
            status.detail ??
            (target.projectId === null
              ? "Environment-wide Civilization status."
              : "Civilization status for this project on the selected environment.")
          }
          control={<ReadOnlyValue>{status.status}</ReadOnlyValue>}
        />
        <SettingsRow
          title="Citizens"
          description={`${status.openCitizenCount} open of ${status.citizenCount} enrolled citizens.`}
          control={<ReadOnlyValue>{String(status.citizenCount)}</ReadOnlyValue>}
        />
        <SettingsRow
          title="Access"
          description={
            canWrite
              ? "Configuration changes validate first and commit against the captured tier revision."
              : "This connection can inspect Civilization but lacks settings:write permission."
          }
          control={<ReadOnlyValue>{canWrite ? "Read + manage" : "Read only"}</ReadOnlyValue>}
        />
        <SettingsRow
          title="Revisions"
          description={`Environment ${effective.environmentRevision}; project ${effective.projectRevision}.`}
          control={<ReadOnlyValue>{`schema v${description.version}`}</ReadOnlyValue>}
        />
      </SettingsSection>

      <SettingsSection title="Participation" id="civilization-participation">
        <SettingsRow
          title="Enabled"
          description={`${sourceLabel(effective, "participation.enabled")} · changes are staged locally until Save.`}
          control={
            canWrite && participationEditor.draft !== null ? (
              <Switch
                aria-label={`Enable Civilization on ${target.label}`}
                checked={participationEditor.draft.enabled}
                disabled={participationEditor.saving}
                onCheckedChange={(checked) =>
                  participationEditor.update((current) => ({ ...current, enabled: checked }))
                }
              />
            ) : (
              <ReadOnlyValue>{config.participation.enabled ? "Enabled" : "Disabled"}</ReadOnlyValue>
            )
          }
        />
        <SettingsRow
          title="Emergency off"
          description={`${sourceLabel(effective, "participation.emergencyOff")} · stronger operational stop than ordinary disable.`}
          control={
            canWrite && participationEditor.draft !== null ? (
              <Switch
                aria-label={`Emergency off Civilization on ${target.label}`}
                checked={participationEditor.draft.emergencyOff}
                disabled={participationEditor.saving}
                onCheckedChange={(checked) =>
                  participationEditor.update((current) => ({ ...current, emergencyOff: checked }))
                }
              />
            ) : (
              <ReadOnlyValue>{config.participation.emergencyOff ? "On" : "Off"}</ReadOnlyValue>
            )
          }
        />
        <SettingsRow
          title="Adoption"
          description={`${sourceLabel(effective, "participation.adoption")} · ${description.applicationTiming.participation}.`}
          control={
            canWrite && participationEditor.draft !== null ? (
              <Select
                value={participationEditor.draft.adoption}
                onValueChange={(value) =>
                  participationEditor.update((current) => ({
                    ...current,
                    adoption: value as ParticipationDraft["adoption"],
                  }))
                }
                disabled={participationEditor.saving}
              >
                <SelectTrigger aria-label={`Civilization adoption on ${target.label}`} size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="future_only">Future only</SelectItem>
                  <SelectItem value="all_existing">All existing</SelectItem>
                </SelectPopup>
              </Select>
            ) : (
              <ReadOnlyValue>{config.participation.adoption.replaceAll("_", " ")}</ReadOnlyValue>
            )
          }
        />
        <SectionSaveRow
          title="Save participation"
          editor={participationEditor}
          canWrite={canWrite}
          target={target}
        />
      </SettingsSection>

      <SettingsSection title="Identity and personality" id="civilization-names">
        <SettingsRow
          title="Name pool"
          description={`${sourceLabel(effective, "names.selectedPoolId")} · ${effective.selectedNameProbabilities.length} weighted entries in the selected pool.`}
          control={
            canWrite && identityEditor.draft !== null ? (
              <Select
                value={identityEditor.draft.selectedNamePoolId}
                disabled={identityEditor.saving}
                onValueChange={(value) =>
                  identityEditor.update((current) => ({
                    ...current,
                    selectedNamePoolId: value ?? "",
                  }))
                }
              >
                <SelectTrigger aria-label={`Civilization name pool on ${target.label}`} size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {config.names.pools.map((pool) => (
                    <SelectItem key={pool.id} value={pool.id}>
                      {pool.id}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : (
              <ReadOnlyValue>{config.names.selectedPoolId}</ReadOnlyValue>
            )
          }
        />
        <SettingsRow
          title="Name pool entries"
          description={`Edit stable IDs, display names, weights, and order. The server allows up to ${description.limits.nameEntriesPerPool ?? "its advertised limit"} entries per pool.`}
          control={
            canWrite ? (
              <Button size="sm" variant="outline" onClick={() => setNamePoolOpen(true)}>
                Edit pools…
              </Button>
            ) : (
              <ReadOnlyValue>Read only</ReadOnlyValue>
            )
          }
        />
        <SettingsRow
          title="Automatic titles"
          description={`${sourceLabel(effective, "names.automaticTitles")} · title ownership remains server-managed.`}
          control={
            canWrite && identityEditor.draft !== null ? (
              <Switch
                aria-label={`Automatic Civilization titles on ${target.label}`}
                checked={identityEditor.draft.automaticTitles}
                disabled={identityEditor.saving}
                onCheckedChange={(checked) =>
                  identityEditor.update((current) => ({ ...current, automaticTitles: checked }))
                }
              />
            ) : (
              <ReadOnlyValue>{config.names.automaticTitles ? "Enabled" : "Disabled"}</ReadOnlyValue>
            )
          }
        />
        <SettingsRow
          title="Title template"
          description={`${sourceLabel(effective, "names.titleTemplate")} · validated by the server before save.`}
          control={
            canWrite && identityEditor.draft !== null ? (
              <Input
                aria-label={`Civilization title template on ${target.label}`}
                size="sm"
                value={identityEditor.draft.titleTemplate}
                disabled={identityEditor.saving}
                onChange={(event) =>
                  identityEditor.update((current) => ({
                    ...current,
                    titleTemplate: event.currentTarget.value,
                  }))
                }
              />
            ) : (
              <ReadOnlyValue>{config.names.titleTemplate}</ReadOnlyValue>
            )
          }
        />
        <SettingsRow
          title="Adoption title policy"
          description={`${sourceLabel(effective, "names.adoptionTitlePolicy")} · preserve leaves existing manual titles untouched.`}
          control={
            canWrite && identityEditor.draft !== null ? (
              <Select
                value={identityEditor.draft.adoptionTitlePolicy}
                disabled={identityEditor.saving}
                onValueChange={(value) =>
                  identityEditor.update((current) => ({
                    ...current,
                    adoptionTitlePolicy: value as IdentityDraft["adoptionTitlePolicy"],
                  }))
                }
              >
                <SelectTrigger
                  aria-label={`Civilization adoption title policy on ${target.label}`}
                  size="sm"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="preserve">Preserve</SelectItem>
                  <SelectItem value="managed">Managed</SelectItem>
                </SelectPopup>
              </Select>
            ) : (
              <ReadOnlyValue>{config.names.adoptionTitlePolicy}</ReadOnlyValue>
            )
          }
        />
        <SettingsRow
          title="Personality pool"
          description={`${sourceLabel(effective, "personalities.selectedPoolId")} · ${effective.selectedProfileProbabilities.length} weighted profiles in the selected pool.`}
          control={
            canWrite && identityEditor.draft !== null ? (
              <Select
                value={identityEditor.draft.selectedProfilePoolId}
                disabled={identityEditor.saving}
                onValueChange={(value) =>
                  identityEditor.update((current) => ({
                    ...current,
                    selectedProfilePoolId: value ?? "",
                  }))
                }
              >
                <SelectTrigger
                  aria-label={`Civilization personality pool on ${target.label}`}
                  size="sm"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {config.personalities.pools.map((pool) => (
                    <SelectItem key={pool.id} value={pool.id}>
                      {pool.id}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : (
              <ReadOnlyValue>{config.personalities.selectedPoolId}</ReadOnlyValue>
            )
          }
        />
        <SettingsRow
          title="Personality pool entries"
          description={`Edit one stable profile identity with paired mild and rich presentation variants, plus weights and order. The server allows up to ${description.limits.profileEntriesPerPool ?? "its advertised limit"} entries per pool.`}
          control={
            canWrite ? (
              <Button size="sm" variant="outline" onClick={() => setProfilePoolOpen(true)}>
                Edit pools…
              </Button>
            ) : (
              <ReadOnlyValue>Read only</ReadOnlyValue>
            )
          }
        />
        <SettingsRow
          id="civilization-personality"
          title="Personality rendering"
          description={`${sourceLabel(effective, "personalities.rendering")} · Off hides personality data; Mild uses restrained presentation traits; Rich uses the paired archetype snapshot. Changing strength never rerolls the citizen.`}
          control={
            canWrite && identityEditor.draft !== null ? (
              <Select
                value={identityEditor.draft.rendering}
                disabled={identityEditor.saving}
                onValueChange={(value) =>
                  identityEditor.update((current) => ({
                    ...current,
                    rendering: value as IdentityDraft["rendering"],
                  }))
                }
              >
                <SelectTrigger
                  aria-label={`Civilization personality rendering on ${target.label}`}
                  size="sm"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="off">Off</SelectItem>
                  <SelectItem value="mild">Mild</SelectItem>
                  <SelectItem value="rich">Rich archetype</SelectItem>
                </SelectPopup>
              </Select>
            ) : (
              <ReadOnlyValue>{config.personalities.rendering}</ReadOnlyValue>
            )
          }
        />
        <SectionSaveRow
          title="Save identity"
          editor={identityEditor}
          canWrite={canWrite}
          target={target}
        />
      </SettingsSection>

      <SettingsSection title="Knowledge and context" id="civilization-context">
        <SettingsRow
          title="Note categories"
          description={`${sourceLabel(effective, "knowledge.noteCategories")} · comma-separated categories included by policy.`}
          control={
            canWrite && contextEditor.draft !== null ? (
              <Input
                aria-label={`Civilization note categories on ${target.label}`}
                size="sm"
                value={contextEditor.draft.knowledge.noteCategories.join(", ")}
                disabled={contextEditor.saving}
                onChange={(event) =>
                  contextEditor.update((current) => ({
                    ...current,
                    knowledge: {
                      ...current.knowledge,
                      noteCategories: event.currentTarget.value
                        .split(",")
                        .map((value) => value.trim())
                        .filter((value) => value.length > 0),
                    },
                  }))
                }
              />
            ) : (
              <ReadOnlyValue>{config.knowledge.noteCategories.join(", ")}</ReadOnlyValue>
            )
          }
        />
        <SettingsRow
          title="Note byte limit"
          description={`${sourceLabel(effective, "knowledge.noteBytes")} · maximum note body size in bytes.`}
          control={
            canWrite && contextEditor.draft !== null ? (
              <NumberEditor
                label={`Civilization note byte limit on ${target.label}`}
                value={contextEditor.draft.knowledge.noteBytes}
                disabled={contextEditor.saving}
                onChange={(value) =>
                  contextEditor.update((current) => ({
                    ...current,
                    knowledge: { ...current.knowledge, noteBytes: value },
                  }))
                }
              />
            ) : (
              <ReadOnlyValue>{`${config.knowledge.noteBytes} bytes`}</ReadOnlyValue>
            )
          }
        />
        <SettingsRow
          title="Active notes"
          description={`${sourceLabel(effective, "knowledge.activeNotes")} · bounded active note count.`}
          control={
            canWrite && contextEditor.draft !== null ? (
              <NumberEditor
                label={`Civilization active note count on ${target.label}`}
                value={contextEditor.draft.knowledge.activeNotes}
                disabled={contextEditor.saving}
                onChange={(value) =>
                  contextEditor.update((current) => ({
                    ...current,
                    knowledge: { ...current.knowledge, activeNotes: value },
                  }))
                }
              />
            ) : (
              <ReadOnlyValue>{String(config.knowledge.activeNotes)}</ReadOnlyValue>
            )
          }
        />
        <SettingsRow
          title="Note retention"
          description={`${sourceLabel(effective, "knowledge.retentionDays")} · retention policy in days.`}
          control={
            canWrite && contextEditor.draft !== null ? (
              <NumberEditor
                label={`Civilization note retention days on ${target.label}`}
                value={contextEditor.draft.knowledge.retentionDays}
                disabled={contextEditor.saving}
                onChange={(value) =>
                  contextEditor.update((current) => ({
                    ...current,
                    knowledge: { ...current.knowledge, retentionDays: value },
                  }))
                }
              />
            ) : (
              <ReadOnlyValue>{`${config.knowledge.retentionDays} days`}</ReadOnlyValue>
            )
          }
        />
        {(
          [
            ["Include notes in packet", "packetInclusion", "knowledge.packetInclusion"],
            ["Ancestor reads", "ancestorReads", "knowledge.ancestorReads"],
            ["Show generation", "showGeneration", "knowledge.showGeneration"],
            ["Show parent", "showParent", "knowledge.showParent"],
          ] as const
        ).map(([title, key, path]) => (
          <SettingsRow
            key={key}
            title={title}
            description={`${sourceLabel(effective, path)} · bounded context policy.`}
            control={
              canWrite && contextEditor.draft !== null ? (
                <Switch
                  aria-label={`${title} on ${target.label}`}
                  checked={contextEditor.draft.knowledge[key]}
                  disabled={contextEditor.saving}
                  onCheckedChange={(checked) =>
                    contextEditor.update((current) => ({
                      ...current,
                      knowledge: { ...current.knowledge, [key]: checked },
                    }))
                  }
                />
              ) : (
                <ReadOnlyValue>{config.knowledge[key] ? "Enabled" : "Disabled"}</ReadOnlyValue>
              )
            }
          />
        ))}
        <SettingsRow
          title="Packet byte budget"
          description={`${sourceLabel(effective, "context.packetBytes")} · byte budget only; this is not a token guarantee.`}
          control={
            canWrite && contextEditor.draft !== null ? (
              <NumberEditor
                label={`Civilization packet byte budget on ${target.label}`}
                value={contextEditor.draft.context.packetBytes}
                disabled={contextEditor.saving}
                onChange={(value) =>
                  contextEditor.update((current) => ({
                    ...current,
                    context: { ...current.context, packetBytes: value },
                  }))
                }
              />
            ) : (
              <ReadOnlyValue>{`${config.context.packetBytes} bytes`}</ReadOnlyValue>
            )
          }
        />
        {(
          [
            ["Roster count", "rosterCount"],
            ["Note count", "noteCount"],
            ["Inbox excerpt count", "inboxExcerptCount"],
          ] as const
        ).map(([title, key]) => (
          <SettingsRow
            key={key}
            title={title}
            description={`${sourceLabel(effective, `context.${key}`)} · bounded packet selection count.`}
            control={
              canWrite && contextEditor.draft !== null ? (
                <NumberEditor
                  label={`Civilization ${title.toLowerCase()} on ${target.label}`}
                  value={contextEditor.draft.context[key]}
                  disabled={contextEditor.saving}
                  onChange={(value) =>
                    contextEditor.update((current) => ({
                      ...current,
                      context: { ...current.context, [key]: value },
                    }))
                  }
                />
              ) : (
                <ReadOnlyValue>{String(config.context[key])}</ReadOnlyValue>
              )
            }
          />
        ))}
        <SettingsRow
          title="Context selection"
          description={`${sourceLabel(effective, "context.selection")} · determines bounded selection order.`}
          control={
            canWrite && contextEditor.draft !== null ? (
              <Select
                value={contextEditor.draft.context.selection}
                disabled={contextEditor.saving}
                onValueChange={(value) =>
                  contextEditor.update((current) => ({
                    ...current,
                    context: {
                      ...current.context,
                      selection: value as ContextDraft["context"]["selection"],
                    },
                  }))
                }
              >
                <SelectTrigger
                  aria-label={`Civilization context selection on ${target.label}`}
                  size="sm"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="recent">Recent</SelectItem>
                  <SelectItem value="stable_id">Stable ID</SelectItem>
                </SelectPopup>
              </Select>
            ) : (
              <ReadOnlyValue>{config.context.selection}</ReadOnlyValue>
            )
          }
        />
        <SectionSaveRow
          title="Save context"
          editor={contextEditor}
          canWrite={canWrite}
          target={target}
        />
      </SettingsSection>

      <SettingsSection title="Messaging" id="civilization-messaging">
        <SettingsRow
          title="Messaging enabled"
          description={`${sourceLabel(effective, "messaging.enabled")} · mail is passive: sending does not wake, steer, resume, or automatically reply from another agent.`}
          control={
            canWrite && messagingEditor.draft !== null ? (
              <Switch
                aria-label={`Civilization messaging on ${target.label}`}
                checked={messagingEditor.draft.enabled}
                disabled={messagingEditor.saving}
                onCheckedChange={(checked) =>
                  messagingEditor.update((current) => ({ ...current, enabled: checked }))
                }
              />
            ) : (
              <ReadOnlyValue>{config.messaging.enabled ? "Enabled" : "Disabled"}</ReadOnlyValue>
            )
          }
        />
        <SettingsRow
          title="Eligible thread kinds"
          description={`${sourceLabel(effective, "messaging.eligibleThreadKinds")} · explicit eligibility only; no wake behavior is implied.`}
          control={
            canWrite && messagingEditor.draft !== null ? (
              <div className="flex flex-wrap justify-end gap-3 text-sm">
                {(["root", "fork", "subagent"] as const).map((kind) => (
                  <label key={kind} className="flex items-center gap-2">
                    <Switch
                      size="sm"
                      aria-label={`Civilization ${kind} messaging on ${target.label}`}
                      checked={messagingEditor.draft!.eligibleThreadKinds.includes(kind)}
                      disabled={messagingEditor.saving}
                      onCheckedChange={(checked) =>
                        messagingEditor.update((current) => ({
                          ...current,
                          eligibleThreadKinds: checked
                            ? [...new Set([...current.eligibleThreadKinds, kind])]
                            : current.eligibleThreadKinds.filter((entry) => entry !== kind),
                        }))
                      }
                    />
                    <span>{kind}</span>
                  </label>
                ))}
              </div>
            ) : (
              <ReadOnlyValue>{config.messaging.eligibleThreadKinds.join(", ")}</ReadOnlyValue>
            )
          }
        />
        {(
          [
            [
              "Controllable children",
              "allowControllableChildren",
              "messaging.allowControllableChildren",
            ],
            ["Replies enabled", "repliesEnabled", "messaging.repliesEnabled"],
          ] as const
        ).map(([title, key, path]) => (
          <SettingsRow
            key={key}
            title={title}
            description={`${sourceLabel(effective, path)} · passive delivery policy.`}
            control={
              canWrite && messagingEditor.draft !== null ? (
                <Switch
                  aria-label={`Civilization ${title.toLowerCase()} on ${target.label}`}
                  checked={messagingEditor.draft[key]}
                  disabled={messagingEditor.saving}
                  onCheckedChange={(checked) =>
                    messagingEditor.update((current) => ({ ...current, [key]: checked }))
                  }
                />
              ) : (
                <ReadOnlyValue>{config.messaging[key] ? "Enabled" : "Disabled"}</ReadOnlyValue>
              )
            }
          />
        ))}
        {(
          [
            ["Message byte cap", "messageBytes", "bytes"],
            ["Pending per recipient", "pendingPerRecipient", "messages"],
            ["Sender per-minute quota", "senderPerMinute", "/min"],
            ["Project per-minute quota", "projectPerMinute", "/min"],
            ["Retained message count", "retainedMessageCount", "messages"],
            ["Retained body bytes", "retainedBodyBytes", "bytes"],
            ["Unread TTL", "unreadTtlDays", "days"],
          ] as const
        ).map(([title, key, unit]) => (
          <SettingsRow
            key={key}
            title={title}
            description={`${sourceLabel(effective, `messaging.${key}`)} · server-bounded messaging policy.`}
            control={
              canWrite && messagingEditor.draft !== null ? (
                <NumberEditor
                  label={`Civilization ${title.toLowerCase()} on ${target.label}`}
                  value={messagingEditor.draft[key]}
                  disabled={messagingEditor.saving}
                  onChange={(value) =>
                    messagingEditor.update((current) => ({ ...current, [key]: value }))
                  }
                />
              ) : (
                <ReadOnlyValue>{`${config.messaging[key]} ${unit}`}</ReadOnlyValue>
              )
            }
          />
        ))}
        <SectionSaveRow
          title="Save messaging"
          editor={messagingEditor}
          canWrite={canWrite}
          target={target}
        />
      </SettingsSection>

      <SettingsSection title="Operations and diagnostics" id="civilization-diagnostics">
        {(
          [
            ["Terminal retention", "terminalRetentionDays", "days"],
            ["Operation receipt retention", "operationReceiptRetentionDays", "days"],
            ["Diagnostic retention", "diagnosticRetentionDays", "days"],
            ["Tombstone retention", "tombstoneRetentionDays", "days"],
            ["Cleanup cadence", "cleanupCadenceMinutes", "minutes"],
            ["Cleanup batch", "cleanupBatch", "records"],
            ["Census page size", "censusPageSize", "rows"],
            ["Inbox page size", "inboxPageSize", "rows"],
            ["Response body byte cap", "responseBodyBytes", "bytes"],
          ] as const
        ).map(([title, key, unit]) => (
          <SettingsRow
            key={key}
            title={title}
            description={`${sourceLabel(effective, `operations.${key}`)} · bounded operational policy.`}
            control={
              canWrite && operationsEditor.draft !== null ? (
                <NumberEditor
                  label={`Civilization ${title.toLowerCase()} on ${target.label}`}
                  value={operationsEditor.draft[key]}
                  disabled={operationsEditor.saving}
                  onChange={(value) =>
                    operationsEditor.update((current) => ({ ...current, [key]: value }))
                  }
                />
              ) : (
                <ReadOnlyValue>{`${config.operations[key]} ${unit}`}</ReadOnlyValue>
              )
            }
          />
        ))}
        <SettingsRow
          title="Diagnostics"
          description={`${sourceLabel(effective, "operations.diagnostics")} · policy only; bounded metadata, never bodies, prompts, or credentials.`}
          control={
            canWrite && operationsEditor.draft !== null ? (
              <Select
                value={operationsEditor.draft.diagnostics}
                disabled={operationsEditor.saving}
                onValueChange={(value) =>
                  operationsEditor.update((current) => ({
                    ...current,
                    diagnostics: value as OperationsDraft["diagnostics"],
                  }))
                }
              >
                <SelectTrigger aria-label={`Civilization diagnostics on ${target.label}`} size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="off">Off</SelectItem>
                  <SelectItem value="errors">Errors</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                </SelectPopup>
              </Select>
            ) : (
              <ReadOnlyValue>{config.operations.diagnostics}</ReadOnlyValue>
            )
          }
        />
        <SectionSaveRow
          title="Save operations"
          editor={operationsEditor}
          canWrite={canWrite}
          target={target}
        />
      </SettingsSection>

      <SettingsSection title="Provider capabilities" id="civilization-providers">
        <SettingsRow
          title="Summary"
          description={`${capabilities.providers.length} provider instances report Civilization capability metadata.`}
          control={
            <ReadOnlyValue>
              {`${fullProviders} full${limitedProviders > 0 ? ` · ${limitedProviders} limited` : ""}`}
            </ReadOnlyValue>
          }
        />
        {capabilities.providers.map((provider) => (
          <SettingsRow
            key={provider.providerInstanceId}
            title={provider.providerInstanceId}
            description={
              provider.detail ??
              ([
                provider.contextInjection ? "context" : null,
                provider.messaging ? "messaging" : null,
                provider.providerContinuationRefresh ? "continuation refresh" : null,
              ]
                .filter(Boolean)
                .join(" · ") ||
                "No Civilization transport features reported.")
            }
            control={<ReadOnlyValue>{supportLabel(provider)}</ReadOnlyValue>}
          />
        ))}
      </SettingsSection>

      {target.projectId === null ? null : (
        <>
          <CivilizationContextInspector
            environmentId={target.environmentId}
            projectId={target.projectId}
            targetLabel={target.label}
            initialFilters={initialInspectionFilters}
          />
          <CivilizationProjectInspection
            environmentId={target.environmentId}
            projectId={target.projectId}
            targetLabel={target.label}
            effective={effective}
            allowSensitiveActions={allowSensitiveProjectActions}
          />
        </>
      )}

      <SettingsSection title="Server contract" id="civilization-config">
        <SettingsRow
          title="Inheritance"
          description={description.inheritance}
          control={<ReadOnlyValue>{`${effective.provenance.length} paths`}</ReadOnlyValue>}
        />
        <SettingsRow
          title="Configured limits"
          description="Hard limits are server-authoritative; the UI does not infer or widen them."
          control={
            <ReadOnlyValue>{`${Object.keys(description.limits).length} limits`}</ReadOnlyValue>
          }
        />
        <SettingsRow
          title="Export configuration"
          description="Downloads the server's canonical stored override JSON for this exact tier."
          control={
            <Button size="sm" variant="outline" onClick={exportConfig}>
              Export
            </Button>
          }
        />
        <SettingsRow
          title="Import configuration"
          description={
            importByteLimit === null
              ? "Import is unavailable because the server did not advertise its import byte limit."
              : `Preview validation and diff before commit. Client size hint: ${importByteLimit} UTF-8 bytes; the server remains authoritative.`
          }
          control={
            canWrite ? (
              <Button
                size="sm"
                variant="outline"
                disabled={importByteLimit === null}
                onClick={openImport}
              >
                Import…
              </Button>
            ) : (
              <ReadOnlyValue>Read only</ReadOnlyValue>
            )
          }
        />
        <SettingsRow
          title="Reset this tier"
          description={
            target.projectId === null
              ? "Removes the environment override with configReset so built-in values inherit."
              : "Removes the project override with configReset so environment values inherit."
          }
          control={
            canWrite ? (
              <Button size="sm" variant="outline" disabled={resettingTier} onClick={resetTier}>
                {resettingTier ? "Resetting…" : "Reset"}
              </Button>
            ) : (
              <ReadOnlyValue>Read only</ReadOnlyValue>
            )
          }
        />
        {configToolMessage !== null ? (
          <SettingsRow
            title="Configuration operation"
            description={configToolMessage}
            control={<ReadOnlyValue>Result</ReadOnlyValue>}
          />
        ) : null}
      </SettingsSection>

      <Dialog
        open={importOpen}
        onOpenChange={(open) => {
          if (importSaving) return;
          setImportOpen(open);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Import Civilization configuration</DialogTitle>
            <DialogDescription>
              Paste canonical override JSON for {target.label}. Nothing is committed until the
              server validates it, returns a diff preview, permission is re-checked, and you confirm
              import.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Textarea
              aria-label={`Civilization configuration import JSON on ${target.label}`}
              value={importJson}
              disabled={importPreviewing || importSaving}
              onChange={(event) => {
                setImportJson(event.currentTarget.value);
                setImportPreviewChanges(null);
                setImportMessage(null);
              }}
            />
            <div className="text-xs text-muted-foreground">
              {new TextEncoder().encode(importJson).byteLength} / {importByteLimit ?? "unavailable"}{" "}
              UTF-8 bytes
            </div>
            {importMessage !== null ? (
              <div className="text-sm text-muted-foreground" role="status">
                {importMessage}
              </div>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={importPreviewing || importSaving || importConflictRefreshPending}
              onClick={previewImport}
            >
              {importPreviewing
                ? "Previewing…"
                : importConflictRefreshPending
                  ? "Refreshing…"
                  : "Validate & preview"}
            </Button>
            <Button
              disabled={
                importPreviewChanges === null ||
                importPreviewing ||
                importSaving ||
                importConflictReview
              }
              onClick={applyImport}
            >
              {importSaving ? "Importing…" : "Import"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      {namePoolOpen ? (
        <CivilizationNamePoolEditorDialog
          open
          onOpenChange={setNamePoolOpen}
          environmentId={target.environmentId}
          projectId={target.projectId}
          targetLabel={target.label}
          effective={effective}
          runConfigAction={runConfigAction}
          refresh={overview.refresh}
          maxPools={description.limits.poolsPerKind}
          maxEntries={description.limits.nameEntriesPerPool}
          maxWeight={description.limits.entryWeight}
        />
      ) : null}
      {profilePoolOpen ? (
        <CivilizationProfilePoolEditorDialog
          open
          onOpenChange={setProfilePoolOpen}
          environmentId={target.environmentId}
          projectId={target.projectId}
          targetLabel={target.label}
          effective={effective}
          runConfigAction={runConfigAction}
          refresh={overview.refresh}
          maxPools={description.limits.poolsPerKind}
          maxEntries={description.limits.profileEntriesPerPool}
          maxWeight={description.limits.entryWeight}
        />
      ) : null}
    </div>
  );
}

export function CivilizationSettingsPanel({
  initialInspectionFilters,
}: {
  readonly initialInspectionFilters?: CivilizationContextInspectionFilters | undefined;
} = {}) {
  const { targets, scope } = useSettingsScope();

  return (
    <SettingsPageContainer width="expanded" className="gap-8">
      <div className="px-3 text-sm text-muted-foreground sm:px-4">
        Civilization coordinates server-owned agent identity, bounded personality context, shared
        notes, and passive agent mail. Configuration edits are staged locally, validated by the
        server, and saved with optimistic concurrency.
      </div>
      {targets.length === 0 ? (
        <SettingsSection title="Civilization" id="civilization-status">
          <SettingsRow
            title="No connected target"
            description={
              scope.kind === "unavailable"
                ? scope.message
                : "Connect an environment in the selected scope to inspect Civilization."
            }
            control={<ReadOnlyValue>Unavailable</ReadOnlyValue>}
          />
        </SettingsSection>
      ) : (
        <>
          {targets.length > 1 ? (
            <CivilizationMultiTargetParticipation
              targets={targets.map((target) => ({
                environmentId: target.environmentId,
                label: target.label,
                projectId: target.projectId,
              }))}
            />
          ) : null}
          {targets.map((target) => (
            <CivilizationTargetOverview
              key={`${target.environmentId}:${target.projectId ?? "environment"}`}
              allowSensitiveProjectActions={targets.length === 1}
              initialInspectionFilters={initialInspectionFilters}
              target={{
                environmentId: target.environmentId,
                label: target.label,
                projectId: target.projectId,
              }}
            />
          ))}
        </>
      )}
    </SettingsPageContainer>
  );
}
