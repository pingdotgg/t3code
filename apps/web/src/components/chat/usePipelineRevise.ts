import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PipelineRun, PipelineRunReviseInput } from "@t3tools/contracts";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** Sends feedback to an earlier step; failures show as a toast and resolve to null. */
export function usePipelineRevise(environmentId: EnvironmentId) {
  const canRevise = useAtomValue(
    serverEnvironment.revisePipelineStep.permissionAtom(environmentId),
  );
  const command = useAtomCommand(serverEnvironment.revisePipelineStep, {
    label: "pipeline revise step",
    reportFailure: false,
  });
  const revise = async (input: PipelineRunReviseInput): Promise<PipelineRun | null> => {
    const result = await command({ environmentId, input });
    if (result._tag === "Success") return result.value.run;
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not send feedback",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return null;
  };
  return { canRevise, revise };
}
