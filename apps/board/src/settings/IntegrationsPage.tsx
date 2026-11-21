import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useContext } from "react";

import { issueTrackerEnvironment } from "../state/issues";
import { sourceControlEnvironment } from "../state/sourceControl";
import { buttonClass } from "./controls/buttonClass";
import { IntegrationGroup } from "./integrations/IntegrationGroup";
import { JiraCard } from "./integrations/JiraCard";
import { LinearCard } from "./integrations/LinearCard";
import { ProviderCard } from "./integrations/ProviderCard";

export function IntegrationsPage({ environmentId }: { environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  const trackersAtom = issueTrackerEnvironment.connections({ environmentId, input: {} });
  const discoveryAtom = sourceControlEnvironment.discovery({ environmentId, input: {} });
  const trackers = useAtomValue(trackersAtom);
  const discovery = useAtomValue(discoveryAtom);
  const list = AsyncResult.getOrElse(trackers, () => null);
  const hosts = AsyncResult.getOrElse(discovery, () => null)?.sourceControlProviders ?? [];
  const linear = list?.trackers.find((tracker) => tracker.tracker === "linear");
  const issueHosts = hosts.filter((host) => host.kind === "github");
  const problem = (message: string, retry: () => void) => (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <p role="alert" className="min-w-0 text-xs break-words text-red-400">
        {message}
      </p>
      <button type="button" onClick={retry} className={buttonClass}>
        Retry
      </button>
    </div>
  );

  return (
    <div className="flex flex-col gap-8">
      <IntegrationGroup
        title="Source control"
        description="Connect the hosts the board can use for pull requests, checks and review status."
      >
        {hosts.length === 0 &&
          (discovery._tag === "Failure" ? (
            problem("The engine could not report its source control hosts.", () =>
              registry.refresh(discoveryAtom),
            )
          ) : (
            <p className="px-4 py-3 text-xs text-faint">Asking the engine for its hosts.</p>
          ))}
        {hosts.map((item) => (
          <ProviderCard key={item.kind} item={item} purpose="source-control" />
        ))}
      </IntegrationGroup>
      <IntegrationGroup
        title="Task trackers"
        description="Connect the trackers the board can use to browse issues."
      >
        {linear !== undefined && list !== null && (
          <LinearCard
            environmentId={environmentId}
            tracker={linear}
            bindings={list.bindings}
            checking={trackers.waiting && !linear.connected}
            onRecheck={() => registry.refresh(trackersAtom)}
          />
        )}
        {linear === undefined &&
          (trackers._tag === "Failure" ? (
            problem("The engine could not report its issue trackers.", () =>
              registry.refresh(trackersAtom),
            )
          ) : list === null ? (
            <p className="px-4 py-3 text-xs text-faint">Asking the engine for its trackers.</p>
          ) : null)}
        {issueHosts.map((item) => (
          <ProviderCard key={item.kind} item={item} purpose="tracker" />
        ))}
        <JiraCard />
      </IntegrationGroup>
    </div>
  );
}
