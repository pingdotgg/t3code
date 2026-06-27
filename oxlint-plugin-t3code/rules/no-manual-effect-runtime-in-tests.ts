import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const EFFECT_RUNTIME_METHODS = new Set([
  "runCallback",
  "runCallbackWith",
  "runFork",
  "runForkWith",
  "runPromise",
  "runPromiseExit",
  "runPromiseExitWith",
  "runPromiseWith",
  "runSync",
  "runSyncExit",
  "runSyncExitWith",
  "runSyncWith",
]);

// Existing manual runners are tracked as debt. The rule permits no net-new
// occurrences in these files, while unlisted test files must have zero.
const LEGACY_BASELINE = new Map<string, number>([
  ["apps/mobile/src/features/agent-awareness/liveActivityPreferences.test.ts", 1],
  ["apps/mobile/src/features/agent-awareness/remoteRegistration.test.ts", 2],
  ["apps/mobile/src/state/use-remote-environment-registry.test.ts", 2],
  ["apps/server/src/orchestration/commandInvariants.test.ts", 6],
  ["apps/server/src/orchestration/Layers/CheckpointReactor.test.ts", 42],
  ["apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts", 5],
  ["apps/server/src/orchestration/Layers/OrchestrationReactor.test.ts", 4],
  ["apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts", 70],
  ["apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts", 31],
  ["apps/server/src/orchestration/Layers/ThreadDeletionReactor.test.ts", 2],
  ["apps/server/src/orchestration/projector.test.ts", 20],
  ["apps/server/src/project/Layers/ProjectSetupScriptRunner.test.ts", 4],
  ["apps/server/src/provider/acp/CursorAcpSupport.test.ts", 1],
  ["apps/server/src/provider/Layers/ClaudeAdapter.test.ts", 2],
  ["apps/server/src/provider/Layers/CodexAdapter.test.ts", 1],
  ["apps/server/src/provider/Layers/CodexSessionRuntime.test.ts", 5],
  ["apps/server/src/provider/Layers/CursorAdapter.test.ts", 1],
  ["apps/server/src/provider/Layers/CursorProvider.test.ts", 4],
  ["apps/server/src/provider/ProviderService.test.ts", 2],
  ["apps/server/src/provider/ProviderSessionReaper.test.ts", 21],
  ["apps/server/src/relay/AgentAwarenessRelay.test.ts", 4],
  ["apps/server/src/server.test.ts", 1],
  ["apps/web/src/cloud/dpop.test.ts", 2],
  ["apps/web/src/environments/runtime/service.addSavedEnvironment.test.ts", 1],
  ["oxlint-plugin-t3code/rules/no-manual-effect-runtime-in-tests.test.ts", 7],
  ["packages/client-runtime/src/relay/managedRelayState.test.ts", 1],
  ["packages/client-runtime/src/wsTransport.test.ts", 2],
]);

const baselineFor = (filename: string): number => {
  const normalized = filename.replaceAll("\\", "/");
  for (const [suffix, count] of LEGACY_BASELINE) {
    if (normalized.endsWith(suffix)) return count;
  }
  return 0;
};

const manualRunnerName = (callee: unknown): Option.Option<string> => {
  const expression = unwrapExpression(callee);
  if (Option.isNone(expression) || expression.value.type !== "MemberExpression") {
    return Option.none();
  }

  const object = unwrapExpression(expression.value.object);
  const property = getPropertyName(expression.value.property);
  if (Option.isNone(property)) return Option.none();

  if (isIdentifier(object, "Effect") && EFFECT_RUNTIME_METHODS.has(property.value)) {
    return Option.some(`Effect.${property.value}`);
  }

  if (isIdentifier(object, "ManagedRuntime") && property.value === "make") {
    return Option.some("ManagedRuntime.make");
  }

  return Option.none();
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow manually creating or running Effect runtimes in tests; use @effect/vitest.",
    },
  },
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {};

    const allowedCount = baselineFor(context.filename);
    let occurrenceCount = 0;

    return {
      CallExpression(node) {
        const runner = manualRunnerName(node.callee);
        if (Option.isNone(runner)) return;

        occurrenceCount++;
        if (occurrenceCount <= allowedCount) return;

        context.report({
          node: node.callee,
          message: `Do not use ${runner.value} in tests. Use @effect/vitest with it.effect(...) and test layers instead.`,
        });
      },
    };
  },
});
