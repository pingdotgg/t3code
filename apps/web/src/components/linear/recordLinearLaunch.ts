import type { RecordLinearLaunchInput } from "@t3tools/client-runtime/linear/launch-plan";
import { recordLinearLaunch as recordLaunch } from "@t3tools/client-runtime/linear/record-launch";

import { configuredHostedAppUrl } from "../../hostedPairing";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readPrimaryEnvironmentId } from "../../state/environments";
import { linearEnvironment } from "../../state/linear";
import { toastManager } from "../ui/toast";

/** Web adapter: warns with a toast and never blocks the launch it records. */
export async function recordLinearLaunch(input: RecordLinearLaunchInput): Promise<void> {
  // Chats from other machines are not recorded; pipeline runs carry the machine that records them.
  if (input.target.kind !== "pipeline_run" && readPrimaryEnvironmentId() !== input.environmentId) {
    return;
  }
  const warning = await recordLaunch(
    {
      registry: appAtomRegistry,
      recordLaunch: linearEnvironment.recordLaunch,
      // The desktop app's custom scheme can't be opened from Linear.
      threadOrigin: /^https?:$/u.test(window.location.protocol)
        ? window.location.origin
        : configuredHostedAppUrl(),
    },
    input,
  );
  if (warning !== null) {
    toastManager.add({
      type: "warning",
      title: `Could not update ${input.identifier} in Linear`,
      description: warning,
    });
  }
}
