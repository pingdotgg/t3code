import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import {
  hashDockerBuildInputs,
  selectDockerBuildContext,
} from "../Docker/BuildHash.ts";
import { initialCwd } from "../Util/Node.ts";
import { sha256Object } from "../Util/sha256.ts";
import { tarGzipDirectory } from "../Util/tarGzip.ts";

const DEFAULT_DOCKERFILE = "Dockerfile";
const RAILWAY_BUILD_PLATFORM = "linux/amd64";
const MAX_CONTEXT_BYTES = 32 * 1024 * 1024;
const MAX_CONTEXT_ENTRIES = 10_000;
const TAR_BLOCK_BYTES = 512;

export interface RailwayLocalContextSource {
  readonly context: string;
  readonly dockerfilePath?: string;
}

export class ServiceImageOrMainRequired extends Data.TaggedError(
  "Railway.ServiceImageOrMainRequired",
)<{ message: string }> {}

export class ServiceSourceInvalid extends Data.TaggedError(
  "Railway.ServiceSourceInvalid",
)<{ message: string }> {}

export class ServiceDockerfilePathInvalid extends Data.TaggedError(
  "Railway.ServiceDockerfilePathInvalid",
)<{ dockerfilePath: string; message: string }> {}

export class ServiceContextPathInvalid extends Data.TaggedError(
  "Railway.ServiceContextPathInvalid",
)<{ path: string; expected: "directory" | "file" }> {
  override get message() {
    return `Railway.Service expected ${this.path} to be an existing ${this.expected}`;
  }
}

export class ServiceDockerfileOutsideContext extends Data.TaggedError(
  "Railway.ServiceDockerfileOutsideContext",
)<{ context: string; dockerfile: string }> {}

export class ServiceContextSymlinkUnsupported extends Data.TaggedError(
  "Railway.ServiceContextSymlinkUnsupported",
)<{ path: string }> {}

export class ServiceContextPathUnsupported extends Data.TaggedError(
  "Railway.ServiceContextPathUnsupported",
)<{ path: string }> {}

export class ServiceContextTooLarge extends Data.TaggedError(
  "Railway.ServiceContextTooLarge",
)<{ limit: number; size: number }> {}

export type RailwayServiceSource =
  | { readonly mode: "main"; readonly main: string }
  | {
      readonly mode: "context";
      readonly context: string;
      readonly dockerfilePath: string | undefined;
    }
  | { readonly mode: "image"; readonly image: string }
  | { readonly mode: "repo"; readonly repo: string };

const nonEmpty = (value: string | undefined): value is string =>
  value !== undefined && value.length > 0;

export const resolveRailwayServiceSource = Effect.fn(function* (props: {
  readonly main?: string;
  readonly context?: string;
  readonly image?: string;
  readonly repo?: string;
  readonly dockerfilePath?: string;
}) {
  const main = nonEmpty(props.main) ? props.main : undefined;
  const context = nonEmpty(props.context) ? props.context : undefined;
  const image = nonEmpty(props.image) ? props.image : undefined;
  const repo = nonEmpty(props.repo) ? props.repo : undefined;
  const modes = [
    main === undefined ? undefined : "main",
    context === undefined ? undefined : "context",
    repo === undefined ? undefined : "repo",
    main === undefined && image !== undefined ? "image" : undefined,
  ].filter((mode): mode is RailwayServiceSource["mode"] => mode !== undefined);

  if (modes.length === 0) {
    return yield* new ServiceImageOrMainRequired({
      message:
        "Railway.Service requires `image`, `main`, `context`, or `repo`.",
    });
  }
  if (modes.length !== 1) {
    return yield* new ServiceSourceInvalid({
      message:
        "Railway.Service requires exactly one source: `main`, `context`, `image`, or `repo` (`image` may configure the base image for `main`).",
    });
  }
  switch (modes[0]) {
    case "main":
      return { mode: "main", main: main! } as const;
    case "context":
      return {
        mode: "context",
        context: context!,
        dockerfilePath: props.dockerfilePath,
      } as const;
    case "image":
      return { mode: "image", image: image! } as const;
    case "repo":
      return { mode: "repo", repo: repo! } as const;
    default:
      return yield* new ServiceSourceInvalid({
        message: "Railway.Service source could not be resolved",
      });
  }
});

const resolveBuild = Effect.fn(function* (source: RailwayLocalContextSource) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = path.resolve(initialCwd, source.context);
  const dockerfilePath = source.dockerfilePath ?? DEFAULT_DOCKERFILE;
  if (dockerfilePath.length === 0 || path.isAbsolute(dockerfilePath)) {
    return yield* new ServiceDockerfilePathInvalid({
      dockerfilePath,
      message:
        "Railway.Service `dockerfilePath` must be a non-empty path relative to `context`",
    });
  }
  if (!(yield* fs.exists(context))) {
    return yield* new ServiceContextPathInvalid({
      path: context,
      expected: "directory",
    });
  }
  if (Result.isSuccess(yield* Effect.result(fs.readLink(context)))) {
    return yield* new ServiceContextSymlinkUnsupported({ path: context });
  }
  const contextInfo = yield* fs.stat(context);
  if (contextInfo.type !== "Directory") {
    return yield* new ServiceContextPathInvalid({
      path: context,
      expected: "directory",
    });
  }
  const dockerfile = path.resolve(context, dockerfilePath);
  if (!(yield* fs.exists(dockerfile))) {
    return yield* new ServiceContextPathInvalid({
      path: dockerfile,
      expected: "file",
    });
  }
  const selected = yield* selectDockerBuildContext({ context, dockerfile });
  if (selected.dockerfilePath === undefined) {
    return yield* new ServiceDockerfileOutsideContext({
      context,
      dockerfile,
    });
  }
  const parts = selected.dockerfilePath.split("/");
  let current = context;
  for (const part of parts) {
    current = path.join(current, part);
    if (Result.isSuccess(yield* Effect.result(fs.readLink(current)))) {
      return yield* new ServiceContextSymlinkUnsupported({ path: current });
    }
  }
  const dockerfileInfo = yield* fs.stat(dockerfile);
  if (dockerfileInfo.type !== "File") {
    return yield* new ServiceContextPathInvalid({
      path: dockerfile,
      expected: "file",
    });
  }
  return {
    build: {
      context,
      dockerfile,
      platform: RAILWAY_BUILD_PLATFORM,
    },
    selected,
  };
});

