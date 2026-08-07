/**
 * Writable persistence for native agent profile Markdown documents.
 *
 * Profile revisions are content-addressed by AgentCatalog. Writes therefore
 * compare the caller's expected revision against a freshly loaded document,
 * atomically replace the Markdown file, then re-load it to return its new
 * revision. Project profiles additionally keep their explicit `t3.json`
 * reference in sync.
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { stringify as stringifyYaml } from "yaml";

import {
  AgentProfileDocument,
  AgentProfileLocator,
  AgentProfileRevision,
  T3ProjectFile,
  T3_PROJECT_FILE_NAME,
  type T3ProjectFile as T3ProjectFileType,
} from "@t3tools/contracts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { T3ProjectFileFromJson } from "@t3tools/shared/t3ProjectFile";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as AgentCatalog from "./AgentCatalog.ts";
import * as AgentProjectFileCoordinator from "./AgentProjectFileCoordinator.ts";

const MARKDOWN_EXTENSION = ".md";
const encodeProjectFile = Schema.encodeUnknownEffect(fromJsonStringPretty(T3ProjectFile));
const decodeProjectFile = Schema.decodeEffect(T3ProjectFileFromJson);

export class AgentProfileStoreError extends Schema.TaggedErrorClass<AgentProfileStoreError>()(
  "AgentProfileStoreError",
  {
    operation: Schema.Literals(["load", "resolve", "write-document", "write-project-file"]),
    scope: AgentProfileLocator.fields.scope,
    id: AgentProfileLocator.fields.id,
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${this.scope}-scoped profile '${this.id}': ${this.detail}`;
  }
}

export class AgentProfileStoreRevisionConflictError extends Schema.TaggedErrorClass<AgentProfileStoreRevisionConflictError>()(
  "AgentProfileStoreRevisionConflictError",
  {
    scope: AgentProfileLocator.fields.scope,
    id: AgentProfileLocator.fields.id,
    expectedRevision: Schema.optionalKey(AgentProfileRevision),
    actualRevision: Schema.optionalKey(AgentProfileRevision),
  },
) {
  override get message(): string {
    return `Profile '${this.scope}/${this.id}' revision conflict (expected ${this.expectedRevision ?? "a new profile"}, found ${this.actualRevision ?? "no profile"}).`;
  }
}

export const AgentProfileStoreErrorSchema = Schema.Union([
  AgentProfileStoreError,
  AgentProfileStoreRevisionConflictError,
]);
export type AgentProfileStoreFailure = typeof AgentProfileStoreErrorSchema.Type;

export class AgentProfileStore extends Context.Service<
  AgentProfileStore,
  {
    readonly save: (input: {
      readonly profile: AgentProfileDocument;
      readonly expectedRevision?: AgentProfileRevision | undefined;
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<AgentProfileDocument, AgentProfileStoreFailure>;
    readonly archive: (input: {
      readonly ref: AgentProfileLocator;
      readonly expectedRevision: AgentProfileRevision;
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<AgentProfileDocument, AgentProfileStoreFailure>;
    readonly restore: (input: {
      readonly ref: AgentProfileLocator;
      readonly expectedRevision: AgentProfileRevision;
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<AgentProfileDocument, AgentProfileStoreFailure>;
  }
>()("t3/agents/AgentProfileStore") {}

const isContained = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
};

const renderProfile = (profile: AgentProfileDocument): string => {
  const {
    id: _id,
    scope: _scope,
    revision: _revision,
    sourcePath: _sourcePath,
    instructions,
    ...frontmatter
  } = profile;
  return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n${instructions}`;
};

export const make = Effect.gen(function* () {
  const catalog = yield* AgentCatalog.AgentCatalog;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mutex = yield* Semaphore.make(1);
  const projectFileCoordinator = yield* AgentProjectFileCoordinator.AgentProjectFileCoordinator;

  const storeError = (
    operation: AgentProfileStoreError["operation"],
    ref: AgentProfileLocator,
    detail: string,
    cause?: unknown,
  ) =>
    new AgentProfileStoreError({
      operation,
      scope: ref.scope,
      id: ref.id,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const profileRoot = (scope: AgentProfileLocator["scope"], workspaceRoot: string | undefined) =>
    scope === "environment" ? config.stateDir : workspaceRoot;

  const existingFile = Effect.fn("AgentProfileStore.existingFile")(function* (filePath: string) {
    return yield* fileSystem.readFileString(filePath).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(error),
      }),
    );
  });

  const restorePreviousFile = (input: {
    readonly filePath: string;
    readonly previous: Option.Option<string>;
  }) =>
    Option.isSome(input.previous)
      ? writeFileStringAtomically({
          filePath: input.filePath,
          contents: input.previous.value,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        )
      : fileSystem.remove(input.filePath, { force: true });

  const resolveWritePath = Effect.fn("AgentProfileStore.resolveWritePath")(function* (input: {
    readonly ref: AgentProfileLocator;
    readonly workspaceRoot?: string | undefined;
    readonly documentPath: string;
  }) {
    const root = profileRoot(input.ref.scope, input.workspaceRoot);
    if (!root) {
      return yield* new AgentProfileStoreError({
        operation: "resolve",
        scope: input.ref.scope,
        id: input.ref.id,
        detail: "Project profiles require a workspace root.",
      });
    }
    if (input.ref.scope === "environment") {
      yield* fileSystem
        .makeDirectory(root, { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            storeError("resolve", input.ref, "Could not create profile root.", cause),
          ),
        );
    }
    const canonicalRoot = yield* fileSystem
      .realPath(root)
      .pipe(
        Effect.mapError((cause) =>
          storeError("resolve", input.ref, "Could not resolve profile root.", cause),
        ),
      );
    if (path.isAbsolute(input.documentPath)) {
      return yield* new AgentProfileStoreError({
        operation: "resolve",
        scope: input.ref.scope,
        id: input.ref.id,
        detail: "Profile source paths must be relative.",
      });
    }
    const requested = path.resolve(canonicalRoot, input.documentPath);
    if (
      !isContained(path, canonicalRoot, requested) ||
      path.extname(requested).toLowerCase() !== MARKDOWN_EXTENSION
    ) {
      return yield* new AgentProfileStoreError({
        operation: "resolve",
        scope: input.ref.scope,
        id: input.ref.id,
        detail: "Profile source path must be a contained Markdown file.",
      });
    }
    yield* fileSystem
      .makeDirectory(path.dirname(requested), { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          storeError("resolve", input.ref, "Could not create profile directory.", cause),
        ),
      );
    const canonicalParent = yield* fileSystem
      .realPath(path.dirname(requested))
      .pipe(
        Effect.mapError((cause) =>
          storeError("resolve", input.ref, "Could not resolve profile directory.", cause),
        ),
      );
    if (!isContained(path, canonicalRoot, canonicalParent)) {
      return yield* new AgentProfileStoreError({
        operation: "resolve",
        scope: input.ref.scope,
        id: input.ref.id,
        detail: "Profile directory resolves outside its allowed root.",
      });
    }
    return { root: canonicalRoot, filePath: path.join(canonicalParent, path.basename(requested)) };
  });

  const writeContained = Effect.fn("AgentProfileStore.writeContained")(function* (input: {
    readonly ref: AgentProfileLocator;
    readonly root: string;
    readonly filePath: string;
    readonly contents: string;
    readonly operation: AgentProfileStoreError["operation"];
  }) {
    const previous = yield* existingFile(input.filePath).pipe(
      Effect.mapError((cause) =>
        storeError(input.operation, input.ref, "Could not snapshot the existing file.", cause),
      ),
    );
    yield* writeFileStringAtomically({ filePath: input.filePath, contents: input.contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) =>
        storeError(
          input.operation,
          input.ref,
          `Could not replace '${path.basename(input.filePath)}'.`,
          cause,
        ),
      ),
    );
    const containmentFailure = (cause: unknown | undefined) =>
      Effect.gen(function* () {
        const rollback = yield* restorePreviousFile({
          filePath: input.filePath,
          previous,
        }).pipe(Effect.result);
        if (Result.isFailure(rollback)) {
          return yield* storeError(
            input.operation,
            input.ref,
            "Written file no longer resolves inside its allowed root and its previous contents could not be restored.",
            new AggregateError(
              [...(cause === undefined ? [] : [cause]), rollback.failure],
              "Agent profile containment rollback failed.",
            ),
          );
        }
        return yield* storeError(
          input.operation,
          input.ref,
          "Written file no longer resolves inside its allowed root.",
          cause,
        );
      });
    const canonicalFile = yield* fileSystem.realPath(input.filePath).pipe(Effect.result);
    if (Result.isFailure(canonicalFile)) {
      return yield* containmentFailure(canonicalFile.failure);
    }
    if (!isContained(path, input.root, canonicalFile.success)) {
      return yield* containmentFailure(undefined);
    }
  });

  const projectFile = Effect.fn("AgentProfileStore.projectFile")(function* (
    ref: AgentProfileLocator,
    workspaceRoot: string,
  ) {
    const canonicalRoot = yield* fileSystem
      .realPath(workspaceRoot)
      .pipe(
        Effect.mapError((cause) =>
          storeError("write-project-file", ref, "Could not resolve project root.", cause),
        ),
      );
    const filePath = path.join(canonicalRoot, T3_PROJECT_FILE_NAME);
    const exists = yield* fileSystem
      .exists(filePath)
      .pipe(
        Effect.mapError((cause) =>
          storeError("write-project-file", ref, "Could not inspect t3.json.", cause),
        ),
      );
    if (exists) {
      const canonicalFile = yield* fileSystem
        .realPath(filePath)
        .pipe(
          Effect.mapError((cause) =>
            storeError("write-project-file", ref, "Could not resolve t3.json.", cause),
          ),
        );
      if (!isContained(path, canonicalRoot, canonicalFile)) {
        return yield* new AgentProfileStoreError({
          operation: "write-project-file",
          scope: ref.scope,
          id: ref.id,
          detail: "t3.json resolves outside the project root.",
        });
      }
    }
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(error),
      }),
      Effect.mapError((cause) =>
        storeError("write-project-file", ref, "Could not read t3.json.", cause),
      ),
    );
    if (Option.isNone(raw)) return {} satisfies T3ProjectFileType;
    return yield* decodeProjectFile(raw.value).pipe(
      Effect.mapError((cause) =>
        storeError("write-project-file", ref, "t3.json is invalid.", cause),
      ),
    );
  });

  const writeProjectReference = Effect.fn("AgentProfileStore.writeProjectReference")(
    function* (input: {
      readonly ref: AgentProfileLocator;
      readonly workspaceRoot: string;
      readonly documentPath: string;
    }) {
      const root = yield* fileSystem
        .realPath(input.workspaceRoot)
        .pipe(
          Effect.mapError((cause) =>
            storeError("write-project-file", input.ref, "Could not resolve project root.", cause),
          ),
        );
      return yield* projectFileCoordinator.withWorkspaceLock(
        root,
        Effect.gen(function* () {
          const current = yield* projectFile(input.ref, root);
          const agents = [
            ...(current.agents ?? []).filter((entry) => entry.id !== input.ref.id),
            {
              id: input.ref.id,
              path: input.documentPath,
            },
          ];
          const contents = yield* encodeProjectFile({ ...current, agents }).pipe(
            Effect.map((encoded) => `${encoded}\n`),
            Effect.mapError((cause) =>
              storeError("write-project-file", input.ref, "Could not encode t3.json.", cause),
            ),
          );
          return yield* writeContained({
            ref: input.ref,
            root,
            filePath: path.join(root, T3_PROJECT_FILE_NAME),
            contents,
            operation: "write-project-file",
          });
        }),
      );
    },
  );

  const saveUnlocked = Effect.fn("AgentProfileStore.saveUnlocked")(function* (input: {
    readonly profile: AgentProfileDocument;
    readonly expectedRevision?: AgentProfileRevision | undefined;
    readonly workspaceRoot?: string | undefined;
  }) {
    const ref: AgentProfileLocator = { id: input.profile.id, scope: input.profile.scope };
    const current = yield* catalog
      .getProfile({ ref, workspaceRoot: input.workspaceRoot })
      .pipe(Effect.result);
    if (Result.isSuccess(current)) {
      if (input.expectedRevision !== current.success.revision) {
        return yield* new AgentProfileStoreRevisionConflictError({
          scope: ref.scope,
          id: ref.id,
          ...(input.expectedRevision ? { expectedRevision: input.expectedRevision } : {}),
          actualRevision: current.success.revision,
        });
      }
    } else if (current.failure._tag !== "AgentCatalogNotFoundError") {
      return yield* storeError("load", ref, "Could not load current profile.", current.failure);
    } else if (input.expectedRevision !== undefined) {
      return yield* new AgentProfileStoreRevisionConflictError({
        scope: ref.scope,
        id: ref.id,
        expectedRevision: input.expectedRevision,
      });
    }

    const defaultPath =
      ref.scope === "environment"
        ? path.join("agents", `${ref.id}.md`)
        : `.t3code/agents/${ref.id}.md`;
    const documentPath =
      current._tag === "Success"
        ? (current.success.sourcePath ?? defaultPath)
        : ref.scope === "environment"
          ? defaultPath
          : (input.profile.sourcePath ?? defaultPath);
    const target = yield* resolveWritePath({
      ref,
      workspaceRoot: input.workspaceRoot,
      documentPath,
    });
    const previous = yield* existingFile(target.filePath).pipe(
      Effect.mapError((cause) =>
        storeError("write-document", ref, "Could not snapshot profile Markdown.", cause),
      ),
    );
    yield* writeContained({
      ref,
      root: target.root,
      filePath: target.filePath,
      contents: renderProfile(input.profile),
      operation: "write-document",
    });
    if (ref.scope === "project") {
      if (!input.workspaceRoot) {
        return yield* storeError("resolve", ref, "Project profiles require a workspace root.");
      }
      const projectWrite = yield* writeProjectReference({
        ref,
        workspaceRoot: input.workspaceRoot,
        documentPath,
      }).pipe(Effect.result);
      if (Result.isFailure(projectWrite)) {
        const rollback = yield* restorePreviousFile({
          filePath: target.filePath,
          previous,
        }).pipe(Effect.result);
        if (Result.isFailure(rollback)) {
          return yield* storeError(
            "write-document",
            ref,
            "Could not roll back profile Markdown after t3.json failed to save.",
            new AggregateError(
              [projectWrite.failure, rollback.failure],
              "Agent profile project-reference rollback failed.",
            ),
          );
        }
        return yield* projectWrite.failure;
      }
    }
    return yield* catalog
      .getProfile({ ref, workspaceRoot: input.workspaceRoot })
      .pipe(
        Effect.mapError((cause) => storeError("load", ref, "Could not load saved profile.", cause)),
      );
  });

  const save: AgentProfileStore["Service"]["save"] = (input) =>
    mutex.withPermits(1)(saveUnlocked(input));

  const updateArchived = Effect.fn("AgentProfileStore.updateArchived")(function* (input: {
    readonly ref: AgentProfileLocator;
    readonly expectedRevision: AgentProfileRevision;
    readonly workspaceRoot?: string | undefined;
    readonly archived: boolean;
  }) {
    const profile = yield* catalog
      .getProfile({ ref: input.ref, workspaceRoot: input.workspaceRoot })
      .pipe(
        Effect.mapError((cause) => storeError("load", input.ref, "Could not load profile.", cause)),
      );
    const now = DateTime.formatIso(yield* DateTime.now);
    return yield* save({
      profile: { ...profile, archivedAt: input.archived ? now : null, updatedAt: now },
      expectedRevision: input.expectedRevision,
      workspaceRoot: input.workspaceRoot,
    });
  });

  const archive: AgentProfileStore["Service"]["archive"] = (input) =>
    updateArchived({ ...input, archived: true });
  const restore: AgentProfileStore["Service"]["restore"] = (input) =>
    updateArchived({ ...input, archived: false });

  return AgentProfileStore.of({ save, archive, restore });
});

export const layer = Layer.effect(AgentProfileStore, make);
