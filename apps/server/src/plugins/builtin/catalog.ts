import { BUILTIN_PLUGIN_MANIFESTS } from "@t3tools/contracts";
import { definitions as canvas } from "./definitions/canvas.ts";
import { definitions as preview } from "./definitions/preview.ts";
import { definitions as terminal } from "./definitions/terminal.ts";
import { definitions as threads } from "./definitions/threads.ts";
import { definitions as workspace } from "./definitions/workspace.ts";
import { definitions as sourceControl } from "./definitions/sourceControl.ts";
import { definitions as settings } from "./definitions/settings.ts";
import { definitions as usage } from "./definitions/usage.ts";
import { definitions as connections } from "./definitions/connections.ts";
import { definitions as runtime } from "./definitions/runtime.ts";
import { definitions as clients } from "./definitions/clients.ts";
import { definitions as providers } from "./definitions/providers.ts";

const definitions = [
  ...canvas,
  ...preview,
  ...terminal,
  ...threads,
  ...workspace,
  ...sourceControl,
  ...settings,
  ...usage,
  ...connections,
  ...runtime,
  ...clients,
  ...providers,
];
const byId = new Map(definitions.map((definition) => [definition.id, definition]));
if (byId.size !== definitions.length) throw new Error("Duplicate compiled builtin plugin.");

export const COMPILED_SERVER_BUILTINS = [
  ...BUILTIN_PLUGIN_MANIFESTS.map((manifest) => {
    const definition = byId.get(manifest.id);
    if (!definition) throw new Error(`Builtin plugin '${manifest.id}' has no compiled definition.`);
    return { ...definition, manifest };
  }),
  ...definitions.flatMap((definition) =>
    BUILTIN_PLUGIN_MANIFESTS.some((manifest) => manifest.id === definition.id)
      ? []
      : definition.manifest
        ? [{ ...definition, manifest: definition.manifest }]
        : [],
  ),
];

const catalog = new Map(COMPILED_SERVER_BUILTINS.map((definition) => [definition.id, definition]));
export const getCompiledServerBuiltin = (id: string) => catalog.get(id);
