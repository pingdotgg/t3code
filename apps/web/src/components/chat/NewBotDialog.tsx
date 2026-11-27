import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  BOT_FILE_MAX_CHARS,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { Atom } from "effect/reactivity";
import { useState, type FormEvent } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { m } from "~/i18n/messages";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import { providerInstanceEntriesFor } from "~/providerInstances";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { botFilesEnvironment } from "~/state/botFiles";
import { useEnvironmentProviders } from "~/state/environments";
import { EMPTY_SERVER_PROVIDERS } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { ProviderModelPicker } from "./ProviderModelPicker";

const newBotEnvironmentAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("bots:new-bot-dialog-environment"),
);

export function openNewBotDialog(environmentId: EnvironmentId): void {
  appAtomRegistry.set(newBotEnvironmentAtom, environmentId);
}

const close = () => appAtomRegistry.set(newBotEnvironmentAtom, null);

/** Hosted once at the root, so the command palette can open it from anywhere. */
export function NewBotDialogHost() {
  const environmentId = useAtomValue(newBotEnvironmentAtom);
  return environmentId === null ? null : (
    <NewBotDialog key={environmentId} environmentId={environmentId} />
  );
}

function NewBotDialog({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const navigate = useNavigate();
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const canCreate = useAtomValue(botFilesEnvironment.create.permissionAtom(environmentId));
  const create = useAtomCommand(botFilesEnvironment.create, { reportFailure: false });
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const instanceEntries = providerInstanceEntriesFor(providers, settings, null);
  const selection = picked ?? scheduledTaskDefaultModel(settings, null, instanceEntries);
  const shownInstanceId =
    selection?.instanceId ?? instanceEntries[0]?.instanceId ?? ("" as ProviderInstanceId);
  const shownModel = selection?.model ?? "";
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    shownInstanceId,
    shownModel,
  );
  const ready = canCreate && !pending && title.trim().length > 0 && selection !== null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready || selection === null) return;
    setPending(true);
    setError(null);
    const result = await create({
      environmentId,
      input: { title: title.trim(), instructions, modelSelection: selection },
    });
    setPending(false);
    if (result._tag === "Success") {
      close();
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, result.value.threadId)),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setError(thrownErrorMessage(squashAtomCommandFailure(result), m) ?? gt("An error occurred."));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open || pending ? undefined : close())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            <T>New Bot</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              A Bot coordinates other threads for you. Tell it what to look after and how you like
              it to work.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="new-bot"
            className="flex flex-col gap-3"
            onSubmit={(event) => void submit(event)}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-bot-name">
                <T>Name</T>
              </Label>
              <Input
                id="new-bot-name"
                autoFocus
                value={title}
                readOnly={pending}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={gt("e.g. Chief of staff")}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-bot-instructions">
                <T>Instructions</T>
              </Label>
              <Textarea
                id="new-bot-instructions"
                rows={6}
                size="sm"
                maxLength={BOT_FILE_MAX_CHARS}
                value={instructions}
                readOnly={pending}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder={gt("What the Bot looks after and how you like it to work.")}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>
                <T>Model</T>
              </Label>
              <ProviderModelPicker
                environmentId={environmentId}
                disabled={pending}
                activeInstanceId={shownInstanceId}
                model={shownModel}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                isComposerOwned={false}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onInstanceModelChange={(instanceId, model) => setPicked({ instanceId, model })}
              />
            </div>
            {error === null ? null : (
              <p className="text-destructive text-xs" role="alert">
                {error}
              </p>
            )}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={close}>
            <T>Cancel</T>
          </Button>
          <Button type="submit" form="new-bot" size="sm" disabled={!ready}>
            {pending ? gt("Starting Bot…") : gt("Create Bot")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
