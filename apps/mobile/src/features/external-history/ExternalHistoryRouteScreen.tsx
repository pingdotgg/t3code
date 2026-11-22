import { msg, useMessages } from "gt-react-native";
import { useAtomValue } from "@effect/atom-react";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  externalHistoryPagingReducer,
  initialExternalHistoryPaging,
  externalHistoryRangeLabel,
  externalHistoryRoleLabel,
  externalHistorySearchFilters,
  externalHistorySourceStatusLabel,
} from "@t3tools/client-runtime/externalHistory";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  type ExternalHistoryMatch,
  type ExternalHistoryRequest,
  type ExternalHistorySettings,
  type ExternalHistorySource,
  type ProjectId,
} from "@t3tools/contracts";
import { useEffect, useReducer, useState, type ReactNode } from "react";
import { Platform, ScrollView, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { useProject } from "../../state/entities";
import { externalHistory } from "../../state/externalHistory";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";

type Search = Extract<ExternalHistoryRequest, { operation: "search" }>;
type Scope = { readonly environmentId: EnvironmentId; readonly currentProjectPath?: string };

export function ExternalHistoryThreadButton(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const m = useMessages();
  const navigation = useNavigation();
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const project = useProject(props);
  return config?.environment.capabilities.externalHistory === 1 ? (
    <Button
      label={m(msg("External history"))}
      tone="text"
      onPress={() =>
        navigation.navigate("SettingsExternalHistory", {
          environmentId: props.environmentId,
          ...(project ? { currentProjectPath: project.workspaceRoot } : {}),
        })
      }
    />
  ) : null;
}

export function ExternalHistoryRouteScreen(
  props: StaticScreenProps<{
    readonly environmentId: string;
    readonly currentProjectPath?: string;
  }>,
) {
  const m = useMessages();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const navigation = useNavigation();
  const focused = useIsFocused();
  const supported = config?.environment.capabilities.externalHistory === 1;
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AppBar title={m(msg("External history"))} onBack={() => navigation.goBack()} />
      <ScreenContent>
        {supported && focused && config ? (
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentInsetAdjustmentBehavior="automatic"
            automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            contentContainerStyle={{ padding: 20, paddingBottom: 40, gap: 16 }}
          >
            <Text className="text-sm text-foreground-muted">
              {m(
                msg(
                  "Search agent conversations found on this environment. Open the original evidence behind each match.",
                ),
              )}
            </Text>
            <HistorySettings
              environmentId={environmentId}
              settings={config.settings.externalHistory}
            >
              {config.settings.externalHistory.enabled ? (
                <HistorySources
                  key={
                    "sources:" + JSON.stringify([environmentId, config.settings.externalHistory])
                  }
                  environmentId={environmentId}
                  {...(props.route.params.currentProjectPath
                    ? { currentProjectPath: props.route.params.currentProjectPath }
                    : {})}
                />
              ) : (
                <Text className="text-sm text-foreground-muted">
                  {m(msg("External history search is off for this environment."))}
                </Text>
              )}
            </HistorySettings>
          </ScrollView>
        ) : !supported ? (
          <Text className="p-5 text-sm text-foreground-muted">
            {m(msg("Update this server to search external history."))}
          </Text>
        ) : null}
      </ScreenContent>
    </View>
  );
}

function HistorySettings(props: {
  readonly environmentId: EnvironmentId;
  readonly settings: ExternalHistorySettings;
  readonly children: ReactNode;
}) {
  const m = useMessages();
  const canWrite = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(props.environmentId),
  );
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (settings: ExternalHistorySettings) => {
    if (pending || !canWrite) return;
    setPending(true);
    setError(null);
    const result = await update({
      environmentId: props.environmentId,
      input: { patch: { externalHistory: settings } },
    });
    setPending(false);
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
  };
  return (
    <View className="gap-4">
      <View className="gap-3 rounded-xl border border-border p-3">
        <SettingsSwitchRow
          label={m(msg("Allow external history search"))}
          value={props.settings.enabled}
          disabled={pending || !canWrite}
          onValueChange={(enabled) => void save({ ...props.settings, enabled })}
        />
        <Text className="text-xs text-foreground-muted">
          {m(
            msg(
              "Makes these sources available to this environment's connected clients and agents with thread access. Source files stay in their existing locations.",
            ),
          )}
        </Text>
        {!canWrite ? (
          <Text className="text-xs text-foreground-muted">
            {m(msg("This connection cannot change environment settings."))}
          </Text>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" className="text-danger">
            {error}
          </Text>
        ) : null}
      </View>
      {props.children}
    </View>
  );
}

