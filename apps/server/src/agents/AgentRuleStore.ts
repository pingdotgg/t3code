/** Writable, revision-checked persistence for native Agent Rule Markdown. */
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
  AgentProfileLocator,
  AgentProfileId,
  AgentProfileRevision,
  AgentRuleDocument,
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

export class AgentRuleStoreError extends Schema.TaggedErrorClass<AgentRuleStoreError>()(
  "AgentRuleStoreError",
  {
    operation: Schema.Literals(["load", "resolve", "write-document", "write-project-file"]),
    scope: AgentProfileLocator.fields.scope,
    id: AgentProfileLocator.fields.id,
    detail: Schema.String,
  },
) {}

export class AgentRuleStoreRevisionConflictError extends Schema.TaggedErrorClass<AgentRuleStoreRevisionConflictError>()(
  "AgentRuleStoreRevisionConflictError",
  {
    scope: AgentProfileLocator.fields.scope,
    id: AgentProfileLocator.fields.id,
    expectedRevision: Schema.optionalKey(AgentProfileRevision),
    actualRevision: Schema.optionalKey(AgentProfileRevision),
  },
) {}

export const AgentRuleStoreErrorSchema = Schema.Union([
  AgentRuleStoreError,
  AgentRuleStoreRevisionConflictError,
]);
export type AgentRuleStoreFailure = typeof AgentRuleStoreErrorSchema.Type;

