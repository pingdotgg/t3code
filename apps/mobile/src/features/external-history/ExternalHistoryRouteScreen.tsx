import { useAtomValue } from "@effect/atom-react";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { externalHistoryRangeLabel } from "@t3tools/client-runtime/externalHistory";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  type ExternalHistoryMatch,
  type ExternalHistoryRequest,
  type ExternalHistorySettings,
  type ProjectId,
} from "@t3tools/contracts";
import { useState } from "react";
import { ScrollView, View } from "react-native";

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
  const navigation = useNavigation();
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const project = useProject(props);
  return config?.environment.capabilities.externalHistory === 1 ? (
    <Button
      label="External history"
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
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const navigation = useNavigation();
  const focused = useIsFocused();
  const supported = config?.environment.capabilities.externalHistory === 1;
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AppBar title="External history" onBack={() => navigation.goBack()} />
      <ScreenContent>
        {supported && focused && config ? (
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ padding: 20, paddingBottom: 40, gap: 16 }}
          >
            <Text className="text-sm text-foreground-muted">
              Search Codex conversations and configured ChatGPT exports on this environment. Open
              the original evidence behind each match.
            </Text>
            <HistorySettings
              key={
                "settings:" +
                JSON.stringify([environmentId, config.settings.externalHistory.chatGptExportPaths])
              }
              environmentId={environmentId}
              settings={config.settings.externalHistory}
            />
            {config.settings.externalHistory.enabled ? (
              <HistorySources
                key={"sources:" + JSON.stringify([environmentId, config.settings.externalHistory])}
                environmentId={environmentId}
                {...(props.route.params.currentProjectPath
                  ? { currentProjectPath: props.route.params.currentProjectPath }
                  : {})}
              />
            ) : (
              <Text className="text-sm text-foreground-muted">
                External history search is off for this environment.
              </Text>
            )}
          </ScrollView>
        ) : !supported ? (
          <Text className="p-5 text-sm text-foreground-muted">
            Update this server to search external history.
          </Text>
        ) : null}
      </ScreenContent>
    </View>
  );
}

function HistorySettings(props: {
  readonly environmentId: EnvironmentId;
  readonly settings: ExternalHistorySettings;
}) {
  const canWrite = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(props.environmentId),
  );
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [paths, setPaths] = useState(props.settings.chatGptExportPaths.join("\n"));
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
    <View className="gap-3 rounded-xl border border-border p-3">
      <SettingsSwitchRow
        label="Allow external history search"
        value={props.settings.enabled}
        disabled={pending || !canWrite}
        onValueChange={(enabled) => void save({ ...props.settings, enabled })}
      />
      <Text className="text-xs text-foreground-muted">
        Makes these sources available to this environment's connected clients and agents with thread
        access. Source files stay in their existing locations.
      </Text>
      <Text className="text-sm text-foreground">ChatGPT export paths</Text>
      <AppTextInput
        accessibilityLabel="ChatGPT export paths"
        placeholder="One export file path per line"
        multiline
        textAlignVertical="top"
        numberOfLines={3}
        value={paths}
        editable={!pending && canWrite}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setPaths}
      />
      <Text className="text-xs text-foreground-muted">
        Paths refer to files on the T3 server. Remove a path to stop offering that export.
      </Text>
      <Button
        label="Save export paths"
        tone="text"
        disabled={pending || !canWrite || paths === props.settings.chatGptExportPaths.join("\n")}
        onPress={() =>
          void save({
            ...props.settings,
            chatGptExportPaths: [
              ...new Set(
                paths
                  .split("\n")
                  .map((path) => path.trim())
                  .filter(Boolean),
              ),
            ],
          })
        }
      />
      {!canWrite ? (
        <Text className="text-xs text-foreground-muted">
          This connection cannot change environment settings.
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-danger">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function HistorySources(props: Scope) {
  const query = useEnvironmentQuery(
    externalHistory.query({ environmentId: props.environmentId, input: { operation: "sources" } }),
  );
  const [selected, setSelected] = useState<string | null>(null);
  if (query.error)
    return (
      <Text accessibilityRole="alert" className="text-danger">
        {query.error}
      </Text>
    );
  if (!query.data || query.data.operation !== "sources")
    return <Text className="text-foreground-muted">Loading history sources…</Text>;
  if (!query.data.enabled)
    return (
      <Text className="text-foreground-muted">
        External history search is off for this environment.
      </Text>
    );
  const sources = query.data.sources;
  const source = sources.find((item) => item.id === selected) ?? sources[0];
  if (!source)
    return (
      <View className="gap-2">
        <Text className="text-foreground-muted">
          No sources are configured. Enable a Codex provider or add a ChatGPT export path.
        </Text>
        <Button
          label="Refresh sources"
          tone="text"
          disabled={query.isPending}
          onPress={query.refresh}
        />
      </View>
    );
  return (
    <View className="gap-4">
      <View>
        <Text className="mb-2 text-sm text-foreground-muted">History source</Text>
        {sources.map((item, index) => (
          <SelectionRow
            key={item.id}
            title={item.label}
            selected={source.id === item.id}
            isFirst={index === 0}
            isLast={index === sources.length - 1}
            onPress={() => setSelected(item.id)}
          />
        ))}
      </View>
      <HistorySearch
        key={source.id}
        {...props}
        sourceId={source.id}
        codex={source.kind === "codex"}
      />
    </View>
  );
}

function HistorySearch(props: Scope & { readonly sourceId: string; readonly codex: boolean }) {
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
      ...(props.codex
        ? { includeArchived, ...(filterCwd.trim() ? { filterCwd: filterCwd.trim() } : {}) }
        : {}),
    });
  };
  return (
    <View className="gap-3">
      <AppTextInput
        accessibilityLabel="Search external history"
        placeholder="Find text in messages and tool evidence"
        value={text}
        onChangeText={setText}
        maxLength={256}
        returnKeyType="search"
        onSubmitEditing={submit}
      />
      {props.codex ? (
        <>
          <AppTextInput
            accessibilityLabel="History directory filter"
            placeholder="All project directories"
            value={filterCwd}
            onChangeText={setFilterCwd}
            maxLength={4096}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {props.currentProjectPath ? (
            <View className="flex-row gap-2">
              <Button
                label="This project"
                tone="text"
                onPress={() => setFilterCwd(props.currentProjectPath!)}
              />
              <Button label="All projects" tone="text" onPress={() => setFilterCwd("")} />
            </View>
          ) : null}
          <SettingsSwitchRow
            label="Include archived Codex threads"
            value={includeArchived}
            onValueChange={setIncludeArchived}
          />
        </>
      ) : null}
      <Button label="Search" onPress={submit} disabled={!text.trim()} />
      {search ? (
        <HistoryResults
          key={JSON.stringify([search, generation])}
          environmentId={props.environmentId}
          search={search}
        />
      ) : (
        <Text className="text-xs text-foreground-muted">
          Search reads bounded pages from the selected source. It may take several pages to scan a
          large history.
        </Text>
      )}
    </View>
  );
}

