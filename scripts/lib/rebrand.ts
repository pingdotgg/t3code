// @effect-diagnostics nodeBuiltinImport:off - Bundler plugins and config files run before any Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

type Environment = Readonly<Record<string, string | undefined>>;
type Catalog = Readonly<Record<string, unknown>>;

export const DEFAULT_APP_NAME = "T3 Code";

/** The product name a build shows users. `T3CODE_APP_NAME` sets it for a fork. */
export function resolveAppName(env: Environment): string {
  const name = env.T3CODE_APP_NAME?.trim();
  if (!name) return DEFAULT_APP_NAME;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .&'-]*$/u.test(name)) {
    throw new Error(`T3CODE_APP_NAME must be a plain product name such as Acme Code, not ${name}.`);
  }
  return name;
}

/** The name a standalone build shows in place of T3 Code; null leaves every build untouched. */
export function rebrandName(env: Environment): string | null {
  if (!/^(1|true)$/i.test(env.T3CODE_STANDALONE?.trim() ?? "")) return null;
  const name = resolveAppName(env);
  return name === DEFAULT_APP_NAME ? null : name;
}

// T3 Connect, T3 Chat, the T3 account and T3 Tools are services and a company the fork does not run.
const KEPT = String.raw`(?:Connect|Chat|Account|account|Tools)\b`;
// Source names the product only before a space, so `T3-Code-1.0.dmg` and `com.t3tools.T3Code` stay.
const IN_SOURCE = new RegExp(String.raw`\bT3\s+Code\b|\bT3(?=\s+[A-Za-z])(?!\s+${KEPT})`, "g");
// Translations also write "T3-Thread", "thread do T3" and the account as "T3-Konto" or "compte T3".
const KEPT_IN_TRANSLATION = String.raw`(?:${KEPT}|[Kk]onto\b|アカウント|계정|账户|帐户)`;
const IN_TRANSLATION = new RegExp(
  String.raw`\bT3[\s-]+Code\b|(?<!(?:cuenta de|compte|conta|аккаунт)\s)\bT3\b(?![\s-]*${KEPT_IN_TRANSLATION})`,
  "g",
);

/** Renames the product in prose; `t3code`, `T3CODE_*` and the `t3` command never match. */
export function rebrandText(text: string, name: string, pattern = IN_SOURCE): string {
  return text.replace(pattern, name);
}

export function rebrandStrings<T>(value: T, name: string, pattern = IN_SOURCE): T {
  if (typeof value === "string") return rebrandText(value, name, pattern) as T;
  if (Array.isArray(value)) return value.map((item) => rebrandStrings(item, name, pattern)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rebrandStrings(item, name, pattern)]),
    ) as T;
  }
  return value;
}

// generaltranslation's hashSource for an entry without context: SHA-256 of the sorted-key JSON.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// generaltranslation's sanitizeJsxChildren: a `<T>` entry hashes without its element indexes.
function sanitizeJsx(child: unknown): unknown {
  if (Array.isArray(child)) return child.map(sanitizeJsx);
  if (child === null || typeof child !== "object") return child;
  const node = child as Record<string, unknown>;
  const keys = Object.keys(node);
  if (
    typeof node.k === "string" &&
    (keys.length === 1 ||
      (keys.length === 2 && (typeof node.i === "number" || typeof node.v === "string")) ||
      (keys.length === 3 && typeof node.v === "string" && typeof node.i === "number"))
  ) {
    return { k: node.k, ...(node.v ? { v: node.v } : {}) };
  }
  const data = node.d as { b?: Record<string, unknown>; t?: unknown } | undefined;
  return {
    ...(node.c ? { c: sanitizeJsx(node.c) } : {}),
    ...(data?.b
      ? {
          b: Object.fromEntries(
            Object.entries(data.b).map(([key, value]) => [key, sanitizeJsx(value)]),
          ),
        }
      : {}),
    ...(data?.t ? { t: data.t } : {}),
  };
}

export const catalogKey = (source: unknown, dataFormat: "ICU" | "JSX"): string =>
  NodeCrypto.createHash("sha256")
    .update(
      stableStringify({ dataFormat, source: dataFormat === "JSX" ? sanitizeJsx(source) : source }),
    )
    .digest("hex")
    .slice(0, 16);

/**
 * GT looks a translation up by the hash of its English source, so renaming the product in the
 * source moves every entry that names it to a new key. `source` is the app's en.json.
 */
export function rebrandCatalog(source: Catalog, catalog: Catalog, name: string): Catalog {
  const moved = new Map<string, string>();
  for (const [key, text] of Object.entries(source)) {
    const branded = rebrandStrings(text, name);
    if (stableStringify(branded) === stableStringify(text)) continue;
    const format = (["ICU", "JSX"] as const).find(
      (candidate) => catalogKey(text, candidate) === key,
    );
    if (format) moved.set(key, catalogKey(branded, format));
  }
  return Object.fromEntries(
    Object.entries(catalog).map(([key, value]) => [
      moved.get(key) ?? key,
      rebrandStrings(value, name, IN_TRANSLATION),
    ]),
  );
}

const CATALOG_DIR = /^(.*[\\/]i18n[\\/]translations[\\/])[\w-]+\.json$/;

export function rebrandCatalogFile(path: string, name: string): Catalog | null {
  const match = CATALOG_DIR.exec(path);
  if (!match) return null;
  const read = (file: string): Catalog => JSON.parse(NodeFS.readFileSync(file, "utf8"));
  return rebrandCatalog(read(`${match[1]}en.json`), read(path), name);
}

/**
 * Renames T3 Code in a standalone build's source and catalogs; other builds get no plugin. Works in
 * Vite and in `vp pack`, so the web, desktop and server bundles share it.
 */
export function rebrandPlugin(env: Environment) {
  const name = rebrandName(env);
  if (!name) return undefined;
  return {
    name: "t3code:rebrand",
    enforce: "pre" as const,
    load(id: string) {
      const catalog = rebrandCatalogFile(id.split("?", 1)[0]!, name);
      return catalog ? { code: JSON.stringify(catalog), moduleType: "json" as const } : null;
    },
    transform(code: string, id: string) {
      if (id.includes("node_modules") || !/\.[cm]?[jt]sx?$/.test(id.split("?", 1)[0]!)) return null;
      const branded = rebrandText(code, name);
      return branded === code ? null : { code: branded, map: null };
    },
    // After the page-title plugin, which writes the T3 Code title for this build's channel.
    transformIndexHtml: {
      order: "post" as const,
      handler: (html: string) => rebrandText(html, name),
    },
  };
}
