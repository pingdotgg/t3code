/**
 * Read-only discovery and loading for the agent-profile and rule catalog.
 *
 * Environment entries are Markdown files in `<stateDir>/agents` and
 * `<stateDir>/rules`. Project entries are deliberately not globbed: they are
 * only available when `t3.json` explicitly names both their id and path.
 */
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  AGENT_PROFILE_MAX_REFERENCES,
  AgentCatalogDiagnostic,
  AgentCatalogEntryKind,
  AgentProfileDocument,
  AgentProfileLocator,
  AgentProfileSummary,
  AgentRuleDocument,
  AgentRuleSummary,
} from "@t3tools/contracts";
import { fromYaml } from "@t3tools/shared/schemaYaml";

import * as ServerConfig from "../config.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";

const MARKDOWN_EXTENSION = ".md";
const FRONTMATTER_PATTERN = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const CatalogEntryKind = AgentCatalogEntryKind;
type CatalogEntryKind = typeof CatalogEntryKind.Type;

const CatalogScope = Schema.Literals(["environment", "project"]);
type CatalogScope = typeof CatalogScope.Type;

export const AgentCatalogSnapshot = Schema.Struct({
  profiles: Schema.Array(AgentProfileSummary),
  rules: Schema.Array(AgentRuleSummary),
  diagnostics: Schema.Array(AgentCatalogDiagnostic),
});
export type AgentCatalogSnapshot = typeof AgentCatalogSnapshot.Type;

export const AgentCatalogValidation = Schema.Struct({
  diagnostics: Schema.Array(AgentCatalogDiagnostic),
});
export type AgentCatalogValidation = typeof AgentCatalogValidation.Type;

export class AgentCatalogNotFoundError extends Schema.TaggedErrorClass<AgentCatalogNotFoundError>()(
  "AgentCatalogNotFoundError",
  {
    kind: CatalogEntryKind,
    scope: CatalogScope,
    id: Schema.String,
  },
) {
  override get message(): string {
    return `No ${this.scope}-scoped ${this.kind} named '${this.id}' was found.`;
  }
}

