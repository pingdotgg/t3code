import type { ImportDeclaration, Program } from "@oxc-project/types";
import picomatch from "picomatch";
import type * as rolldown from "rolldown";

/**
 * `rolldown` and `rolldown/parseAst` load `@rolldown/binding-*` at module
 * scope, so they are imported lazily on first use (#562).
 */
const loadRolldown = () => import("rolldown");
const loadParseAst = () => import("rolldown/parseAst");

/**
 * Packages whose namespace imports are rewritten by default. Their root
 * modules re-export every service (`export * as Lambda from "./Lambda/index.ts"`),
 * and every one of them declares `"sideEffects": false`.
 */
export const DEFAULT_NAMESPACE_IMPORT_PACKAGES: ReadonlyArray<string> = [
  "alchemy",
  "@alchemy.run/*",
];

/**
 * Options for {@link namespaceImportPlugin}.
 */
export interface NamespaceImportPluginOptions {
  /**
   * Extra package names or globs whose namespace imports are rewritten, in
   * addition to {@link DEFAULT_NAMESPACE_IMPORT_PACKAGES}. Matched with
   * picomatch against the package name of the import specifier. Only list
   * packages that declare `"sideEffects": false`.
   */
  readonly packages?: ReadonlyArray<string>;
}

const SUPPORTED_FILE_RE = /\.(?:m?[jt]sx?|cjs|cts)$/;

/**
 * Rolldown plugin that rewrites namespace imports of barrel packages into
 * named imports, so `experimental.lazyBarrel` only compiles the re-exports
 * a module actually uses.
 *
 * ```ts
 * import * as AWS from "@alchemy.run/aws";
 * AWS.Lambda.Function;
 * // becomes
 * import { Lambda as AWS$Lambda } from "@alchemy.run/aws";
 * AWS$Lambda.Function;
 * ```
 *
 * Rolldown loads every export of a barrel imported with `import * as ns`,
 * even when only `ns.X` is read, so without this rewrite one
 * `import * as AWS from "@alchemy.run/aws"` parses every AWS service.
 *
 * A namespace is only rewritten when every reference to its name is a
 * static member access (`ns.X`, or `ns.X` in a type). Anything else —
 * passing the namespace around, computed access, a shadowing binding,
 * JSX — leaves the import untouched.
 */
export const namespaceImportPlugin = (
  options: NamespaceImportPluginOptions = {},
): rolldown.Plugin => {
  const isMatch = picomatch([...DEFAULT_NAMESPACE_IMPORT_PACKAGES, ...(options.packages ?? [])]);
  const matchesSpecifier = (specifier: string) => {
    const name = packageNameOf(specifier);
    return name !== null && isMatch(name);
  };

  return {
    name: "alchemy:namespace-imports",
    transform: {
      filter: { id: SUPPORTED_FILE_RE, code: /import\s*\*\s*as\s/ },
      async handler(code, id, meta) {
        const edits = await collectNamespaceImportEdits(code, id, matchesSpecifier);
        if (edits.length === 0) return null;
        const s = meta.magicString ?? new (await loadRolldown()).RolldownMagicString(code);
        for (const edit of edits) s.overwrite(edit.start, edit.end, edit.text);
        return { code: s };
      },
    },
  };
};

/** A source replacement over `[start, end)`. */
export interface NamespaceImportEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Returns the edits that rewrite each eligible namespace import in `code`
 * (see {@link namespaceImportPlugin}), or an empty array when nothing is
 * rewritten.
 */
