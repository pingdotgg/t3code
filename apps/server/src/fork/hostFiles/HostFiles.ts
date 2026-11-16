// @effect-diagnostics nodeBuiltinImport:off - Effect's realPath keeps the requested letter case.
import * as NodeFSP from "node:fs/promises";

import { hostPreviewMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isNetworkPath } from "@t3tools/shared/path";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as AssetSigner from "../../assets/AssetSigner.ts";
import { openMediaFile, readMediaFileHeader, type OpenMediaFile } from "../../assets/MediaFile.ts";
import { base64UrlDecodeUtf8, base64UrlEncode } from "../../auth/utils.ts";
import * as ServerConfig from "../../config.ts";
import { isWithinRoot } from "../../workspace/KnownWorkspaces.ts";

const GRANT_TTL_MS = 60 * 60 * 1000;
const OPEN_PROOF_TTL_MS = 5 * 60 * 1000;
// Keeps upstream asset tokens, grants and open proofs from verifying as each other.
const GRANT_SIGNING_DOMAIN = "t3-host-files-v1\n";
const OPEN_PROOF_SIGNING_DOMAIN = "t3-host-files-open-v1\n";
const SNIFF_BYTES = 8192;
const LISTING_LIMIT = 5_000;
const LINE_SUFFIX = /^(.+?)(?::\d+){1,2}$/;
// The router reads these as syntax or matches them only percent-encoded; a drive colon is escaped.
const ROUTE_RESERVED = /[#?:;@&=+$,%*]/;
const DRIVE_PREFIX = /^\/[A-Za-z]:(?=\/|$)/;
const HTML_EXTENSIONS: ReadonlySet<string> = new Set([".html", ".htm"]);
const TYPED_MIME_TYPE = /^(?:image|audio|video|font)\/|^application\/pdf$/;
// A framed report's own styles and scripts must load; top-level reads still show them as text.
const GRANT_MIME_TYPES: ReadonlyMap<string, string> = new Map([
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
]);

/** A folder whose subtree answers at `<origin><urlPrefix>/…`. */
export interface FileRoot {
  /** Absolute host path: "/srv/files", "D:\\files". */
  readonly directory: string;
  /** Decoded URL path of `directory`: "/srv/files", "/D:/files". */
  readonly urlPrefix: `/${string}`;
}

/** What this server serves, fixed at startup. */
export interface Policy {
  readonly roots: ReadonlyArray<FileRoot>;
  /** Canonical folders never served, whatever their names: T3's state and secrets, and /dev/fd. */
  readonly refused: ReadonlyArray<string>;
}

/** An absolute request path checked against the roots, before the disk is touched. */
export interface RequestPath {
  readonly root: FileRoot;
  readonly path: string;
  /** `path` without a trailing ":line" or ":line:col", tried only when `path` does not exist. */
  readonly withoutLineSuffix: string | undefined;
  readonly trailingSlash: boolean;
  /** The last URL segment as sent, so a relative redirect keeps its encoding. */
  readonly rawName: string;
}

const GrantClaims = Schema.Struct({
  v: Schema.Literal(1),
  /** Canonical folder the grant reads from. */
  folder: Schema.String,
  dev: Schema.String,
  ino: Schema.String,
  /** Set for an exact grant: only `folder/file`. */
  file: Schema.optionalKey(Schema.String),
  exp: Schema.Number,
});
type GrantClaims = typeof GrantClaims.Type;
const GrantClaimsJson = Schema.fromJsonString(GrantClaims);
const decodeGrantClaims = Schema.decodeUnknownOption(GrantClaimsJson);
const encodeGrantClaims = Schema.encodeSync(GrantClaimsJson);

export type FileKind =
  | { readonly _tag: "Html" }
  | { readonly _tag: "Typed"; readonly mimeType: string }
  | { readonly _tag: "Text" }
  | { readonly _tag: "Download" };

export interface ListingEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly size: bigint;
}

