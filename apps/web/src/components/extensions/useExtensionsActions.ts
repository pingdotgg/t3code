// Fork: Kaluwa's Extensions page. Runs changes, tracks which rows are busy, and reports outcomes.
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId, ExtensionsMutation, ExtensionsSubscription } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";
import { useGT } from "gt-react";
import { useContext, useState } from "react";

import { extensionsFastListAtom, extensionsMutate } from "../../state/extensions";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { mutationPendingKeys, mutationSubjectName } from "./extensionsModel";

const REFRESH_START_MS = 500;
const REFRESH_LIMIT_MS = 30_000;

/** Resolves once the list refetch a mutation started has landed. */
function listRefreshed(registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) {
  const atom = extensionsFastListAtom(environmentId);
  return new Promise<void>((resolve) => {
    let started = registry.get(atom).waiting;
    const finish = () => {
      clearTimeout(startTimer);
      clearTimeout(limitTimer);
      unsubscribe();
      resolve();
    };
    const unsubscribe = registry.subscribe(atom, (result) => {
      if (result.waiting) started = true;
      else if (started) finish();
    });
    // No refetch began (nobody is reading the list), so there is nothing to wait for.
    const startTimer = setTimeout(() => {
      if (!started) finish();
    }, REFRESH_START_MS);
    const limitTimer = setTimeout(finish, REFRESH_LIMIT_MS);
  });
}

export function useExtensionsActions(
  environmentId: EnvironmentId | null,
  subscriptions: readonly ExtensionsSubscription[],
) {
  const gt = useGT();
  const registry = useContext(RegistryContext);
  const mutate = useAtomCommand(extensionsMutate);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const doneTitle = (mutation: ExtensionsMutation) => {
    const name = mutationSubjectName(mutation) ?? "";
    switch (mutation._tag) {
      case "McpAdd":
        return gt("Added {name}", { name });
      case "McpCopy":
        return gt("Copied {name}", { name });
      case "McpRemove":
        return gt("Removed {name}", { name });
      case "McpSetEnabled":
      case "PluginSetEnabled":
        return mutation.enabled
          ? gt("Turned on {name}", { name })
          : gt("Turned off {name}", { name });
      case "McpSignIn":
        return gt("Signed in to {name}", { name });
      case "PluginInstall":
        return gt("Installed {name}", { name });
      case "PluginUninstall":
        return gt("Uninstalled {name}", { name });
      case "SkillLink":
        return gt("Linked {name}", { name });
      case "SkillUnlink":
        return gt("Unlinked {name}", { name });
      case "SkillMoveToLibrary":
        return gt("Moved {name} to the skill library", { name });
      case "SkillUseLibraryCopy":
        return gt("{name} now uses the library copy", { name });
      case "SkillRemoveBrokenLinks":
        return gt("Removed the broken skill links");
    }
  };

  const run = async (mutations: readonly ExtensionsMutation[]) => {
    if (environmentId === null || mutations.length === 0) return false;
    const keys = mutations.flatMap(mutationPendingKeys);
    setPending((current) => new Set([...current, ...keys]));
    const failures: string[] = [];
    let attempted = 0;
    for (const mutation of mutations) {
      const name = mutationSubjectName(mutation) ?? gt("Broken skill links");
      const result = await mutate({ environmentId, input: mutation });
      if (result._tag === "Success") {
        attempted += result.value.outcomes.length;
        for (const outcome of result.value.outcomes) {
          if (outcome.ok) continue;
          const subscription =
            subscriptions.find((entry) => entry.instanceId === outcome.instanceId)?.displayName ??
            outcome.instanceId;
          failures.push(
            gt("{name} on {subscription}: {message}", {
              name,
              subscription,
              message: outcome.message ?? gt("It did not work."),
            }),
          );
        }
      } else if (!isAtomCommandInterrupted(result)) {
        attempted += 1;
        const error = squashAtomCommandFailure(result);
        failures.push(
          gt("{name}: {message}", {
            name,
            message: error instanceof Error ? error.message : gt("The request failed."),
          }),
        );
      }
    }
    // The rows stay busy until the list shows the change, not just until the server answers.
    if (failures.length < attempted) await listRefreshed(registry, environmentId);
    setPending((current) => {
      const next = new Set(current);
      for (const key of keys) next.delete(key);
      return next;
    });
    if (failures.length > 0) {
      toastManager.add({
        type: "error",
        title:
          failures.length === attempted
            ? gt("{count, plural, one {The change failed} other {{count} changes failed}}", {
                count: failures.length,
              })
            : gt("{failed} of {total} changes failed", {
                failed: failures.length,
                total: attempted,
              }),
        description: failures.join("\n"),
      });
    } else if (attempted > 0) {
      toastManager.add({
        type: "success",
        title:
          mutations.length === 1
            ? doneTitle(mutations[0]!)
            : gt("{count} changes applied", { count: mutations.length }),
      });
    }
    return failures.length === 0;
  };

  return { pending, run };
}
