import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { CircleAlertIcon, GitBranchIcon } from "lucide-react";
import { useGT } from "gt-react";

import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import type { useProject } from "~/state/entities";
import { useEnvironmentProviders } from "~/state/environments";
import { getTriggerDisplayModelName } from "./chat/providerIconUtils";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { ProjectFavicon } from "./ProjectFavicon";
import { ThreadHoverCard } from "./ThreadHoverCard";
import { ThreadPullRequestsMiniList } from "./ThreadStatusIndicators";
import { CardSection } from "./ui/card-section";
import { MiddleTruncate } from "./ui/middle-truncate";

type ChipProject = NonNullable<ReturnType<typeof useProject>>;

export function ThreadChipHoverCard(props: {
  title: string;
  project: ChipProject | null;
  shell: EnvironmentThreadShell | null;
  unreadable: boolean;
}) {
  const gt = useGT();
  const { shell } = props;
  const providers = useEnvironmentProviders();
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(
    shell?.environmentId ?? null,
  );
  const instanceId = shell
    ? (shell.runtime?.providerInstanceId ?? shell.modelSelection.instanceId)
    : null;
  const provider =
    shell && instanceId
      ? (providers.get(shell.environmentId)?.find((entry) => entry.instanceId === instanceId) ??
        null)
      : null;
  const model = shell
    ? provider?.models.find((entry) => entry.slug === shell.modelSelection.model)
    : undefined;
  const modelLabel = model
    ? getTriggerDisplayModelName(model, provider?.driver)
    : shell?.modelSelection.model.trim();
  return (
    <ThreadHoverCard
      title={props.title}
      footer={
        supportsMultiplePullRequests && shell && shell.pullRequests.length > 0 ? (
          <CardSection divided="top" padding="compact">
            <div className="pl-0.5 text-meta text-muted-foreground">
              <ThreadPullRequestsMiniList pullRequests={shell.pullRequests} />
            </div>
          </CardSection>
        ) : null
      }
    >
      {props.project ? (
        <div className="flex min-w-0 items-center gap-2">
          <ProjectFavicon project={props.project} className="size-3 shrink-0" />
          <div className="min-w-0 truncate text-foreground/75">{props.project.title}</div>
        </div>
      ) : null}
      {shell?.branch ? (
        <div className="flex min-w-0 items-center gap-2">
          <GitBranchIcon className="size-3 shrink-0 stroke-muted-foreground" />
          <MiddleTruncate value={shell.branch} className="flex" />
        </div>
      ) : null}
      {provider && modelLabel ? (
        <div className="flex min-w-0 items-center gap-2">
          <ProviderInstanceIcon
            driverKind={provider.driver}
            displayName={resolveProviderInstanceDisplayName(provider)}
            acpRegistryIconUrl={provider.iconUrl}
            iconClassName="size-3 shrink-0 opacity-60"
          />
          <div className="min-w-0 truncate text-foreground/75">{modelLabel}</div>
        </div>
      ) : null}
      {props.unreadable ? (
        <div className="flex min-w-0 items-start gap-2 text-warning">
          <CircleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 stroke-current" />
          <div className="min-w-0 flex-1 wrap-break-word">
            {gt(
              "On another machine, so this machine's agent can't read it. Remove it or switch back to send.",
            )}
          </div>
        </div>
      ) : null}
    </ThreadHoverCard>
  );
}
