import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { BlocksIcon } from "lucide-react";

import { PluginRenderBoundary } from "./PluginRenderBoundary";
import { pluginEnvironment } from "../state/plugins";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { loadsPluginUi, pluginUiChoicesAtom } from "./pluginFollow";
import {
  pluginContributionKey,
  pluginRightPanelAtom,
  pluginRightPanelKey,
  pluginWebFailuresAtom,
  pluginWebLoadedAtom,
} from "./pluginRegistry";

function PluginPanelNotice(props: {
  readonly title: string;
  readonly description: string;
  readonly onClose: () => void;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BlocksIcon />
        </EmptyMedia>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm" variant="outline" onClick={props.onClose}>
          Close
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function usePluginPanelState(environmentId: EnvironmentId, pluginId: string) {
  const result = useAtomValue(pluginEnvironment.pluginsLive({ environmentId, input: {} }));
  const loadsUi = loadsPluginUi(
    useAtomValue(pluginUiChoicesAtom),
    environmentId,
    useAtomValue(primaryEnvironmentIdAtom),
  );
  const webFailed = useAtomValue(pluginWebFailuresAtom(pluginId)).has(environmentId);
  const loaded = useAtomValue(pluginWebLoadedAtom(pluginContributionKey(environmentId, pluginId)));
  const plugin = AsyncResult.isSuccess(result)
    ? result.value.plugins.find((candidate) => candidate.id === pluginId)
    : undefined;
  const starting =
    AsyncResult.isInitial(result) ||
    (plugin?.hasWeb === true && (plugin.status === "active" || plugin.status === "loading"));
  return {
    name: plugin?.name ?? pluginId,
    loading: loadsUi && !webFailed && !loaded && starting,
  };
}

function PluginNotLoadedNotice(props: {
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
  readonly panel: string;
  readonly onClose: () => void;
}) {
  const { name, loading } = usePluginPanelState(props.environmentId, props.pluginId);
  return loading ? (
    <PluginPanelNotice
      title="Loading plugin"
      description={`${name} is loading its "${props.panel}" panel.`}
      onClose={props.onClose}
    />
  ) : (
    <PluginPanelNotice
      title="Plugin not active"
      description={`${name} is disabled or not loaded, so its "${props.panel}" panel is unavailable.`}
      onClose={props.onClose}
    />
  );
}

export function PluginPanelSurface(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly pluginId: string;
  readonly panel: string;
  readonly onClose: () => void;
}) {
  const entry = useAtomValue(
    pluginRightPanelAtom(pluginRightPanelKey(props.environmentId, props.pluginId, props.panel)),
  );
  if (entry === undefined) {
    return (
      <PluginNotLoadedNotice
        environmentId={props.environmentId}
        pluginId={props.pluginId}
        panel={props.panel}
        onClose={props.onClose}
      />
    );
  }
  const Panel = entry.component;
  return (
    <PluginRenderBoundary
      owner={entry.owner}
      what={`Its panel ${entry.title}`}
      resetKeys={[entry]}
      fallback={
        <PluginPanelNotice
          title="Plugin panel failed"
          description={`${entry.title} from ${entry.owner.pluginName} stopped with an error.`}
          onClose={props.onClose}
        />
      }
    >
      <Panel threadId={props.threadId} />
    </PluginRenderBoundary>
  );
}
