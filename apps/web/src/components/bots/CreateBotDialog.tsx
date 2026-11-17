import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  BOT_NAME_MAX_LENGTH,
  BotError,
  CommandId,
  type BotAvatarColor,
  type BotAvatarShape,
  type EnvironmentId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { useAtomSet } from "@effect/atom-react";
import { Schema } from "effect";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useId, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import {
  getCustomModelOptionsByInstance,
  resolveEffectiveDefaultModelSelection,
} from "../../modelSelection";
import {
  providerInstanceEntriesFor,
  type ProviderInstanceEntry,
  resolveDefaultProviderModelSelection,
} from "../../providerInstances";
import { sidebarModeAtom } from "../../state/bots";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  ComposerEffortColumn,
  describeComposerEffort,
  hasComposerModelOptions,
} from "../chat/ComposerModelEffort";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import type { TraitsSelectionInput } from "../chat/TraitsPicker";
import { isConnectedWithConfig } from "../settings/scopedSettings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { BotAvatarShape as BotAvatarShapeGlyph } from "./BotAvatar";
import { BotAvatarPicker } from "./BotAvatarPicker";

// Settings hooks need an id; with no computer connected nothing is created anyway.
const NO_ENVIRONMENT = "" as EnvironmentId;
const isBotError = Schema.is(BotError);

