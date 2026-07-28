// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type {
  PreviewAutomationOperation,
  PreviewAutomationOpenInput,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationResizeResult,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewTabId,
} from "@t3tools/contracts";
import { PreviewAutomationScreenshotSaveError } from "@t3tools/contracts";

import * as ServerConfig from "../../../config.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { PreviewSnapshotToolkit, PreviewStandardToolkit, PreviewToolkit } from "./tools.ts";

export function normalizePreviewOpenInput(
  input: PreviewAutomationOpenInput,
): PreviewAutomationOpenInput {
  const open = input.open ?? input.show ?? true;
  return {
    ...input,
    open,
    show: open,
    reuseExistingTab: input.reuseExistingTab ?? true,
  };
}

const invoke = Effect.fn("PreviewToolkit.invoke")(function* <A>(
  operation: PreviewAutomationOperation,
  input: unknown,
  timeoutMs?: number,
  tabId?: PreviewTabId,
): Effect.fn.Return<
  A,
  import("@t3tools/contracts").PreviewAutomationError,
  McpInvocationContext.McpInvocationContext | PreviewAutomationBroker.PreviewAutomationBroker
> {
  const scope = yield* McpInvocationContext.requireMcpCapability("preview");
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  return yield* broker.invoke<A>({
    scope,
    operation,
    input,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(tabId === undefined ? {} : { tabId }),
  });
});

const invokeTargeted = <A>(
  operation: PreviewAutomationOperation,
  input: {
    readonly tabId?: PreviewTabId | undefined;
    readonly [key: string]: unknown;
  },
  timeoutMs?: number,
) => {
  const { tabId, ...operationInput } = input;
  return invoke<A>(operation, operationInput, timeoutMs, tabId);
};

