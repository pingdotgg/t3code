import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import type { EnvironmentId, OrchestrationV2Subagent } from "@t3tools/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Text as SystemText, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { useEnvironmentServerConfig, useProject, useThreadShell } from "../../state/entities";
import { subagentCardDetail } from "./subagent-card-presentation";
import { SUBAGENT_TONE_TEXT_CLASS, SubagentStatusDot } from "./SubagentStatusDot";
import { resolveSubagentRowPresentation } from "./threadAgentsPresentation";

type SubagentRowSubagent = Pick<
  OrchestrationV2Subagent,
  | "threadId"
  | "childThreadId"
  | "model"
  | "driver"
  | "providerInstanceId"
  | "title"
  | "prompt"
  | "status"
  | "progress"
  | "result"
>;

type ElapsedColumn = {
  readonly width: number;
  readonly report: (key: string, width: number | null) => void;
};

const ElapsedColumnContext = createContext<ElapsedColumn | null>(null);

/**
 * Sizes every subagent timer inside it to the widest one, like a table column,
 * so the status labels beside them line up and shift together, once, when a
 * timer gains a digit.
 */
export function SubagentElapsedColumn(props: { readonly children: ReactNode }) {
  const [widths, setWidths] = useState<ReadonlyMap<string, number>>(() => new Map());
  // Stable, so a timer's unmount cleanup is the only thing that drops its width.
  const report = useCallback(
    (key: string, width: number | null) =>
      setWidths((current) => {
        if (current.get(key) === (width ?? undefined)) return current;
        const next = new Map(current);
        if (width === null) next.delete(key);
        else next.set(key, width);
        return next;
      }),
    [],
  );
  const width = Math.max(0, ...widths.values());
  const column = useMemo(() => ({ width, report }), [width, report]);
  return <ElapsedColumnContext value={column}>{props.children}</ElapsedColumnContext>;
}

/**
 * Renders a ticking subagent duration in the system font: DM Sans has no
 * tabular figures, so `tabular-nums` alone would still let the width jitter.
 * Inside a column, a row without a duration still keeps the column's space.
 */
export function SubagentElapsedText(props: { readonly children: string | null }) {
  const column = useContext(ElapsedColumnContext);
  if (props.children !== null) return <ElapsedCell column={column}>{props.children}</ElapsedCell>;
  return column ? <View style={{ minWidth: column.width }} /> : null;
}

function ElapsedCell(props: { readonly column: ElapsedColumn | null; readonly children: string }) {
  const { column } = props;
  const key = useId();
  const report = column?.report;
  useEffect(() => (report ? () => report(key, null) : undefined), [key, report]);
  return (
    <View className="shrink-0 items-end" style={{ minWidth: column?.width ?? 0 }}>
      <SystemText
        className="text-xs text-foreground-muted"
        numberOfLines={1}
        onLayout={report ? (event) => report(key, event.nativeEvent.layout.width) : undefined}
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {props.children}
      </SystemText>
    </View>
  );
}

export function SubagentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: SubagentRowSubagent;
  readonly elapsed: ReactNode;
}) {
  const presentation = resolveSubagentRowPresentation(props.subagent);
  const detail = subagentCardDetail(presentation.detail);
  return (
    <View className="flex-row gap-3">
      <View className="h-5 justify-center">
        <SubagentStatusDot tone={presentation.tone} placement="sheet" />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <View className="min-h-5 flex-row items-center gap-2">
          <View className="min-w-0 flex-1 flex-row items-baseline gap-1.5">
            <Text
              numberOfLines={1}
              className="min-w-0 flex-1 font-t3-medium text-sm text-foreground"
            >
              {presentation.title}
            </Text>
            <Text
              accessibilityElementsHidden
              importantForAccessibility="no"
              className="shrink-0 text-xs text-foreground-muted"
            >
              ·
            </Text>
            <Text
              className={cn(
                "shrink-0 text-xs font-t3-medium",
                SUBAGENT_TONE_TEXT_CLASS[presentation.tone],
              )}
            >
              {presentation.statusLabel}
            </Text>
          </View>
          {props.elapsed}
          {presentation.canOpenThread ? (
            <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
          ) : (
            // Holds the chevron's width so statuses line up with openable rows.
            <View className="w-3" />
          )}
        </View>
        <SubagentMetadata environmentId={props.environmentId} subagent={props.subagent} />
        {detail ? (
          <Text
            numberOfLines={3}
            className={cn(
              "text-xs text-foreground-muted",
              presentation.tone === "failed" && SUBAGENT_TONE_TEXT_CLASS.failed,
            )}
          >
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function SubagentMetadata(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: SubagentRowSubagent;
}) {
  const { environmentId, subagent } = props;
  const config = useEnvironmentServerConfig(environmentId);
  const provider = config?.providers.find(
    (candidate) => candidate.instanceId === subagent.providerInstanceId,
  );
  const parent = useThreadShell(scopeThreadRef(environmentId, subagent.threadId))?.source;
  const child = useThreadShell(
    subagent.childThreadId === null ? null : scopeThreadRef(environmentId, subagent.childThreadId),
  )?.source;
  const parentProject = useProject(
    parent ? scopeProjectRef(environmentId, parent.projectId) : null,
  );
  const childProject = useProject(child ? scopeProjectRef(environmentId, child.projectId) : null);
  const { modelLabel, workspace } = resolveSubagentMetadata({
    model: subagent.model,
    provider,
    parentThread: parent,
    childThread: child,
    parentProject,
    childProject,
  });
  return (
    <View className="min-w-0 flex-row items-center gap-1.5">
      <ProviderIcon
        provider={provider?.driver ?? subagent.driver}
        iconUrl={provider?.iconUrl}
        size={12}
      />
      <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
        {provider ? `${resolveProviderInstanceDisplayName(provider)} · ` : ""}
        {modelLabel}
      </Text>
      {workspace.map(({ label, value }) => (
        // The row reads this label in place of the icon. collapsable keeps the
        // view (and label) from being flattened away without making it a
        // separate accessibility stop.
        <View
          key={label}
          collapsable={false}
          accessibilityLabel={`${label}: ${value}`}
          className="min-w-0 shrink flex-row items-center gap-1.5"
        >
          <Text className="text-xs text-foreground-muted">·</Text>
          <SymbolView
            name={label === "Branch" ? "arrow.triangle.branch" : "folder"}
            size={11}
            tintColorClassName="accent-icon-muted"
          />
          <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
            {value}
          </Text>
        </View>
      ))}
    </View>
  );
}
