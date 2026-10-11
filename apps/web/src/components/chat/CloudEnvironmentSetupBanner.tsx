import { useCallback, useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { CloudIcon, Settings2Icon } from "lucide-react";

import { mutateCloudEnvironment, providerCloudConfiguration } from "../../cloudRunStore";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * The composer banner for a thread that runs in a Codex Cloud environment
 * configuration, like the setup conversation: Edit opens its review, Publish
 * saves the prepared environment for new tasks. Pass `null` to show nothing.
 */
export function useCloudEnvironmentSetupBannerItem(
  target: {
    environmentId: EnvironmentId;
    instanceId: ProviderInstanceId;
    configId: string;
  } | null,
  onEdit: () => void,
): ComposerBannerStackItem | null {
  const [publishing, setPublishing] = useState(false);
  const canOperate = useAtomValue(
    mutateCloudEnvironment.permissionAtom(target?.environmentId ?? null),
  );
  const mutate = useAtomCommand(mutateCloudEnvironment);
  const configuration = useEnvironmentQuery(
    target
      ? providerCloudConfiguration({
          environmentId: target.environmentId,
          input: { instanceId: target.instanceId, id: target.configId },
        })
      : null,
  );
  const config = target ? configuration.data : undefined;
  const environmentId = target?.environmentId;
  const instanceId = target?.instanceId;
  const configId = config?.id;
  const refresh = configuration.refresh;

  const publish = useCallback(async () => {
    if (!environmentId || !instanceId || !configId) return;
    setPublishing(true);
    try {
      const result = await mutate({
        environmentId,
        input: { instanceId, operation: "publish", id: configId },
      });
      if (result._tag === "Success") refresh();
    } finally {
      setPublishing(false);
    }
  }, [environmentId, instanceId, configId, mutate, refresh]);

  return useMemo<ComposerBannerStackItem | null>(() => {
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
            disabled={publishing || !canOperate || config.revision === null}
            onClick={() => void publish()}
          >
            {publishing ? "Publishing…" : config.published ? "Republish" : "Publish environment"}
          </Button>
        </>
      ),
    };
  }, [config, publishing, canOperate, onEdit, publish]);
}
