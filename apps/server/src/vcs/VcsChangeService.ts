import { VcsWorkflowError, type VcsNamedRef, type VcsRevision } from "@t3tools/contracts";
import {
  JJ_BOOKMARK_JSON_TEMPLATE,
  JJ_CHANGED_FILE_JSON_TEMPLATE,
  JJ_REVISION_JSON_TEMPLATE,
  classifyJjCommandFailure,
  isJjBookmarkRecord,
  isJjChangedFileRecord,
  isJjRevisionRecord,
  parseJjJsonLines,
  quoteJjRootFileFileset,
  quoteJjSymbol,
  type JjChangedFileRecord,
  type JjRevisionRecord,
} from "@t3tools/shared/jjCli";
import { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as VcsDriver from "./VcsDriver.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

const CHANGE_METADATA_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const CHANGE_PATCH_MAX_OUTPUT_BYTES = 120_000;
const FINALIZE_TIMEOUT_MS = 10 * 60_000;
const MESSAGE_MAX_LENGTH = 10_000;

export interface VcsChangeMessageContext {
  readonly summary: string;
  readonly patch: string;
  readonly workspaceRevision: VcsRevision;
}

export interface VcsFinalizeChangeInput {
  readonly cwd: string;
  readonly message: string;
  readonly filePaths?: ReadonlyArray<string>;
  readonly createPublishRef?: string;
  readonly publishRef?: VcsNamedRef;
}

export type VcsFinalizeChangeResult =
  | { readonly status: "skipped_no_changes" }
  | {
      readonly status: "created";
      readonly finalizedRevision: VcsRevision;
      readonly workspaceRevision: VcsRevision;
      readonly publishRef?: VcsNamedRef;
    };

export class VcsChangeService extends Context.Service<
  VcsChangeService,
  {
    readonly detectKind: (cwd: string) => Effect.Effect<"git" | "jj" | "unknown", VcsWorkflowError>;
    readonly prepareMessageContext: (input: {
      readonly cwd: string;
      readonly filePaths?: ReadonlyArray<string>;
    }) => Effect.Effect<VcsChangeMessageContext | null, VcsWorkflowError>;
    readonly finalizeChange: (
      input: VcsFinalizeChangeInput,
    ) => Effect.Effect<VcsFinalizeChangeResult, VcsWorkflowError>;
  }
>()("t3/vcs/VcsChangeService") {}

function changeError(input: {
  readonly operation: string;
  readonly kind?: "git" | "jj" | "unknown";
  readonly detail: string;
  readonly recoverable?: boolean;
}): VcsWorkflowError {
  return new VcsWorkflowError({
    workflow: "change",
    operation: input.operation,
    kind: input.kind ?? "jj",
    detail: input.detail,
    recoverable: input.recoverable ?? false,
  });
}

function errorDetail(cause: unknown): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : String(cause);
}

function toRevision(record: JjRevisionRecord): VcsRevision {
  return { commitId: record.commitId, changeId: record.changeId };
}

const isVcsWorkflowError = Schema.is(VcsWorkflowError);