interface NotFound {
  readonly _tag: "NotFound";
}
interface AddSlash {
  readonly _tag: "AddSlash";
  readonly location: string;
}
export interface FileTarget {
  readonly _tag: "File";
  /** Canonical path. */
  readonly path: string;
  readonly file: OpenMediaFile;
  readonly kind: FileKind;
}
interface Listing {
  readonly _tag: "Listing";
  readonly title: string;
  readonly entries: ReadonlyArray<ListingEntry>;
  readonly omitted: number;
  readonly hasParent: boolean;
}
interface Folder {
  readonly _tag: "Folder";
  readonly directory: string;
}

export type GrantTarget = NotFound | AddSlash | FileTarget;

/** A grant read is limited to its grant; an absolute read has none. */
interface Rules {
  readonly policy: Policy;
  readonly grant: GrantClaims | undefined;
}

const NOT_FOUND: NotFound = { _tag: "NotFound" };

const isHiddenName = (name: string) => name.startsWith(".");

// Native realpath gives the on-disk letter case, which the refused-folder check compares.
const canonicalOf = (lexical: string) =>
  Effect.promise(() => NodeFSP.realpath(lexical).catch(() => null));

export const toFileRoot = (path: Path.Path, directory: string): FileRoot => ({
  directory,
  urlPrefix: path.sep === "\\" ? `/${directory.replaceAll("\\", "/")}` : `/${directory.slice(1)}`,
});

/** Home, the temp folder(s) and their real paths. Never fails: a bad input is dropped. */
export const fileRoots = Effect.gen(function* () {
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const candidates = [
    yield* HostProcess.HomeDirectory,
    environment.TMPDIR ?? environment.TMP ?? environment.TEMP,
    (yield* HostProcess.Platform) === "win32" ? undefined : "/tmp",
  ].filter((value): value is string => !!value && !isNetworkPath(value));
  const directories = yield* Effect.forEach(candidates, (candidate) => {
    const lexical = path.resolve(candidate);
    return canonicalOf(lexical).pipe(
      Effect.map((real) => (real === null ? [lexical] : [lexical, real])),
    );
  });
  const roots = new Map<string, FileRoot>();
  for (const directory of directories.flat()) {
    // A filesystem root would claim every URL.
    if (path.dirname(directory) === directory || isNetworkPath(directory)) continue;
    const root = toFileRoot(path, directory);
    if (ROUTE_RESERVED.test(root.urlPrefix.replace(DRIVE_PREFIX, ""))) continue;
    // The router matches case-insensitively, so a case-only twin would be a duplicate route.
    const key = root.urlPrefix.toLowerCase();
    if (!roots.has(key)) roots.set(key, root);
  }
  return [...roots.values()];
});

export const makePolicy = Effect.fn("HostFiles.makePolicy")(function* (
  roots: ReadonlyArray<FileRoot>,
) {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const state = yield* Effect.forEach([config.stateDir, config.secretsDir], (directory) =>
    canonicalOf(directory).pipe(Effect.map((real) => real ?? path.resolve(directory))),
  );
  // macOS does not resolve `/dev/fd/N` to the open file's path.
  return { roots, refused: [...state, "/dev/fd"] } satisfies Policy;
});

const decodeSegment = (raw: string): string | null => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return decoded === "" || /[/\\\0]/.test(decoded) ? null : decoded;
};

const parseSegments = (raw: string) => {
  const parts = raw.split("/");
  const trailingSlash = parts.at(-1) === "";
  if (trailingSlash) parts.pop();
  const decoded: Array<string> = [];
  for (const part of parts) {
    const segment = decodeSegment(part);
    if (segment === null) return null;
    decoded.push(segment);
  }
  return { raw: parts, decoded, trailingSlash };
};

