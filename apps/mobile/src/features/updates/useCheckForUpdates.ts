import { AuthProvidersManageScope } from "@t3tools/contracts";
import {
  checkEnvironmentUpdates,
  summarizeUpdateCheck,
} from "@t3tools/client-runtime/update-check";

import * as Dialog from "../../components/ui/Dialog";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

/** Checks every connected environment's own server and its providers, and shows each result. */
export function useCheckForUpdates() {
  const { environments } = useEnvironments();
  const manageableIds = useEnvironmentsWithScope(environments, AuthProvidersManageScope);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const lookupNpmRelease = useAtomCommand(serverEnvironment.lookupNpmRelease, {
    reportFailure: false,
  });

  return async () => {
    const items = await checkEnvironmentUpdates(
      environments.map((environment) => ({
        ...environment,
        hostedByThisApp: false,
        canManageProviders: manageableIds.has(environment.environmentId),
      })),
      { lookupNpmRelease, refreshProviders },
    );
    const summary = summarizeUpdateCheck(items);
    Dialog.alert(summary.title, summary.lines.join("\n"));
  };
}