function HistorySources(props: Scope) {
  const m = useMessages();
  const query = useEnvironmentQuery(
    externalHistory.query({
      environmentId: props.environmentId,
      input: { operation: "sources", catalogVersion: 2 },
    }),
  );
  const [selected, setSelected] = useState<string | null>(null);
  if (query.error)
    return (
      <Text accessibilityRole="alert" className="text-danger">
        {query.error}
      </Text>
    );
  if (!query.data || query.data.operation !== "sources")
    return <Text className="text-foreground-muted">{m(msg("Loading history sources…"))}</Text>;
  if (!query.data.enabled)
    return (
      <Text className="text-foreground-muted">
        {m(msg("External history search is off for this environment."))}
      </Text>
    );
  const sources = query.data.sources;
  const source =
    sources.find((item) => item.id === selected && item.status === "ready") ??
    sources.find((item) => item.status === "ready");
  return (
    <View className="gap-4">
      <View className="gap-2">
        <Text className="text-sm text-foreground-muted">{m(msg("Found on this environment"))}</Text>
        {sources.length === 0 ? (
          <Text className="text-foreground-muted">
            {m(msg("No local history found. Refresh after adding conversations on this server."))}
          </Text>
        ) : null}
        {sources.map((item, index) => (
          <View key={item.id}>
            <SelectionRow
              title={item.label}
              selected={source?.id === item.id}
              isFirst={index === 0}
              isLast={index === sources.length - 1}
              disabled={item.status !== "ready"}
              onPress={() => setSelected(item.id)}
            />
            <Text className="text-xs text-foreground-muted">
              {externalHistorySourceStatusLabel(item.status, m)}
              {item.message ? ` · ${item.message}` : ""}
            </Text>
          </View>
        ))}
        {query.data.unsupported.map((item) => (
          <Text key={item.provider} className="text-xs text-foreground-muted">
            {item.label} · {item.reason}
          </Text>
        ))}
        <Button
          label={m(msg("Refresh sources"))}
          tone="text"
          disabled={query.isPending}
          onPress={query.refresh}
        />
      </View>
      {source ? (
        <HistorySearch
          key={JSON.stringify([source.id, source.capabilities])}
          {...props}
          sourceId={source.id}
          capabilities={source.capabilities}
        />
      ) : null}
    </View>
  );
}

function HistorySearch(
  props: Scope & {
    readonly sourceId: string;
    readonly capabilities: ExternalHistorySource["capabilities"];
  },
) {
  const m = useMessages();
  const [text, setText] = useState("");
  const [filterCwd, setFilterCwd] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [search, setSearch] = useState<Search | null>(null);
  const [generation, setGeneration] = useState(0);
  const submit = () => {
    if (!text.trim()) return;
    setGeneration((current) => current + 1);
    setSearch({
      operation: "search",
      sourceId: props.sourceId,
      query: text.trim(),
      ...externalHistorySearchFilters(props.capabilities, { filterCwd, includeArchived }),
    });
  };
  return (
    <View className="gap-3">
      <AppTextInput
        accessibilityLabel={m(msg("Search external history"))}
        placeholder={m(msg("Find text in messages and tool evidence"))}
        value={text}
        onChangeText={setText}
        maxLength={256}
        returnKeyType="search"
        onSubmitEditing={submit}
      />
      {props.capabilities.cwdFilter ? (
        <>
          <AppTextInput
            accessibilityLabel={m(msg("History directory filter"))}
            placeholder={m(msg("All project directories"))}
            value={filterCwd}
            onChangeText={(value) => {
              setFilterCwd(value);
              setSearch(null);
            }}
            maxLength={4096}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {props.currentProjectPath ? (
            <View className="flex-row gap-2">
              <Button
                label={m(msg("This project"))}
                tone="text"
                onPress={() => {
                  setFilterCwd(props.currentProjectPath!);
                  setSearch(null);
                }}
              />
              <Button
                label={m(msg("All projects"))}
                tone="text"
                onPress={() => {
                  setFilterCwd("");
                  setSearch(null);
                }}
              />
            </View>
          ) : null}
        </>
      ) : null}
      {props.capabilities.archived ? (
        <SettingsSwitchRow
          label={m(msg("Include archived threads"))}
          value={includeArchived}
          onValueChange={(value) => {
            setIncludeArchived(value);
            setSearch(null);
          }}
        />
      ) : null}
      <Button label={m(msg("Search"))} onPress={submit} disabled={!text.trim()} />
      {search ? (
        <HistoryResults
          key={JSON.stringify([search, generation])}
          environmentId={props.environmentId}
          search={search}
        />
      ) : (
        <Text className="text-xs text-foreground-muted">
          {m(msg("Search messages and tool evidence from the selected source."))}
        </Text>
      )}
    </View>
  );
}

