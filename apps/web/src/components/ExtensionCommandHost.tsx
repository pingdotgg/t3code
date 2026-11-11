import {
  extensionCommandValue,
  extensionFailureMessage,
} from "@t3tools/client-runtime/state/extensions";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import type { EnvironmentId, ExtensionInfo, ExtensionInvokeInput } from "@t3tools/contracts";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { extensionEnvironment } from "../state/extensions";
import { useAtomCommand } from "../state/use-atom-command";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

type Selection = {
  environmentId: EnvironmentId;
  extension: ExtensionInfo;
  command: NonNullable<ExtensionInfo["manifest"]["commands"]>[number];
  context?: ExtensionInvokeInput["context"];
};
const selectionAtom = Atom.make<Selection | null>(null);
export function openExtensionCommand(selection: Selection) {
  appAtomRegistry.set(selectionAtom, selection);
}

export function ExtensionCommandHost() {
  const selection = useAtomValue(selectionAtom);
  return (
    <Dialog
      open={selection !== null}
      onOpenChange={(open) => {
        if (!open) appAtomRegistry.set(selectionAtom, null);
      }}
    >
      <DialogPopup>
        {selection && (
          <CommandForm
            key={`${selection.environmentId}:${selection.extension.manifest.id}:${selection.command.id}`}
            selection={selection}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function CommandForm({ selection }: { selection: Selection }) {
  const [argumentsText, setArgumentsText] = useState("{}");
  const [output, setOutput] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const permission = useAtomValue(
    extensionEnvironment.invoke.permissionAtom(selection.environmentId),
  );
  const invoke = useAtomCommand(extensionEnvironment.invoke);
  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={async (event) => {
        event.preventDefault();
        let input: unknown;
        try {
          input = JSON.parse(argumentsText);
        } catch {
          setOutput("Enter valid JSON arguments.");
          return;
        }
        setBusy(true);
        try {
          const result = await invoke({
            environmentId: selection.environmentId,
            input: {
              id: selection.extension.manifest.id,
              kind: "command",
              name: selection.command.id,
              input,
              ...(selection.context ? { context: selection.context } : {}),
            },
          });
          setOutput(JSON.stringify(extensionCommandValue(result), null, 2));
        } catch (error) {
          setOutput(extensionFailureMessage(error));
        }
        setBusy(false);
      }}
    >
      <DialogHeader>
        <DialogTitle>{selection.command.title}</DialogTitle>
        <DialogDescription>{selection.command.description}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <label className="block space-y-1 text-sm">
          <span>Arguments (JSON)</span>
          <Textarea
            value={argumentsText}
            onChange={(event) => setArgumentsText(event.target.value)}
            aria-label="Command arguments (JSON)"
          />
        </label>
        {selection.command.inputSchema && (
          <details>
            <summary>Input schema</summary>
            <pre className="max-h-48 overflow-auto text-xs">
              {JSON.stringify(selection.command.inputSchema, null, 2)}
            </pre>
          </details>
        )}
        {output !== null && (
          <pre role="status" className="max-h-64 overflow-auto text-xs">
            {output}
          </pre>
        )}
      </DialogPanel>
      <DialogFooter>
        <Button type="submit" disabled={busy || !permission}>
          {busy ? "Running..." : "Run command"}
        </Button>
      </DialogFooter>
    </form>
  );
}