export class AgentRuleStore extends Context.Service<
  AgentRuleStore,
  {
    readonly save: (input: {
      readonly rule: AgentRuleDocument;
      readonly expectedRevision?: AgentProfileRevision | undefined;
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<AgentRuleDocument, AgentRuleStoreFailure>;
    readonly archive: (input: {
      readonly ref: AgentProfileLocator;
      readonly expectedRevision: AgentProfileRevision;
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<AgentRuleDocument, AgentRuleStoreFailure>;
    readonly restore: (input: {
      readonly ref: AgentProfileLocator;
      readonly expectedRevision: AgentProfileRevision;
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<AgentRuleDocument, AgentRuleStoreFailure>;
  }
>()("t3/agents/AgentRuleStore") {}

const isContained = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
};

const renderRule = (rule: AgentRuleDocument): string => {
  const {
    id: _id,
    scope: _scope,
    revision: _revision,
    sourcePath: _sourcePath,
    body,
    ...frontmatter
  } = rule;
  return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${body}\n`;
};

export const make = Effect.gen(function* () {
  const catalog = yield* AgentCatalog.AgentCatalog;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mutex = yield* Semaphore.make(1);

  const storeError = (
    operation: AgentRuleStoreError["operation"],
    ref: AgentProfileLocator,
    detail: string,
  ) => new AgentRuleStoreError({ operation, scope: ref.scope, id: ref.id, detail });
  const ruleRoot = (scope: AgentProfileLocator["scope"], workspaceRoot: string | undefined) =>
    scope === "environment" ? config.stateDir : workspaceRoot;

  const resolveWritePath = Effect.fn("AgentRuleStore.resolveWritePath")(function* (input: {
    readonly ref: AgentProfileLocator;
    readonly workspaceRoot?: string | undefined;
    readonly documentPath: string;
  }) {
    const root = ruleRoot(input.ref.scope, input.workspaceRoot);
    if (!root)
      return yield* storeError("resolve", input.ref, "Project rules require a workspace root.");
    if (input.ref.scope === "environment") {
      yield* fileSystem
        .makeDirectory(root, { recursive: true })
        .pipe(
          Effect.mapError(() => storeError("resolve", input.ref, "Could not create rule root.")),
        );
    }
    const canonicalRoot = yield* fileSystem
      .realPath(root)
      .pipe(
        Effect.mapError(() => storeError("resolve", input.ref, "Could not resolve rule root.")),
      );
    if (path.isAbsolute(input.documentPath)) {
      return yield* storeError("resolve", input.ref, "Rule source paths must be relative.");
    }
    const requested = path.resolve(canonicalRoot, input.documentPath);
    if (
      !isContained(path, canonicalRoot, requested) ||
      path.extname(requested).toLowerCase() !== MARKDOWN_EXTENSION
    ) {
      return yield* storeError(
        "resolve",
        input.ref,
        "Rule source path must be a contained Markdown file.",
      );
    }
    yield* fileSystem
      .makeDirectory(path.dirname(requested), { recursive: true })
      .pipe(
        Effect.mapError(() => storeError("resolve", input.ref, "Could not create rule directory.")),
      );
    const canonicalParent = yield* fileSystem
      .realPath(path.dirname(requested))
      .pipe(
        Effect.mapError(() =>
          storeError("resolve", input.ref, "Could not resolve rule directory."),
        ),
      );
    if (!isContained(path, canonicalRoot, canonicalParent)) {
      return yield* storeError(
        "resolve",
        input.ref,
        "Rule directory resolves outside its allowed root.",
      );
    }
    return path.join(canonicalParent, path.basename(requested));
  });

  const projectFile = Effect.fn("AgentRuleStore.projectFile")(function* (
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
        return yield* storeError(
          "write-project-file",
          ref,
          "t3.json resolves outside the project root.",
        );
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

  const writeProjectReference = Effect.fn("AgentRuleStore.writeProjectReference")(
    function* (input: {
      readonly ref: AgentProfileLocator;
      readonly workspaceRoot: string;
      readonly documentPath: string;
    }) {
      const current = yield* projectFile(input.ref, input.workspaceRoot);
      const rules = [
        ...(current.rules ?? []).filter((entry) => entry.id !== input.ref.id),
        { id: AgentProfileId.make(input.ref.id), path: input.documentPath },
      ];
      const contents = yield* encodeProjectFile({ ...current, rules }).pipe(
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

  const saveUnlocked = Effect.fn("AgentRuleStore.saveUnlocked")(function* (input: {
    readonly rule: AgentRuleDocument;
    readonly expectedRevision?: AgentProfileRevision | undefined;
    readonly workspaceRoot?: string | undefined;
  }) {
    const ref: AgentProfileLocator = {
      id: AgentProfileId.make(input.rule.id),
      scope: input.rule.scope,
    };
    const current = yield* catalog
      .getRule({ ref, workspaceRoot: input.workspaceRoot })
      .pipe(Effect.result);
    if (Result.isSuccess(current)) {
      if (input.expectedRevision !== current.success.revision) {
        return yield* new AgentRuleStoreRevisionConflictError({
          scope: ref.scope,
          id: ref.id,
          ...(input.expectedRevision ? { expectedRevision: input.expectedRevision } : {}),
          actualRevision: current.success.revision,
        });
      }
    } else if (current.failure._tag !== "AgentCatalogNotFoundError") {
      return yield* storeError("load", ref, "Could not load current rule.");
    } else if (input.expectedRevision !== undefined) {
      return yield* new AgentRuleStoreRevisionConflictError({
        scope: ref.scope,
        id: ref.id,
        expectedRevision: input.expectedRevision,
      });
    }
    const defaultPath =
      ref.scope === "environment"
        ? path.join("rules", `${ref.id}.md`)
        : `.t3code/rules/${ref.id}.md`;
    const documentPath =
      current._tag === "Success"
        ? (current.success.sourcePath ?? defaultPath)
        : (input.rule.sourcePath ?? defaultPath);
    const targetPath = yield* resolveWritePath({
      ref,
      workspaceRoot: input.workspaceRoot,
      documentPath,
    });
    yield* writeFileStringAtomically({
      filePath: targetPath,
      contents: renderRule(input.rule),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(() => storeError("write-document", ref, "Could not replace rule Markdown.")),
    );
    if (ref.scope === "project") {
      if (!input.workspaceRoot)
        return yield* storeError("resolve", ref, "Project rules require a workspace root.");
      yield* writeProjectReference({ ref, workspaceRoot: input.workspaceRoot, documentPath });
    }
    return yield* catalog
      .getRule({ ref, workspaceRoot: input.workspaceRoot })
      .pipe(Effect.mapError(() => storeError("load", ref, "Could not load saved rule.")));
  });

  const save: AgentRuleStore["Service"]["save"] = (input) =>
    mutex.withPermits(1)(saveUnlocked(input));
  const updateArchived = Effect.fn("AgentRuleStore.updateArchived")(function* (input: {
    readonly ref: AgentProfileLocator;
    readonly expectedRevision: AgentProfileRevision;
    readonly workspaceRoot?: string | undefined;
    readonly archived: boolean;
  }) {
    const rule = yield* catalog
      .getRule({ ref: input.ref, workspaceRoot: input.workspaceRoot })
      .pipe(Effect.mapError(() => storeError("load", input.ref, "Could not load rule.")));
    const now = DateTime.formatIso(yield* DateTime.now);
    return yield* save({
      rule: { ...rule, archivedAt: input.archived ? now : null, updatedAt: now },
      expectedRevision: input.expectedRevision,
      workspaceRoot: input.workspaceRoot,
    });
  });
  const archive: AgentRuleStore["Service"]["archive"] = (input) =>
    updateArchived({ ...input, archived: true });
  const restore: AgentRuleStore["Service"]["restore"] = (input) =>
    updateArchived({ ...input, archived: false });
  return AgentRuleStore.of({ save, archive, restore });
});

export const layer = Layer.effect(AgentRuleStore, make);