/** `rawPath` is the request path as sent (still percent-encoded), which is what the router matched. */
export const parseRequestPath = (
  path: Path.Path,
  roots: ReadonlyArray<FileRoot>,
  rawPath: string,
): RequestPath | null => {
  if (!rawPath.startsWith("/")) return null;
  const parsed = parseSegments(rawPath.slice(1));
  if (parsed === null) return null;
  const sameSegment =
    path.sep === "\\"
      ? (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
      : (left: string, right: string) => left === right;
  let match: { readonly root: FileRoot; readonly depth: number } | undefined;
  for (const root of roots) {
    const prefix = root.urlPrefix.slice(1).split("/");
    if (
      prefix.length <= parsed.decoded.length &&
      prefix.every((segment, index) => sameSegment(segment, parsed.decoded[index] ?? "")) &&
      (match === undefined || prefix.length > match.depth)
    ) {
      match = { root, depth: prefix.length };
    }
  }
  if (match === undefined) return null;
  const { root } = match;
  const below = parsed.decoded.slice(match.depth);
  if (below.some(isHiddenName)) return null;
  const pathOf = (names: ReadonlyArray<string>) => path.join(root.directory, ...names);
  const name = below.at(-1);
  const stripped =
    !parsed.trailingSlash && name !== undefined ? LINE_SUFFIX.exec(name)?.[1] : undefined;
  return {
    root,
    path: pathOf(below),
    withoutLineSuffix:
      stripped === undefined ? undefined : pathOf([...below.slice(0, -1), stripped]),
    trailingSlash: parsed.trailingSlash,
    rawName: parsed.raw.at(-1) ?? "",
  };
};

/** Hidden relative to the longest root holding the path, or anywhere in it outside the roots. */
const isHiddenCanonical = (path: Path.Path, roots: ReadonlyArray<FileRoot>, canonical: string) => {
  let root: FileRoot | undefined;
  for (const candidate of roots) {
    if (
      isWithinRoot(path, canonical, candidate.directory) &&
      (root === undefined || candidate.directory.length > root.directory.length)
    ) {
      root = candidate;
    }
  }
  const relative = root === undefined ? canonical : path.relative(root.directory, canonical);
  return relative.split(/[\\/]/).some(isHiddenName);
};

const isRefused = (path: Path.Path, policy: Policy, canonical: string) =>
  policy.refused.some((directory) => isWithinRoot(path, canonical, directory));

const grantCovers = (path: Path.Path, claims: GrantClaims, canonical: string) =>
  claims.file === undefined
    ? isWithinRoot(path, canonical, claims.folder)
    : canonical === path.join(claims.folder, claims.file);

const isVisible = (path: Path.Path, rules: Rules, canonical: string) =>
  !isHiddenCanonical(path, rules.policy.roots, canonical) &&
  !isRefused(path, rules.policy, canonical) &&
  (rules.grant === undefined || grantCovers(path, rules.grant, canonical));

const identityOf = (info: FileSystem.File.Info) => ({
  dev: String(info.dev),
  ino: String(Option.getOrElse(info.ino, () => 0n)),
});

const typedMimeType = (rules: Rules, extension: string): string | undefined => {
  if (extension === ".json") return "application/json";
  const grantType = rules.grant === undefined ? undefined : GRANT_MIME_TYPES.get(extension);
  if (grantType !== undefined) return grantType;
  const mimeType = hostPreviewMimeTypeFromExtension(extension);
  return mimeType !== null && TYPED_MIME_TYPE.test(mimeType) ? mimeType : undefined;
};

// The helpers below run inside the openPath/openGrantPath spans, some once per listed entry.
const fileKind = Effect.fnUntraced(function* (
  rules: Rules,
  canonical: string,
  file: OpenMediaFile,
) {
  const path = yield* Path.Path;
  const extension = path.extname(canonical).toLowerCase();
  if (HTML_EXTENSIONS.has(extension)) return { _tag: "Html" } satisfies FileKind;
  const mimeType = typedMimeType(rules, extension);
  if (mimeType !== undefined) return { _tag: "Typed", mimeType } satisfies FileKind;
  const header = yield* readMediaFileHeader(canonical, file, SNIFF_BYTES);
  return (header.includes(0) ? { _tag: "Download" } : { _tag: "Text" }) satisfies FileKind;
});

const openFile = Effect.fnUntraced(function* (rules: Rules, canonical: string) {
  const file = yield* openMediaFile(canonical).pipe(Effect.orElseSucceed(() => null));
  if (file === null) return NOT_FOUND;
  const kind = yield* fileKind(rules, canonical, file).pipe(Effect.option);
  return Option.isSome(kind)
    ? ({ _tag: "File", path: canonical, file, kind: kind.value } satisfies FileTarget)
    : NOT_FOUND;
});

const resolveCanonical = Effect.fnUntraced(function* (
  rules: Rules,
  canonical: string,
  trailingSlash: boolean,
  rawName: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!isVisible(path, rules, canonical)) return NOT_FOUND;
  const info = yield* fileSystem.stat(canonical).pipe(Effect.option);
  if (Option.isNone(info)) return NOT_FOUND;
  if (info.value.type === "File")
    return trailingSlash ? NOT_FOUND : yield* openFile(rules, canonical);
  if (info.value.type !== "Directory") return NOT_FOUND;
  // "./" keeps a name with a colon from reading as a URL scheme.
  if (!trailingSlash) return { _tag: "AddSlash", location: `./${rawName}/` } satisfies AddSlash;
  const index = yield* canonicalOf(path.join(canonical, "index.html"));
  if (index !== null && isVisible(path, rules, index)) {
    const target = yield* openFile(rules, index);
    if (target._tag === "File") return target;
  }
  return { _tag: "Folder", directory: canonical } satisfies Folder;
});

