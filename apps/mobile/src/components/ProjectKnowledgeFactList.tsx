import { uuidv4 } from "../lib/uuid";
import { useState } from "react";
import { Pressable, Switch, View } from "react-native";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  CommandId,
  type AssistedLearningRun,
  type EnvironmentId,
  type KnowledgeMessageRef,
  type KnowledgeSelection,
  type KnowledgeSourceUnavailableReason,
  type ProjectFact,
  type ProjectFactId,
  type ProjectId,
  type ProjectKnowledgeSearchInput,
} from "@t3tools/contracts";
import {
  KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL,
  assistedLearningRunLabel,
  isSupersededFact,
  knowledgeOriginLabel,
} from "@t3tools/client-runtime/projectKnowledge";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import type { knowledgeSelectionState } from "../lib/projectKnowledgeComposer";
import { projectKnowledge } from "../state/projectKnowledge";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "../state/session";
import { SelectForDraftControl } from "./ProjectKnowledgeDraftFooter";
import { KnowledgeHealthRow } from "./ProjectKnowledgeFactDetail";
import { AppText, AppTextInput } from "./ui/AppText";
import { Button } from "./ui/Button";

type StatusFilter = "saved" | "automatic" | "forgotten";

/** Filters, search and paging for the fact list. The sheet reads its results for draft labels. */
export function useProjectKnowledgeBrowse(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly history: boolean;
  readonly onArchivedChange: () => void;
}) {
  const [status, setStatus] = useState<StatusFilter>("saved");
  const [afterId, setAfterId] = useState<ProjectFactId | undefined>();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [searchInput, setSearchInput] = useState<ProjectKnowledgeSearchInput | null>(null);
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [lostSourcesOnly, setLostSourcesOnly] = useState(false);
  const list = useEnvironmentQuery(
    projectKnowledge.list({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        ...(props.history && lostSourcesOnly
          ? { sourceState: "unavailable" as const }
          : status === "automatic"
            ? { status: "saved" as const, origin: "assisted" as const }
            : { status }),
        ...(afterId ? { afterId } : {}),
        ...(props.history && showSuperseded ? { includeSuperseded: true } : {}),
      },
    }),
  );
  const health = useEnvironmentQuery(
    props.history
      ? projectKnowledge.status({
          environmentId: props.environmentId,
          input: { projectId: props.projectId },
        })
      : null,
  );
  const search = useEnvironmentQuery(
    searchInput
      ? projectKnowledge.search({
          environmentId: props.environmentId,
          input: { ...searchInput, recordRetrieval: false },
        })
      : null,
  );
  const restartSearch = () =>
    setSearchInput((current) =>
      current === null
        ? null
        : {
            projectId: current.projectId,
            query: current.query,
            includeArchived: current.includeArchived ?? false,
            requestId: CommandId.make(uuidv4()),
            ...(current.includeSuperseded ? { includeSuperseded: true } : {}),
          },
    );
  const showList = (change: () => void) => {
    change();
    setAfterId(undefined);
    setSearchInput(null);
  };
  const facts: ReadonlyArray<ProjectFact> = searchInput
    ? search.data?.facts.state === "available"
      ? search.data.facts.matches.map((match) => match.fact)
      : []
    : (list.data?.facts ?? []);
  // Search already drops facts whose citations no longer resolve.
  const unavailableReasons = new Map(
    searchInput
      ? []
      : (list.data?.unavailableSources ?? []).map((item) => [item.factId, item.reason]),
  );
  const messages = searchInput
    ? (search.data?.messages.matches ?? []).flatMap((match) =>
        match.messageId && match.digest
          ? [
              {
                snippet: match.snippet,
                ref: {
                  kind: "message" as const,
                  threadId: match.threadId,
                  messageId: match.messageId,
                  digest: match.digest,
                },
              },
            ]
          : [],
      )
    : [];
  return {
    history: props.history,
    status,
    afterId,
    includeArchived,
    searchText,
    searchInput,
    showSuperseded,
    lostSourcesOnly,
    list,
    health,
    search,
    facts,
    messages,
    unavailableReasons,
    setSearchText,
    refresh: () => {
      list.refresh();
      health.refresh();
      restartSearch();
    },
    startSearch: () => {
      const query = searchText.trim();
      setSearchInput(
        query.length < 2
          ? null
          : {
              projectId: props.projectId,
              query,
              includeArchived,
              requestId: CommandId.make(uuidv4()),
              ...(props.history && showSuperseded ? { includeSuperseded: true } : {}),
            },
      );
    },
    selectStatus: (value: StatusFilter) =>
      showList(() => {
        setStatus(value);
        setLostSourcesOnly(false);
      }),
    setIncludeArchived: (value: boolean) => {
      props.onArchivedChange();
      setIncludeArchived(value);
      setSearchInput(null);
    },
    setShowSuperseded: (value: boolean) => showList(() => setShowSuperseded(value)),
    showLostSources: () => showList(() => setLostSourcesOnly(true)),
    showAllFacts: () => {
      setLostSourcesOnly(false);
      setAfterId(undefined);
    },
    setAfterId,
    pageFactMatches: () => {
      if (searchInput && search.data?.facts.state === "available" && search.data.facts.nextCursor)
        setSearchInput({
          ...searchInput,
          requestId: CommandId.make(uuidv4()),
          factCursor: search.data.facts.nextCursor,
        });
    },
    pageConversations: () => {
      if (searchInput && search.data?.messages.nextCursor)
        setSearchInput({ ...searchInput, cursor: search.data.messages.nextCursor });
    },
  };
}