const paddedTarBytes = (size: number) =>
  Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;

const fitsUstarPath = (relativePath: string) => {
  if (relativePath.length <= 100) return true;
  for (let index = relativePath.length - 101; index >= 1; index--) {
    if (relativePath[index] !== "/") continue;
    const nameLength = relativePath.length - index - 1;
    if (index <= 155 && nameLength > 0 && nameLength <= 100) return true;
  }
  return false;
};

const tarEntryBytes = (
  relativePath: string,
  type: "Directory" | "File",
  size: number,
) => {
  const tarPath = type === "Directory" ? `${relativePath}/` : relativePath;
  const longNameBytes = fitsUstarPath(tarPath)
    ? 0
    : TAR_BLOCK_BYTES + paddedTarBytes(tarPath.length + 1);
  return (
    longNameBytes +
    TAR_BLOCK_BYTES +
    (type === "File" ? paddedTarBytes(size) : 0)
  );
};

const checkContextLimit = (size: number, entries: number) =>
  size > MAX_CONTEXT_BYTES || entries > MAX_CONTEXT_ENTRIES
    ? Effect.fail(
        new ServiceContextTooLarge({
          limit: MAX_CONTEXT_BYTES,
          size,
        }),
      )
    : Effect.void;

const selectedEntries = Effect.fn(function* (selected: {
  context: string;
  includes: (relativePath: string) => boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries: Array<{
    entry: string;
    sourcePath: string;
    type: "Directory" | "File";
    mode: number;
  }> = [];
  let size = 2 * TAR_BLOCK_BYTES;
  let entryCount = 0;
  for (const entry of (yield* fs.readDirectory(selected.context, {
    recursive: true,
  })).sort()) {
    const relative = entry.replaceAll("\\", "/");
    if (!selected.includes(relative)) continue;
    const sourcePath = path.join(selected.context, entry);
    if (/[^\x20-\x7e]/.test(relative)) {
      return yield* new ServiceContextPathUnsupported({ path: sourcePath });
    }
    if (Result.isSuccess(yield* Effect.result(fs.readLink(sourcePath)))) {
      return yield* new ServiceContextSymlinkUnsupported({ path: sourcePath });
    }
    const info = yield* fs.stat(sourcePath);
    if (info.type !== "Directory" && info.type !== "File") continue;
    entryCount += 1;
    size += tarEntryBytes(relative, info.type, Number(info.size));
    yield* checkContextLimit(size, entryCount);
    entries.push({
      entry,
      sourcePath,
      type: info.type,
      mode: info.mode & 0o7777,
    });
  }
  return entries;
});

const codeHash = Effect.fn(function* (input: {
  context: string;
  dockerfilePath: string;
}) {
  const contextHash = yield* hashDockerBuildInputs(
    {
      context: input.context,
      dockerfile: input.dockerfilePath,
      platform: RAILWAY_BUILD_PLATFORM,
    },
    "effective",
  );
  return (yield* sha256Object({
    contextHash,
    dockerfilePath: input.dockerfilePath,
  })).slice(0, 16);
});

export const hashRailwayLocalContext = Effect.fn(function* (
  source: RailwayLocalContextSource,
) {
  const { build, selected } = yield* resolveBuild(source);
  yield* selectedEntries(selected);
  return yield* codeHash({
    context: build.context,
    dockerfilePath: selected.dockerfilePath!,
  });
});

export const prepareRailwayLocalContext = Effect.fn(function* (
  source: RailwayLocalContextSource,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { selected } = yield* resolveBuild(source);
  const snapshot = yield* fs.makeTempDirectoryScoped({
    prefix: "alchemy-railway-context-",
  });
  const entries = yield* selectedEntries(selected);
  let copiedSize = 2 * TAR_BLOCK_BYTES;
  let copiedEntries = 0;
  for (const entry of entries) {
    const destination = path.join(snapshot, entry.entry);
    copiedEntries += 1;
    if (entry.type === "Directory") {
      copiedSize += tarEntryBytes(entry.entry, entry.type, 0);
      yield* checkContextLimit(copiedSize, copiedEntries);
      yield* fs.makeDirectory(destination, { recursive: true });
      yield* fs.chmod(destination, entry.mode);
    } else {
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      const contents = yield* fs.readFile(entry.sourcePath);
      copiedSize += tarEntryBytes(entry.entry, entry.type, contents.byteLength);
      yield* checkContextLimit(copiedSize, copiedEntries);
      yield* fs.writeFile(destination, contents);
      yield* fs.chmod(destination, entry.mode);
    }
  }
  const dockerfilePath = selected.dockerfilePath!;
  const hash = yield* codeHash({ context: snapshot, dockerfilePath });
  const tarball = yield* tarGzipDirectory(snapshot, { preserveMode: true });
  return { codeHash: hash, dockerfilePath, tarball };
});
