import {
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderUsageAccess,
  withProviderUsageAccess,
} from "@t3tools/contracts";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { UsageAccessReads } from "./UsageAccessReads";

export interface UsageAccessPrompt {
  readonly environmentId: EnvironmentId;
  /** Shown only when the prompt spans environments. */
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly paths: readonly string[];
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
    setSaving(true);
    const results = await Promise.all(
      prompts.map((prompt) => {
        const access: ProviderUsageAccess =
          allowSelected && !declined.has(promptKey(prompt)) ? "allowed" : "denied";
        const config = appAtomRegistry.get(serverEnvironment.configValueAtom(prompt.environmentId));
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
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const environments = [...new Set(prompts.map((prompt) => prompt.environmentId))];
  return (
    <div className="flex flex-col gap-4">
      {environments.map((environmentId) => {
        const group = prompts.filter((prompt) => prompt.environmentId === environmentId);
        return (
          <section key={environmentId} className="flex flex-col gap-3">
            {environments.length > 1 ? (
              <h3 className="text-xs font-medium text-muted-foreground">
                {group[0]?.environmentLabel}
              </h3>
            ) : null}
            <ul className="flex flex-col gap-3">
              {group.map((prompt) => {
                const key = promptKey(prompt);
                const snapshot = presentations
                  .get(prompt.environmentId)
                  ?.serverConfig?.providers.find(
                    (provider) => provider.instanceId === prompt.instanceId,
                  );
                const label = resolveProviderInstanceDisplayName(
                  snapshot ?? { instanceId: prompt.instanceId, driver: prompt.driver },
                );
                const checkboxId = `usage-access-${key}`;
                return (
                  <li key={key} className="flex items-start gap-3">
                    <Checkbox
                      id={checkboxId}
                      aria-label={label}
                      className="mt-0.5"
                      checked={!declined.has(key)}
                      disabled={disabled}
                      onCheckedChange={(checked) => onToggle(prompt, Boolean(checked))}
                    />
                    <label htmlFor={checkboxId} className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <ProviderInstanceIcon
                          driverKind={prompt.driver}
                          displayName={label}
                          accentColor={snapshot?.accentColor}
                          size="compact"
                        />
                        {label}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        <UsageAccessReads driver={prompt.driver} paths={prompt.paths} />
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function UsageAccessIntro() {
  return (
    <T>
      T3 Code can chart tokens, cost, and limits from what your agents keep on the computer they run
      on. Choose which agents to include.
    </T>
  );
}

function UsageAccessFooterNote() {
  return <T>You can change this for each agent in Settings → Providers.</T>;
}

/** Covers the Usage page until every listed agent has an answer; answering is the only way past it. */
export function UsageAccessOverlay({
  prompts,
}: {
  readonly prompts: readonly UsageAccessPrompt[];
}) {
  const choices = useUsageAccessChoices(prompts, () => {});
  return (
    <div className="absolute inset-0 z-10 flex justify-center overflow-y-auto scrollbar-gutter-both bg-linear-to-b from-background/40 via-background/95 via-30% to-background px-4 pt-24 pb-8">
      <section
        role="region"
        aria-labelledby="usage-access-title"
        className="flex w-full max-w-md flex-col gap-6"
      >
        <div className="flex flex-col gap-2 text-center">
          <h2 id="usage-access-title" className="text-xl font-semibold">
            <T>Show usage from your agents?</T>
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
        <div className="flex flex-col items-center gap-3">
          <div className="flex gap-2">
            <Button
              variant="ghost"
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
          </div>
          <p className="text-xs text-muted-foreground">
            <UsageAccessFooterNote />
          </p>
        </div>
      </section>
    </div>
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
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            <T>Show usage from your agents?</T>
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
          <p className="mt-4 text-xs text-muted-foreground">
            <UsageAccessFooterNote />
          </p>
        </DialogPanel>
        <DialogFooter>
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
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
