import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  SkillEvalRunControlInput,
  SkillEvalRunId,
  SkillEvalRunSummary,
  SkillEvalTaskMutateInput,
  SkillModelCell,
  SkillReviewListItem,
  SkillVariantMutateInput,
} from "@t3tools/contracts";
import { SKILL_REVIEW_EXTRA_MODELS_MAX } from "@t3tools/contracts";
import { AlertCircleIcon } from "lucide-react";
import { useState } from "react";

import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useEnvironmentSettings } from "../../../hooks/useSettings";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  type ProviderInstanceEntry,
} from "../../../providerInstances";
import { useEnvironmentProviders } from "../../../state/environments";
import { useProjects } from "../../../state/entities";
import { useEnvironmentQuery } from "../../../state/query";
import { skillEnvironment } from "../../../state/skills";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../../ui/empty";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../ui/table";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { useSettingsScope } from "../SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "../settingsLayout";
import { SkillEvaluationPanel } from "./SkillEvaluationPanel";
import { SkillVariantPanel } from "./SkillVariantPanel";
import { SkillVerdictBadge } from "./SkillVerdictBadge";
import {
  deliveryLabel,
  effectiveModeLabel,
  evaluationCandidateForProject,
  formatEffect,
  formatInterval,
  formatRate,
  gatingLabel,
  verdictReason,
} from "./skillsSettings.logic";

function commandErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cellKey(cell: SkillModelCell): string {
  return `${cell.driver}\u0000${cell.model}`;
}

type ReviewModel = { readonly driver: SkillModelCell["driver"]; readonly model: string };

function reviewModelKey(model: ReviewModel): string {
  return `${model.driver}\u0000${model.model}`;
}

