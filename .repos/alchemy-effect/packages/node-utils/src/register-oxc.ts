import { randomUUID } from "node:crypto";
import {
  registerHooks,
  type LoadFnOutput,
  type LoadHookContext,
  type ResolveFnOutput,
  type ResolveHookContext,
} from "node:module";
import { pathToFileURL } from "node:url";
import type {
  ImportLoader,
  ImportLoaderRegistrationOptions,
} from "./import-loader.ts";
import {
  filePathOfUrl,
  isFileLikeSpecifier,
  isProjectPath,
  SpecifierResolver,
  splitSpecifierMetadata,
} from "./resolve-specifier.ts";
import { SourceTransformer } from "./transform-source.ts";

export type {
  ImportLoader as RegisteredOxcImporter,
  ImportLoaderRegistrationOptions as RegisterOxcOptions,
  SourceTransform,
  SourceTransformResult,
  TransformContext,
} from "./import-loader.ts";

const protocol = "alchemy-import:";
const namespaceParameter = "alchemy-import-namespace";
const globalRegistrationKey = Symbol.for(
  "@alchemy.run/node-utils/register-oxc",
);

interface ImportRequest {
  readonly namespace?: string | undefined;
  readonly parentURL: string;
  readonly specifier: string;
}

type NextResolve = (
  specifier: string,
  context?: Partial<ResolveHookContext>,
) => ResolveFnOutput;

const namespaceOf = (url: string | undefined) => {
  if (url === undefined || !url.startsWith("file:")) return undefined;
  return new URL(url).searchParams.get(namespaceParameter) ?? undefined;
};

const withoutNamespace = (url: string) => {
  if (!url.startsWith("file:")) return url;
  const parsed = new URL(url);
  parsed.searchParams.delete(namespaceParameter);
  return parsed.href;
};

const withNamespace = (url: string, namespace: string) => {
  const parsed = new URL(url);
  parsed.searchParams.set(namespaceParameter, namespace);
  return parsed.href;
};

const parseRequest = (specifier: string): ImportRequest | undefined => {
  if (!specifier.startsWith(protocol)) return undefined;
  return JSON.parse(decodeURIComponent(specifier.slice(protocol.length)));
};

/** Specifiers Node owns outright: builtins, data URLs, remote schemes. */
const isForeignSpecifier = (specifier: string) =>
  /^(?:node:|data:|[a-z][a-z\d+.-]*:\/\/)/i.test(specifier) &&
  !specifier.startsWith("file:");

const notFoundCodes = new Set([
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
  "ERR_UNSUPPORTED_DIR_IMPORT",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
]);

const isNotFound = (error: unknown): error is Error & { url?: string } =>
  error instanceof Error &&
  notFoundCodes.has((error as { code?: string }).code ?? "");

/**
 * The file Node could not find, from the error it raised. Node names the
 * resolved target (`url` on ESM errors, the message on CommonJS ones) —
 * for a package `exports` entry pointing at emitted JavaScript that was
 * never built, that is the `.js` path whose `.ts` source we can substitute.
 */
const missingPathOf = (error: Error & { url?: string }) => {
  if (error.url !== undefined) return filePathOfUrl(error.url);
  const match = error.message.match(/^Cannot find module '([^']+)'/);
  if (match === null) return undefined;
  const [, target] = match;
  if (target === undefined) return undefined;
  if (target.startsWith("file:")) return filePathOfUrl(target);
  return target.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(target)
    ? target
    : undefined;
};

/** A `require()` reaching the hooks: Node's CommonJS resolver wants paths, not URLs. */
const isRequireContext = (context: ResolveHookContext) =>
  context.conditions?.includes("require") === true &&
  !context.conditions.includes("import");

const resolveWithCandidate = (
  candidate: string,
  metadata: string,
  context: ResolveHookContext,
  nextResolve: NextResolve,
): ResolveFnOutput | undefined => {
  const specifier = isRequireContext(context)
    ? candidate + metadata
    : pathToFileURL(candidate).href + metadata;
  try {
    return nextResolve(specifier, context);
  } catch {
    return undefined;
  }
};

/**
 * tsx-compatible resolution. Node's resolver decides in the end; Oxc's
 * resolver supplies the TypeScript-aware candidate (tsconfig `paths`,
 * `.js` → `.ts` substitution, extensionless and directory imports) that
 * Node would not find on its own.
 */
const resolveSpecifier = (
  resolver: SpecifierResolver,
  specifier: string,
  context: ResolveHookContext,
  nextResolve: NextResolve,
): ResolveFnOutput => {
  if (isForeignSpecifier(specifier)) return nextResolve(specifier, context);

  const parentPath = filePathOfUrl(context.parentURL);
  const { specifier: clean, metadata } = splitSpecifierMetadata(specifier);
  const conditions = context.conditions ?? [];

  // TypeScript's rules apply to project code. Dependencies keep Node's plain
  // resolution so published packages behave exactly as they would without us.
  if (parentPath !== undefined && isProjectPath(parentPath)) {
    const candidate = resolver.resolve(parentPath, clean, conditions);
    if (candidate !== undefined) {
      const resolved = resolveWithCandidate(
        candidate,
        metadata,
        context,
        nextResolve,
      );
      if (resolved !== undefined) return resolved;
    }
  }

  try {
    return nextResolve(specifier, context);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    // A package `exports`/`main` target naming emitted JavaScript that only
    // exists as TypeScript source (workspace packages in a checkout).
    const missing = missingPathOf(error);
    if (missing !== undefined && isFileLikeSpecifier(missing)) {
      const candidate = resolver.resolveMissing(missing, conditions);
      if (candidate !== undefined && candidate !== missing) {
        const resolved = resolveWithCandidate(
          candidate,
          metadata,
          context,
          nextResolve,
        );
        if (resolved !== undefined) return resolved;
      }
    }
    throw error;
  }
};