const writeScreenshotFile = (input: {
  readonly absolutePath: string;
  readonly screenshotBase64: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const targetDirectory = path.dirname(input.absolutePath);
      yield* fileSystem.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.absolutePath)}.`,
      });
      const tempPath = path.join(tempDirectory, "screenshot.tmp");
      yield* fileSystem.writeFile(
        tempPath,
        new Uint8Array(Buffer.from(input.screenshotBase64, "base64")),
      );
      // Rename replaces an existing symlink itself instead of following it,
      // closing the check/write race around workspace save destinations.
      yield* fileSystem.rename(tempPath, input.absolutePath);
    }),
  );

const saveSnapshotScreenshotArtifact = Effect.fn("PreviewToolkit.saveSnapshotScreenshotArtifact")(
  function* (input: {
    readonly scope: McpInvocationContext.McpInvocationScope;
    readonly screenshotBase64: string;
  }) {
    const config = yield* ServerConfig.ServerConfig;
    const fileName = `browser-screenshot-${(yield* Clock.currentTimeMillis).toString(36)}-${NodeCrypto.randomUUID().slice(0, 8)}.png`;
    const path = yield* Path.Path;
    const absolutePath = path.join(config.browserArtifactsDir, fileName);
    yield* writeScreenshotFile({ absolutePath, screenshotBase64: input.screenshotBase64 }).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewAutomationScreenshotSaveError({
            operation: "snapshot",
            environmentId: input.scope.environmentId,
            threadId: input.scope.threadId,
            providerSessionId: input.scope.providerSessionId,
            providerInstanceId: input.scope.providerInstanceId,
            savePath: fileName,
            reason: "failed to write the screenshot artifact",
            cause,
          }),
      ),
    );
    return absolutePath;
  },
);

const saveSnapshotScreenshot = Effect.fn("PreviewToolkit.saveSnapshotScreenshot")(
  function* (input: {
    readonly scope: McpInvocationContext.McpInvocationScope;
    readonly savePath: string;
    readonly screenshotBase64: string;
  }) {
    const { savePath, scope } = input;
    const fail = (reason: string, cause?: unknown) =>
      new PreviewAutomationScreenshotSaveError({
        operation: "snapshot",
        environmentId: scope.environmentId,
        threadId: scope.threadId,
        providerSessionId: scope.providerSessionId,
        providerInstanceId: scope.providerInstanceId,
        savePath,
        reason,
        ...(cause === undefined ? {} : { cause }),
      });
    if (!savePath.toLowerCase().endsWith(".png")) {
      return yield* fail("savePath must end with .png");
    }

    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const threadContext = yield* projectionSnapshotQuery
      .getThreadCheckpointContext(scope.threadId)
      .pipe(Effect.mapError((cause) => fail("failed to resolve the thread workspace", cause)));
    if (Option.isNone(threadContext)) {
      return yield* fail("thread was not found");
    }
    const workspaceRoot = threadContext.value.worktreePath ?? threadContext.value.workspaceRoot;

    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const resolved = yield* workspacePaths
      .resolveRelativePathWithinRoot({ workspaceRoot, relativePath: savePath })
      .pipe(
        Effect.mapError((cause) =>
          fail("savePath must be a relative path inside the workspace", cause),
        ),
      );

    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const realPathOrNull = (target: string) =>
      fileSystem.realPath(target).pipe(
        Effect.map((canonical): string | null => canonical),
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(null)
              : Effect.fail(fail("failed to resolve the save path", error)),
        }),
      );
    const isOutsideRoot = (canonicalRoot: string, canonical: string) => {
      const relative = path.relative(canonicalRoot, canonical);
      return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    };

    const canonicalRoot = yield* fileSystem
      .realPath(workspaceRoot)
      .pipe(Effect.mapError((cause) => fail("failed to resolve the workspace root", cause)));

    const lexicalParent = path.dirname(resolved.absolutePath);
    let existingAncestor = lexicalParent;
    let canonicalAncestor = yield* realPathOrNull(existingAncestor);
    while (canonicalAncestor === null) {
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) {
        return yield* fail("failed to resolve the save directory");
      }
      existingAncestor = parent;
      canonicalAncestor = yield* realPathOrNull(existingAncestor);
    }
    if (isOutsideRoot(canonicalRoot, canonicalAncestor)) {
      return yield* fail("savePath must stay inside the workspace root");
    }

    yield* fileSystem
      .makeDirectory(lexicalParent, { recursive: true })
      .pipe(Effect.mapError((cause) => fail("failed to create the save directory", cause)));
    const canonicalParent = yield* fileSystem
      .realPath(lexicalParent)
      .pipe(Effect.mapError((cause) => fail("failed to resolve the save directory", cause)));
    if (isOutsideRoot(canonicalRoot, canonicalParent)) {
      return yield* fail("savePath must stay inside the workspace root");
    }

    const destination = path.join(canonicalParent, path.basename(resolved.absolutePath));
    const destinationIsSymlink = yield* fileSystem.readLink(destination).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (destinationIsSymlink) {
      return yield* fail("savePath must not be an existing symlink");
    }

    yield* writeScreenshotFile({
      absolutePath: destination,
      screenshotBase64: input.screenshotBase64,
    }).pipe(Effect.mapError((cause) => fail("failed to write the screenshot file", cause)));
    return resolved.relativePath;
  },
);

const handlers = {
  preview_status: (input) => invokeTargeted<PreviewAutomationStatus>("status", input ?? {}),
  preview_open: (input) =>
    invokeTargeted<PreviewAutomationStatus>("open", normalizePreviewOpenInput(input)),
  preview_navigate: (input) =>
    invokeTargeted<PreviewAutomationStatus>("navigate", input, input.timeoutMs),
  preview_resize: (input) =>
    invokeTargeted<PreviewAutomationResizeResult>("resize", input, input.timeoutMs),
  preview_set_appearance: (input) =>
    invokeTargeted<PreviewAutomationSetColorSchemeResult>("setColorScheme", input),
  preview_snapshot: (input) =>
    Effect.gen(function* () {
      const { save, savePath, ...target } = input ?? {};
      const snapshot = yield* invokeTargeted<PreviewAutomationSnapshot>("snapshot", target);
      if (savePath !== undefined) {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const savedScreenshotPath = yield* saveSnapshotScreenshot({
          scope,
          savePath,
          screenshotBase64: snapshot.screenshot.data,
        });
        return { ...snapshot, savedScreenshotPath };
      }
      if (save === true) {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const savedScreenshotPath = yield* saveSnapshotScreenshotArtifact({
          scope,
          screenshotBase64: snapshot.screenshot.data,
        });
        return { ...snapshot, savedScreenshotPath };
      }
      return snapshot;
    }),
  preview_click: (input) =>
    invokeTargeted<void>("click", input, input.timeoutMs).pipe(Effect.as(null)),
  preview_type: (input) =>
    invokeTargeted<void>("type", input, input.timeoutMs).pipe(Effect.as(null)),
  preview_press: (input) => invokeTargeted<void>("press", input).pipe(Effect.as(null)),
  preview_scroll: (input) => invokeTargeted<void>("scroll", input).pipe(Effect.as(null)),
  preview_evaluate: (input) =>
    invokeTargeted<unknown>("evaluate", input).pipe(Effect.map((result) => result ?? null)),
  preview_wait_for: (input) =>
    invokeTargeted<void>("waitFor", input, input.timeoutMs).pipe(Effect.as(null)),
  preview_recording_start: (input) =>
    invokeTargeted<PreviewAutomationRecordingStatus>("recordingStart", input ?? {}),
  preview_recording_stop: (input) =>
    invokeTargeted<PreviewAutomationRecordingArtifact>("recordingStop", input ?? {}),
} satisfies Parameters<typeof PreviewToolkit.toLayer>[0];

const { preview_snapshot, ...standardHandlers } = handlers;

export const PreviewStandardToolkitHandlersLive = PreviewStandardToolkit.toLayer(standardHandlers);

export const PreviewSnapshotToolkitHandlersLive = PreviewSnapshotToolkit.toLayer({
  preview_snapshot,
});

export const PreviewToolkitHandlersLive = PreviewToolkit.toLayer(handlers);
