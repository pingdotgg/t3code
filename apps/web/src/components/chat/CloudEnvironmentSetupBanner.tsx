import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { CloudIcon, Settings2Icon } from "lucide-react";

import { cloudEnvironments } from "../../cloudRunStore";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { useCloudEnvironmentMutation } from "./CloudEnvironmentSetup";

/**
 * The composer banner for a cloud environment setup conversation: Edit opens
 * the environment's review, Publish saves it for new cloud tasks. Pass `null`
 * to show nothing.
 */
export function useCloudEnvironmentSetupBannerItem(
  target: {
    environmentId: EnvironmentId;
    instanceId: ProviderInstanceId;
    configId: string;
  } | null,
  onEdit: () => void,
): ComposerBannerStackItem | null {
  const mutation = useCloudEnvironmentMutation(target?.environmentId ?? null);
  const configuration = useEnvironmentQuery(
    target
      ? cloudEnvironments.configuration({
          environmentId: target.environmentId,
          input: { instanceId: target.instanceId, id: target.configId },
        })
      : null,
  );
  const config = target ? configuration.data : undefined;
  const publish = async () => {
    if (!target || !config) return;
    const result = await mutation.run({
      instanceId: target.instanceId,
      operation: "publish",
      id: config.id,
    });
    if (result) configuration.refresh();
  };

  if (!config) return null;
  return {
    id: `cloud-environment-setup:${config.id}`,
    variant: "default",
    icon: <CloudIcon />,
    title: config.name,
    description: config.published
      ? "Published. New cloud tasks start from this environment."
      : "Publish once setup is done to save it for new cloud tasks.",
    actions: (
      <>
        <Button size="xs" variant="ghost" onClick={onEdit}>
          <Settings2Icon /> Edit environment
        </Button>
        <Button
          size="xs"
          variant={config.published ? "ghost" : "default"}
          disabled={mutation.busy !== null || !mutation.canOperate || config.revision === null}
          onClick={() => void publish()}
        >
          {mutation.busy ? "Publishing…" : config.published ? "Republish" : "Publish environment"}
        </Button>
      </>
    ),
  };
}
