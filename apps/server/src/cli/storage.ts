import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";

import { resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";
import {
  inspectStorage,
  quarantineStorageCandidate,
  restoreStorageReceipt,
} from "./storageCore.ts";

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Print machine-readable JSON."),
  Flag.optional,
);

const resolveStorageBaseDir = Effect.fn("storage.resolveBaseDir")(function* (
  explicitBaseDir: Option.Option<string>,
) {
  const environmentBaseDir = yield* Config.string("T3CODE_HOME").pipe(Config.option);
  return yield* resolveBaseDir(
    Option.getOrUndefined(explicitBaseDir) ?? Option.getOrUndefined(environmentBaseDir),
  );
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

const inspectCommand = Command.make("inspect", { baseDir: baseDirFlag, json: jsonFlag }).pipe(
  Command.withDescription(
    "Inspect T3 Code storage and list worktrees that are safe to quarantine.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const baseDir = yield* resolveStorageBaseDir(flags.baseDir);
      const result = yield* Effect.try(() => inspectStorage(baseDir));
      if (Option.getOrElse(flags.json, () => false)) {
        yield* Console.log(JSON.stringify(result, null, 2));
        return;
      }
      yield* Console.log("T3 Code storage");
      for (const area of result.areas) {
        yield* Console.log(
          `  ${area.kind}: ${formatBytes(area.bytes)} (${String(area.entries)} entries)`,
        );
      }
      yield* Console.log("\nWorktree candidates");
      if (result.candidates.length === 0) {
        yield* Console.log("  none");
      }
      for (const candidate of result.candidates) {
        const state = candidate.eligible ? "eligible" : candidate.reasons.join(", ");
        yield* Console.log(
          `  ${candidate.id}  ${formatBytes(candidate.bytes)}  ${state}\n    ${candidate.path}\n    snapshot ${candidate.snapshot}`,
        );
      }
    }),
  ),
);

const candidateFlag = Flag.string("candidate").pipe(
  Flag.withDescription("Stable candidate ID from `t3 storage inspect`."),
);
const snapshotFlag = Flag.string("snapshot").pipe(
  Flag.withDescription("Snapshot from the same inspection."),
);

const quarantineCommand = Command.make("quarantine", {
  baseDir: baseDirFlag,
  candidateId: candidateFlag,
  snapshot: snapshotFlag,
}).pipe(
  Command.withDescription("Move an unchanged, unreferenced worktree into recoverable quarantine."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const baseDir = yield* resolveStorageBaseDir(flags.baseDir);
      const result = yield* Effect.try(() =>
        quarantineStorageCandidate({
          baseDir,
          candidateId: flags.candidateId,
          snapshot: flags.snapshot,
        }),
      );
      yield* Console.log(
        `Quarantined ${result.receipt.originalPath}.\nReceipt: ${result.receiptPath}`,
      );
    }),
  ),
);

const receiptFlag = Flag.string("receipt").pipe(
  Flag.withDescription("Receipt ID returned by quarantine."),
);

const restoreCommand = Command.make("restore", {
  baseDir: baseDirFlag,
  receiptId: receiptFlag,
}).pipe(
  Command.withDescription("Restore a quarantined worktree using its receipt."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const baseDir = yield* resolveStorageBaseDir(flags.baseDir);
      const result = yield* Effect.try(() =>
        restoreStorageReceipt({
          baseDir,
          receiptId: flags.receiptId,
        }),
      );
      yield* Console.log(
        `Restored ${result.receipt.originalPath}.\nReceipt: ${result.receiptPath}`,
      );
    }),
  ),
);

export const storageCommand = Command.make("storage").pipe(
  Command.withDescription("Inspect and recoverably quarantine T3 Code storage."),
  Command.withSubcommands([inspectCommand, quarantineCommand, restoreCommand]),
);
