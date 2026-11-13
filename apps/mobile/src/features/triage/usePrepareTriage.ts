import type { EnvironmentId } from "@t3tools/contracts";
import Constants from "expo-constants";

import { authClientMetadata } from "../../lib/authClientMetadata";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Asks a machine to prepare a triage session. The result carries the prompt
 * that links its playbook; the caller reports a failure.
 */
export function usePrepareTriage() {
  const prepare = useAtomCommand(serverEnvironment.prepareTriage, { reportFailure: false });
  return (environmentId: EnvironmentId) =>
    prepare({
      environmentId,
      input: { client: authClientMetadata(Constants.expoConfig?.version) },
    });
}
