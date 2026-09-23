/**
 * Bridges T2/T5's typed per-tool executor (VoiceToolExecutor) behind T3's
 * VoiceLiveToolExecutor dispatch interface, and performs the actual UI
 * navigation for the open-thread tool.
 *
 * The open tool executes in two halves: the tool validates the thread and
 * produces the route destination (acknowledged: false, T2's contract), then
 * this bridge drives the attached router, reads the resulting route back
 * through the navigator, and flips `acknowledged` only on a verified
 * landing. Navigation failures travel in-band on the frozen output's
 * `environment` outcome so the model can report them; a superseded
 * navigation (a newer destination won) returns unacknowledged without an
 * error so the correction wins cleanly.
 *
 * The broker advertises tool names with a `voice.` prefix
 * (`apps/server/src/voice/broker.ts` `voiceToolName`); names are normalized
 * to the bare VoiceToolSchemas key before dispatch.
 */
import type { VoiceToolName } from "@t3tools/contracts";
import type { VoiceLiveToolExecutor } from "../live-client";
import type { VoiceNavigator } from "../navigation";
import type { VoiceToolExecutor } from "../tools";

export interface NavigatingVoiceToolExecutorDeps {
  readonly tools: VoiceToolExecutor;
  readonly navigator: Pick<VoiceNavigator, "navigateToThread">;
}

const normalizeToolName = (name: string): VoiceToolName =>
  (name.startsWith("voice.") ? name.slice("voice.".length) : name) as VoiceToolName;

export function createNavigatingVoiceToolExecutor(
  deps: NavigatingVoiceToolExecutorDeps,
): VoiceLiveToolExecutor {
  const { tools, navigator } = deps;
  return {
    async execute(name: string, input: unknown): Promise<unknown> {
      const tool = normalizeToolName(name);
      if (tool !== "openThread") {
        return dispatchPerTool(tools, tool, input);
      }
      const output = await tools.openThread(input as Parameters<typeof tools.openThread>[0]);
      const destination = output.destination;
      if (output.environment.status !== "ok" || destination === undefined) {
        // The tool already reported the failure in-band (thread_not_found,
        // disconnected environment, ...); nothing to navigate.
        return output;
      }
      const result = await navigator.navigateToThread(destination);
      if (result.status === "acknowledged") {
        return { ...output, acknowledged: true };
      }
      if (result.status === "superseded") {
        // A newer destination won; do not mask the correction with an error.
        return { ...output, acknowledged: false };
      }
      return {
        ...output,
        acknowledged: false,
        environment: {
          environmentId: output.environment.environmentId,
          status: "error",
          error: result.error,
        },
      };
    },
  };
}

function dispatchPerTool(
  tools: VoiceToolExecutor,
  name: VoiceToolName,
  input: unknown,
): Promise<unknown> {
  switch (name) {
    case "discoverEnvironments":
      return tools.discoverEnvironments();
    case "discoverProjects":
      return tools.discoverProjects(input as Parameters<typeof tools.discoverProjects>[0]);
    case "listModels":
      return tools.listModels(input as Parameters<typeof tools.listModels>[0]);
    case "searchThreads":
      return tools.searchThreads(input as Parameters<typeof tools.searchThreads>[0]);
    case "readThread":
      return tools.readThread(input as Parameters<typeof tools.readThread>[0]);
    case "readProject":
      return tools.readProject(input as Parameters<typeof tools.readProject>[0]);
    case "startThread":
      return tools.startThread(input as Parameters<typeof tools.startThread>[0]);
    case "continueThread":
      return tools.continueThread(input as Parameters<typeof tools.continueThread>[0]);
    case "openThread":
      // Reached only if a caller routes the open tool here directly; the
      // navigation-aware path above is the intended entry.
      return tools.openThread(input as Parameters<typeof tools.openThread>[0]);
    case "observeThread":
      return tools.observeThread(input as Parameters<typeof tools.observeThread>[0]);
    case "listControls":
      return tools.listControls(input as Parameters<typeof tools.listControls>[0]);
    case "clickControl":
      return tools.clickControl(input as Parameters<typeof tools.clickControl>[0]);
  }
}
