import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type ServerSettings,
} from "@t3tools/contracts";
import { useEnvironmentScope } from "../../state/session";
import {
  projectScriptFileCommand,
  projectScriptForFile,
  resolveProjectScripts,
} from "@t3tools/shared/projectScripts";
import { Atom } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { Alert } from "react-native";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const NO_SETTINGS = Atom.make<ServerSettings | null>(null);

export function useFileProjectScripts(project: EnvironmentProject | null | undefined) {
  const gt = useGT();
  const settings = useAtomValue(
    project ? serverEnvironment.settingsValueAtom(project.environmentId) : NO_SETTINGS,
  );
  const canEdit = useAtomValue(
    serverEnvironment.editFileProjectScript.permissionAtom(project?.environmentId ?? null, {
      patch: { defaultProjectScripts: [] },
    }),
  );
  const edit = useAtomCommand(serverEnvironment.editFileProjectScript);
  const canOperate = useEnvironmentScope(
    project?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const canWriteSettings = useEnvironmentScope(
    project?.environmentId ?? null,
    AuthSettingsWriteScope,
  );
  const scripts = project && settings ? resolveProjectScripts(settings, project) : [];
  const byCommand = new Map(scripts.map((script) => [script.command, script]));
  return (path: string) => {
    if (!project || !canEdit || !canOperate || !canWriteSettings) return undefined;
    const command = projectScriptFileCommand(path);
    if (!command) return undefined;
    const saved = byCommand.get(command);
    return {
      title: saved ? gt("Remove project script") : gt("Add to project scripts"),
      onPress: async () => {
        const script = projectScriptForFile(path);
        if (!script) return;
        const result = await edit({
          environmentId: project.environmentId,
          input: {
            project,
            patch: { projectScriptOverrides: { [project.id]: saved ? [] : [script] } },
            ...(saved ? { removeScriptId: saved.id } : {}),
          },
        });
        if (result._tag === "Success")
          Alert.alert(saved ? gt("Removed project script") : gt("Added to project scripts"));
      },
    };
  };
}