function HistoryResults(props: { readonly environmentId: EnvironmentId; readonly search: Search }) {
  const [cursors, setCursors] = useState<ReadonlyArray<string>>([]);
  const [selected, setSelected] = useState<ExternalHistoryMatch | null>(null);
  const cursor = cursors.at(-1);
  const query = useEnvironmentQuery(
    externalHistory.query({
      environmentId: props.environmentId,
      input: { ...props.search, ...(cursor === undefined ? {} : { cursor }) },
    }),
  );
  if (selected)
    return (
      <View className="gap-3">
        <Button label="Back to matches" tone="text" onPress={() => setSelected(null)} />
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
  if (!query.data || query.data.operation !== "search")
    return <Text className="text-foreground-muted">Searching history…</Text>;
  const data = query.data;
  return (
    <View className="gap-3">
      <Text className="text-xs text-foreground-muted">
        Examined {data.examinedItems.toLocaleString()} items on this page.
      </Text>
      {data.matches.length === 0 ? (
        <Text className="text-sm text-foreground">
          No matches on this page.
          {data.nextCursor !== null ? " Continue to search the next page." : ""}
        </Text>
      ) : null}
      {data.matches.map((match) => (
        <View
          key={match.ref.readCursor + ":" + match.ref.digest}
          className="gap-2 rounded-xl border border-border p-3"
        >
          <Text className="text-sm font-t3-medium text-foreground">{match.threadTitle}</Text>
          <Text className="text-xs text-foreground-muted">
            {match.role} · {match.totalChars.toLocaleString()} characters
          </Text>
          <Text selectable className="text-sm text-foreground">
            {match.excerpt}
          </Text>
          <Button label="Open source" tone="text" onPress={() => setSelected(match)} />
        </View>
      ))}
      {cursors.length > 0 || data.nextCursor !== null ? (
        <View className="flex-row justify-between gap-2">
          <Button
            label="Previous page"
            disabled={cursors.length === 0 || query.isPending}
            onPress={() => setCursors((current) => current.slice(0, -1))}
          />
          <Button
            label="Continue search"
            disabled={data.nextCursor === null || query.isPending}
            onPress={() => {
              if (data.nextCursor !== null) setCursors((current) => [...current, data.nextCursor!]);
            }}
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
    return <Text className="text-foreground-muted">Reading source…</Text>;
  const data = query.data;
  return (
    <View className="gap-3">
      <Text className="text-sm font-t3-medium text-foreground">{data.threadTitle}</Text>
      <Text className="text-xs text-foreground-muted">
        {data.role} · {externalHistoryRangeLabel(data)}
      </Text>
      <Text selectable className="text-xs text-foreground-muted">
        Thread {data.ref.threadId} · Item {props.match.itemId}
      </Text>
      <Text selectable className="text-sm text-foreground">
        {data.text}
      </Text>
      {offsets.length > 1 || data.nextTextOffset !== null ? (
        <View className="flex-row justify-between gap-2">
          <Button
            label="Previous source text"
            disabled={offsets.length === 1 || query.isPending}
            onPress={() => setOffsets((current) => current.slice(0, -1))}
          />
          <Button
            label="More source text"
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