export async function collectNamespaceImportEdits(
  code: string,
  filename: string,
  matchesSpecifier: (specifier: string) => boolean,
): Promise<NamespaceImportEdit[]> {
  const { parseAst } = await loadParseAst();
  let program: Program;
  try {
    program = parseAst(code, { sourceType: "module", lang: langOf(filename) }, filename);
  } catch {
    return [];
  }

  const candidates = new Map<string, ImportDeclaration>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    if (statement.importKind === "type" || statement.phase) continue;
    if (statement.attributes.length > 0) continue;
    const [specifier, ...rest] = statement.specifiers;
    if (specifier?.type !== "ImportNamespaceSpecifier" || rest.length > 0) continue;
    if (!matchesSpecifier(statement.source.value)) continue;
    // Two imports binding the same name is a syntax error; skip defensively.
    if (candidates.has(specifier.local.name)) {
      candidates.delete(specifier.local.name);
      continue;
    }
    candidates.set(specifier.local.name, statement);
  }
  if (candidates.size === 0) return [];

  interface Usage {
    /** Identifier nodes with the namespace's name, wherever they appear. */
    identifiers: number;
    /** Rewritable member accesses: `[start, end, member, isType]`. */
    members: Array<readonly [number, number, string, boolean]>;
    /** A reference that can't be rewritten (JSX). */
    blocked: boolean;
  }
  const usages = new Map<string, Usage>(
    [...candidates.keys()].map((name) => [name, { identifiers: 0, members: [], blocked: false }]),
  );

  // `inType` is set once the walk enters a type: everything below it is
  // erased by the TypeScript transform, so its members import as `type`.
  const visit = (node: unknown, inType: boolean): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, inType);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const n = node as { type?: unknown } & Record<string, unknown>;
    const type = n.type as string;
    if (type === "Identifier" || type === "JSXIdentifier") {
      const usage = usages.get(n.name as string);
      if (usage) {
        usage.identifiers++;
        if (type === "JSXIdentifier") usage.blocked = true;
      }
      // Fall through: a binding's `typeAnnotation` hangs off its Identifier.
    } else if (type === "TSImportEqualsDeclaration") {
      // `import L = AWS.Lambda` aliases a value through a type-shaped name.
      const usage = usages.get(rootName(n.moduleReference));
      if (usage) usage.blocked = true;
    } else if (type === "MemberExpression" || type === "TSQualifiedName") {
      const [object, property] =
        type === "MemberExpression" ? [n.object, n.property] : [n.left, n.right];
      const o = object as { type: string; name?: string };
      const p = property as { type: string; name?: string };
      const usage = o.type === "Identifier" ? usages.get(o.name!) : undefined;
      if (usage && p.type === "Identifier" && n.computed !== true) {
        usage.members.push([n.start as number, n.end as number, p.name!, inType]);
      }
    }
    const childInType = inType || TYPE_NODES.has(type);
    for (const key in n) {
      if (key === "parent" || key === "type" || key === "start" || key === "end") continue;
      visit(n[key], childInType);
    }
  };
  visit(program.body, false);

  const edits: NamespaceImportEdit[] = [];
  const taken = new Set<string>();
  for (const [name, declaration] of candidates) {
    const usage = usages.get(name)!;
    // One identifier is the import's own binding; every other one must be
    // the object of a rewritable member access.
    if (usage.blocked || usage.members.length === 0) continue;
    if (usage.identifiers !== usage.members.length + 1) continue;

    const aliases = new Map<string, { alias: string; value: boolean }>();
    for (const [, , member, isType] of usage.members) {
      const existing = aliases.get(member);
      if (existing) {
        existing.value ||= !isType;
        continue;
      }
      const alias = uniqueAlias(code, taken, `${name}$${member}`);
      taken.add(alias);
      aliases.set(member, { alias, value: !isType });
    }
    const specifiers = [...aliases]
      .map(([member, { alias, value }]) => `${value ? "" : "type "}${member} as ${alias}`)
      .join(", ");
    const source = code.slice(declaration.source.start, declaration.source.end);
    edits.push({
      start: declaration.start,
      end: declaration.end,
      text: `import { ${specifiers} } from ${source};`,
    });
    for (const [start, end, member] of usage.members) {
      edits.push({ start, end, text: aliases.get(member)!.alias });
    }
  }
  return edits;
}

/**
 * Nodes whose descendants are all types. `typeof ns.X` is a type query over
 * a value, which a `type` import still satisfies.
 */
const TYPE_NODES = new Set([
  "TSTypeAnnotation",
  "TSTypeReference",
  "TSTypeQuery",
  "TSInterfaceDeclaration",
  "TSInterfaceHeritage",
  "TSClassImplements",
  "TSTypeAliasDeclaration",
  "TSTypeParameterInstantiation",
  "TSTypeParameterDeclaration",
]);

/** The leftmost identifier of `a.b.c` (or `a`), or `""`. */
const rootName = (node: unknown): string => {
  let n = node as { type?: string; name?: string; left?: unknown; object?: unknown } | null;
  while (n && (n.type === "TSQualifiedName" || n.type === "MemberExpression")) {
    n = (n.left ?? n.object) as typeof n;
  }
  return n?.type === "Identifier" ? n.name! : "";
};

/** The package name of a bare import specifier, or `null` for relative/absolute ones. */
const packageNameOf = (specifier: string): string | null => {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes(":")) {
    return null;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
};

const langOf = (filename: string): "js" | "jsx" | "ts" | "tsx" => {
  const clean = filename.replace(/[?#].*$/, "");
  if (clean.endsWith(".tsx")) return "tsx";
  if (clean.endsWith(".jsx")) return "jsx";
  // TS is a superset of JS for parsing published `.js` files.
  return "ts";
};

/** `base`, suffixed until it occurs nowhere in `code` and isn't already `taken`. */
const uniqueAlias = (code: string, taken: ReadonlySet<string>, base: string): string => {
  let alias = base;
  while (code.includes(alias) || taken.has(alias)) alias += "$";
  return alias;
};
