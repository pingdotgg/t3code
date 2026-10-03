// @effect-diagnostics nodeBuiltinImport:off
/**
 * Read-only access to persisted workflow scripts for the Agents surface's
 * "{} script" affordance.
 *
 * Containment rules (lifted from the reviewed #3650 inspection service):
 * - the resolved realpath must live under the `projects` dir of a configured
 *   Claude instance (where the Claude harness persists workflow scripts) —
 *   realpath re-containment defeats symlink escapes, including a symlinked
 *   leaf file;
 * - only .js leaf files are served;
 * - reads are size-capped rather than failed, with a truncation marker.
 *
 * The client-supplied path is a hint from the workflow's runHandles; it is
 * never trusted beyond these checks.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { ClaudeSettings, OrchestrationGetWorkflowScriptError } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";

const SCRIPT_BYTE_CAP = 256 * 1024;
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

// Each Claude instance can set its own home or CLAUDE_CONFIG_DIR, and a
// thread's workflow may come from any of them (subagents included).
const claudeProjectsRoots = Effect.fn("orchestration.claudeProjectsRoots")(function* () {
  const settings = yield* ServerSettings.ServerSettingsService.pipe(
    Effect.flatMap((service) => service.getSettings),
  );
  const hostEnvironment = yield* HostProcessEnvironment;
  const roots = new Set<string>();
  for (const instance of Object.values(deriveProviderInstanceConfigMap(settings))) {
    if (instance.driver !== "claudeAgent") continue;
    const config = decodeClaudeSettings(instance.config ?? {});
    if (Option.isNone(config)) continue;
    const home = yield* resolveClaudeHomePath(
      config.value,
      mergeProviderInstanceEnvironment(instance.environment, hostEnvironment),
    );
    roots.add(NodePath.join(home, "projects"));
  }
  return [...roots];
});

export const readWorkflowScript = Effect.fn("orchestration.readWorkflowScript")(function* (input: {
  readonly scriptPath: string;
}) {
  const requested = input.scriptPath;

  if (!NodePath.isAbsolute(requested) || NodePath.extname(requested) !== ".js") {
    return yield* new OrchestrationGetWorkflowScriptError({
      reason: "invalid-path",
      scriptPath: requested,
    });
  }

  const roots = yield* claudeProjectsRoots().pipe(
    Effect.flatMap((candidates) =>
      Effect.promise(() =>
        Promise.all(candidates.map((root) => NodeFSP.realpath(root).catch(() => null))),
      ),
    ),
    Effect.map((resolvedRoots) => resolvedRoots.filter((root) => root !== null)),
    Effect.mapError(
      (cause) =>
        new OrchestrationGetWorkflowScriptError({
          reason: "root-unavailable",
          scriptPath: requested,
          cause,
        }),
    ),
  );
  if (roots.length === 0) {
    return yield* new OrchestrationGetWorkflowScriptError({
      reason: "root-unavailable",
      scriptPath: requested,
    });
  }

  // Realpath the FILE itself (not just its directory): a symlink named
  // like a script inside a contained directory must not escape.
  const resolved = yield* Effect.tryPromise({
    try: () => NodeFSP.realpath(requested),
    catch: (cause) =>
      new OrchestrationGetWorkflowScriptError({
        reason: "not-found",
        scriptPath: requested,
        cause,
      }),
  });

  if (!roots.some((root) => resolved === root || resolved.startsWith(`${root}${NodePath.sep}`))) {
    return yield* new OrchestrationGetWorkflowScriptError({
      reason: "outside-root",
      scriptPath: resolved,
    });
  }
  if (NodePath.extname(resolved) !== ".js") {
    return yield* new OrchestrationGetWorkflowScriptError({
      reason: "not-js",
      scriptPath: resolved,
    });
  }

  // TOCTOU-safe read (review finding): open FIRST, then verify what was
  // actually opened via the file descriptor. Re-checking the path after
  // open would race against a swap; fstat on the handle cannot. The two
  // containment checks fail with their own tagged reasons (not manufactured
  // Errors folded into read-failed); "read-failed" is reserved for genuine
  // platform failures with the real cause attached.
  const read = yield* Effect.tryPromise({
    try: async () => {
      const handle = await NodeFSP.open(resolved, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
          return { failure: "not-regular-file" as const };
        }
        // The opened inode must be the same one realpath resolved to: a
        // process swapping the path between realpath and open changes the
        // inode, which this comparison catches.
        const pathStat = await NodeFSP.lstat(resolved);
        if (stat.ino !== pathStat.ino || stat.dev !== pathStat.dev) {
          return { failure: "changed-during-read" as const };
        }
        const truncated = stat.size > SCRIPT_BYTE_CAP;
        const buffer = Buffer.alloc(Math.min(stat.size, SCRIPT_BYTE_CAP));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return {
          contents: buffer.subarray(0, bytesRead).toString("utf8"),
          truncated,
        };
      } finally {
        await handle.close();
      }
    },
    catch: (cause) =>
      new OrchestrationGetWorkflowScriptError({
        reason: "read-failed",
        scriptPath: resolved,
        cause,
      }),
  });
  if ("failure" in read) {
    return yield* new OrchestrationGetWorkflowScriptError({
      reason: read.failure,
      scriptPath: resolved,
    });
  }

  return {
    scriptPath: resolved,
    contents: read.contents,
    truncated: read.truncated,
  };
});