export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;

  const resolveJjDriver = Effect.fn("VcsChangeService.resolveJjDriver")(function* (cwd: string) {
    const handle = yield* registry.resolve({ cwd });
    if (handle.kind !== "jj") {
      return yield* changeError({
        operation: "resolve-driver",
        kind: handle.kind,
        detail: "Jujutsu change finalization requires a jj repository.",
      });
    }
    return handle.driver;
  });

  const readRevision = Effect.fn("VcsChangeService.readRevision")(function* (
    driver: VcsDriver.VcsDriver["Service"],
    cwd: string,
    revision: string,
  ) {
    const result = yield* driver.execute({
      operation: "VcsChangeService.readRevision",
      cwd,
      args: ["log", "--no-graph", "--revisions", revision, "--template", JJ_REVISION_JSON_TEMPLATE],
      timeoutMs: 10_000,
      maxOutputBytes: CHANGE_METADATA_MAX_OUTPUT_BYTES,
      appendTruncationMarker: false,
    });
    if (result.stdoutTruncated) {
      return yield* changeError({
        operation: "read-revision",
        detail: "jj returned truncated revision metadata.",
      });
    }
    const records = yield* Effect.try({
      try: () => parseJjJsonLines(result.stdout),
      catch: (cause) =>
        changeError({
          operation: "read-revision",
          detail: `jj returned invalid revision metadata: ${errorDetail(cause)}`,
        }),
    });
    if (records.length !== 1 || !isJjRevisionRecord(records[0])) {
      return yield* changeError({
        operation: "read-revision",
        detail: "jj returned invalid revision metadata.",
      });
    }
    return records[0];
  });

  const readChangedFiles = Effect.fn("VcsChangeService.readChangedFiles")(function* (
    driver: VcsDriver.VcsDriver["Service"],
    cwd: string,
  ) {
    const result = yield* driver.execute({
      operation: "VcsChangeService.readChangedFiles",
      cwd,
      args: ["log", "--no-graph", "--revisions", "@", "--template", JJ_CHANGED_FILE_JSON_TEMPLATE],
      timeoutMs: 10_000,
      maxOutputBytes: CHANGE_METADATA_MAX_OUTPUT_BYTES,
      appendTruncationMarker: false,
    });
    if (result.stdoutTruncated) {
      return yield* changeError({
        operation: "read-changed-files",
        detail: "jj returned truncated changed-file metadata.",
      });
    }
    const records = yield* Effect.try({
      try: () => parseJjJsonLines(result.stdout),
      catch: (cause) =>
        changeError({
          operation: "read-changed-files",
          detail: `jj returned invalid changed-file metadata: ${errorDetail(cause)}`,
        }),
    });
    if (!records.every(isJjChangedFileRecord)) {
      return yield* changeError({
        operation: "read-changed-files",
        detail: "jj returned invalid changed-file metadata.",
      });
    }
    return records as ReadonlyArray<JjChangedFileRecord>;
  });

  const resolveAvailablePublishRef = Effect.fn("VcsChangeService.resolveAvailablePublishRef")(
    function* (driver: VcsDriver.VcsDriver["Service"], cwd: string, preferredName: string) {
      const result = yield* driver.execute({
        operation: "VcsChangeService.readBookmarks",
        cwd,
        args: ["bookmark", "list", "--template", JJ_BOOKMARK_JSON_TEMPLATE],
        timeoutMs: 10_000,
        maxOutputBytes: CHANGE_METADATA_MAX_OUTPUT_BYTES,
        appendTruncationMarker: false,
      });
      if (result.stdoutTruncated) {
        return yield* changeError({
          operation: "read-bookmarks",
          detail: "jj returned truncated bookmark metadata.",
        });
      }
      const records = yield* Effect.try({
        try: () => parseJjJsonLines(result.stdout),
        catch: (cause) =>
          changeError({
            operation: "read-bookmarks",
            detail: `jj returned invalid bookmark metadata: ${errorDetail(cause)}`,
          }),
      });
      if (!records.every(isJjBookmarkRecord)) {
        return yield* changeError({
          operation: "read-bookmarks",
          detail: "jj returned invalid bookmark metadata.",
        });
      }
      const localNames = records.flatMap((record) =>
        isJjBookmarkRecord(record) && record.remote === undefined ? [record.name] : [],
      );
      return resolveAutoFeatureBranchName(localNames, preferredName);
    },
  );

  const resolveSelection = Effect.fn("VcsChangeService.resolveSelection")(function* (
    changedFiles: ReadonlyArray<JjChangedFileRecord>,
    filePaths?: ReadonlyArray<string>,
  ) {
    if (filePaths === undefined) {
      return { files: changedFiles, filesets: [] as ReadonlyArray<string> };
    }
    const uniquePaths = [...new Set(filePaths)];
    if (uniquePaths.length === 0) {
      return yield* changeError({
        operation: "validate-selection",
        detail: "Select at least one changed file to finalize.",
      });
    }
    const changedByPath = new Map(changedFiles.map((file) => [file.path, file]));
    const selected = uniquePaths.flatMap((filePath) => {
      const file = changedByPath.get(filePath);
      return file ? [file] : [];
    });
    if (selected.length !== uniquePaths.length) {
      const missing = uniquePaths.filter((filePath) => !changedByPath.has(filePath));
      return yield* changeError({
        operation: "validate-selection",
        detail: `Selected paths are not changed in the current jj change: ${missing.join(", ")}`,
      });
    }
    const filesets = yield* Effect.try({
      try: () => uniquePaths.map(quoteJjRootFileFileset),
      catch: (cause) =>
        changeError({
          operation: "validate-selection",
          detail: errorDetail(cause),
        }),
    });
    return { files: selected, filesets };
  });

  const snapshotAndSelect = Effect.fn("VcsChangeService.snapshotAndSelect")(function* (input: {
    readonly driver: VcsDriver.VcsDriver["Service"];
    readonly cwd: string;
    readonly filePaths?: ReadonlyArray<string>;
  }) {
    yield* input.driver.execute({
      operation: "VcsChangeService.snapshot",
      cwd: input.cwd,
      args: ["util", "snapshot"],
      timeoutMs: 20_000,
      maxOutputBytes: 256 * 1024,
    });
    const revision = yield* readRevision(input.driver, input.cwd, "@");
    if (revision.empty) {
      return null;
    }
    const changedFiles = yield* readChangedFiles(input.driver, input.cwd);
    const selection = yield* resolveSelection(changedFiles, input.filePaths);
    return { revision, selection };
  });

  const detectKind: VcsChangeService["Service"]["detectKind"] = Effect.fn(
    "VcsChangeService.detectKind",
  )(
    function* (cwd) {
      const handle = yield* registry.resolve({ cwd });
      return handle.kind;
    },
    Effect.mapError((cause) =>
      changeError({
        operation: "detect-kind",
        kind: "unknown",
        detail: errorDetail(cause),
        recoverable: true,
      }),
    ),
  );

  const prepareMessageContext: VcsChangeService["Service"]["prepareMessageContext"] = Effect.fn(
    "VcsChangeService.prepareMessageContext",
  )(
    function* (input) {
      yield* Effect.annotateCurrentSpan({
        "vcs.kind": "jj",
        "vcs.workflow": "change",
        "vcs.operation": "prepare-message-context",
      });
      const driver = yield* resolveJjDriver(input.cwd);
      const selected = yield* snapshotAndSelect({
        driver,
        cwd: input.cwd,
        ...(input.filePaths ? { filePaths: input.filePaths } : {}),
      });
      if (!selected) {
        return null;
      }
      const patchResult = yield* driver.execute({
        operation: "VcsChangeService.prepareMessageContext.patch",
        cwd: input.cwd,
        args: ["diff", "--git", "--revision", "@", ...selected.selection.filesets],
        timeoutMs: 30_000,
        maxOutputBytes: CHANGE_PATCH_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      });
      const summary = selected.selection.files
        .map((file) => `${file.status}\t${file.path}`)
        .join("\n");
      if (summary.length === 0 || patchResult.stdout.trim().length === 0) {
        return null;
      }
      return {
        summary,
        patch: patchResult.stdout,
        workspaceRevision: toRevision(selected.revision),
      };
    },
    Effect.mapError((cause) =>
      isVcsWorkflowError(cause)
        ? cause
        : changeError({
            operation: "prepare-message-context",
            detail: errorDetail(cause),
            recoverable: true,
          }),
    ),
  );

  const finalizeChange: VcsChangeService["Service"]["finalizeChange"] = Effect.fn(
    "VcsChangeService.finalizeChange",
  )(
    function* (input) {
      yield* Effect.annotateCurrentSpan({
        "vcs.kind": "jj",
        "vcs.workflow": "change",
        "vcs.operation": "finalize",
      });
      const message = input.message.trim();
      if (message.length === 0) {
        return yield* changeError({
          operation: "finalize-change",
          detail: "Change message cannot be empty.",
        });
      }
      if (message.length > MESSAGE_MAX_LENGTH) {
        return yield* changeError({
          operation: "finalize-change",
          detail: `Change message cannot exceed ${MESSAGE_MAX_LENGTH} characters.`,
        });
      }
      if (input.createPublishRef !== undefined && input.publishRef !== undefined) {
        return yield* changeError({
          operation: "update-publish-ref",
          detail: "Create and update publish bookmark requests are mutually exclusive.",
        });
      }
      if (input.publishRef !== undefined && input.publishRef.kind !== "bookmark") {
        return yield* changeError({
          operation: "update-publish-ref",
          detail: "Jujutsu publishing requires a bookmark.",
        });
      }

      const driver = yield* resolveJjDriver(input.cwd);
      const selected = yield* snapshotAndSelect({
        driver,
        cwd: input.cwd,
        ...(input.filePaths ? { filePaths: input.filePaths } : {}),
      });
      if (!selected) {
        return { status: "skipped_no_changes" as const };
      }

      yield* driver.execute({
        operation: "VcsChangeService.finalizeChange",
        cwd: input.cwd,
        args: ["commit", "--message", message, ...selected.selection.filesets],
        timeoutMs: FINALIZE_TIMEOUT_MS,
        maxOutputBytes: 1_000_000,
      });

      const [finalized, workspace] = yield* Effect.all([
        readRevision(driver, input.cwd, "@-"),
        readRevision(driver, input.cwd, "@"),
      ]);
      if (finalized.empty) {
        return yield* changeError({
          operation: "finalize-change",
          detail: "jj finalized an empty change instead of the selected changes.",
        });
      }

      let publishRef: VcsNamedRef | undefined;
      if (input.publishRef !== undefined) {
        const bookmarkResult = yield* driver.execute({
          operation: "VcsChangeService.updatePublishRef",
          cwd: input.cwd,
          args: [
            "bookmark",
            "set",
            input.publishRef.name,
            "--revision",
            quoteJjSymbol(finalized.commitId),
          ],
          timeoutMs: 20_000,
          maxOutputBytes: 256 * 1024,
        });
        if (
          classifyJjCommandFailure({
            exitCode: bookmarkResult.exitCode,
            stderr: bookmarkResult.stderr,
          }) === "invalid-ref"
        ) {
          return yield* changeError({
            operation: "update-publish-ref",
            detail: "The bookmark cannot be exported as a Git ref.",
          });
        }
        publishRef = {
          kind: "bookmark",
          name: input.publishRef.name,
          target: toRevision(finalized),
        };
      } else if (input.createPublishRef !== undefined) {
        const preferredPublishName = input.createPublishRef.trim();
        if (preferredPublishName.length === 0 || preferredPublishName.includes("\0")) {
          return yield* changeError({
            operation: "create-publish-ref",
            detail: "Publish bookmark name cannot be empty or contain NUL bytes.",
          });
        }
        const publishName = yield* resolveAvailablePublishRef(
          driver,
          input.cwd,
          preferredPublishName,
        );
        const bookmarkResult = yield* driver.execute({
          operation: "VcsChangeService.createPublishRef",
          cwd: input.cwd,
          args: [
            "bookmark",
            "create",
            publishName,
            "--revision",
            quoteJjSymbol(finalized.commitId),
          ],
          timeoutMs: 20_000,
          maxOutputBytes: 256 * 1024,
        });
        if (
          classifyJjCommandFailure({
            exitCode: bookmarkResult.exitCode,
            stderr: bookmarkResult.stderr,
          }) === "invalid-ref"
        ) {
          return yield* changeError({
            operation: "create-publish-ref",
            detail: "The bookmark cannot be exported as a Git ref.",
          });
        }
        publishRef = {
          kind: "bookmark",
          name: publishName,
          target: toRevision(finalized),
        };
      }

      return {
        status: "created" as const,
        finalizedRevision: toRevision(finalized),
        workspaceRevision: toRevision(workspace),
        ...(publishRef ? { publishRef } : {}),
      };
    },
    Effect.mapError((cause) =>
      isVcsWorkflowError(cause)
        ? cause
        : changeError({
            operation: "finalize-change",
            detail: errorDetail(cause),
            recoverable: true,
          }),
    ),
  );

  return VcsChangeService.of({ detectKind, prepareMessageContext, finalizeChange });
});

export const layer = Layer.effect(VcsChangeService, make);
