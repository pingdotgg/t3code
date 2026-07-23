/**
 * Bun layer for Effect's `FileSystem` service.
 *
 * Use this module at the edge of Bun applications, CLIs, scripts, and tests
 * that need real local filesystem access through `effect/FileSystem`: reading
 * and writing files, creating directories and temporary files, inspecting
 * metadata, managing links, or watching paths for changes. It exposes only the
 * Bun `FileSystem` layer; the operations themselves are accessed from the
 * `FileSystem` service once the layer is provided, or from `BunServices.layer`
 * when the program also needs the standard Bun path, stdio, terminal, and child
 * process services.
 *
 * Bun supports Node-compatible filesystem APIs, so this layer reuses the shared
 * Node filesystem implementation. Paths therefore follow the current process and
 * host platform rules: relative paths are resolved from the current working
 * directory, separators and drive/UNC behavior are platform-dependent, and
 * request URLs should be decoded and validated before being mapped to local
 * paths. The service works with bytes, scoped file handles, and Effect
 * streams/sinks; use `FileSystem.stream` for large files instead of
 * `readFile`, and remember that stream offsets and lengths are byte positions.
 * Bun `File` and `Blob` values are not filesystem handles here; path-based HTTP
 * file responses are handled by the Bun HTTP platform adapter with `Bun.file`.
 *
 * @since 4.0.0
 */
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import type { FileSystem } from "effect/FileSystem"
import type * as Layer from "effect/Layer"

/**
 * Layer that provides the `FileSystem` service for Bun using the shared Node file-system implementation.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<FileSystem, never, never> = NodeFileSystem.layer