export function CreateBotDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open={open}
      // Closing mid-create would hide the result of a bot that may already exist.
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogPopup className="sm:max-w-md" showCloseButton={!pending}>
        {open ? (
          <CreateBotForm
            layout="dialog"
            pending={pending}
            onPendingChange={setPending}
            onCancel={() => onOpenChange(false)}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

/** The create form on its own, for the Bots page when there are no bots yet. */
export function CreateBotPanel({
  pending,
  onPendingChange,
}: {
  pending: boolean;
  onPendingChange: (pending: boolean) => void;
}) {
  return (
    <div className="w-full max-w-md rounded-2xl border bg-card shadow-xs">
      <CreateBotForm
        layout="page"
        pending={pending}
        onPendingChange={onPendingChange}
        onCancel={null}
        onDone={() => {}}
      />
    </div>
  );
}

function defaultBotModel(
  settings: UnifiedSettings,
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ModelSelection | null {
  // Pick from what this computer's settings allow, not only what the server reports enabled.
  const providers: ReadonlyArray<ServerProvider> = entries.map((entry) =>
    entry.enabled === entry.snapshot.enabled
      ? entry.snapshot
      : { ...entry.snapshot, enabled: entry.enabled },
  );
  const stored = resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection);
  return stored ? resolveEffectiveDefaultModelSelection(settings, providers, stored) : null;
}

type AvatarChoice = { shape: BotAvatarShape; color: BotAvatarColor };

type FormProps = {
  layout: "dialog" | "page";
  pending: boolean;
  onPendingChange: (pending: boolean) => void;
  onCancel: (() => void) | null;
  onDone: () => void;
};

function CreateBotForm(props: FormProps) {
  const { environments } = useEnvironments();
  // A Boat cloud VM stops when its threads go idle, so it cannot host a bot.
  const machines = environments.filter(
    (environment) =>
      !environment.boatCloud && !environment.boxdCloud && isConnectedWithConfig(environment),
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<AvatarChoice>({ shape: "circle", color: "teal" });
  const [chosenEnvironmentId, setChosenEnvironmentId] = useState<EnvironmentId | null>(null);
  // A chosen computer stays chosen even if it drops, so a create never lands somewhere else.
  const environmentId =
    chosenEnvironmentId ??
    machines.find((machine) => machine.environmentId === primaryEnvironmentId)?.environmentId ??
    machines[0]?.environmentId ??
    null;
  const connected = machines.some((machine) => machine.environmentId === environmentId);
  const machinePicker =
    machines.length === 0 ? (
      <p className="text-body text-muted-foreground">No connected computers</p>
    ) : (
      <Select
        value={environmentId ?? ""}
        onValueChange={(value) => setChosenEnvironmentId(value as EnvironmentId)}
        items={machines.map((machine) => ({ value: machine.environmentId, label: machine.label }))}
      >
        <SelectTrigger>
          <SelectValue placeholder="Disconnected" />
        </SelectTrigger>
        <SelectPopup>
          {machines.map((machine) => (
            <SelectItem key={machine.environmentId} value={machine.environmentId}>
              {machine.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    );
  return (
    <MachineBotForm
      {...props}
      // Each computer has its own providers, so its model choice starts fresh.
      key={environmentId ?? "none"}
      environmentId={connected ? environmentId : null}
      name={name}
      onNameChange={setName}
      avatar={avatar}
      onAvatarChange={setAvatar}
      machinePicker={machinePicker}
    />
  );
}

function MachineBotForm({
  layout,
  pending,
  onPendingChange,
  onCancel,
  onDone,
  environmentId,
  name,
  onNameChange,
  avatar,
  onAvatarChange,
  machinePicker,
}: FormProps & {
  environmentId: EnvironmentId | null;
  name: string;
  onNameChange: (name: string) => void;
  avatar: AvatarChoice;
  onAvatarChange: (avatar: AvatarChoice) => void;
  machinePicker: ReactNode;
}) {
  const id = useId();
  const navigate = useNavigate();
  const setSidebarMode = useAtomSet(sidebarModeAtom);
  const createBot = useOrchestrationCommand(serverEnvironment.createBot, { reportFailure: false });
  const settings = useEnvironmentSettings(environmentId ?? NO_ENVIRONMENT);
  const providersByEnvironment = useEnvironmentProviders();
  const providers =
    (environmentId ? providersByEnvironment.get(environmentId) : undefined) ??
    EMPTY_SERVER_PROVIDERS;
  const entries = providerInstanceEntriesFor(providers, settings, null);
  const [chosenModel, setChosenModel] = useState<ModelSelection | null>(null);
  const model =
    chosenModel &&
    entries.some((entry) => entry.instanceId === chosenModel.instanceId && entry.enabled)
      ? chosenModel
      : defaultBotModel(settings, entries);
  const activeEntry = entries.find((entry) => entry.instanceId === model?.instanceId);
  const traits: TraitsSelectionInput | null =
    model && activeEntry
      ? {
          provider: activeEntry.driverKind,
          instanceId: model.instanceId,
          models: activeEntry.models,
          model: model.model,
          modelOptions: model.options ?? [],
          allowPromptInjectedEffort: false,
          onModelOptionsChange: (options) =>
            setChosenModel(createModelSelection(model.instanceId, model.model, options)),
        }
      : null;
  const effort = describeComposerEffort(traits, settings.effortDisplay, "sm");
  // One command id per attempt, so a retry after a lost reply returns the same bot.
  const [commandId, setCommandId] = useState(() => CommandId.make(randomUUID()));
  const trimmedName = name.trim();
  const canSubmit = !pending && environmentId !== null && model !== null && trimmedName.length > 0;

  const submit = async () => {
    if (!canSubmit) return;
    onPendingChange(true);
    const result = await createBot({
      environmentId,
      input: { commandId, name: trimmedName, avatar, modelSelection: model },
    });
    onPendingChange(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      // The server rejected this attempt for good; only a lost reply should reuse its id.
      if (isBotError(error)) setCommandId(CommandId.make(randomUUID()));
      toastManager.add({
        type: "error",
        title: "Could not create bot",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return;
    }
    setCommandId(CommandId.make(randomUUID()));
    setSidebarMode("bots");
    onDone();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({ environmentId, threadId: result.value.threadId }),
    });
  };

  const fields = (
    <fieldset disabled={pending} className="flex flex-col gap-5">
      <div className="flex justify-center">
        <span className="flex size-20 items-center justify-center rounded-full bg-muted">
          <BotAvatarShapeGlyph
            shape={avatar.shape}
            color={avatar.color}
            animateChanges
            className="size-14"
          />
        </span>
      </div>
      <BotAvatarPicker shape={avatar.shape} color={avatar.color} onChange={onAvatarChange} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          autoFocus
          maxLength={BOT_NAME_MAX_LENGTH}
          placeholder="Scout"
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Computer</Label>
        {machinePicker}
      </div>
      {environmentId !== null ? (
        <div className="flex flex-col gap-1.5">
          <Label>Model</Label>
          {model === null ? (
            <p className="text-body text-muted-foreground">No providers on this computer</p>
          ) : (
            <ProviderModelPicker
              environmentId={environmentId}
              disabled={pending}
              activeInstanceId={model.instanceId}
              model={model.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={getCustomModelOptionsByInstance(
                settings,
                providers,
                model.instanceId,
                model.model,
              )}
              isComposerOwned={false}
              triggerVariant="settings"
              triggerClassName="w-full max-w-none sm:max-w-none"
              popupAlign="start"
              triggerSuffix={effort.suffix}
              triggerDetail={effort.detail}
              effortColumn={
                hasComposerModelOptions(traits) ? (
                  <ComposerEffortColumn traits={traits} optionsOnly />
                ) : undefined
              }
              onInstanceModelChange={(instanceId, slug) =>
                setChosenModel(createModelSelection(instanceId, slug))
              }
            />
          )}
        </div>
      ) : null}
    </fieldset>
  );
  const actions = (
    <>
      {onCancel ? (
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      ) : null}
      <Button type="submit" disabled={!canSubmit}>
        {pending ? "Creating" : "Create"}
      </Button>
    </>
  );

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {layout === "dialog" ? (
        <>
          <DialogHeader>
            <DialogTitle>New bot</DialogTitle>
          </DialogHeader>
          <DialogPanel>{fields}</DialogPanel>
          <DialogFooter>{actions}</DialogFooter>
        </>
      ) : (
        <div className="flex flex-col gap-6 p-6">
          <h1 className="text-title">Create your first bot</h1>
          {fields}
          <div className="flex justify-end gap-2">{actions}</div>
        </div>
      )}
    </form>
  );
}
