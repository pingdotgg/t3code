/**
 * Node.js `FileSystem` layer for programs that perform real filesystem I/O.
 *
 * The exported layer satisfies the platform-independent `FileSystem` service
 * with Node-backed operations for files, directories, metadata, permissions,
 * links, temporary paths, and path watching. Effects still call the service from
 * `effect/FileSystem`; this module only chooses the Node implementation.
 *
 * **Mental model**
 *
 * Provide `NodeFileSystem.layer` at the process boundary when filesystem
 * effects should touch the host filesystem. Use `NodeServices.layer` instead
 * when the same program also needs the standard Node path, stdio, terminal,
 * crypto, and child process services. Tests that need isolation can provide a
 * different `FileSystem` layer without changing the code that performs the
 * reads and writes.
 *
 * **Gotchas**
 *
 * Paths are interpreted by Node, so relative paths resolve against the current
 * working directory and platform-specific path rules apply. Filesystem failures
 * are reported through Effect platform errors rather than thrown exceptions.
 * File watching uses `FileSystem.WatchBackend` when one is available; otherwise
 * it follows `node:fs.watch`, whose recursive support, event batching, and
 * reported path names vary across operating systems.
 *
 * @since 4.0.0
 */
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import type { FileSystem } from "effect/FileSystem"
import type * as Layer from "effect/Layer"

/**
 * Provides the `FileSystem` service backed by Node filesystem APIs.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<FileSystem> = NodeFileSystem.layer
