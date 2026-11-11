import type { EnvironmentId, ExtensionInfo, ExtensionInvokeInput } from "@t3tools/contracts";
import {
  extensionCommandValue,
  extensionFailureMessage,
} from "@t3tools/client-runtime/state/extensions";
import * as Dialog from "../../components/ui/Dialog";
import { extensionEnvironment } from "../../state/extensions";
import { useAtomCommand } from "../../state/use-atom-command";

export function useExtensionCommandPrompt() {
  const invoke = useAtomCommand(extensionEnvironment.invoke);
  return (
    environmentId: EnvironmentId,
    entry: ExtensionInfo,
    command: NonNullable<ExtensionInfo["manifest"]["commands"]>[number],
    context?: ExtensionInvokeInput["context"],
  ) => {
    Dialog.prompt({
      title: command.title,
      message: command.description || "Arguments (JSON)",
      initialValue: "{}",
      confirmText: "Run command",
      onConfirm: (text) => {
        let input: unknown;
        try {
          input = JSON.parse(text);
        } catch {
          Dialog.alert("Invalid JSON arguments");
          return;
        }
        void invoke({
          environmentId,
          input: {
            id: entry.manifest.id,
            kind: "command",
            name: command.id,
            input,
            context: { ...context, surface: "mobile" },
          },
        })
          .then((result) => {
            Dialog.alert(command.title, JSON.stringify(extensionCommandValue(result), null, 2));
          })
          .catch((error: unknown) =>
            Dialog.alert("Extension request failed", extensionFailureMessage(error)),
          );
      },
    });
  };
}
