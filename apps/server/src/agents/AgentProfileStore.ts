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
    return `Profile '${this.id}' was changed by another writer.`;
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
  return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${instructions}\n`;
};

export const make = Effect.gen(function* () {
  const catalog = yield* AgentCatalog.AgentCatalog;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mutex = yield* Semaphore.make(1);

  const storeError = (
    operation: AgentProfileStoreError["operation"],
    ref: AgentProfileLocator,
    detail: string,
  ) => new AgentProfileStoreError({ operation, scope: ref.scope, id: ref.id, detail });

  const profileRoot = (scope: AgentProfileLocator["scope"], workspaceRoot: string | undefined) =>
    scope === "environment" ? config.stateDir : workspaceRoot;

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
          Effect.mapError(() => storeError("resolve", input.ref, "Could not create profile root.")),
        );
    }
    const canonicalRoot = yield* fileSystem
      .realPath(root)
      .pipe(
        Effect.mapError(() => storeError("resolve", input.ref, "Could not resolve profile root.")),
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
        Effect.mapError(() =>
          storeError("resolve", input.ref, "Could not create profile directory."),
        ),
      );
    const canonicalParent = yield* fileSystem
      .realPath(path.dirname(requested))
      .pipe(
        Effect.mapError(() =>
          storeError("resolve", input.ref, "Could not resolve profile directory."),
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
    return path.join(canonicalParent, path.basename(requested));
  });

  const projectFile = Effect.fn("AgentProfileStore.projectFile")(function* (
    ref: AgentProfileLocator,
    workspaceRoot: string,
  ) {
    const canonicalRoot = yield* fileSystem
      .realPath(workspaceRoot)
      .pipe(
        Effect.mapError(() =>
          storeError("write-project-file", ref, "Could not resolve project root."),
        ),
      );
    const filePath = path.join(canonicalRoot, T3_PROJECT_FILE_NAME);
    const exists = yield* fileSystem
      .exists(filePath)
      .pipe(
        Effect.mapError(() => storeError("write-project-file", ref, "Could not inspect t3.json.")),
      );
    if (exists) {
      const canonicalFile = yield* fileSystem
        .realPath(filePath)
        .pipe(
          Effect.mapError(() =>
            storeError("write-project-file", ref, "Could not resolve t3.json."),
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
      Effect.mapError(() => storeError("write-project-file", ref, "Could not read t3.json.")),
    );
    if (Option.isNone(raw)) return {} satisfies T3ProjectFileType;
    return yield* decodeProjectFile(raw.value).pipe(
      Effect.mapError(() => storeError("write-project-file", ref, "t3.json is invalid.")),
    );
  });

  const writeProjectReference = Effect.fn("AgentProfileStore.writeProjectReference")(
    function* (input: {
      readonly ref: AgentProfileLocator;
      readonly workspaceRoot: string;
      readonly documentPath: string;
    }) {
      const current = yield* projectFile(input.ref, input.workspaceRoot);
      const agents = [
        ...(current.agents ?? []).filter((entry) => entry.id !== input.ref.id),
        {
          id: input.ref.id,
          path: input.documentPath,
        },
      ];
      const contents = yield* encodeProjectFile({ ...current, agents }).pipe(
        Effect.map((encoded) => `${encoded}\n`),
        Effect.mapError(() =>
          storeError("write-project-file", input.ref, "Could not encode t3.json."),
        ),
      );
      yield* writeFileStringAtomically({
        filePath: path.join(input.workspaceRoot, T3_PROJECT_FILE_NAME),
        contents,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(() =>
          storeError("write-project-file", input.ref, "Could not replace t3.json."),
        ),
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
      return yield* storeError("load", ref, "Could not load current profile.");
    } else if (input.expectedRevision !== undefined) {
      return yield* new AgentProfileStoreRevisionConflictError({
        scope: ref.scope,
        id: ref.id,
        expectedRevision: input.expectedRevision,
      });
    }

    const documentPath =
      current._tag === "Success"
        ? (current.success.sourcePath ??
          (ref.scope === "environment"
            ? path.join("agents", `${ref.id}.md`)
            : `.t3code/agents/${ref.id}.md`))
        : (input.profile.sourcePath ??
          (ref.scope === "environment"
            ? path.join("agents", `${ref.id}.md`)
            : `.t3code/agents/${ref.id}.md`));
    const targetPath = yield* resolveWritePath({
      ref,
      workspaceRoot: input.workspaceRoot,
      documentPath,
    });
    yield* writeFileStringAtomically({
      filePath: targetPath,
      contents: renderProfile(input.profile),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(() =>
        storeError("write-document", ref, "Could not replace profile Markdown."),
      ),
    );
    if (ref.scope === "project") {
      if (!input.workspaceRoot) {
        return yield* storeError("resolve", ref, "Project profiles require a workspace root.");
      }
      yield* writeProjectReference({ ref, workspaceRoot: input.workspaceRoot, documentPath });
    }
    return yield* catalog
      .getProfile({ ref, workspaceRoot: input.workspaceRoot })
      .pipe(Effect.mapError(() => storeError("load", ref, "Could not load saved profile.")));
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
      .pipe(Effect.mapError(() => storeError("load", input.ref, "Could not load profile.")));
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
