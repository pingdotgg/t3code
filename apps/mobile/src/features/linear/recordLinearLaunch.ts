import type { RecordLinearLaunchInput } from "@t3tools/client-runtime/linear/launch-plan";
import { recordLinearLaunch as recordLaunch } from "@t3tools/client-runtime/linear/record-launch";
import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";

import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { linearEnvironment } from "../../state/linear";

/**
 * Mobile adapter: the app has no web origin of its own, so Linear links to the hosted web app,
 * which opens `/<environmentId>/<threadId>`. Never blocks the launch it records; a failure to
 * link or write back is surfaced as a notice afterwards.
 */
export async function recordLinearLaunch(input: RecordLinearLaunchInput): Promise<void> {
  const warning = await recordLaunch(
    {
      registry: appAtomRegistry,
      recordLaunch: linearEnvironment.recordLaunch,
      threadOrigin: DEFAULT_HOSTED_APP_URL,
    },
    input,
  );
  if (warning !== null) {
    Dialog.alert(`Could not update ${input.identifier} in Linear`, warning);
  }
}
