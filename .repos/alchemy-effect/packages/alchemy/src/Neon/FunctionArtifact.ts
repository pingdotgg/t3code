import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { inflateRawSync } from "node:zlib";
import * as Bundle from "../Bundle/Bundle.ts";
import * as TempRoot from "../Bundle/TempRoot.ts";
import { sha256 } from "../Util/sha256.ts";
import { moduleExtension } from "../Util/Node.ts";
import { zipFiles, type ZipFile } from "../Util/zip.ts";
import type { FunctionProps } from "./Function.ts";
import { nativeArtifactError } from "./NativeArtifact.ts";

export class FunctionArtifactError extends Data.TaggedError(
  "FunctionArtifactError",
)<{ message: string }> {}

const safePath = (name: string) =>
  name.length > 0 &&
  !name.startsWith("/") &&
  !name.includes("\\") &&
  !name
    .replace(/\/$/, "")
    .split("/")
    .some(
      (part) =>
        part.length === 0 ||
        part === ".." ||
        part === "." ||
        part.startsWith(".env") ||
        part === ".git" ||
        part === ".alchemy",
    ) &&
  !/^[a-z]:/i.test(name);

/** Validate before extracting, including ZIP Unix mode bits and decompressed size. */
export const validateFunctionZip = (bytes: Uint8Array) =>
  Effect.try({
    try: () => {
      if (bytes.byteLength > 100 * 1024 * 1024)
        throw new Error("Archive exceeds 100 MiB safety limit");
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      let end = bytes.length - 22;
      for (; end >= Math.max(0, bytes.length - 65557); end--)
        if (view.getUint32(end, true) === 0x06054b50) break;
      if (end < 0 || view.getUint32(end, true) !== 0x06054b50)
        throw new Error("Invalid ZIP directory");
      const count = view.getUint16(end + 10, true);
      let offset = view.getUint32(end + 16, true);
      let size = 0;
      const files: Record<string, Uint8Array> = Object.create(null);
      for (let i = 0; i < count; i++) {
        if (view.getUint32(offset, true) !== 0x02014b50)
          throw new Error("Invalid ZIP entry");
        const length = view.getUint16(offset + 28, true);
        const name = new TextDecoder().decode(
          bytes.subarray(offset + 46, offset + 46 + length),
        );
        const mode = view.getUint32(offset + 38, true) >>> 16;
        if (!safePath(name) || name in files || (mode & 0xf000) === 0xa000)
          throw new Error("Unsafe or duplicate archive entry");
        const flags = view.getUint16(offset + 8, true);
        const method = view.getUint16(offset + 10, true);
        const compressedSize = view.getUint32(offset + 20, true);
        const expandedSize = view.getUint32(offset + 24, true);
        if ((flags & 1) !== 0 || (method !== 0 && method !== 8))
          throw new Error("Unsupported ZIP encoding");
        if (size + expandedSize > 250 * 1024 * 1024)
          throw new Error("Expanded archive exceeds 250 MiB safety limit");
        const local = view.getUint32(offset + 42, true);
        if (
          view.getUint32(local, true) !== 0x04034b50 ||
          view.getUint16(local + 6, true) !== flags ||
          view.getUint16(local + 8, true) !== method
        )
          throw new Error("ZIP local header mismatch");
        const localCompressed = view.getUint32(local + 18, true);
        const localExpanded = view.getUint32(local + 22, true);
        if (
          (((flags & 8) === 0 || localCompressed !== 0) &&
            localCompressed !== compressedSize) ||
          (((flags & 8) === 0 || localExpanded !== 0) &&
            localExpanded !== expandedSize)
        )
          throw new Error("ZIP size mismatch");
        const localNameLength = view.getUint16(local + 26, true);
        if (
          new TextDecoder().decode(
            bytes.subarray(local + 30, local + 30 + localNameLength),
          ) !== name
        )
          throw new Error("ZIP entry name mismatch");
        const start =
          local + 30 + localNameLength + view.getUint16(local + 28, true);
        if (start + compressedSize > view.getUint32(end + 16, true))
          throw new Error("ZIP entry overlaps directory");
        const compressed = bytes.subarray(start, start + compressedSize);
        const content =
          method === 0
            ? compressed
            : inflateRawSync(compressed, { maxOutputLength: expandedSize + 1 });
        if (content.byteLength !== expandedSize)
          throw new Error("ZIP expanded size mismatch");
        const nativeError = nativeArtifactError(name, content);
        if (nativeError) throw new Error(nativeError);
        size += content.byteLength;
        files[name] = content;
        offset +=
          46 +
          length +
          view.getUint16(offset + 30, true) +
          view.getUint16(offset + 32, true);
      }
      if (!("index.mjs" in files))
        throw new Error("Artifact requires root index.mjs");
      if (
        offset !==
        view.getUint32(end + 16, true) + view.getUint32(end + 12, true)
      )
        throw new Error("ZIP directory mismatch");
      return files;
    },
    catch: () =>
      new FunctionArtifactError({
        message:
          "Invalid Function ZIP: require root index.mjs, safe relative paths, no symlinks/secrets, Linux ARM64 native files, and bounded size",
      }),
  });