function HistoryResults(props: { readonly environmentId: EnvironmentId; readonly search: Search }) {
  const m = useMessages();
  const [paging, dispatch] = useReducer(
    externalHistoryPagingReducer,
    undefined,
    initialExternalHistoryPaging,
  );
  const [selected, setSelected] = useState<ExternalHistoryMatch | null>(null);
  const cursor = paging.cursor;
  const query = useEnvironmentQuery(
    paging.status === "searching"
      ? externalHistory.query({
          environmentId: props.environmentId,
          input: { ...props.search, ...(cursor === undefined ? {} : { cursor }) },
        })
      : null,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The query hook has no result callback to advance the shared pager.
  useEffect(() => {
    if (query.isSuccess && !query.isPending && query.data?.operation === "search")
      dispatch({ type: "page", cursor, page: query.data });
  }, [cursor, query.data, query.isPending, query.isSuccess]);
  const data = paging.status === "ready" ? paging.page : null;
  if (selected)
    return (
      <View className="gap-3">
        <Button label={m(msg("Back to matches"))} tone="text" onPress={() => setSelected(null)} />
        <HistorySource
          key={selected.ref.readCursor + selected.ref.digest}
          environmentId={props.environmentId}
          match={selected}
        />
      </View>
    );
  if (query.error)
    return (
      <Text accessibilityRole="alert" className="text-danger">
        {query.error}
      </Text>
    );
  return (
    <View className="gap-3">
      <Text className="text-xs text-foreground-muted">
        {m(msg("Searched {count, plural, one {# item} other {# items}}{ending}"), {
          count: paging.examinedItems,
          ending: paging.status === "searching" ? "…" : ".",
        })}
      </Text>
      {paging.status === "searching" ? (
        <Button label={m(msg("Stop search"))} onPress={() => dispatch({ type: "stop" })} />
      ) : paging.status === "stopped" ? (
        <View className="gap-2">
          <Text className="text-sm text-foreground-muted">{m(msg("Search stopped."))}</Text>
          <Button label={m(msg("Resume search"))} onPress={() => dispatch({ type: "resume" })} />
        </View>
      ) : null}
      {data?.matches.length === 0 ? (
        <Text className="text-sm text-foreground">{m(msg("No more matches found."))}</Text>
      ) : null}
      {data?.matches.map((match) => (
        <View
          key={match.ref.readCursor + ":" + match.ref.digest}
          className="gap-2 rounded-xl border border-border p-3"
        >
          <Text className="text-sm font-t3-medium text-foreground">{match.threadTitle}</Text>
          <Text className="text-xs text-foreground-muted">
            {m(msg("{role} · {count, plural, one {# character} other {# characters}}"), {
              role: externalHistoryRoleLabel(match.role, m),
              count: match.totalChars,
            })}
          </Text>
          <Text selectable className="text-sm text-foreground">
            {match.excerpt}
          </Text>
          <Button label={m(msg("Open source"))} tone="text" onPress={() => setSelected(match)} />
        </View>
      ))}
      {paging.previous.length > 0 || data?.nextCursor != null ? (
        <View className="flex-row justify-between gap-2">
          <Button
            label={m(msg("Previous page"))}
            disabled={paging.previous.length === 0}
            onPress={() => dispatch({ type: "previous" })}
          />
          <Button
            label={m(msg("Continue search"))}
            disabled={data?.nextCursor == null}
            onPress={() => dispatch({ type: "next" })}
          />
        </View>
      ) : null}
    </View>
  );
}

function HistorySource(props: {
  readonly environmentId: EnvironmentId;
  readonly match: ExternalHistoryMatch;
}) {
  const m = useMessages();
  const [offsets, setOffsets] = useState<ReadonlyArray<number>>([0]);
  const query = useEnvironmentQuery(
    externalHistory.query({
      environmentId: props.environmentId,
      input: {
        operation: "read",
        ref: props.match.ref,
        textOffset: offsets.at(-1) ?? 0,
        maxChars: 12_000,
      },
    }),
  );
  if (query.error)
    return (
      <Text accessibilityRole="alert" className="text-danger">
        {query.error}
      </Text>
    );
  if (!query.data || query.data.operation !== "read")
    return <Text className="text-foreground-muted">{m(msg("Reading source…"))}</Text>;
  const data = query.data;
  return (
    <View className="gap-3">
      <Text className="text-sm font-t3-medium text-foreground">{data.threadTitle}</Text>
      <Text className="text-xs text-foreground-muted">
        {externalHistoryRoleLabel(data.role, m)} · {externalHistoryRangeLabel(data, m)}
      </Text>
      <Text selectable className="text-xs text-foreground-muted">
        {m(msg("Thread {threadId} · Item {itemId}"), {
          threadId: data.ref.threadId,
          itemId: props.match.itemId,
        })}
      </Text>
      <Text selectable className="text-sm text-foreground">
        {data.text}
      </Text>
      {offsets.length > 1 || data.nextTextOffset !== null ? (
        <View className="flex-row justify-between gap-2">
          <Button
            label={m(msg("Previous source text"))}
            disabled={offsets.length === 1 || query.isPending}
            onPress={() => setOffsets((current) => current.slice(0, -1))}
          />
          <Button
            label={m(msg("More source text"))}
            disabled={data.nextTextOffset === null || query.isPending}
            onPress={() => {
              if (data.nextTextOffset !== null)
                setOffsets((current) => [...current, data.nextTextOffset!]);
            }}
          />
        </View>
      ) : null}
    </View>
  );
}