type ProjectKnowledgeBrowse = ReturnType<typeof useProjectKnowledgeBrowse>;
type SelectionState = ReturnType<typeof knowledgeSelectionState>;

export function ProjectKnowledgeFactList(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly browse: ProjectKnowledgeBrowse;
  readonly assisted: boolean;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly selectionState: (current: KnowledgeSelection) => SelectionState;
  readonly onToggleSelection: (selection: KnowledgeSelection) => void;
  readonly onRefreshSelection: (selection: KnowledgeSelection) => void;
  readonly onInspectFact: (fact: ProjectFact) => void;
  readonly onReadMessage: (ref: KnowledgeMessageRef) => void;
  readonly onNewFact: () => void;
}) {
  const { browse } = props;
  const { list, health, search, searchInput } = browse;
  return (
    <View className="gap-4">
      <View className="gap-2">
        <AppTextInput
          accessibilityLabel="Search project knowledge"
          value={browse.searchText}
          onChangeText={browse.setSearchText}
          placeholder="Search facts and conversations"
          maxLength={200}
          returnKeyType="search"
          onSubmitEditing={browse.startSearch}
        />
        <View className="flex-row flex-wrap gap-2">
          <Button label="Search" tone="secondary" onPress={browse.startSearch} />
          <Button label="Refresh" tone="text" onPress={browse.refresh} />
        </View>
        <View className="flex-row items-center gap-3">
          <AppText className="flex-1 text-sm">Include archived conversations</AppText>
          <Switch
            accessibilityLabel="Include archived conversations"
            value={browse.includeArchived}
            onValueChange={browse.setIncludeArchived}
          />
        </View>
      </View>

      <View className="flex-row flex-wrap gap-2">
        {(props.assisted
          ? (["saved", "automatic", "forgotten"] as const)
          : (["saved", "forgotten"] as const)
        ).map((value) => (
          <Button
            key={value}
            label={value}
            tone={
              browse.status === value && !searchInput && !browse.lostSourcesOnly
                ? "primary"
                : "secondary"
            }
            onPress={() => browse.selectStatus(value)}
          />
        ))}
      </View>
      {browse.history ? (
        <View className="flex-row items-center gap-3">
          <AppText className="flex-1 text-sm">Show superseded facts</AppText>
          <Switch
            accessibilityLabel="Show superseded facts"
            value={browse.showSuperseded}
            onValueChange={browse.setShowSuperseded}
          />
        </View>
      ) : null}
      {health.data ? (
        <KnowledgeHealthRow status={health.data} onShowUnavailable={browse.showLostSources} />
      ) : null}
      {browse.history && browse.lostSourcesOnly ? (
        <View className="flex-row flex-wrap items-center gap-2">
          <AppText className="text-sm">Showing facts that lost their source</AppText>
          <Button label="Show all facts" tone="text" onPress={browse.showAllFacts} />
        </View>
      ) : null}
      {props.assisted ? (
        <AssistedLearningRow
          environmentId={props.environmentId}
          projectId={props.projectId}
          lastRun={health.data?.assistedLearning?.lastRun ?? null}
        />
      ) : null}

      {(list.error ?? search.error) ? (
        <AppText accessibilityRole="alert" className="text-danger">
          {list.error ?? search.error}
        </AppText>
      ) : null}
      {list.isPending || search.isPending ? <AppText>Reading project memory…</AppText> : null}
      {search.data?.facts.state === "unavailable" ? (
        <AppText className="text-sm text-foreground-muted">
          Fact ranking is unavailable. Conversation search and saved facts remain available.
        </AppText>
      ) : null}
      {search.data?.facts.state === "available" && search.data.facts.coverage === "partial" ? (
        <AppText className="text-sm text-foreground-muted">
          Partial coverage. Narrow the query to reach more facts.
        </AppText>
      ) : null}

      <Button
        label="Save project fact"
        icon="plus"
        tone="secondary"
        disabled={!props.canMutate || props.busy}
        onPress={props.onNewFact}
      />

      {browse.facts.map((fact) => (
        <FactRow
          key={fact.id}
          fact={fact}
          unavailable={browse.unavailableReasons.get(fact.id) ?? null}
          selection={props.selectionState({
            kind: "fact",
            factId: fact.id,
            revision: fact.revision,
          })}
          onInspect={() => props.onInspectFact(fact)}
          onToggleSelection={props.onToggleSelection}
          onRefreshSelection={props.onRefreshSelection}
        />
      ))}
      {!searchInput && list.data?.nextCursor ? (
        <Button
          label="Next facts"
          tone="secondary"
          onPress={() => browse.setAfterId(list.data?.nextCursor ?? undefined)}
        />
      ) : null}
      {browse.afterId ? (
        <Button label="First facts" tone="text" onPress={() => browse.setAfterId(undefined)} />
      ) : null}
      {searchInput && search.data?.facts.state === "available" && search.data.facts.nextCursor ? (
        <Button
          label="Next fact matches"
          tone="secondary"
          disabled={search.isPending}
          onPress={browse.pageFactMatches}
        />
      ) : null}

      {browse.messages.length > 0 ? (
        <AppText className="text-sm font-t3-medium">Conversations</AppText>
      ) : null}
      {browse.messages.map(({ ref, snippet }) => (
        <View key={`${ref.threadId}:${ref.messageId}`} className="gap-2 rounded-2xl bg-subtle p-3">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Read message: ${snippet}`}
            onPress={() => props.onReadMessage(ref)}
          >
            <AppText numberOfLines={4}>{snippet}</AppText>
          </Pressable>
          <SelectForDraftControl
            current={ref}
            state={props.selectionState(ref)}
            onToggle={props.onToggleSelection}
            onRefresh={props.onRefreshSelection}
          />
        </View>
      ))}
      {searchInput && search.data?.messages.nextCursor ? (
        <Button
          label="Next conversations"
          tone="secondary"
          disabled={search.isPending}
          onPress={browse.pageConversations}
        />
      ) : null}
    </View>
  );
}

function FactRow(props: {
  readonly fact: ProjectFact;
  readonly unavailable: KnowledgeSourceUnavailableReason | null;
  readonly selection: SelectionState;
  readonly onInspect: () => void;
  readonly onToggleSelection: (selection: KnowledgeSelection) => void;
  readonly onRefreshSelection: (selection: KnowledgeSelection) => void;
}) {
  const { fact } = props;
  const superseded = isSupersededFact(fact);
  return (
    <View
      className={
        superseded
          ? "gap-2 rounded-2xl border border-dashed border-border p-3 opacity-70"
          : "gap-2 rounded-2xl border border-border p-3"
      }
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Inspect fact: ${fact.content ?? "Forgotten fact"}`}
        className="gap-1"
        onPress={props.onInspect}
      >
        {superseded ? (
          <AppText className="text-xs font-t3-medium text-foreground-muted">Superseded</AppText>
        ) : null}
        {props.unavailable ? (
          <AppText className="text-xs text-warning-foreground">
            {KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL[props.unavailable]}
          </AppText>
        ) : null}
        <AppText className="text-base" numberOfLines={3}>
          {fact.content ?? "Forgotten fact"}
        </AppText>
        <AppText className="text-xs text-foreground-muted">
          {fact.kind} · {fact.status} · {knowledgeOriginLabel(fact.origin)}
        </AppText>
      </Pressable>
      {fact.status !== "forgotten" ? (
        <SelectForDraftControl
          current={{ kind: "fact", factId: fact.id, revision: fact.revision }}
          state={props.selection}
          onToggle={props.onToggleSelection}
          onRefresh={props.onRefreshSelection}
        />
      ) : null}
    </View>
  );
}

function AssistedLearningRow(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly lastRun: AssistedLearningRun | null;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const canWrite = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = config?.settings;
  if (!settings || config.environment.capabilities.projectSettingsOverrides !== true) return null;
  const enabled = resolveProjectSettings(settings, props.projectId).settings.enableAssistedLearning;
  const toggle = async (next: boolean) => {
    setBusy(true);
    setError(null);
    const result = await update({
      environmentId: props.environmentId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [props.projectId]: {
              ...settings.projectSettingsOverrides[props.projectId],
              enableAssistedLearning: next,
            },
          },
        },
      },
    });
    setBusy(false);
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
  };
  return (
    <View className="gap-1 rounded-2xl bg-subtle p-3">
      <View className="flex-row items-center gap-3">
        <AppText className="flex-1">Save facts from finished runs</AppText>
        <Switch
          accessibilityLabel="Save facts from finished runs"
          value={enabled}
          disabled={!canWrite || busy}
          onValueChange={(value) => void toggle(value)}
        />
      </View>
      <AppText className="text-xs text-foreground-muted">
        After each run in this project, your text generation model saves up to three cited facts.
        Each run costs one model call.
      </AppText>
      {props.lastRun ? (
        <AppText className="text-xs">{assistedLearningRunLabel(props.lastRun)}</AppText>
      ) : null}
      {error ? (
        <AppText accessibilityRole="alert" className="text-xs text-danger">
          {error}
        </AppText>
      ) : null}
    </View>
  );
}
