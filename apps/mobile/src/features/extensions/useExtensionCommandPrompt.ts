import { m } from "../../i18n/messages";
import { useGT } from "gt-react-native";
import type { EnvironmentId, ExtensionInfo, ExtensionInvokeInput } from "@t3tools/contracts";
import {
  extensionCommandValue,
  extensionFailureMessage,
} from "@t3tools/client-runtime/state/extensions";
import * as Dialog from "../../components/ui/Dialog";
import { extensionEnvironment } from "../../state/extensions";
import { useAtomCommand } from "../../state/use-atom-command";

export function useExtensionCommandPrompt() {
  const gt = useGT();
  const invoke = useAtomCommand(extensionEnvironment.invoke);
  return (
    environmentId: EnvironmentId,
    entry: ExtensionInfo,
    command: NonNullable<ExtensionInfo["manifest"]["commands"]>[number],
    context?: ExtensionInvokeInput["context"],
  ) => {
    Dialog.prompt({
      title: command.title,
      message: command.description || gt("Arguments (JSON)"),
      initialValue: "{}",
      confirmText: gt("Run command"),
      onConfirm: (text) => {
        let input: unknown;
        try {
          input = JSON.parse(text);
        } catch {
          Dialog.alert(gt("Invalid JSON arguments"));
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
            Dialog.alert(gt("Extension request failed"), extensionFailureMessage(error, m)),
          );
      },
    });
  };
}
