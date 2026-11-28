import {
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderUsageAccess,
  withProviderUsageAccess,
} from "@t3tools/contracts";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { usageAccessReadsLabel } from "@t3tools/client-runtime/state/usage-access";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { SettingsGroup } from "../settings/SettingsGroup";
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
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";

export interface UsageAccessPrompt {
  readonly environmentId: EnvironmentId;
  /** Shown only when the prompt spans environments. */
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
}

const promptKey = (prompt: UsageAccessPrompt) => `${prompt.environmentId}\0${prompt.instanceId}`;

/** Each environment keeps its own answer per agent; one choice here saves to every listed environment. */
function useUsageAccessChoices(prompts: readonly UsageAccessPrompt[], onAnswered: () => void) {
  const gt = useGT();
  const mutateProviderInstance = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
  });
  const [declined, setDeclined] = useState<ReadonlySet<string>>(() => new Set());
  const [saving, setSaving] = useState(false);

  const toggle = (prompt: UsageAccessPrompt, checked: boolean) =>
    setDeclined((current) => {
      const next = new Set(current);
      if (checked) next.delete(promptKey(prompt));
      else next.add(promptKey(prompt));
      return next;
    });

  const answer = async (allowSelected: boolean) => {
    const configs = prompts.map((prompt) =>
      appAtomRegistry.get(serverEnvironment.configValueAtom(prompt.environmentId)),
    );
    // A save rewrites the instance from its saved settings, so it waits until they have loaded.
    if (configs.some((config) => config === null)) {
      toastManager.add({ type: "error", title: gt("Could not save usage access") });
      return;
    }
    setSaving(true);
    const results = await Promise.all(
      prompts.map((prompt, index) => {
        const access: ProviderUsageAccess =
          allowSelected && !declined.has(promptKey(prompt)) ? "allowed" : "denied";
        const config = configs[index];
        return mutateProviderInstance({
          environmentId: prompt.environmentId,
          input: {
            patch: {},
            providerInstanceMutation: {
              operation: "upsert",
              instanceId: prompt.instanceId,
              instance: withProviderUsageAccess(
                config?.settings.providerInstances[prompt.instanceId],
                prompt.driver,
                access,
              ),
            },
          },
        });
      }),
    );
    setSaving(false);
    const failure = results.find(
      (result) => result._tag === "Failure" && !isAtomCommandInterrupted(result),
    );
    if (failure !== undefined && failure._tag === "Failure") {
      const cause = squashAtomCommandFailure(failure);
      toastManager.add({
        type: "error",
        title: gt("Could not save usage access"),
        ...(cause instanceof Error ? { description: cause.message } : {}),
      });
      return;
    }
    onAnswered();
  };

  return {
    declined,
    toggle,
    saving,
    answer,
    noneSelected: prompts.every((prompt) => declined.has(promptKey(prompt))),
  };
}

type UsageAccessChoices = ReturnType<typeof useUsageAccessChoices>;

function usePromptLabels(prompts: readonly UsageAccessPrompt[]) {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  return prompts.map((prompt) => {
    const snapshot = presentations
      .get(prompt.environmentId)
      ?.serverConfig?.providers.find((provider) => provider.instanceId === prompt.instanceId);
    return {
      prompt,
      key: promptKey(prompt),
      accentColor: snapshot?.accentColor,
      label: resolveProviderInstanceDisplayName(
        snapshot ?? { instanceId: prompt.instanceId, driver: prompt.driver },
      ),
    };
  });
}

function UsageAccessRows({
  prompts,
  declined,
  disabled,
  onToggle,
}: {
  readonly prompts: readonly UsageAccessPrompt[];
  readonly declined: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly onToggle: (prompt: UsageAccessPrompt, checked: boolean) => void;
}) {
  const m = useMessages();
  const agents = usePromptLabels(prompts);
  const environments = [...new Set(prompts.map((prompt) => prompt.environmentId))];
  return (
    <div className="flex flex-col gap-4">
      {environments.map((environmentId) => {
        const group = agents.filter((agent) => agent.prompt.environmentId === environmentId);
        return (
          <section key={environmentId} className="flex flex-col gap-2">
            {environments.length > 1 ? (
              <h3 className="px-1 text-xs font-medium text-muted-foreground">
                {group[0]?.prompt.environmentLabel}
              </h3>
            ) : null}
            <SettingsGroup>
              {group.map(({ prompt, key, label, accentColor }) => (
                <div key={key} className="flex items-center gap-3 px-3.5 py-3">
                  <ProviderInstanceIcon
                    driverKind={prompt.driver}
                    displayName={label}
                    accentColor={accentColor}
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-sm font-medium">{label}</span>
                    <span className="text-xs text-muted-foreground">
                      {usageAccessReadsLabel(prompt.driver, m)}
                    </span>
                  </div>
                  <Switch
                    aria-label={label}
                    checked={!declined.has(key)}
                    disabled={disabled}
                    onCheckedChange={(checked) => onToggle(prompt, Boolean(checked))}
                  />
                </div>
              ))}
            </SettingsGroup>
          </section>
        );
      })}
    </div>
  );
}

function UsageAccessTitle() {
  return <T>Show agent usage?</T>;
}

function UsageAccessIntro() {
  return <T>T3 Code reads these from each agent, system-wide. Pick which agents to allow.</T>;
}

function UsageAccessActions({ choices }: { readonly choices: UsageAccessChoices }) {
  return (
    <>
      <Button
        variant="outline"
        disabled={choices.saving}
        onClick={() => void choices.answer(false)}
      >
        <T>Don't allow</T>
      </Button>
      <Button
        disabled={choices.saving || choices.noneSelected}
        onClick={() => void choices.answer(true)}
      >
        <T>Allow</T>
      </Button>
    </>
  );
}

/** The Usage page's own content until every listed agent has an answer. The rest of the app stays usable. */
export function UsageAccessQuestion({
  prompts,
}: {
  readonly prompts: readonly UsageAccessPrompt[];
}) {
  const choices = useUsageAccessChoices(prompts, () => {});
  return (
    <section
      aria-labelledby="usage-access-title"
      className="mx-auto flex min-h-[min(34rem,70vh)] w-full max-w-sm flex-col justify-center gap-5"
    >
      <div className="flex flex-col gap-1">
        <h2 id="usage-access-title" className="text-xl leading-snug font-semibold">
          <UsageAccessTitle />
        </h2>
        <p className="text-sm text-muted-foreground">
          <UsageAccessIntro />
        </p>
      </div>
      <UsageAccessRows
        prompts={prompts}
        declined={choices.declined}
        disabled={choices.saving}
        onToggle={choices.toggle}
      />
      <div className="flex justify-end gap-2">
        <UsageAccessActions choices={choices} />
      </div>
    </section>
  );
}

/** Asks for one agent from outside the Usage page. Closing without an answer asks again next time. */
export function UsageAccessDialog({
  prompts,
  onOpenChange,
}: {
  readonly prompts: readonly UsageAccessPrompt[];
  readonly onOpenChange: (open: boolean) => void;
}) {
  const choices = useUsageAccessChoices(prompts, () => onOpenChange(false));
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <UsageAccessTitle />
          </DialogTitle>
          <DialogDescription>
            <UsageAccessIntro />
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <UsageAccessRows
            prompts={prompts}
            declined={choices.declined}
            disabled={choices.saving}
            onToggle={choices.toggle}
          />
        </DialogPanel>
        <DialogFooter>
          <UsageAccessActions choices={choices} />
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