/** `child` is a visible name in a visible canonical folder, so only a link can lead elsewhere. */
const listedInfo = Effect.fnUntraced(function* (rules: Rules, child: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const own = yield* fileSystem.lstat(child).pipe(Effect.option);
  if (Option.isNone(own)) return null;
  if (own.value.type !== "SymbolicLink") {
    return isRefused(path, rules.policy, child) ? null : own.value;
  }
  const canonical = yield* canonicalOf(child);
  if (canonical === null || !isVisible(path, rules, canonical)) return null;
  return Option.getOrNull(yield* fileSystem.stat(canonical).pipe(Effect.option));
});

const listFolder = Effect.fnUntraced(function* (
  rules: Rules,
  request: RequestPath,
  directory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fileSystem.readDirectory(directory).pipe(Effect.option);
  if (Option.isNone(names)) return NOT_FOUND;
  const visible = names.value.filter((name) => !isHiddenName(name)).toSorted();
  const shown = visible.slice(0, LISTING_LIMIT);
  const entries = yield* Effect.forEach(
    shown,
    (name) =>
      listedInfo(rules, path.join(directory, name)).pipe(
        Effect.map((info) =>
          info?.type === "File" || info?.type === "Directory"
            ? ({
                name,
                isDirectory: info.type === "Directory",
                size: info.size,
              } satisfies ListingEntry)
            : null,
        ),
      ),
    { concurrency: 16 },
  );
  return {
    _tag: "Listing",
    title: request.path,
    entries: entries
      .filter((entry) => entry !== null)
      .toSorted((left, right) => Number(right.isDirectory) - Number(left.isDirectory)),
    omitted: visible.length - shown.length,
    hasParent: request.path !== request.root.directory,
  } satisfies Listing;
});

export const openPath = Effect.fn("HostFiles.openPath")(function* (
  policy: Policy,
  rawPath: string,
) {
  const path = yield* Path.Path;
  const request = parseRequestPath(path, policy.roots, rawPath);
  if (request === null) return NOT_FOUND;
  const rules: Rules = { policy, grant: undefined };
  const exact = yield* canonicalOf(request.path);
  if (exact !== null) {
    const target = yield* resolveCanonical(rules, exact, request.trailingSlash, request.rawName);
    return target._tag === "Folder" ? yield* listFolder(rules, request, target.directory) : target;
  }
  const stripped =
    request.withoutLineSuffix === undefined ? null : yield* canonicalOf(request.withoutLineSuffix);
  if (stripped === null) return NOT_FOUND;
  const target = yield* resolveCanonical(rules, stripped, false, request.rawName);
  return target._tag === "File" ? target : NOT_FOUND;
});

const verifySignature = Effect.fnUntraced(function* (message: string, signature: string) {
  const signer = yield* AssetSigner.AssetSigner;
  return yield* signer.verify(message, signature).pipe(
    Effect.tapError((cause) => Effect.logError("Failed to load the asset signing key.", { cause })),
    Effect.orElseSucceed(() => false),
  );
});

const openProofMessage = (rawPath: string, exp: string) =>
  `${OPEN_PROOF_SIGNING_DOMAIN}${exp}\n${rawPath}`;