export class AgentCatalogDocumentError extends Schema.TaggedErrorClass<AgentCatalogDocumentError>()(
  "AgentCatalogDocumentError",
  {
    kind: CatalogEntryKind,
    scope: CatalogScope,
    id: Schema.String,
    sourcePath: Schema.String,
    code: Schema.Literals(["invalid-document", "missing-frontmatter", "read-failed"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Unable to load ${this.scope}-scoped ${this.kind} '${this.id}' from ${this.sourcePath}.`;
  }
}

export const AgentCatalogLoadError = Schema.Union([
  AgentCatalogNotFoundError,
  AgentCatalogDocumentError,
]);
export type AgentCatalogLoadError = typeof AgentCatalogLoadError.Type;

const trimmedNonEmpty = Schema.String.check(Schema.isNonEmpty()).pipe(
  Schema.decodeTo(Schema.String.check(Schema.isNonEmpty()), SchemaTransformation.trim()),
);

const ProfileFrontmatter = Schema.Struct({
  name: trimmedNonEmpty,
  description: Schema.optionalKey(trimmedNonEmpty),
  defaultModelSelection: Schema.optionalKey(Schema.Unknown),
  chatSelectable: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  requirements: Schema.optionalKey(Schema.Unknown),
  instructionPriority: Schema.optionalKey(Schema.Unknown),
  runtime: Schema.Unknown,
  workspace: Schema.Unknown,
  tools: Schema.Unknown,
  delegation: Schema.Unknown,
  budgets: Schema.Unknown,
  rules: Schema.Unknown,
  hooks: Schema.Unknown,
  createdAt: Schema.optionalKey(Schema.String),
  updatedAt: Schema.optionalKey(Schema.String),
  archivedAt: Schema.optionalKey(Schema.Unknown),
});

const RuleFrontmatter = Schema.Struct({
  name: trimmedNonEmpty,
  description: Schema.optionalKey(trimmedNonEmpty),
  globs: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  alwaysApply: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  priority: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  profiles: Schema.Array(AgentProfileLocator).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  createdAt: Schema.optionalKey(Schema.String),
  updatedAt: Schema.optionalKey(Schema.String),
  archivedAt: Schema.optionalKey(Schema.Unknown),
});

const decodeProfileFrontmatter = Schema.decodeUnknownEffect(fromYaml(ProfileFrontmatter));
const decodeRuleFrontmatter = Schema.decodeUnknownEffect(fromYaml(RuleFrontmatter));
const decodeProfileLocator = Schema.decodeUnknownEffect(AgentProfileLocator);
const decodeProfileSummary = Schema.decodeUnknownEffect(AgentProfileSummary);
const decodeProfileDocument = Schema.decodeUnknownEffect(AgentProfileDocument);
const decodeRuleSummary = Schema.decodeUnknownEffect(AgentRuleSummary);
const decodeRuleDocument = Schema.decodeUnknownEffect(AgentRuleDocument);

interface Source {
  readonly kind: CatalogEntryKind;
  readonly ref: AgentProfileLocator;
  readonly sourcePath: string;
  readonly documentPath: string;
}

interface ParsedMarkdown {
  readonly frontmatter: string;
  readonly body: string;
}

const normalizeMarkdown = (source: string) => source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
const CATALOG_EPOCH = "1970-01-01T00:00:00.000Z";

const splitMarkdown = (source: string): ParsedMarkdown | null => {
  const match = FRONTMATTER_PATTERN.exec(source);
  if (!match || match[1] === undefined) return null;
  return { frontmatter: match[1], body: source.slice(match[0].length) };
};

const isContained = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
};

const diagnostic = (input: AgentCatalogDiagnostic): AgentCatalogDiagnostic => input;

const sourceSort = (left: Source, right: Source) =>
  left.ref.scope.localeCompare(right.ref.scope) ||
  left.ref.id.localeCompare(right.ref.id) ||
  left.sourcePath.localeCompare(right.sourcePath);

/** Keep the RPC catalog bounded while telling clients that entries were omitted. */
export const boundAgentCatalog = (catalog: AgentCatalogSnapshot): AgentCatalogSnapshot => {
  const truncationDiagnostics: Array<AgentCatalogDiagnostic> = [];
  const profiles = catalog.profiles.slice(0, AGENT_PROFILE_MAX_REFERENCES);
  const rules = catalog.rules.slice(0, AGENT_PROFILE_MAX_REFERENCES);
  const addTruncationDiagnostic = <T extends AgentProfileSummary | AgentRuleSummary>(
    entries: ReadonlyArray<T>,
    kind: CatalogEntryKind,
  ) => {
    const omitted = entries[AGENT_PROFILE_MAX_REFERENCES];
    if (!omitted) return;
    truncationDiagnostics.push({
      code: "truncated",
      kind,
      scope: omitted.scope,
      id: omitted.id,
      ...(omitted.sourcePath === null ? {} : { sourcePath: omitted.sourcePath }),
      message: `Only the first ${AGENT_PROFILE_MAX_REFERENCES} ${kind} entries are shown; additional entries were omitted.`,
    });
  };
  addTruncationDiagnostic(catalog.profiles, "profile");
  addTruncationDiagnostic(catalog.rules, "rule");
  return {
    profiles,
    rules,
    diagnostics: [...truncationDiagnostics, ...catalog.diagnostics].slice(
      0,
      AGENT_PROFILE_MAX_REFERENCES,
    ),
  };
};

/** A read-only catalog. `list` parses only metadata; `get*` loads document bodies on demand. */
export class AgentCatalog extends Context.Service<
  AgentCatalog,
  {
    readonly list: (input?: {
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<AgentCatalogSnapshot>;
    readonly getProfile: (input: {
      readonly ref: AgentProfileLocator;
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<AgentProfileDocument, AgentCatalogLoadError>;
    readonly getRule: (input: {
      readonly ref: AgentProfileLocator;
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<AgentRuleDocument, AgentCatalogLoadError>;
    readonly validate: (input?: {
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<AgentCatalogValidation>;
  }
>()("t3/agents/AgentCatalog") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const projectFileLoader = yield* T3ProjectFileLoader.T3ProjectFileLoader;

  const hash = Effect.fn("AgentCatalog.hash")(function* (source: string) {
    return yield* crypto
      .digest("SHA-256", new TextEncoder().encode(normalizeMarkdown(source)))
      .pipe(Effect.map(Encoding.encodeHex));
  });

  const revisionOf = Effect.fn("AgentCatalog.revisionOf")(function* (
    source: Source,
    contents: string,
  ) {
    return yield* hash(contents).pipe(
      Effect.mapError(
        (cause) =>
          new AgentCatalogDocumentError({
            kind: source.kind,
            scope: source.ref.scope,
            id: source.ref.id,
            sourcePath: source.sourcePath,
            code: "read-failed",
            cause,
          }),
      ),
    );
  });

  const readSource = Effect.fn("AgentCatalog.readSource")(function* (source: Source) {
    return yield* fileSystem.readFileString(source.sourcePath).pipe(
      Effect.mapError(
        (cause) =>
          new AgentCatalogDocumentError({
            kind: source.kind,
            scope: source.ref.scope,
            id: source.ref.id,
            sourcePath: source.sourcePath,
            code: "read-failed",
            cause,
          }),
      ),
    );
  });

  const canonicalRoot = Effect.fn("AgentCatalog.canonicalRoot")(function* (
    root: string,
    kind: CatalogEntryKind,
    scope: CatalogScope,
  ) {
    return yield* fileSystem.realPath(root).pipe(
      Effect.mapError((_cause) =>
        diagnostic({
          code: "root-unavailable",
          kind,
          scope,
          sourcePath: root,
          message: `Could not resolve catalog root '${root}'.`,
        }),
      ),
    );
  });

  const canonicalFile = Effect.fn("AgentCatalog.canonicalFile")(function* (input: {
    readonly root: string;
    readonly candidate: string;
    readonly kind: CatalogEntryKind;
    readonly scope: CatalogScope;
    readonly id: string;
  }) {
    const resolved = yield* fileSystem.realPath(input.candidate).pipe(
      Effect.mapError(() =>
        diagnostic({
          code: "read-failed",
          kind: input.kind,
          scope: input.scope,
          id: input.id,
          sourcePath: input.candidate,
          message: `Could not resolve catalog entry '${input.candidate}'.`,
        }),
      ),
    );
    if (!isContained(path, input.root, resolved)) {
      return yield* Effect.fail(
        diagnostic({
          code: "outside-root",
          kind: input.kind,
          scope: input.scope,
          id: input.id,
          sourcePath: input.candidate,
          message: `Catalog entry resolves outside its allowed root: '${resolved}'.`,
        }),
      );
    }
    const stat = yield* fileSystem.stat(resolved).pipe(
      Effect.mapError(() =>
        diagnostic({
          code: "read-failed",
          kind: input.kind,
          scope: input.scope,
          id: input.id,
          sourcePath: resolved,
          message: `Could not inspect catalog entry '${resolved}'.`,
        }),
      ),
    );
    if (stat.type !== "File") {
      return yield* Effect.fail(
        diagnostic({
          code: "invalid-reference",
          kind: input.kind,
          scope: input.scope,
          id: input.id,
          sourcePath: resolved,
          message: "Catalog entries must be regular files.",
        }),
      );
    }
    return resolved;
  });

  const discoverEnvironment = Effect.fn("AgentCatalog.discoverEnvironment")(function* (
    kind: CatalogEntryKind,
  ) {
    const root = path.join(config.stateDir, kind === "profile" ? "agents" : "rules");
    const stateRoot = yield* canonicalRoot(config.stateDir, kind, "environment").pipe(
      Effect.result,
    );
    if (Result.isFailure(stateRoot)) {
      return { sources: [] as ReadonlyArray<Source>, diagnostics: [stateRoot.failure] };
    }

    const catalogRootExists = yield* fileSystem.exists(root).pipe(
      Effect.mapError(() =>
        diagnostic({
          code: "root-unavailable",
          kind,
          scope: "environment",
          sourcePath: root,
          message: `Could not inspect catalog root '${root}'.`,
        }),
      ),
      Effect.result,
    );
    if (Result.isFailure(catalogRootExists)) {
      return { sources: [] as ReadonlyArray<Source>, diagnostics: [catalogRootExists.failure] };
    }
    if (!catalogRootExists.success) {
      return {
        sources: [] as ReadonlyArray<Source>,
        diagnostics: [] as ReadonlyArray<AgentCatalogDiagnostic>,
      };
    }
    const catalogRoot = yield* canonicalRoot(root, kind, "environment").pipe(Effect.result);
    if (Result.isFailure(catalogRoot)) {
      return {
        sources: [] as ReadonlyArray<Source>,
        diagnostics: [catalogRoot.failure],
      };
    }
    if (!isContained(path, stateRoot.success, catalogRoot.success)) {
      return {
        sources: [] as ReadonlyArray<Source>,
        diagnostics: [
          diagnostic({
            code: "outside-root",
            kind,
            scope: "environment",
            sourcePath: root,
            message: `Catalog root resolves outside server state: '${catalogRoot.success}'.`,
          }),
        ],
      };
    }

    const entries = yield* fileSystem.readDirectory(catalogRoot.success).pipe(
      Effect.mapError(() =>
        diagnostic({
          code: "read-failed",
          kind,
          scope: "environment",
          sourcePath: catalogRoot.success,
          message: `Could not read catalog root '${catalogRoot.success}'.`,
        }),
      ),
      Effect.result,
    );
    if (Result.isFailure(entries)) {
      return { sources: [] as ReadonlyArray<Source>, diagnostics: [entries.failure] };
    }
    const sources: Array<Source> = [];
    const diagnostics: Array<AgentCatalogDiagnostic> = [];
    for (const entry of [...entries.success].sort()) {
      if (path.extname(entry).toLowerCase() !== MARKDOWN_EXTENSION) continue;
      const id = path.basename(entry, path.extname(entry)).trim();
      if (!id) continue;
      const resolved = yield* canonicalFile({
        root: catalogRoot.success,
        candidate: path.join(catalogRoot.success, entry),
        kind,
        scope: "environment",
        id,
      }).pipe(Effect.result);
      if (Result.isFailure(resolved)) {
        diagnostics.push(resolved.failure);
        continue;
      }
      const ref = yield* decodeProfileLocator({ scope: "environment", id }).pipe(Effect.result);
      if (Result.isFailure(ref)) {
        diagnostics.push(
          diagnostic({
            code: "invalid-reference",
            kind,
            scope: "environment",
            id,
            sourcePath: resolved.success,
            message: "Catalog entry filename is not a valid agent id.",
          }),
        );
        continue;
      }
      sources.push({
        kind,
        ref: ref.success,
        sourcePath: resolved.success,
        documentPath: path.join(kind === "profile" ? "agents" : "rules", entry),
      });
    }
    return { sources, diagnostics };
  });

  const discoverProject = Effect.fn("AgentCatalog.discoverProject")(function* (
    kind: CatalogEntryKind,
    workspaceRoot: string | undefined,
  ) {
    if (!workspaceRoot)
      return {
        sources: [] as ReadonlyArray<Source>,
        diagnostics: [] as ReadonlyArray<AgentCatalogDiagnostic>,
      };
    const root = yield* canonicalRoot(workspaceRoot, kind, "project").pipe(Effect.result);
    if (Result.isFailure(root)) {
      return { sources: [] as ReadonlyArray<Source>, diagnostics: [root.failure] };
    }
    const projectFile = yield* projectFileLoader.load(root.success);
    if (projectFile._tag === "None")
      return {
        sources: [] as ReadonlyArray<Source>,
        diagnostics: [] as ReadonlyArray<AgentCatalogDiagnostic>,
      };

    const references =
      kind === "profile" ? (projectFile.value.agents ?? []) : (projectFile.value.rules ?? []);
    const sources: Array<Source> = [];
    const diagnostics: Array<AgentCatalogDiagnostic> = [];
    for (const reference of references) {
      if (
        path.isAbsolute(reference.path) ||
        path.extname(reference.path).toLowerCase() !== MARKDOWN_EXTENSION
      ) {
        diagnostics.push(
          diagnostic({
            code: "invalid-reference",
            kind,
            scope: "project",
            id: reference.id,
            sourcePath: reference.path,
            message: "Project catalog paths must be workspace-relative Markdown files.",
          }),
        );
        continue;
      }
      const resolved = yield* canonicalFile({
        root: root.success,
        candidate: path.resolve(root.success, reference.path),
        kind,
        scope: "project",
        id: reference.id,
      }).pipe(Effect.result);
      if (Result.isFailure(resolved)) {
        diagnostics.push(resolved.failure);
        continue;
      }
      const ref = yield* decodeProfileLocator({ scope: "project", id: reference.id }).pipe(
        Effect.result,
      );
      if (Result.isFailure(ref)) {
        diagnostics.push(
          diagnostic({
            code: "invalid-reference",
            kind,
            scope: "project",
            id: reference.id,
            sourcePath: resolved.success,
            message: "Project catalog reference id is not a valid agent id.",
          }),
        );
        continue;
      }
      sources.push({
        kind,
        ref: ref.success,
        sourcePath: resolved.success,
        documentPath: reference.path,
      });
    }
    return { sources, diagnostics };
  });

  const discover = Effect.fn("AgentCatalog.discover")(function* (
    workspaceRoot: string | undefined,
  ) {
    const [environmentProfiles, environmentRules, projectProfiles, projectRules] =
      yield* Effect.all([
        discoverEnvironment("profile"),
        discoverEnvironment("rule"),
        discoverProject("profile", workspaceRoot),
        discoverProject("rule", workspaceRoot),
      ]);
    const diagnostics = [
      ...environmentProfiles.diagnostics,
      ...environmentRules.diagnostics,
      ...projectProfiles.diagnostics,
      ...projectRules.diagnostics,
    ];
    const uniqueSources = new Map<string, Source>();
    for (const source of [
      ...environmentProfiles.sources,
      ...environmentRules.sources,
      ...projectProfiles.sources,
      ...projectRules.sources,
    ].sort(sourceSort)) {
      const key = `${source.kind}:${source.ref.scope}:${source.ref.id}`;
      if (uniqueSources.has(key)) {
        diagnostics.push(
          diagnostic({
            code: "duplicate",
            kind: source.kind,
            scope: source.ref.scope,
            id: source.ref.id,
            sourcePath: source.sourcePath,
            message: `Duplicate ${source.ref.scope}-scoped ${source.kind} id '${source.ref.id}'.`,
          }),
        );
        continue;
      }
      uniqueSources.set(key, source);
    }
    return { sources: [...uniqueSources.values()].sort(sourceSort), diagnostics };
  });

  const parsed = Effect.fn("AgentCatalog.parsed")(function* (source: Source) {
    const contents = yield* readSource(source);
    const markdown = splitMarkdown(contents);
    if (!markdown) {
      return yield* new AgentCatalogDocumentError({
        kind: source.kind,
        scope: source.ref.scope,
        id: source.ref.id,
        sourcePath: source.sourcePath,
        code: "missing-frontmatter",
        cause: new Error("Markdown document has no YAML frontmatter."),
      });
    }
    return { source: contents, markdown };
  });

  const profileSummary = Effect.fn("AgentCatalog.profileSummary")(function* (source: Source) {
    const { source: contents, markdown } = yield* parsed(source);
    const frontmatter = yield* decodeProfileFrontmatter(markdown.frontmatter).pipe(
      Effect.mapError(
        (cause) =>
          new AgentCatalogDocumentError({
            kind: "profile",
            scope: source.ref.scope,
            id: source.ref.id,
            sourcePath: source.sourcePath,
            code: "invalid-document",
            cause,
          }),
      ),
    );
    const revision = yield* revisionOf(source, contents);
    return yield* decodeProfileSummary({
      id: source.ref.id,
      scope: source.ref.scope,
      revision,
      sourcePath: source.documentPath,
      name: frontmatter.name,
      ...(frontmatter.description ? { description: frontmatter.description } : {}),
      defaultModelSelection: frontmatter.defaultModelSelection ?? null,
      chatSelectable: frontmatter.chatSelectable,
      requirements: frontmatter.requirements ?? { toolRequirement: "none", t3McpCapabilities: [] },
      archivedAt: frontmatter.archivedAt ?? null,
      updatedAt: frontmatter.updatedAt ?? CATALOG_EPOCH,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new AgentCatalogDocumentError({
            kind: "profile",
            scope: source.ref.scope,
            id: source.ref.id,
            sourcePath: source.sourcePath,
            code: "invalid-document",
            cause,
          }),
      ),
    );
  });

  const ruleSummary = Effect.fn("AgentCatalog.ruleSummary")(function* (source: Source) {
    const { source: contents, markdown } = yield* parsed(source);
    const frontmatter = yield* decodeRuleFrontmatter(markdown.frontmatter).pipe(
      Effect.mapError(
        (cause) =>
          new AgentCatalogDocumentError({
            kind: "rule",
            scope: source.ref.scope,
            id: source.ref.id,
            sourcePath: source.sourcePath,
            code: "invalid-document",
            cause,
          }),
      ),
    );
    const revision = yield* revisionOf(source, contents);
    return yield* decodeRuleSummary({
      id: source.ref.id,
      scope: source.ref.scope,
      revision,
      sourcePath: source.documentPath,
      name: frontmatter.name,
      ...(frontmatter.description ? { description: frontmatter.description } : {}),
      globs: frontmatter.globs,
      alwaysApply: frontmatter.alwaysApply,
      priority: frontmatter.priority,
      updatedAt: frontmatter.updatedAt ?? CATALOG_EPOCH,
      archivedAt: frontmatter.archivedAt ?? null,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new AgentCatalogDocumentError({
            kind: "rule",
            scope: source.ref.scope,
            id: source.ref.id,
            sourcePath: source.sourcePath,
            code: "invalid-document",
            cause,
          }),
      ),
    );
  });

  const toDiagnostic = (error: AgentCatalogDocumentError): AgentCatalogDiagnostic =>
    diagnostic({
      code: error.code,
      kind: error.kind,
      scope: error.scope,
      id: error.id,
      sourcePath: error.sourcePath,
      message: error.message,
    });

  const list: AgentCatalog["Service"]["list"] = Effect.fn("AgentCatalog.list")(function* (
    input = {},
  ) {
    const discovered = yield* discover(input.workspaceRoot);
    const profiles: Array<AgentProfileSummary> = [];
    const rules: Array<AgentRuleSummary> = [];
    const diagnostics = [...discovered.diagnostics];
    for (const source of discovered.sources) {
      if (source.kind === "profile") {
        const summary = yield* profileSummary(source).pipe(Effect.result);
        if (Result.isFailure(summary)) diagnostics.push(toDiagnostic(summary.failure));
        else profiles.push(summary.success);
      } else {
        const summary = yield* ruleSummary(source).pipe(Effect.result);
        if (Result.isFailure(summary)) diagnostics.push(toDiagnostic(summary.failure));
        else rules.push(summary.success);
      }
    }
    return {
      profiles: profiles.sort(
        (left, right) => left.scope.localeCompare(right.scope) || left.id.localeCompare(right.id),
      ),
      rules: rules.sort(
        (left, right) => left.scope.localeCompare(right.scope) || left.id.localeCompare(right.id),
      ),
      diagnostics,
    };
  });

  const find = Effect.fn("AgentCatalog.find")(function* (
    kind: CatalogEntryKind,
    ref: AgentProfileLocator,
    workspaceRoot: string | undefined,
  ) {
    const discovered = yield* discover(workspaceRoot);
    const source = discovered.sources.find(
      (candidate) =>
        candidate.kind === kind && candidate.ref.scope === ref.scope && candidate.ref.id === ref.id,
    );
    if (!source)
      return yield* new AgentCatalogNotFoundError({ kind, scope: ref.scope, id: ref.id });
    return source;
  });

  const profileDocument = Effect.fn("AgentCatalog.profileDocument")(function* (source: Source) {
    const { source: contents, markdown } = yield* parsed(source);
    const frontmatter = yield* decodeProfileFrontmatter(markdown.frontmatter).pipe(
      Effect.mapError(
        (cause) =>
          new AgentCatalogDocumentError({
            kind: "profile",
            scope: source.ref.scope,
            id: source.ref.id,
            sourcePath: source.sourcePath,
            code: "invalid-document",
            cause,
          }),
      ),
    );
    const revision = yield* revisionOf(source, contents);
    return yield* decodeProfileDocument({
      id: source.ref.id,
      scope: source.ref.scope,
      revision,
      sourcePath: source.documentPath,
      instructions: markdown.body,
      ...frontmatter,
      defaultModelSelection: frontmatter.defaultModelSelection ?? null,
      requirements: frontmatter.requirements ?? {
        toolRequirement: "none",
        t3McpCapabilities: [],
      },
      instructionPriority: frontmatter.instructionPriority ?? "prompt",
      createdAt: frontmatter.createdAt ?? CATALOG_EPOCH,
      updatedAt: frontmatter.updatedAt ?? CATALOG_EPOCH,
      archivedAt: frontmatter.archivedAt ?? null,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new AgentCatalogDocumentError({
            kind: "profile",
            scope: source.ref.scope,
            id: source.ref.id,
            sourcePath: source.sourcePath,
            code: "invalid-document",
            cause,
          }),
      ),
    );
  });

  const getProfile: AgentCatalog["Service"]["getProfile"] = Effect.fn("AgentCatalog.getProfile")(
    function* (input) {
      const source = yield* find("profile", input.ref, input.workspaceRoot);
      return yield* profileDocument(source);
    },
  );

  const ruleDocument = Effect.fn("AgentCatalog.ruleDocument")(function* (source: Source) {
    const { source: contents, markdown } = yield* parsed(source);
    const frontmatter = yield* decodeRuleFrontmatter(markdown.frontmatter).pipe(
      Effect.mapError(
        (cause) =>
          new AgentCatalogDocumentError({
            kind: "rule",
            scope: source.ref.scope,
            id: source.ref.id,
            sourcePath: source.sourcePath,
            code: "invalid-document",
            cause,
          }),
      ),
    );
    const revision = yield* revisionOf(source, contents);
    return yield* decodeRuleDocument({
      id: source.ref.id,
      scope: source.ref.scope,
      revision,
      sourcePath: source.documentPath,
      body: markdown.body,
      ...frontmatter,
      createdAt: frontmatter.createdAt ?? CATALOG_EPOCH,
      updatedAt: frontmatter.updatedAt ?? CATALOG_EPOCH,
      archivedAt: frontmatter.archivedAt ?? null,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new AgentCatalogDocumentError({
            kind: "rule",
            scope: source.ref.scope,
            id: source.ref.id,
            sourcePath: source.sourcePath,
            code: "invalid-document",
            cause,
          }),
      ),
    );
  });

  const getRule: AgentCatalog["Service"]["getRule"] = Effect.fn("AgentCatalog.getRule")(
    function* (input) {
      const source = yield* find("rule", input.ref, input.workspaceRoot);
      return yield* ruleDocument(source);
    },
  );

  const validate: AgentCatalog["Service"]["validate"] = Effect.fn("AgentCatalog.validate")(
    function* (input = {}) {
      const discovered = yield* discover(input.workspaceRoot);
      const diagnostics = [...discovered.diagnostics];
      for (const source of discovered.sources) {
        const document =
          source.kind === "profile"
            ? profileDocument(source).pipe(Effect.asVoid)
            : ruleDocument(source).pipe(Effect.asVoid);
        const result = yield* document.pipe(Effect.result);
        if (Result.isFailure(result) && result.failure._tag === "AgentCatalogDocumentError") {
          diagnostics.push(toDiagnostic(result.failure));
        }
      }
      return { diagnostics };
    },
  );

  return AgentCatalog.of({ list, getProfile, getRule, validate });
});

export const layer = Layer.effect(AgentCatalog, make);