function AddModelPicker({
  entries,
  existing,
  onAdd,
}: {
  entries: ReadonlyArray<ProviderInstanceEntry>;
  existing: ReadonlyArray<ReviewModel>;
  onAdd: (model: ReviewModel) => void;
}) {
  const taken = new Set(existing.map(reviewModelKey));
  const options = entries
    .filter(isProviderInstancePickerReady)
    .flatMap((entry) =>
      entry.models.map((model) => ({
        key: reviewModelKey({ driver: entry.driverKind, model: model.slug }),
        driver: entry.driverKind,
        model: model.slug,
        label: `${entry.displayName} · ${model.name}`,
      })),
    )
    .filter(
      (option, index, all) =>
        !taken.has(option.key) && all.findIndex((other) => other.key === option.key) === index,
    );
  if (options.length === 0) return null;
  return (
    <Select
      value={null}
      onValueChange={(key) => {
        const option = options.find((candidate) => candidate.key === key);
        if (option) onAdd({ driver: option.driver, model: option.model });
      }}
    >
      <SelectTrigger aria-label="Add a model to review">
        <SelectValue>Add model…</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option.key} value={option.key}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function SkillList({
  search,
  selectedSkillName,
  items,
  onSearchChange,
  onSelect,
}: {
  readonly search: string;
  readonly selectedSkillName: string | null;
  readonly items: readonly SkillReviewListItem[];
  readonly onSearchChange: (value: string) => void;
  readonly onSelect: (skillName: string) => void;
}) {
  return (
    <aside className="min-h-0 border-b lg:border-r lg:border-b-0">
      <div className="border-b p-3">
        <Input
          aria-label="Search skills"
          placeholder="Search skills"
          value={search}
          onChange={(event) => onSearchChange(event.currentTarget.value)}
        />
      </div>
      <div className="max-h-80 overflow-y-auto lg:max-h-[calc(100vh-15rem)]">
        {items.map((item) => (
          <button
            key={item.skillName}
            type="button"
            aria-current={item.skillName === selectedSkillName ? "page" : undefined}
            className="w-full border-b px-4 py-3 text-left aria-[current=page]:bg-accent/60"
            onClick={() => onSelect(item.skillName)}
          >
            <span className="block text-sm font-medium">{item.skillName}</span>
            {item.description ? (
              <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">
                {item.description}
              </span>
            ) : null}
            <span className="mt-2 flex flex-wrap gap-1">
              {item.providers.map((provider) => (
                <Badge key={provider} variant="outline">
                  {provider}
                </Badge>
              ))}
              {item.cells.map((cell) => (
                <SkillVerdictBadge key={cellKey(cell)} verdict={cell.verdict} />
              ))}
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}

function ModelTable({
  cells,
  runs,
  addedModels,
  selectedCell,
  onSelect,
  onRemove,
}: {
  readonly cells: readonly SkillModelCell[];
  readonly runs: readonly SkillEvalRunSummary[];
  readonly addedModels: readonly ReviewModel[];
  readonly selectedCell: SkillModelCell | null;
  readonly onSelect: (cell: SkillModelCell) => void;
  readonly onRemove: (cell: SkillModelCell) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Provider / model</TableHead>
            <TableHead>Delivery</TableHead>
            <TableHead>Gating</TableHead>
            <TableHead>Mode</TableHead>
            <TableHead>Controlled evidence</TableHead>
            <TableHead>Observational evidence</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {cells.map((cell) => {
            const latestResult = runs
              .filter((run) => run.config.candidate.model === cell.model)
              .flatMap((run) => run.armResults)
              .find((result) => result.role === "treatment");
            const reason = verdictReason(cell.verdict);
            const added = addedModels.some((model) => reviewModelKey(model) === cellKey(cell));
            return (
              <TableRow
                key={cellKey(cell)}
                data-state={
                  selectedCell !== null && cellKey(cell) === cellKey(selectedCell)
                    ? "selected"
                    : undefined
                }
                className="cursor-pointer"
                onClick={() => onSelect(cell)}
              >
                <TableCell>
                  <span className="block font-medium">{cell.model}</span>
                  <span className="text-xs text-muted-foreground">{cell.driver}</span>
                  {added ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`Remove ${cell.model}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemove(cell);
                      }}
                    >
                      Remove
                    </Button>
                  ) : null}
                </TableCell>
                <TableCell>{deliveryLabel(cell)}</TableCell>
                <TableCell>
                  <Tooltip>
                    <TooltipTrigger render={<span>{gatingLabel(cell)}</span>} />
                    <TooltipPopup side="top">
                      Hard means the provider harness blocks the skill. Instruction means the model
                      is asked not to use it.
                    </TooltipPopup>
                  </Tooltip>
                </TableCell>
                <TableCell>{effectiveModeLabel(cell)}</TableCell>
                <TableCell>
                  <div className="space-y-1">
                    <SkillVerdictBadge verdict={cell.verdict} />
                    <p className="text-xs text-muted-foreground">
                      {formatEffect(cell.verdict.effect)} · 95% CI{" "}
                      {formatInterval(cell.verdict.ciLow, cell.verdict.ciHigh)} ·{" "}
                      {cell.verdict.nTasks} tasks
                      {latestResult ? ` · ${latestResult.repeats} repeats` : ""}
                    </p>
                    {reason ? <p className="text-xs text-muted-foreground">{reason}</p> : null}
                  </div>
                </TableCell>
                <TableCell>
                  <p className="text-sm">{cell.observational.turns} turns</p>
                  <p className="text-xs text-muted-foreground">
                    {formatRate(cell.observational.activationRate)} activation
                  </p>
                  <p className="text-xs text-muted-foreground">Observational, confounded</p>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function SkillsSettingsForEnvironment({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const [search, setSearch] = useState("");
  const [selectedSkillNameState, setSelectedSkillName] = useState<string | null>(null);
  const [selectedCellKey, setSelectedCellKey] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [addedModels, setAddedModels] = useState<ReadonlyMap<string, ReadonlyArray<ReviewModel>>>(
    () => new Map(),
  );
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [variantBusy, setVariantBusy] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);

  const listQuery = useEnvironmentQuery(skillEnvironment.reviewList({ environmentId, input: {} }));
  const normalizedSearch = search.trim().toLowerCase();
  const filteredItems = (listQuery.data ?? []).filter(
    (item) =>
      normalizedSearch === "" ||
      item.skillName.toLowerCase().includes(normalizedSearch) ||
      item.description?.toLowerCase().includes(normalizedSearch),
  );
  const selectedSkillName =
    filteredItems.find((item) => item.skillName === selectedSkillNameState)?.skillName ??
    filteredItems[0]?.skillName ??
    null;
  const selectedAddedModels =
    selectedSkillName === null ? [] : (addedModels.get(selectedSkillName) ?? []);
  const detailQuery = useEnvironmentQuery(
    selectedSkillName
      ? skillEnvironment.reviewDetail({
          environmentId,
          input:
            selectedAddedModels.length === 0
              ? { skillName: selectedSkillName }
              : { skillName: selectedSkillName, models: selectedAddedModels },
        })
      : null,
  );
  const detail = detailQuery.data?.skillName === selectedSkillName ? detailQuery.data : null;
  const selectedCell =
    detail?.cells.find((cell) => cellKey(cell) === selectedCellKey) ?? detail?.cells[0] ?? null;
  const runQuery = useEnvironmentQuery(
    selectedRunId
      ? skillEnvironment.runDetail({
          environmentId,
          input: { evalRunId: selectedRunId as SkillEvalRunId },
        })
      : null,
  );

  const canMutateVariants = useAtomValue(
    skillEnvironment.mutateVariant.permissionAtom(environmentId),
  );
  const canMutateTasks = useAtomValue(
    skillEnvironment.mutateEvalTask.permissionAtom(environmentId),
  );
  const canControlRuns = useAtomValue(
    skillEnvironment.controlEvalRun.permissionAtom(environmentId),
  );
  const refreshReviewListCommand = useAtomCommand(skillEnvironment.refreshReviewList, {
    label: "skill catalog refresh",
  });
  const mutateVariantCommand = useAtomCommand(skillEnvironment.mutateVariant, {
    label: "skill variant mutation",
  });
  const mutateTaskCommand = useAtomCommand(skillEnvironment.mutateEvalTask, {
    label: "skill eval task mutation",
  });
  const controlRunCommand = useAtomCommand(skillEnvironment.controlEvalRun, {
    label: "skill eval run control",
  });

  const projects = useProjects()
    .filter((project) => project.environmentId === environmentId)
    .map((project) => ({ id: project.id, title: project.title }));
  const providersByEnvironment = useEnvironmentProviders();
  const providerEntries = deriveProviderInstanceEntries(
    providersByEnvironment.get(environmentId) ?? [],
  );
  const providerSettings = useEnvironmentSettings(environmentId, (settings) => ({
    providerInstances: settings.providerInstances,
    projectSettingsOverrides: settings.projectSettingsOverrides,
  }));
  const candidateForProject = (projectId: ProjectId) =>
    selectedCell === null
      ? null
      : evaluationCandidateForProject(selectedCell, providerEntries, providerSettings, projectId);

  const handleCatalogRefresh = async () => {
    if (catalogBusy) return;
    setCatalogBusy(true);
    setCommandError(null);
    const result = await refreshReviewListCommand({
      environmentId,
      input: { refresh: true },
    });
    setCatalogBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setCommandError(commandErrorMessage(squashAtomCommandFailure(result)));
    }
  };
  const handleVariantMutation = async (input: SkillVariantMutateInput) => {
    if (variantBusy) return;
    setVariantBusy(true);
    setCommandError(null);
    const result = await mutateVariantCommand({ environmentId, input });
    setVariantBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setCommandError(commandErrorMessage(squashAtomCommandFailure(result)));
    }
    // Commands refresh the plain detail key; this view may also carry added models.
    if (result._tag === "Success" && selectedAddedModels.length > 0) detailQuery.refresh();
  };
  const handleTaskMutation = async (input: SkillEvalTaskMutateInput) => {
    if (taskBusy) return;
    setTaskBusy(true);
    setCommandError(null);
    const result = await mutateTaskCommand({ environmentId, input });
    setTaskBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setCommandError(commandErrorMessage(squashAtomCommandFailure(result)));
    }
    // Commands refresh the plain detail key; this view may also carry added models.
    if (result._tag === "Success" && selectedAddedModels.length > 0) detailQuery.refresh();
  };
  const handleRunControl = async (input: SkillEvalRunControlInput) => {
    if (runBusy) return;
    setRunBusy(true);
    setCommandError(null);
    const result = await controlRunCommand({ environmentId, input });
    setRunBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        setCommandError(commandErrorMessage(squashAtomCommandFailure(result)));
      return;
    }
    if (selectedAddedModels.length > 0) detailQuery.refresh();
    setSelectedRunId(result.value.evalRunId);
  };
  const refreshButton = (
    <Button
      size="xs"
      variant="outline"
      disabled={catalogBusy}
      aria-busy={catalogBusy}
      onClick={() => void handleCatalogRefresh()}
    >
      <RefreshIcon size="xs" refreshing={catalogBusy} />
      {catalogBusy ? "Refreshing" : "Refresh"}
    </Button>
  );

  if (listQuery.error) {
    return (
      <SettingsPageContainer>
        <Alert variant="error">
          <AlertTitle>Could not load skills</AlertTitle>
          <AlertDescription>{listQuery.error}</AlertDescription>
          <Button size="xs" variant="outline" onClick={listQuery.refresh}>
            Try again
          </Button>
        </Alert>
      </SettingsPageContainer>
    );
  }

  if (listQuery.isPending && listQuery.data === null) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">Loading skills…</p>
      </SettingsPageContainer>
    );
  }

  if (listQuery.data?.length === 0) {
    return (
      <SettingsPageContainer>
        {commandError ? (
          <Alert variant="error">
            <AlertCircleIcon />
            <AlertTitle>Skill action failed</AlertTitle>
            <AlertDescription>{commandErrorMessage(commandError)}</AlertDescription>
          </Alert>
        ) : null}
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No skills found</EmptyTitle>
            <EmptyDescription>
              Refresh project catalogs or add a provider skill in this environment.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>{refreshButton}</EmptyContent>
        </Empty>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer width="expanded" className="gap-4">
      {commandError ? (
        <Alert variant="error">
          <AlertCircleIcon />
          <AlertTitle>Skill action failed</AlertTitle>
          <AlertDescription>{commandErrorMessage(commandError)}</AlertDescription>
        </Alert>
      ) : null}
      <SettingsSection
        title="Skills"
        variant="plain"
        className="min-h-[38rem] overflow-hidden"
        headerAction={refreshButton}
      >
        <div className="grid min-h-[38rem] lg:grid-cols-[18rem_minmax(0,1fr)]">
          <SkillList
            search={search}
            selectedSkillName={selectedSkillName}
            items={filteredItems}
            onSearchChange={setSearch}
            onSelect={(skillName) => {
              setSelectedSkillName(skillName);
              setSelectedCellKey(null);
              setSelectedRunId(null);
            }}
          />
          <main className="min-w-0 space-y-8 p-4 sm:p-6">
            {filteredItems.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No matching skills</EmptyTitle>
                  <EmptyDescription>Try a different name or description.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : detailQuery.error ? (
              <Alert variant="error">
                <AlertTitle>Could not load skill details</AlertTitle>
                <AlertDescription>{detailQuery.error}</AlertDescription>
                <Button size="xs" variant="outline" onClick={detailQuery.refresh}>
                  Try again
                </Button>
              </Alert>
            ) : detail === null ? (
              <p className="text-sm text-muted-foreground">Loading skill details…</p>
            ) : (
              <>
                <header>
                  <h2 className="text-xl font-semibold tracking-tight">{detail.skillName}</h2>
                  {detail.description ? (
                    <p className="mt-1 text-sm text-muted-foreground">{detail.description}</p>
                  ) : null}
                </header>
                <section className="space-y-3" aria-labelledby="skill-by-model-heading">
                  <div>
                    <h3 id="skill-by-model-heading" className="text-sm font-semibold">
                      By model
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {detail.cells.length === 0
                        ? "No model has used, forked, or evaluated this skill yet. Add a model to start."
                        : "Select a row to edit its effective variant and run evaluations."}
                    </p>
                  </div>
                  {selectedAddedModels.length < SKILL_REVIEW_EXTRA_MODELS_MAX ? (
                    <AddModelPicker
                      entries={providerEntries}
                      existing={detail.cells}
                      onAdd={(model) => {
                        setAddedModels((current) =>
                          new Map(current).set(detail.skillName, [...selectedAddedModels, model]),
                        );
                        setSelectedCellKey(reviewModelKey(model));
                        setSelectedRunId(null);
                      }}
                    />
                  ) : null}
                  <ModelTable
                    cells={detail.cells}
                    runs={detail.runs}
                    addedModels={selectedAddedModels}
                    selectedCell={selectedCell}
                    onSelect={(cell) => {
                      setSelectedCellKey(cellKey(cell));
                      setSelectedRunId(null);
                    }}
                    onRemove={(cell) => {
                      const removedKey = cellKey(cell);
                      setAddedModels((current) => {
                        const next = new Map(current);
                        const models = (next.get(detail.skillName) ?? []).filter(
                          (model) => reviewModelKey(model) !== removedKey,
                        );
                        if (models.length === 0) next.delete(detail.skillName);
                        else next.set(detail.skillName, models);
                        return next;
                      });
                      if (selectedCellKey === removedKey) setSelectedCellKey(null);
                      setSelectedRunId(null);
                    }}
                  />
                </section>
                {selectedCell === null ? null : (
                  <>
                    <SkillVariantPanel
                      skillName={detail.skillName}
                      cell={selectedCell}
                      rules={detail.rules}
                      revisions={detail.revisions}
                      canMutate={canMutateVariants}
                      busy={variantBusy}
                      onMutate={(input) => void handleVariantMutation(input)}
                    />
                    <SkillEvaluationPanel
                      skillName={detail.skillName}
                      cell={selectedCell}
                      rules={detail.rules}
                      tasks={detail.tasks}
                      runs={detail.runs}
                      runDetail={runQuery.data?.evalRunId === selectedRunId ? runQuery.data : null}
                      runDetailPending={runQuery.isPending}
                      runDetailError={runQuery.error}
                      selectedRunId={selectedRunId}
                      projects={projects}
                      candidateForProject={candidateForProject}
                      canMutateTasks={canMutateTasks}
                      canControlRuns={canControlRuns}
                      taskBusy={taskBusy}
                      runBusy={runBusy}
                      onSelectRun={setSelectedRunId}
                      onRefreshRunDetail={runQuery.refresh}
                      onMutateTask={(input) => void handleTaskMutation(input)}
                      onControlRun={(input) => void handleRunControl(input)}
                    />
                  </>
                )}
              </>
            )}
          </main>
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function SkillsSettings() {
  const { environment, scope } = useSettingsScope();
  if (!environment) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          {scope.kind === "environment"
            ? `Reconnect ${scope.label} to review its skills.`
            : "Connect an environment to review its skills."}
        </p>
      </SettingsPageContainer>
    );
  }
  if (environment.serverConfig?.environment.capabilities.skills !== true) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">Update this server to use Skills</p>
      </SettingsPageContainer>
    );
  }
  return <SkillsSettingsForEnvironment environmentId={environment.environmentId} />;
}
