import { pluginEnabledInThread } from "@t3tools/client-runtime/state/kompas";
import type { ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { SearchIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { useAtomCommand } from "../state/use-atom-command";
import { kompasEnvironment, useKompas } from "./state";

/** One chip per plugin: on or off in this conversation. */
export function ComposerPlugins(props: { readonly threadId: ThreadId | null }) {
  const gt = useGT();
  const kompas = useKompas();
  const setForThread = useAtomCommand(kompasEnvironment.setPluginForThread);
  const { threadId } = props;
  const plugins = kompas?.snapshot.plugins.filter((plugin) => plugin.enabled) ?? [];
  if (kompas === null || threadId === null || plugins.length === 0) return null;
  return (
    <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {plugins.map((plugin) => {
        const enabled = pluginEnabledInThread(kompas.snapshot, plugin.id, threadId);
        return (
          <Button
            key={plugin.id}
            type="button"
            size="sm-pill"
            variant={enabled ? "secondary" : "ghost-muted"}
            aria-pressed={enabled}
            title={
              enabled
                ? gt("{plugin} is on in this conversation", { plugin: plugin.label })
                : gt("{plugin} is off in this conversation", { plugin: plugin.label })
            }
            onClick={() =>
              void setForThread({
                environmentId: kompas.environmentId,
                input: { pluginId: plugin.id, threadId, enabled: !enabled },
              })
            }
          >
            {enabled ? <SearchIcon /> : null}
            {plugin.label}
          </Button>
        );
      })}
    </div>
  );
}
