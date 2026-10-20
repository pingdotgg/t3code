import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const CONFIG_FILES = [
  "app.config.ts",
  "app.config.mts",
  "app.config.js",
  "app.config.mjs",
  "app.config.cjs",
];
const JSON_CONFIG_FILES = ["app.config.json", "app.json"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A `projectId` whose whole value is one quoted string: the entry ends at the
// quote, then after any space and comments a separator or the end of the
// file; an operator may follow a line break or a comment. A comment is
// matched whole (a line comment through its line break), so a separator
// inside one cannot end the entry. An EAS project id is a UUID; another
// service's (Firebase's, say) is not, and names no EAS project.
const QUOTED_PROJECT_ID =
  /\bprojectId["']?\s*:\s*["'`]([^"'`\n]*)["'`](?=(?:\s|\/\/[^\n\r\u2028\u2029]*(?:[\n\r\u2028\u2029]|$)|\/\*(?:[^*]|\*(?!\/))*\*\/)*(?:[,;})\]]|$))/gi;
const PROJECT_ID_MENTION = /\bprojectId\b/gi;
// Reading a config is linear in its size per entry; one this large is not an
// app config but a file made to keep the server busy.
const MAX_CONFIG_LENGTH = 256 * 1024;
// Each entry is read against the rest of the file, so a file with many is
// quadratic; an app config mentions its project a few times at most.
const MAX_MENTIONS = 32;

