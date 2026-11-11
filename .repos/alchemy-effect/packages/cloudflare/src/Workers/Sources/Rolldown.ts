import { stripVTControlCharacters } from "node:util";
import * as Artifacts from "alchemy/Artifacts";
import * as Bundle from "alchemy/Bundle/Bundle";
import { findCwdForBundle, resolveMainPath } from "alchemy/Bundle/TempRoot";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { flow } from "effect/Function";
import type * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import path from "pathe";
import picomatch from "picomatch";
import type * as rolldown from "rolldown";
import { isWorkflowExport } from "../../Workflows/Workflow.ts";
import { isDurableObjectExport } from "../DurableObject.ts";
import type { SourceContext, SourceProvider } from "../Source.ts";
import type { SqlMigrationSnapshot } from "../SqlMigrationsRuntime.ts";
import type { WorkerProps } from "../Worker.ts";
import type { WorkerExport } from "../WorkerRuntimeContext.ts";
import type { ModuleRule } from "./Prebuilt.ts";
import { bundleSource } from "./shared.ts";
import { workerModulePlugin } from "./WorkerModulePlugin.ts";

/**
 * Bundler options for a Worker: Rolldown input/output overrides and
 * {@link Bundle.BundleExtraOptions}, merged over Alchemy's defaults.
 */
export interface WorkerBuildOptions extends Bundle.BundleConfig {
  /**
   * Rolldown output options merged over Alchemy's defaults. Use this to
   * control chunking (`codeSplitting`), minification, etc.
   */
  output?: rolldown.OutputOptions;
  /**
   * Forwarded to rolldown's `preserveEntrySignatures` input option. Some
   * `output.codeSplitting` configurations require relaxing it (e.g.
   * `includeDependenciesRecursively: false` needs `"allow-extension"`).
   * Workers must keep their entry exports, so never pass `false`.
   */
  preserveEntrySignatures?: rolldown.InputOptions["preserveEntrySignatures"];
}

export interface WorkerBundleOptions {
  id: string;
  main: string;
  compatibility: {
    date: string;
    flags: string[];
  };
  entry:
    | {
        kind: "external";
      }
    | {
        kind: "effect";
        exports: Record<string, WorkerExport>;
      };
  stack: { name: string; stage: string };
  extraOptions: WorkerBuildOptions | undefined;
  rules?: readonly ModuleRule[] | undefined;
}

/**
 * The bundler options for a Worker's props, as local dev records them in its
 * hashed config (a change restarts the instance). Builds themselves go
 * through the Worker's source provider (`resolveSource`), which derives the
 * same options from its {@link SourceContext} in {@link makeRolldownSource}.
 */
export const workerBundleOptions = (options: {
  id: string;
  props: Pick<WorkerProps, "main" | "isExternal" | "exports" | "build" | "rules">;
  compatibility: WorkerBundleOptions["compatibility"];
  stack: WorkerBundleOptions["stack"];
}): WorkerBundleOptions => ({
  id: options.id,
  main: options.props.main!,
  compatibility: options.compatibility,
  entry: options.props.isExternal
    ? { kind: "external" }
    : { kind: "effect", exports: options.props.exports ?? {} },
  stack: options.stack,
  extraOptions: options.props.build,
  rules: options.props.rules,
});

/**
 * Lower the Worker's `rules` to bundler module rules: an import whose
 * resolved file matches a rule's glob is emitted as its own module, of the
 * rule's type, instead of being loaded by rolldown. Globs match the path
 * relative to the entry's directory (`../` included), or an absolute path;
 * `!` globs exclude across all user rules, as in the prebuilt
 * (`bundle: false`) walk. JavaScript, TypeScript and JSON are always bundled.
 */
