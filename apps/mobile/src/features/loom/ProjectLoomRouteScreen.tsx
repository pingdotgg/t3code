import { useAtomValue } from "@effect/atom-react";
import { LegendList } from "@legendapp/list/react-native";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  loomCoverageNotes,
  loomMarkerLabel,
  loomMarkerThreadRef,
  loomTruncationNotes,
} from "@t3tools/client-runtime/projectLoom";
import {
  EnvironmentId,
  ProjectId,
  type LoomRunStatusFilter,
  type LoomWindowInput,
  type ProviderInstanceId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useProject } from "../../state/entities";
import { projectLoom } from "../../state/projectLoom";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironments } from "../../state/environments";
import { ListFilterMenu } from "../layout/workspace/ListFilterMenu";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { buildLoomActivityList, type LoomActivityListItem } from "./loomActivityList";

const WINDOWS = { "24h": 1, "7d": 7, "30d": 30 } as const;
const STATUSES = ["active", "completed", "failed", "interrupted"] as const;
type WindowSpan = keyof typeof WINDOWS;

function bounds(span: WindowSpan) {
  const to = new Date();
  return {
    from: new Date(to.getTime() - WINDOWS[span] * 86_400_000).toISOString(),
    to: to.toISOString(),
  };
}

function time(at: string) {
  return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function ProjectLoomRouteScreen(
  props: StaticScreenProps<{ readonly environmentId: string; readonly projectId: string }>,
) {
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const projectId = ProjectId.make(props.route.params.projectId);
  return (
    <ProjectLoomScreen
      key={`${environmentId}:${projectId}`}
      environmentId={environmentId}
      projectId={projectId}
    />
  );
}

function ProjectLoomScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const { presentationById } = useEnvironments();
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const supported = config?.environment.capabilities.projectLoom === true;
  const project = useProject(props);
  const [span, setSpan] = useState<WindowSpan>("7d");
  const [windowBounds, setWindowBounds] = useState(() => bounds("7d"));
  const [status, setStatus] = useState<LoomRunStatusFilter | null>(null);
  const [provider, setProvider] = useState<ProviderInstanceId | null>(null);
  const [cursors, setCursors] = useState<ReadonlyArray<string>>([]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const input: LoomWindowInput = {
    projectId: props.projectId,
    ...windowBounds,
    filters: {
      ...(status === null ? {} : { statuses: [status] }),
      ...(provider === null ? {} : { providerInstanceIds: [provider] }),
    },
    ...(cursors.length === 0 ? {} : { cursor: cursors.at(-1)! }),
  };
  const query = useEnvironmentQuery(
    supported ? projectLoom.window({ environmentId: props.environmentId, input }) : null,
  );
  const data = query.data;
  const items = useMemo(
    () => (data === null ? [] : buildLoomActivityList(data, collapsed)),
    [collapsed, data],
  );
  const providers = [
    ...new Set([
      ...(data?.lanes.map((lane) => lane.providerInstanceId) ?? []),
      ...(data?.runs.map((run) => run.providerInstanceId) ?? []),
      ...(provider === null ? [] : [provider]),
    ]),
  ].sort();
  const refresh = () => {
    setCursors([]);
    setWindowBounds(bounds(span));
  };
  const toggleCollapsed = (threadId: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  };
  const selectThread = (target: ScopedThreadRef) =>
    selectDetail({ name: "Thread", params: target });
  const canOpenThread = (target: ScopedThreadRef) =>
    target.environmentId === props.environmentId || presentationById.has(target.environmentId);
  const renderItem = ({ item }: { item: LoomActivityListItem }) => {
    if (item.kind === "date") {
      return (
        <Text className="pt-5 pb-2 text-xs font-t3-medium uppercase text-foreground-muted">
          {new Date(`${item.date}T12:00:00`).toLocaleDateString(undefined, {
            weekday: "long",
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
        </Text>
      );
    }
    if (item.kind === "thread") {
      const { row } = item;
      const delegatedFrom = row.delegatedFrom;
      const parentAvailable = delegatedFrom === undefined || canOpenThread(delegatedFrom);
      return (
        <View
          className="flex-row items-center gap-2 border-b border-separator bg-grouped-card px-3 py-3"
          style={{ marginLeft: Math.min(row.depth, 5) * 16 }}
        >
          {row.childCount > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${row.collapsed ? "Expand" : "Collapse"} ${row.title}`}
              accessibilityState={{ expanded: !row.collapsed }}
              hitSlop={8}
              onPress={() => toggleCollapsed(row.threadId)}
              className="min-h-11 min-w-11 items-center justify-center"
            >
              <Text className="text-base text-foreground-muted">{row.collapsed ? "▸" : "▾"}</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open thread ${row.title}`}
            onPress={() => selectThread(scopeThreadRef(props.environmentId, row.threadId))}
            className="min-h-11 min-w-0 flex-1 justify-center gap-1"
          >
            <Text className="text-base font-t3-bold text-foreground" numberOfLines={2}>
              {row.title}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {[
                row.relationship === "root"
                  ? null
                  : row.relationship === "subagent"
                    ? "Delegated agent"
                    : "Fork",
                row.lane === null ? "Parent context · no activity on this date" : row.lane.model,
                row.parentMissing ? "Parent not available in this window" : null,
                row.hiddenCount > 0 ? `${row.hiddenCount} hidden threads` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </Pressable>
          {delegatedFrom === undefined ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open parent thread ${delegatedFrom.title} on ${delegatedFrom.environmentId}`}
              disabled={!parentAvailable}
              accessibilityState={{ disabled: !parentAvailable }}
              onPress={() =>
                selectThread(scopeThreadRef(delegatedFrom.environmentId, delegatedFrom.threadId))
              }
              className="min-h-11 max-w-36 justify-center"
            >
              <Text className="text-xs text-foreground-muted" numberOfLines={2}>
                {parentAvailable
                  ? `Parent on ${delegatedFrom.environmentId}`
                  : `Connect to ${delegatedFrom.environmentId} to open this parent.`}
              </Text>
            </Pressable>
          )}
        </View>
      );
    }
    const at = item.kind === "run" ? item.run.requestedAt : item.marker.at;
    const label =
      item.kind === "run"
        ? `Run ${item.run.ordinal} · ${item.run.status}`
        : loomMarkerLabel(item.marker);
    const target =
      item.kind === "run"
        ? scopeThreadRef(props.environmentId, item.run.threadId)
        : loomMarkerThreadRef(props.environmentId, item.marker);
    const available = canOpenThread(target);
    const remoteLabel =
      item.kind === "marker" && item.marker.kind === "subagent_task"
        ? item.marker.remoteChild?.label
        : undefined;
    return (
      <Pressable
        accessibilityRole={
          item.kind === "marker" && item.marker.kind === "pull_request" ? "link" : "button"
        }
        accessibilityLabel={label}
        disabled={!available}
        accessibilityState={{ disabled: !available }}
        onPress={() => {
          if (item.kind === "marker" && item.marker.kind === "pull_request") {
            void tryOpenExternalUrl(item.marker.url, "pull-request");
          } else selectThread(target);
        }}
        className="min-h-11 gap-1 border-b border-separator bg-grouped-card px-4 py-3"
        style={{ marginLeft: Math.min(item.depth, 5) * 16 + 16 }}
      >
        <Text className="text-sm text-foreground">{label}</Text>
        <Text className="text-xs text-foreground-muted">
          {time(at)}
          {item.kind === "run"
            ? ` · ${item.run.providerInstanceId} · ${item.run.model} · ${
                item.run.startedAt === null
                  ? "Start unknown"
                  : `Started ${time(item.run.startedAt)}`
              } · ${item.run.completedAt === null ? "End not recorded" : `Ended ${time(item.run.completedAt)}`}`
            : ""}
        </Text>
        {available ? null : (
          <Text className="text-xs text-foreground-muted">
            Connect to {remoteLabel ?? target.environmentId} to open this thread.
          </Text>
        )}
      </Pressable>
    );
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AppBar
        title="Loom"
        subtitle={project?.title ?? props.projectId}
        onBack={() => navigation.goBack()}
      />
      <ScreenContent>
        <LegendList
          renderScrollComponent={Platform.OS === "ios" ? NativeScrollView : undefined}
          className="flex-1"
          data={items}
          keyExtractor={(item) => item.key}
          getItemType={(item) => item.kind}
          estimatedItemSize={72}
          renderItem={renderItem}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
          ListHeaderComponent={
            <View className="gap-3 pt-3">
              {config === null ? (
                <Text className="text-sm text-foreground-muted">
                  Connecting to the environment…
                </Text>
              ) : !supported ? (
                <Text className="text-sm text-foreground-muted">
                  This environment's server does not have the Loom yet. Update the server to use it.
                </Text>
              ) : (
                <>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ gap: 8, paddingVertical: 8 }}
                  >
                    <ListFilterMenu
                      label={span}
                      accessibilityLabel="Loom window"
                      actions={Object.keys(WINDOWS).map((value) => ({
                        id: value,
                        title: value,
                        state: value === span ? "on" : "off",
                      }))}
                      onSelect={(value) => {
                        const next = value as WindowSpan;
                        setSpan(next);
                        setWindowBounds(bounds(next));
                        setCursors([]);
                      }}
                    />
                    <ListFilterMenu
                      label={status ?? "All statuses"}
                      accessibilityLabel="Filter Loom by status"
                      active={status !== null}
                      actions={[
                        { id: "all", title: "All statuses", state: status === null ? "on" : "off" },
                        ...STATUSES.map((value) => ({
                          id: value,
                          title: value,
                          state: value === status ? ("on" as const) : ("off" as const),
                        })),
                      ]}
                      onSelect={(value) => {
                        setStatus(value === "all" ? null : (value as LoomRunStatusFilter));
                        setCursors([]);
                      }}
                    />
                    <ListFilterMenu
                      label={provider ?? "All providers"}
                      accessibilityLabel="Filter Loom by provider"
                      active={provider !== null}
                      actions={[
                        {
                          id: "all",
                          title: "All providers",
                          state: provider === null ? "on" : "off",
                        },
                        ...providers.map((value) => ({
                          id: value,
                          title: value,
                          state: value === provider ? ("on" as const) : ("off" as const),
                        })),
                      ]}
                      onSelect={(value) => {
                        setProvider(providers.find((id) => id === value) ?? null);
                        setCursors([]);
                      }}
                    />
                  </ScrollView>
                  <Button
                    label="Refresh"
                    tone="text"
                    onPress={refresh}
                    disabled={query.isPending}
                  />
                  {query.error ? (
                    <Text className="text-sm text-danger-foreground">{query.error}</Text>
                  ) : null}
                  {data ? (
                    <>
                      <Text className="text-xs text-foreground-muted">
                        As of {new Date(data.asOf).toLocaleString()}
                      </Text>
                      {[...loomTruncationNotes(data), ...loomCoverageNotes(data)].map((note) => (
                        <Text key={note} className="text-xs text-foreground-muted">
                          Limited window: {note}.
                        </Text>
                      ))}
                      <Text className="text-xs text-foreground-muted">
                        Test commands are recognized commands, not test results.{" "}
                        {data.coverage.commandsScanned} commands examined.
                      </Text>
                      <Text className="text-xs text-foreground-muted">
                        Runs requested before the window appear on its first date.
                      </Text>
                    </>
                  ) : null}
                </>
              )}
            </View>
          }
          ListEmptyComponent={
            supported && query.error === null ? (
              <Text className="py-8 text-center text-sm text-foreground-muted">
                {query.isPending
                  ? "Loading activity…"
                  : "No activity in this window. Try another window or filter."}
              </Text>
            ) : null
          }
          ListFooterComponent={
            supported ? (
              <View className="flex-row flex-wrap gap-3 pt-4">
                {cursors.length > 0 ? (
                  <Button
                    label="Previous threads"
                    disabled={query.isPending}
                    onPress={() => setCursors((previous) => previous.slice(0, -1))}
                  />
                ) : null}
                {data?.nextCursor ? (
                  <Button
                    label="Older threads"
                    disabled={query.isPending}
                    onPress={() => {
                      setWindowBounds({ from: data.from, to: data.to });
                      setCursors((previous) => [...previous, data.nextCursor!]);
                    }}
                  />
                ) : null}
              </View>
            ) : null
          }
        />
      </ScreenContent>
    </View>
  );
}
