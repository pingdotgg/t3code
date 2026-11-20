import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  normalizeProviderAccentColor,
  resolveProviderInstanceDisplayName,
  shouldShowInstanceBadge,
} from "@t3tools/client-runtime/state/provider-instance-display";
import {
  resolveSubagentMetadata,
  subagentCardDetail,
} from "@t3tools/client-runtime/state/subagent-display";
import { formatSubagentEffort } from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentId, OrchestrationV2Subagent } from "@t3tools/contracts";
import { msg, T, useMessages, Var } from "gt-react-native";
import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ProviderIcon, ProviderInstanceIcon } from "../../components/ProviderIcon";
import { WithStatusBadgeDot, type StatusBadgeState } from "../../components/StatusBadgeDot";
import { cn } from "../../lib/cn";
import { useEnvironmentServerConfig, useProject, useThreadShell } from "../../state/entities";
import { SUBAGENT_TONE_TEXT_CLASS, SubagentStatusDot } from "./SubagentStatusDot";
import { ThreadCardContent } from "./ThreadCardFace";
import { resolveSubagentRowPresentation, type SubagentRowTone } from "./threadAgentsPresentation";

const TONE_BADGE_STATE: Readonly<Record<SubagentRowTone, StatusBadgeState>> = {
  working: "working",
  completed: "done",
  failed: "failed",
  stopped: "waiting",
};

type SubagentRowSubagent = Pick<
  OrchestrationV2Subagent,
  | "threadId"
  | "childThreadId"
  | "model"
  | "modelSelection"
  | "driver"
  | "providerInstanceId"
  | "title"
  | "prompt"
  | "status"
  | "progress"
  | "result"
  | "remoteChild"
>;

export function SubagentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: SubagentRowSubagent;
  readonly elapsed: ReactNode;
  /** The task runs in a linked environment this app is connected to. */
  readonly canOpenRemote?: boolean;
}) {
  const messages = useMessages();
  const presentation = resolveSubagentRowPresentation(
    props.subagent,
    props.canOpenRemote,
    messages,
  );
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
              className="min-w-0 shrink font-t3-medium text-sm text-foreground"
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
            {presentation.runsOn !== null ? (
              <Text numberOfLines={1} className="shrink text-xs text-foreground-muted">
                <T>
                  on <Var>{presentation.runsOn}</Var>
                </T>
              </Text>
            ) : null}
          </View>
          {props.elapsed}
          {presentation.canOpenThread ? (
            <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
          ) : null}
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

function useSubagentMetadata(environmentId: EnvironmentId, subagent: SubagentRowSubagent) {
  const messages = useMessages();
  // A task in a linked environment runs a provider instance of that environment.
  const config = useEnvironmentServerConfig(subagent.remoteChild?.environmentId ?? environmentId);
  const providers = (config?.providers ?? []).map((candidate) => {
    const rawConfig = config?.settings.providerInstances[candidate.instanceId]?.config;
    const instanceConfig =
      rawConfig !== null && typeof rawConfig === "object"
        ? (rawConfig as Readonly<Record<string, unknown>>)
        : null;
    const agentId = instanceConfig?.source === "local" ? undefined : instanceConfig?.agentId;
    return {
      ...candidate,
      driverKind: candidate.driver,
      accentColor: normalizeProviderAccentColor(candidate.accentColor),
      acpRegistryAgentId: typeof agentId === "string" ? agentId.trim() || undefined : undefined,
    };
  });
  const provider = providers.find(
    (candidate) => candidate.instanceId === subagent.providerInstanceId,
  );
  const showBadge = provider !== undefined && shouldShowInstanceBadge(provider, providers);
  // A remote task's own driver is only a "remote" label.
  const driver =
    provider?.driver ?? (subagent.remoteChild === undefined ? subagent.driver : undefined);
  const parent = useThreadShell(scopeThreadRef(environmentId, subagent.threadId))?.source;
  const child = useThreadShell(
    subagent.childThreadId === null ? null : scopeThreadRef(environmentId, subagent.childThreadId),
  )?.source;
  const parentProject = useProject(
    parent ? scopeProjectRef(environmentId, parent.projectId) : null,
  );
  const childProject = useProject(child ? scopeProjectRef(environmentId, child.projectId) : null);
  const selection = subagent.modelSelection;
  const { modelLabel, modelSlug, workspace } = resolveSubagentMetadata(
    {
      model: subagent.model,
      modelSelection: selection,
      provider,
      parentThread: parent,
      childThread: child,
      parentProject,
      childProject,
    },
    messages,
  );
  const branchLabel = messages(msg("Branch", { $context: "field label" }));
  const effort = formatSubagentEffort({ modelSlug, modelSelection: selection, provider });
  const icon = (size: number) =>
    showBadge ? (
      <ProviderInstanceIcon
        provider={provider.driver}
        iconUrl={provider.iconUrl}
        size={size}
        displayName={resolveProviderInstanceDisplayName(provider)}
        accentColor={provider.accentColor}
        showBadge
      />
    ) : driver === undefined ? (
      <SymbolView name="robot" size={size - 1} tintColorClassName="accent-icon-muted" />
    ) : (
      <ProviderIcon provider={driver} iconUrl={provider?.iconUrl} size={size} />
    );
  const text = `${provider ? `${resolveProviderInstanceDisplayName(provider)} · ` : ""}${modelLabel}${
    effort ? ` · ${effort}` : ""
  }`;
  return { icon, text, workspace, branchLabel };
}

function SubagentWorkspace(props: {
  readonly workspace: ReturnType<typeof useSubagentMetadata>["workspace"];
  readonly branchLabel: string;
}) {
  return (
    <>
      {props.workspace.map(({ label, value }) => (
        // Preserve the label against flattening without making it a separate accessibility stop.
        <View
          key={label}
          collapsable={false}
          accessibilityLabel={`${label}: ${value}`}
          className="min-w-0 shrink flex-row items-center gap-1.5"
        >
          <Text className="text-xs text-foreground-muted">·</Text>
          <SymbolView
            name={label === props.branchLabel ? "arrow.triangle.branch" : "folder"}
            size={11}
            tintColorClassName="accent-icon-muted"
          />
          <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
            {value}
          </Text>
        </View>
      ))}
    </>
  );
}

function SubagentMetadata(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: SubagentRowSubagent;
}) {
  const { icon, text, workspace, branchLabel } = useSubagentMetadata(
    props.environmentId,
    props.subagent,
  );
  return (
    <View className="min-w-0 flex-row items-center gap-1.5">
      {icon(12)}
      <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
        {text}
      </Text>
      <SubagentWorkspace workspace={workspace} branchLabel={branchLabel} />
    </View>
  );
}

