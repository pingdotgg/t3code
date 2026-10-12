import {
  describePluginContributions,
  type PluginOfferedViews,
} from "@t3tools/client-runtime/state/pluginContributions";
import type { PluginInstallation, PluginInstallationManifest } from "@t3tools/contracts";

import type { EnvironmentPresentation } from "../../state/environments";
import { pluginActionEnvironment } from "../../state/pluginActions";
import { usePluginViews } from "../../state/pluginViews";
import { useEnvironmentQuery } from "../../state/query";

/**
 * What a plugin adds to T3 Code, from its manifest summary. For the enabled
 * installation, the environment's action and view snapshots say what is offered
 * now; listing them never starts the plugin. Pass `installation` as null for a
 * manifest that is not installed yet, such as a downloaded update.
 */
export function PluginContributionsList({
  environment,
  manifest,
  installation,
}: {
  readonly environment: EnvironmentPresentation;
  readonly manifest: PluginInstallationManifest;
  readonly installation: PluginInstallation | null;
}) {
  const environmentId = environment.environmentId;
  const capabilities = environment.serverConfig?.environment.capabilities;
  const offered = installation !== null && installation.enabled;
  const actions = useEnvironmentQuery(
    offered && capabilities?.pluginActions === true
      ? pluginActionEnvironment.snapshot({ environmentId, input: {} })
      : null,
  ).data;
  // The same session-bound snapshot the view host uses; it asks nothing of a server without views.
  const views = usePluginViews(offered ? environmentId : null).views;
  const offeredViews: PluginOfferedViews | null =
    installation !== null && views?._tag === "available"
      ? {
          views: views.views.filter(
            (view) =>
              view.installationId === installation.installationId &&
              view.generation === installation.generation,
          ),
          problems: views.problems.filter(
            (problem) =>
              problem.installationId === installation.installationId &&
              problem.generation === installation.generation,
          ),
        }
      : null;
  const groups = describePluginContributions({
    manifest,
    installation,
    actions: actions ?? null,
    views: offeredViews,
  });
  // An older server's summary of a download omits tools, settings, and actions,
  // so an empty list there cannot say the plugin declares nothing.
  if (groups.length === 0)
    return (
      <span className="text-muted-foreground">
        {installation === null ? "Nothing listed" : "Nothing declared"}
      </span>
    );
  return (
    <span className="block space-y-2">
      {groups.map((group) => (
        <span key={group.kind} className="block">
          <span className="block text-xs font-medium text-muted-foreground">{group.label}</span>
          {group.items.map((item) => (
            <span key={item.key} className="block">
              <span className="font-medium">{item.title}</span>
              {item.detail ? (
                <span className="block text-xs text-muted-foreground">{item.detail}</span>
              ) : null}
            </span>
          ))}
          {group.notice ? <span className="block text-xs text-warning">{group.notice}</span> : null}
        </span>
      ))}
    </span>
  );
}