// A spread after an entry may replace it from elsewhere: anywhere after it,
// at any depth, since a spread in an enclosing object replaces the entry
// too, and a comment or string could hide a brace from a scan of the
// entry's own object. An assignment over the config may replace it from
// anywhere: `Object.assign(defaults, overrides)` names the call before
// both arguments.
const SPREAD_LATER = /\.\.\./;
// Space, a comment, or an opening parenthesis: what may sit between `...`
// and the thing spread. Sticky, so the scan moves through the file once.
const SPREAD_FILLER = /(?:\s+|\/\/[^\n\r\u2028\u2029]*|\/\*(?:[^*]|\*(?!\/))*\*\/|\()/y;
// `config`'s `extra` and `extra.eas` entries, the holders of the EAS id
// (dotted, optional-chained or in brackets).
const EXTRA_OF_CONFIG = String.raw`config(?:\s*\??\.\s*extra|\s*(?:\?\.)?\s*\[\s*["'\x60]extra["'\x60]\s*\])`;
const EAS_OF_CONFIG =
  EXTRA_OF_CONFIG + String.raw`(?:\s*\??\.\s*eas|\s*(?:\?\.)?\s*\[\s*["'\x60]eas["'\x60]\s*\])`;
// The holder, and nothing more of it: no further property, call or operator
// (`?? {}` keeps it, so it may follow).
const HOLDER_END = String.raw`(?![\p{ID_Continue}$\u200c\u200d\\]|\s*(?:[.\[(]|\?(?!\?)))`;
const HOLDER_AT = {
  extra: new RegExp(EXTRA_OF_CONFIG + HOLDER_END, "uy"),
  eas: new RegExp(EAS_OF_CONFIG + HOLDER_END, "uy"),
};
// `config` and no more of it: not an identifier continuing (`$`, Unicode
// letters and a `\u` escape do, where `\b` would not), nor a property.
const CONFIG_AT = new RegExp("config" + HOLDER_END, "uy");

/**
 * How a dynamic config with no EAS id of its own relates to app.json's:
 * `spreads` when it spreads `config`, the one Expo hands it (app.json's
 * entry carries through), and nothing else but `config`'s own `extra` or
 * `extra.eas`, which keep the entry wherever they land; `replaces` when it
 * spreads anything else (`config.extra.preview` too), which may replace
 * that entry; `unclear` when it spreads nothing,
 * since it may return `config` changed, or a config of its own that Expo
 * uses alone. A `...` inside a comment after a spread is skipped with the
 * comment, so the scan is linear.
 */
const staticConfigUse = (source: string): "spreads" | "replaces" | "unclear" => {
  let spreads = 0;
  let at = 0;
  for (;;) {
    const next = source.indexOf("...", at);
    if (next === -1) return spreads > 0 ? "spreads" : "unclear";
    at = next + 3;
    for (;;) {
      SPREAD_FILLER.lastIndex = at;
      const filler = SPREAD_FILLER.exec(source);
      if (!filler) break;
      at += filler[0].length;
    }
    CONFIG_AT.lastIndex = at;
    if (CONFIG_AT.test(source)) {
      spreads++;
      continue;
    }
    HOLDER_AT.extra.lastIndex = at;
    HOLDER_AT.eas.lastIndex = at;
    if (!HOLDER_AT.extra.test(source) && !HOLDER_AT.eas.test(source)) return "replaces";
  }
};
const ASSIGNS_OVER = /\bObject\s*\.\s*assign\b|\bassign\s*\(/;
// A config may replace the object holding the entry, or the whole config,
// from somewhere this scan cannot read: an assignment to `.extra` or `.eas`,
// (as a property or in brackets), a `delete` of anything, or another file it
// requires or imports.
const REPLACES_HOLDER =
  /(?:\.\s*(?:extra|eas)|\[\s*["'`](?:extra|eas)["'`]\s*\])\s*=(?!=)|\bdelete\b|\brequire\s*\(|\bimport\s*\(/;
// An `extra:` or `eas:` entry in a config that takes its id from app.json:
// unless its value is an object that starts by spreading that same entry
// of `config` (`config.extra`, `config.extra.eas`; spreading the whole
// config there puts the id elsewhere), it replaces app.json's (`extra: {}`
// drops the id). The key may be quoted
// or computed; a shorthand `extra` or `eas` entry replaces it too. More
// entries than mentions are allowed are not read.
const EXTRA_OR_EAS = /(?:\b(extra|eas)|["'`](extra|eas)["'`]\s*\]?)\s*:\s*/g;
const SHORTHAND_EXTRA_OR_EAS = /(?<![.\p{ID_Continue}$])(?:extra|eas)\s*(?=[,}])/u;
const keepsStaticExtra = (source: string): boolean => {
  if (SHORTHAND_EXTRA_OR_EAS.test(source)) return false;
  let entries = 0;
  for (const entry of source.matchAll(EXTRA_OR_EAS)) {
    if (++entries > MAX_MENTIONS) return false;
    const holder = HOLDER_AT[(entry[1] ?? entry[2]) as "extra" | "eas"];
    let at = entry.index + entry[0].length;
    if (source[at] !== "{") return false;
    at++;
    for (;;) {
      SPREAD_FILLER.lastIndex = at;
      const filler = SPREAD_FILLER.exec(source);
      if (!filler) break;
      at += filler[0].length;
    }
    if (!source.startsWith("...", at)) return false;
    at += 3;
    for (;;) {
      SPREAD_FILLER.lastIndex = at;
      const filler = SPREAD_FILLER.exec(source);
      if (!filler) break;
      at += filler[0].length;
    }
    holder.lastIndex = at;
    if (!holder.test(source)) return false;
  }
  return true;
};

const Extra = Schema.optional(
  Schema.Struct({
    eas: Schema.optional(Schema.Struct({ projectId: Schema.optional(Schema.String) })),
  }),
);
// Expo reads a static config wrapped in `expo` or not, and as JSON5; one
// this cannot decode (comments, say) still names a project, unknown here.
const decodeAppJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ expo: Schema.optional(Schema.Struct({ extra: Extra })), extra: Extra }),
  ),
);

/**
 * The project ids a directory's app config names. Read, never run: a dynamic
 * config is the project's own code, which an agent may have written. Its text
 * is taken as it is, comments included, so an old id left in a comment makes
 * the answer ambiguous rather than wrong. app.config.json or app.json count
 * too: a dynamic config may only replace theirs on some builds. Null when
 * the project is unknown: the config sets or changes it some other way than
 * a literal, or a config cannot be read.
 */
const projectIdsOf = Effect.fn("easProjectId.projectIdsOf")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ids: Array<string> = [];
  const configFile = yield* Effect.findFirst(CONFIG_FILES, (file) =>
    fs.exists(path.join(dir, file)).pipe(Effect.orElseSucceed(() => false)),
  );
  if (Option.isSome(configFile)) {
    const source = yield* fs
      .readFileString(path.join(dir, configFile.value))
      .pipe(Effect.orElseSucceed(() => "projectId"));
    // Every mention of `projectId` must be a quoted entry: one set from a
    // variable, or assigned later, could be any project, and makes the
    // answer unknown.
    if (source.length > MAX_CONFIG_LENGTH) return null;
    const mentions = source.match(PROJECT_ID_MENTION)?.length ?? 0;
    if (mentions > MAX_MENTIONS) return null;
    const entries = [...source.matchAll(QUOTED_PROJECT_ID)];
    const quoted = entries.map((match) => match[1]!);
    // A template that interpolates could be any project too, and so could
    // one a spread after the entry, or an assignment anywhere, replaces;
    if (
      quoted.length !== mentions ||
      quoted.some((id) => id.includes("${")) ||
      ASSIGNS_OVER.test(source) ||
      REPLACES_HOLDER.test(source) ||
      entries.some((match) => SPREAD_LATER.test(source.slice(match.index + match[0].length)))
    ) {
      return null;
    }
    // Only a config shown to spread `config` and nothing else carries app.json's
    // entry through unchanged; any other shape could use or replace it.
    if (
      !quoted.some((id) => UUID.test(id)) &&
      (staticConfigUse(source) !== "spreads" || !keepsStaticExtra(source))
    ) {
      return null;
    }
    ids.push(...quoted.filter((id) => UUID.test(id)).map((id) => id.toLowerCase()));
  }
  for (const file of JSON_CONFIG_FILES) {
    const json = yield* fs.readFileString(path.join(dir, file)).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        Effect.succeed(error.reason._tag === "NotFound" ? Option.none<string>() : null),
      ),
    );
    // A config that is there but cannot be read could name any project.
    if (json === null) return null;
    if (Option.isNone(json)) continue;
    const decoded = decodeAppJson(json.value);
    if (Option.isNone(decoded)) return null;
    const id = (decoded.value.expo ?? decoded.value).extra?.eas?.projectId;
    if (id !== undefined && UUID.test(id)) ids.push(id.toLowerCase());
    // Expo reads only the first static config it finds.
    break;
  }
  return ids;
});