export const buildFunctionArtifact = Effect.fn(function* (
  props: FunctionProps,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let files: ZipFile[] = [];
  if (props.artifact?.zip !== undefined) {
    const archive = yield* fs.readFile(props.artifact.zip);
    yield* validateFunctionZip(archive);
    return { archive, codeHash: yield* sha256(archive) };
  }
  if (props.artifact?.directory !== undefined) {
    const root = yield* fs.realPath(props.artifact.directory);
    const walk: (
      relative: string,
    ) => Effect.Effect<
      void,
      FunctionArtifactError | import("effect/PlatformError").PlatformError
    > = Effect.fn(function* (relative) {
      for (const entry of (yield* fs.readDirectory(
        path.join(root, relative),
      )).sort()) {
        const name = relative ? `${relative}/${entry}` : entry;
        if (!safePath(name))
          return yield* new FunctionArtifactError({
            message: `Unsafe Function artifact entry: ${name}`,
          });
        const absolute = path.join(root, name);
        if ((yield* fs.realPath(absolute)) !== absolute)
          return yield* new FunctionArtifactError({
            message: "Function artifacts must not contain symlinks",
          });
        const info = yield* fs.stat(absolute);
        if (info.type === "Directory") yield* walk(name);
        else if (info.type === "File")
          files.push({ path: name, content: yield* fs.readFile(absolute) });
        else
          return yield* new FunctionArtifactError({
            message: "Function artifacts support regular files only",
          });
      }
    });
    yield* walk("");
  } else {
    if (!props.main)
      return yield* new FunctionArtifactError({
        message: "Specify main or artifact",
      });
    const realMain = yield* TempRoot.resolveMainPath(props.main);
    const virtual = yield* Bundle.virtualEntryPlugin;
    const bridge = yield* Effect.sync(() =>
      import.meta.resolve(
        `./FunctionBridge${moduleExtension(import.meta.url)}`,
      ),
    );
    const output = yield* Bundle.build(
      {
        ...props.bundle?.input,
        input: realMain,
        cwd: yield* TempRoot.findCwdForBundle(realMain),
        platform: "node",
        resolve: {
          ...props.bundle?.input?.resolve,
          conditionNames: [...Bundle.NODE_CONDITION_NAMES],
        },
        plugins: [
          props.bundle?.input?.plugins,
          props.isExternal
            ? undefined
            : virtual(
                (entry) =>
                  `import { makeFunctionBridge } from ${JSON.stringify(bridge)};\nimport entrypoint from ${JSON.stringify(entry)};\nexport default makeFunctionBridge(entrypoint);`,
              ),
        ],
      },
      {
        ...props.bundle?.output,
        format: "esm",
        entryFileNames: "index.mjs",
        codeSplitting: false,
        banner: `import { createRequire as __alchemyCreateRequire } from "node:module";\nconst require = __alchemyCreateRequire(import.meta.url);`,
      },
      props.bundle,
    );
    files = output.files.map(({ path, content }) => ({ path, content }));
  }
  if (!files.some((file) => file.path === "index.mjs"))
    return yield* new FunctionArtifactError({
      message: "Function artifact requires root index.mjs",
    });
  const archive = yield* zipFiles(files);
  yield* validateFunctionZip(archive);
  return { archive, codeHash: yield* sha256(archive) };
});