/** The task as an inline card: provider and model with the status up top, then the title full width. */
export function SubagentCardContent(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: SubagentRowSubagent;
  readonly elapsed: ReactNode;
  readonly canOpenRemote?: boolean;
}) {
  const messages = useMessages();
  const presentation = resolveSubagentRowPresentation(
    props.subagent,
    props.canOpenRemote,
    messages,
  );
  const detail = subagentCardDetail(presentation.detail);
  const { icon, text, workspace, branchLabel } = useSubagentMetadata(
    props.environmentId,
    props.subagent,
  );
  return (
    <ThreadCardContent
      header={
        <>
          {/* The status is a dot on the icon's corner, ringed with the card fill. */}
          <WithStatusBadgeDot
            state={TONE_BADGE_STATE[presentation.tone]}
            ringClassName="bg-card-face"
            accessibilityLabel={presentation.statusLabel}
          >
            {icon(14)}
          </WithStatusBadgeDot>
          {presentation.runsOn !== null ? (
            <Text numberOfLines={1} className="min-w-0 shrink text-xs text-foreground-muted">
              <T>
                on <Var>{presentation.runsOn}</Var>
              </T>
            </Text>
          ) : null}
          <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
            {text}
          </Text>
          <SubagentWorkspace workspace={workspace} branchLabel={branchLabel} />
        </>
      }
      status={props.elapsed}
      title={
        <Text
          numberOfLines={2}
          className={cn(
            "text-sm text-foreground",
            presentation.tone !== "working" && "font-t3-medium",
          )}
        >
          {presentation.title}
        </Text>
      }
      meta={
        detail ? (
          <Text
            numberOfLines={3}
            className={cn(
              "text-xs text-foreground-muted",
              presentation.tone === "failed" && SUBAGENT_TONE_TEXT_CLASS.failed,
            )}
          >
            {detail}
          </Text>
        ) : null
      }
    />
  );
}