const toModuleRules = (main: string, rules: readonly ModuleRule[] | undefined) => {
  const globs = rules?.flatMap((rule) => rule.globs) ?? [];
  const exclude = globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
  const root = path.dirname(main);
  const isExcluded = exclude.length ? picomatch(exclude, { dot: true }) : () => false;
  // Absolute globs match any file; relative ones match from the entry's
  // directory (`../shared/*.png` too), and `**` globs from the filesystem
  // root for files outside it.
  const targetsOf = (id: string) => {
    const file = path.normalize(id);
    const relative = path.relative(root, file);
    const outside = relative.startsWith("../") || path.isAbsolute(relative);
    return outside ? [file, relative, file.replace(/^\//, "")] : [file, relative];
  };
  const moduleRules = (rules ?? []).flatMap((rule) => {
    const include = rule.globs.filter((glob) => !glob.startsWith("!"));
    if (include.length === 0) return [];
    const isIncluded = picomatch(include, { dot: true });
    return [
      {
        type: rule.type,
        test: (id: string) => {
          if (/\.([cm]?[jt]sx?|json)$/.test(id)) return false;
          const targets = targetsOf(id);
          return (
            targets.some((target) => isIncluded(target)) &&
            !targets.some((target) => isExcluded(target))
          );
        },
      },
    ];
  });
  return moduleRules.length ? moduleRules : undefined;
};

/**
 * Rolldown resolves imports to real paths, so an absolute glob under a
 * symlink (macOS `/var` → `/private/var`) is matched by its real base.
 */
const realGlobs = (rules: readonly ModuleRule[] | undefined) =>
  Effect.gen(function* () {
    if (rules === undefined) return rules;
    const fs = yield* FileSystem.FileSystem;
    const real = (glob: string) => {
      const negated = glob.startsWith("!");
      const body = negated ? glob.slice(1) : glob;
      if (!path.isAbsolute(body)) return Effect.succeed(glob);
      const { base } = picomatch.scan(body);
      return fs.realPath(base).pipe(
        Effect.map((resolved) => `${negated ? "!" : ""}${resolved}${body.slice(base.length)}`),
        Effect.orElseSucceed(() => glob),
      );
    };
    return yield* Effect.forEach(rules, (rule) =>
      Effect.forEach(rule.globs, real).pipe(Effect.map((globs) => ({ ...rule, globs }))),
    );
  });

/**
 * Point rolldown's failure to load an imported non-JavaScript file (a font,
 * markdown, an image) at the `rules` that upload it as a module. A text file
 * that happens to parse as JavaScript fails later, without a default export.
 */
const withRulesHint = (error: Bundle.BundleError): Bundle.BundleError => {
  const errors = (
    error.cause as { errors?: Array<{ code?: string; id?: string; message?: string }> }
  )?.errors;
  const exts = (errors ?? []).flatMap((e) => {
    const message = e.message ? stripVTControlCharacters(e.message) : "";
    const file =
      e.code === "UNLOADABLE_DEPENDENCY"
        ? message.match(/Could not load (\S+)/)?.[1]
        : e.code === "PARSE_ERROR"
          ? e.id
          : e.code === "MISSING_EXPORT"
            ? message.match(/"default" is not exported by "([^"]+)"/)?.[1]
            : undefined;
    const ext = file && path.extname(file);
    return ext && !/^\.([cm]?[jt]sx?|json|css)$/.test(ext) ? [ext] : [];
  });
  if (exts.length === 0) return error;
  const unique = [...new Set(exts)];
  const isText = (ext: string) => TEXT_EXTENSIONS.test(ext);
  const rules = [
    { type: "Text", exts: unique.filter(isText) },
    { type: "Data", exts: unique.filter((ext) => !isText(ext)) },
  ]
    .filter((rule) => rule.exts.length)
    .map(
      (rule) =>
        `{ type: "${rule.type}", globs: [${rule.exts.map((ext) => `"**/*${ext}"`).join(", ")}] }`,
    );
  return Bundle.BundleError.make({
    message: `${error.message}\nTo import these files as Worker modules, add rules: [${rules.join(", ")}] to the Worker.`,
    cause: error.cause,
  });
};

/** Extensions the hint suggests importing as `Text` rather than `Data`. */
const TEXT_EXTENSIONS =
  /^\.(md|markdown|mdx|csv|tsv|ya?ml|toml|ini|xml|svg|graphql|gql|glsl|wgsl|vert|frag|prompt)$/;

/**
 * Rebuild any `builtin:esm-external-require` plugin instance with OUR copy of
 * rolldown.
 *
 * A separately installed or bundled `@alchemy.run/cloudflare-runtime/rolldown`
 * can resolve a physically different copy of rolldown than the one Alchemy
 * invokes. Builtin plugins — here `builtin:esm-external-require`, which
 * rewrites CJS `require`s of Node builtins into ESM imports under
 * `nodejs_compat` — are `BuiltinPlugin` class instances that rolldown
 * recognizes with an `instanceof` check. An instance constructed by the
 * foreign rolldown copy fails that check and is silently treated as a
 * hookless JS plugin, so CJS requires keep rolldown's throwing `require`
 * shim and the Worker fails Cloudflare startup validation (#880).
 * Reconstructing the builtin from its `_options` with the rolldown copy we
 * actually invoke makes the identity check pass regardless of which copy the
 * plugin package resolved.
 */
const configureCloudflarePlugins = (
  plugins: Array<rolldown.Plugin | null>,
  esmExternalRequirePlugin: (typeof import("rolldown/plugins"))["esmExternalRequirePlugin"],
  aliases: NonNullable<rolldown.InputOptions["resolve"]>["alias"],
): Array<rolldown.Plugin | null> => {
  const aliasKeys = Object.entries(aliases ?? {})
    .filter(([, value]) => !Array.isArray(value) || value.length > 0)
    .map(([key]) => key);
  const isAliased = (id: string) =>
    aliasKeys.some((key) => {
      if (key.endsWith("$")) return id === key.slice(0, -1);
      const wildcard = key.indexOf("*");
      if (wildcard !== -1) {
        const prefix = key.slice(0, wildcard);
        const suffix = key.slice(wildcard + 1);
        return (
          id.length >= prefix.length + suffix.length && id.startsWith(prefix) && id.endsWith(suffix)
        );
      }
      return id === key || id.startsWith(`${key}/`) || id.startsWith(`${key}\\`);
    });
  return plugins.map((plugin) => {
    if (
      typeof plugin === "object" &&
      plugin !== null &&
      "name" in plugin &&
      plugin.name === "builtin:esm-external-require" &&
      "_options" in plugin
    ) {
      const options = plugin._options as Parameters<typeof esmExternalRequirePlugin>[0];
      return esmExternalRequirePlugin(
        options && {
          ...options,
          external: options.external.filter((id) => typeof id !== "string" || !isAliased(id)),
        },
      ) as rolldown.Plugin;
    }
    // Let Rolldown resolve user aliases before compatibility polyfills.
    if (plugin?.resolveId && aliasKeys.length > 0) {
      const hook = plugin.resolveId;
      const handler = typeof hook === "function" ? hook : hook.handler;
      return {
        ...plugin,
        resolveId: {
          ...(typeof hook === "function" ? {} : hook),
          handler(source, importer, options) {
            if (isAliased(source)) return null;
            return handler.call(this, source, importer, options);
          },
        },
      };
    }
    return plugin;
  });
};

export const WorkerBundle = Effect.gen(function* () {
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

  const makeOptions = Effect.fn(function* (options: WorkerBundleOptions) {
    // Loaded lazily so importing the Cloudflare provider (or the CLI, whose
    // command tree reaches this module) never loads rolldown's native
    // binding — only actually bundling a Worker does (#562).
    const [{ default: cloudflareRolldown }, { esmExternalRequirePlugin }] = yield* Effect.promise(
      () =>
        Promise.all([
          import("@alchemy.run/cloudflare-runtime/rolldown"),
          import("rolldown/plugins"),
        ]),
    );
    const realMain = yield* sanitizeMain(options.main);
    const rules = yield* realGlobs(options.rules);
    const cwd = yield* findCwdForBundle(realMain).pipe(
      Effect.mapError((cause) =>
        Bundle.BundleError.make({
          message: `Failed to find cwd for bundle: ${realMain}`,
          cause,
        }),
      ),
      Effect.provide(context),
    );
    // The Cloudflare-flavored plugin set, shared by the parent build and
    // by every nested `?worker` module build (see WorkerModulePlugin.ts).
    const overrides = options.extraOptions?.input;
    // Nested `?worker` builds keep only their entry chunk (see
    // WorkerModulePlugin.ts), so `rules` apply to the parent build alone: a
    // matching import inside a nested worker fails to load rather than
    // pointing at a module that is never uploaded.
    const cloudflarePlugins = (moduleRules?: ReturnType<typeof toModuleRules>) =>
      configureCloudflarePlugins(
        cloudflareRolldown({
          compatibilityDate: options.compatibility.date,
          compatibilityFlags: options.compatibility.flags,
          moduleRules,
        }),
        esmExternalRequirePlugin,
        overrides?.resolve?.alias,
      );
    const workerModules: rolldown.Plugin = workerModulePlugin({
      loadRolldown: () => import("rolldown"),
      nested: async () => ({
        external: ["lightningcss", "fsevents"],
        cwd,
        ...overrides,
        plugins: [overrides?.plugins, cloudflarePlugins(), workerModules],
        checks: {
          unresolvedImport: false,
          ineffectiveDynamicImport: false,
          ...overrides?.checks,
        },
      }),
    });
    const inputOptions: rolldown.InputOptions = {
      preserveEntrySignatures: options.extraOptions?.preserveEntrySignatures,
      // Forever-devtool native modules that vite/chokidar reference behind
      // runtime guards. Rolldown resolves before tree-shaking, so the dead
      // `require('../pkg')` (lightningcss < 1.32) and `require('fsevents')`
      // (darwin-only) trip [UNRESOLVED_IMPORT] before DCE can prune them.
      // See rolldown/tsdown#212.
      external: ["lightningcss", "fsevents"],
      cwd,
      ...overrides,
      input: realMain,
      plugins: [
        overrides?.plugins,
        cloudflarePlugins(toModuleRules(realMain, rules)),
        workerModules,
        options.entry.kind === "effect"
          ? [virtualEntryPlugin(makeEffectVirtualEntry(options.entry.exports, options.stack))]
          : undefined,
      ],
      checks: {
        // Suppress unresolved import warnings for unrelated AWS packages
        unresolvedImport: false,
        // The shared platform boundary keeps guarded Node/Bun adapter imports.
        ineffectiveDynamicImport: false,
        ...overrides?.checks,
      },
    };
    const outputOptions: rolldown.OutputOptions = {
      format: "esm",
      sourcemap: "hidden",
      minify: true,
      keepNames: true,
      // Rolldown's default chunking can split top-level initializer modules
      // (e.g. Drizzle `pgTable` schemas) away from the classes they read,
      // and workerd then evaluates a reader before its imported binding is
      // initialized — the script fails Cloudflare startup validation with
      // `ScriptStartupError: Cannot access '<minified>' before
      // initialization` (#749). `strictExecutionOrder` wraps cross-chunk
      // modules so evaluation follows ESM semantics regardless of how the
      // graph was chunked. See DrizzleSchemaChunks.test.ts.
      strictExecutionOrder: true,
      ...options.extraOptions?.output,
    };
    return { inputOptions, outputOptions, extraOptions: options.extraOptions };
  });

  const sanitizeMain = (main: string) =>
    resolveMainPath(main).pipe(
      Effect.mapError((cause) =>
        Bundle.BundleError.make({
          message: `Failed to find real path for bundle: ${main}`,
          cause,
        }),
      ),
      Effect.provide(context),
    );

  return {
    build: flow(
      makeOptions,
      Effect.flatMap((resolved) =>
        Bundle.build(resolved.inputOptions, resolved.outputOptions, resolved.extraOptions),
      ),
      Effect.mapError(withRulesHint),
    ),
    watch: flow(
      makeOptions,
      Stream.fromEffect,
      Stream.flatMap((resolved) =>
        Bundle.watch(resolved.inputOptions, resolved.outputOptions, resolved.extraOptions),
      ),
      Stream.map((event) =>
        event._tag === "Error" ? { ...event, error: withRulesHint(event.error) } : event,
      ),
    ),
  };
});

/**
 * Export a bridge class under `name`. A name that isn't an identifier, like a
 * Domain model's `Billing.AccountAggregate`, is exported by alias.
 */
const exportClass = (name: string, base: string, local: string) =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? `export class ${name} extends ${base} {}`
    : `const ${local} = class extends ${base} {};\nexport { ${local} as ${JSON.stringify(name)} };`;

export const makeEffectVirtualEntry = (
  exports: Record<string, WorkerExport>,
  stack: { name: string; stage: string },
) => {
  const doClasses: string[] = [];
  const wfClasses: string[] = [];
  const migrations: Record<string, SqlMigrationSnapshot> = {};
  for (const [className, entry] of Object.entries(exports)) {
    if (isDurableObjectExport(entry)) {
      doClasses.push(className);
    } else if (isWorkflowExport(entry)) {
      wfClasses.push(className);
    } else if (entry.kind === "sqlMigrations") {
      migrations[className] = entry.snapshot;
    }
  }
  const hasMigrations = Object.keys(migrations).length > 0;
  const hasDoClasses = doClasses.length > 0;
  const hasWfClasses = wfClasses.length > 0;
  return (importPath: string) => `
import * as Effect from "effect/Effect";

import { env, DurableObject, WorkerEntrypoint${hasWfClasses ? ", WorkflowEntrypoint" : ""} } from "cloudflare:workers";
import { makeDurableObjectBridge, makeWorkerBridge${hasWfClasses ? ", makeWorkflowBridge" : ""}${hasMigrations ? ", withSqlMigrations" : ""} } from "@alchemy.run/cloudflare/Bridge";
import { makeEntrypointLayer } from "alchemy/Runtime";

import entrypoint from ${JSON.stringify(importPath)};

const meta = {
  entrypoint: ${hasMigrations ? `withSqlMigrations(entrypoint, ${JSON.stringify(migrations)})` : "entrypoint"},
  stack: {
    name: ${JSON.stringify(stack.name)},
    stage: ${JSON.stringify(stack.stage)},
  },
};

export default makeWorkerBridge(WorkerEntrypoint, meta);

// export class proxy stubs for Durable Objects and Workflows
${[
  ...(hasDoClasses
    ? [
        "const DurableObjectBridge = makeDurableObjectBridge(DurableObject, meta);",
        ...doClasses.map((id, i) =>
          exportClass(id, `DurableObjectBridge(${JSON.stringify(id)})`, `DurableObjectClass${i}`),
        ),
      ]
    : []),
  ...(hasWfClasses
    ? [
        "const WorkflowBridgeFn = makeWorkflowBridge(WorkflowEntrypoint, meta);",
        ...wfClasses.map((id, i) =>
          exportClass(id, `WorkflowBridgeFn(${JSON.stringify(id)})`, `WorkflowClass${i}`),
        ),
      ]
    : []),
].join("\n")}
`;
};

/**
 * The default source provider: bundle `props.main` with rolldown.
 *
 * `hash()` deliberately builds — recomputing "without building" is
 * impossible for rolldown without a source-tree memo hash, and today's
 * semantics accept that. The build routes through `Artifacts.cached`
 * under the same key as `build()`, so a diff that had to build shares
 * its output with the reconcile in the same run.
 */
export const makeRolldownSource = (options: {
  main: string;
  rules: readonly ModuleRule[] | undefined;
}): SourceProvider => {
  const bundleOptions = (ctx: SourceContext): WorkerBundleOptions => ({
    id: ctx.id,
    main: options.main,
    compatibility: ctx.compatibility,
    entry: ctx.entry,
    stack: ctx.stack,
    extraOptions: ctx.extraOptions,
    rules: options.rules,
  });
  return bundleSource({
    build: (ctx) =>
      Effect.gen(function* () {
        const bundler = yield* WorkerBundle;
        return yield* bundler.build(bundleOptions(ctx));
      }).pipe(Artifacts.cached("build")),
    watch: (ctx) =>
      Effect.gen(function* () {
        const bundler = yield* WorkerBundle;
        return bundler.watch(bundleOptions(ctx));
      }),
  });
};