/** A five-minute signature over one request path, which only the Open page's link carries. */
export const signOpenProof = Effect.fn("HostFiles.signOpenProof")(function* (rawPath: string) {
  const signer = yield* AssetSigner.AssetSigner;
  const exp = String((yield* Clock.currentTimeMillis) + OPEN_PROOF_TTL_MS);
  return `${exp}.${yield* signer.sign(openProofMessage(rawPath, exp))}`;
});

export const verifyOpenProof = Effect.fn("HostFiles.verifyOpenProof")(function* (
  rawPath: string,
  proof: string,
) {
  const [exp, signature, ...rest] = proof.split(".");
  if (exp === undefined || !/^\d+$/.test(exp) || !signature || rest.length > 0) return false;
  if (Number(exp) <= (yield* Clock.currentTimeMillis)) return false;
  return yield* verifySignature(openProofMessage(rawPath, exp), signature);
});

const decodeClaims = (payload: string): GrantClaims | null => {
  try {
    return Option.getOrNull(decodeGrantClaims(base64UrlDecodeUtf8(payload)));
  } catch {
    return null;
  }
};

/** `html` is canonical. The grant is its folder, or only the file when the folder holds a root. */
export const mintGrant = Effect.fn("HostFiles.mintGrant")(function* (policy: Policy, html: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const signer = yield* AssetSigner.AssetSigner;
  const folder = path.dirname(html);
  const fileName = path.basename(html);
  // A root's real path may have been dropped at startup, or changed since.
  const realRoots = yield* Effect.forEach(policy.roots, (root) => canonicalOf(root.directory), {
    concurrency: "unbounded",
  });
  const exact =
    path.dirname(folder) === folder ||
    [...policy.roots.map((root) => root.directory), ...realRoots].some(
      (root) => root !== null && isWithinRoot(path, root, folder),
    );
  const claims: GrantClaims = {
    v: 1,
    folder,
    ...identityOf(yield* fileSystem.stat(folder)),
    ...(exact ? { file: fileName } : {}),
    exp: (yield* Clock.currentTimeMillis) + GRANT_TTL_MS,
  };
  const payload = base64UrlEncode(encodeGrantClaims(claims));
  const signature = yield* signer.sign(GRANT_SIGNING_DOMAIN + payload);
  return { token: `${payload}.${signature}`, fileName };
});

const verifyGrant = Effect.fnUntraced(function* (token: string) {
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length > 0) return null;
  if (!(yield* verifySignature(GRANT_SIGNING_DOMAIN + payload, signature))) return null;
  const claims = decodeClaims(payload);
  return claims !== null && claims.exp > (yield* Clock.currentTimeMillis) ? claims : null;
});

const holdsPinnedFolder = Effect.fnUntraced(function* (claims: GrantClaims) {
  const fileSystem = yield* FileSystem.FileSystem;
  const folder = yield* fileSystem.stat(claims.folder).pipe(Effect.option);
  if (Option.isNone(folder) || folder.value.type !== "Directory") return false;
  const identity = identityOf(folder.value);
  return identity.dev === claims.dev && identity.ino === claims.ino;
});

/** `rawPath` is the percent-encoded path after the token. */
export const openGrantPath = Effect.fn("HostFiles.openGrantPath")(function* (
  policy: Policy,
  token: string,
  rawPath: string,
) {
  const claims = yield* verifyGrant(token);
  if (claims === null) return NOT_FOUND;
  const path = yield* Path.Path;
  const parsed = parseSegments(rawPath);
  if (parsed === null || parsed.decoded.some(isHiddenName)) return NOT_FOUND;
  const canonical = yield* canonicalOf(path.join(claims.folder, ...parsed.decoded));
  if (canonical === null) return NOT_FOUND;
  const target = yield* resolveCanonical(
    { policy, grant: claims },
    canonical,
    parsed.trailingSlash,
    parsed.raw.at(-1) ?? "",
  );
  if (target._tag === "NotFound" || target._tag === "Folder") return NOT_FOUND;
  // Checked after the open, so a folder swapped in during the lookup is caught.
  return (yield* holdsPinnedFolder(claims)) ? target : NOT_FOUND;
});