/**
 * The EAS project of a workspace's Expo app: its root, or one app below
 * `apps/` or `packages/`. None when there is none, a config is ambiguous, or
 * the apps disagree, so the caller asks for an explicit choice instead of
 * billing the wrong project.
 */
export const findEasProjectId = Effect.fn("easProjectId.findEasProjectId")(function* (
  workspaceRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const isDirectory = (child: string) =>
    fs.stat(child).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
  // Only a directory can be an app; a README or .DS_Store beside them is not one.
  const children = (parent: string) =>
    fs.readDirectory(path.join(workspaceRoot, parent)).pipe(
      Effect.map((names) => names.map((name) => path.join(workspaceRoot, parent, name))),
      Effect.flatMap((paths) =>
        Effect.forEach(paths, (child) =>
          Effect.map(isDirectory(child), (directory) => (directory ? [child] : [])),
        ),
      ),
      Effect.map((kept) => kept.flat()),
      Effect.orElseSucceed(() => []),
    );
  const directories = [
    workspaceRoot,
    ...(yield* children("apps")),
    ...(yield* children("packages")),
  ];
  const ids = yield* Effect.forEach(directories, projectIdsOf, { concurrency: 4 });
  // An app whose project is unknown could be the one the thread works on.
  if (ids.some((found) => found === null)) return Option.none<string>();
  const distinct = new Set(ids.flatMap((found) => found ?? []));
  return distinct.size === 1 ? Option.some([...distinct][0]!) : Option.none<string>();
});