/**
 * `import data from "./x.json"` without an import attribute is how
 * TypeScript projects import JSON (`resolveJsonModule`); Node insists on
 * `with { type: "json" }` for ESM. Supply it, as tsx does.
 */
const withJsonAttribute = (url: string, context: LoadHookContext) => {
  if (!/\.json(?:[?#]|$)/.test(url) || context.importAttributes?.type) {
    return context;
  }
  return {
    ...context,
    importAttributes: { ...context.importAttributes, type: "json" },
  };
};

/**
 * Registers synchronous Node module hooks that transpile TypeScript with
 * Rolldown's Oxc transformer and resolve it the way TypeScript (and tsx)
 * does. A namespaced registration also provides a scoped import whose
 * namespace propagates through the complete ESM graph.
 */
export const registerOxc = (
  options: ImportLoaderRegistrationOptions = {},
): ImportLoader => {
  // One global (un-namespaced) registration per process. Alchemy starts every
  // Node process with `--import` of a file that calls this, and in-process
  // callers (the dev exec child, tests) may call it again; a second copy of
  // the hooks would only re-run the resolve chain. The marker lives on
  // globalThis because a checkout can load this module twice (src/ and lib/).
  const globalRegistration = globalThis as typeof globalThis & {
    [globalRegistrationKey]?: ImportLoader;
  };
  if (options.namespace === undefined) {
    const existing = globalRegistration[globalRegistrationKey];
    if (existing !== undefined) return existing;
  }
  const transformer = new SourceTransformer(options);
  const resolver = new SpecifierResolver({
    tsconfig: options.tsconfig ?? true,
  });
  const shouldInvalidate = options.shouldInvalidate ?? (() => true);

  // Transformed sources carry inline source maps; Node only applies them to
  // stack traces once source-map support is on.
  const sourceMapsWereEnabled = process.sourceMapsEnabled;
  process.setSourceMapsEnabled(true);

  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const request = parseRequest(specifier);
      const inheritedNamespace = namespaceOf(context.parentURL);
      const namespace =
        options.namespace === undefined
          ? undefined
          : (request?.namespace ?? inheritedNamespace);

      if (options.namespace !== undefined && namespace !== options.namespace) {
        return nextResolve(specifier, context);
      }

      const resolutionContext =
        options.conditions === undefined || options.conditions.length === 0
          ? context
          : {
              ...context,
              conditions: [
                ...new Set([...options.conditions, ...context.conditions]),
              ],
            };
      const resolved = request
        ? resolveSpecifier(
            resolver,
            request.specifier,
            { ...resolutionContext, parentURL: request.parentURL },
            nextResolve,
          )
        : resolveSpecifier(resolver, specifier, resolutionContext, nextResolve);
      if (
        namespace !== undefined &&
        resolved.url.startsWith("file:") &&
        shouldInvalidate(
          withoutNamespace(resolved.url),
          context.parentURL === undefined
            ? undefined
            : withoutNamespace(context.parentURL),
        )
      ) {
        return { ...resolved, url: withNamespace(resolved.url, namespace) };
      }
      return resolved;
    },
    load(url, context, nextLoad): LoadFnOutput {
      const namespace = namespaceOf(url);
      if (options.namespace !== undefined && namespace !== options.namespace) {
        return nextLoad(url, context);
      }

      const cleanUrl = withoutNamespace(url);
      const filePath = filePathOfUrl(cleanUrl);
      if (filePath === undefined) return nextLoad(cleanUrl, context);
      options.onImport?.(cleanUrl);

      if (options.filter !== undefined && !options.filter(filePath)) {
        return nextLoad(cleanUrl, withJsonAttribute(cleanUrl, context));
      }
      const transformed = transformer.transform(
        filePath,
        cleanUrl,
        context.format,
      );
      if (transformed === undefined) {
        return nextLoad(cleanUrl, withJsonAttribute(cleanUrl, context));
      }
      return { ...transformed, shortCircuit: true };
    },
  });

  const loader: ImportLoader = {
    import<T>(specifier: string, parentURL: string) {
      const request: ImportRequest = {
        namespace: options.namespace,
        parentURL: parentURL.startsWith("file:")
          ? parentURL
          : pathToFileURL(parentURL).href,
        specifier,
      };
      return import(
        `${protocol}${encodeURIComponent(JSON.stringify(request))}`
      ) as Promise<T>;
    },
    unregister() {
      hooks.deregister();
      if (globalRegistration[globalRegistrationKey] === loader) {
        delete globalRegistration[globalRegistrationKey];
      }
      if (sourceMapsWereEnabled === false) process.setSourceMapsEnabled(false);
    },
  };
  if (options.namespace === undefined) {
    globalRegistration[globalRegistrationKey] = loader;
  }
  return loader;
};

/**
 * One-shot TypeScript import that leaves the rest of the runtime untouched:
 * a private namespace is registered for the call, so nothing is shared with
 * other imports of the same files. Mirrors tsx's `tsImport`.
 */
export const tsImport = async <T = unknown>(
  specifier: string,
  parentURL: string,
  options: Omit<ImportLoaderRegistrationOptions, "namespace"> = {},
): Promise<T> => {
  const loader = registerOxc({ ...options, namespace: randomUUID() });
  try {
    return await loader.import<T>(specifier, parentURL);
  } finally {
    await loader.unregister();
  }
};
