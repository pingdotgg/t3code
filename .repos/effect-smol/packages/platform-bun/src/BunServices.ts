/**
 * Provides the aggregate Bun platform services layer for applications that run
 * on the Bun runtime.
 *
 * This module is useful when an application needs the standard Bun-backed
 * implementations of filesystem access, path operations, stdio, terminal
 * interaction, and child process spawning from a single layer. Provide
 * `BunServices.layer` near the edge of a program to satisfy effects that read
 * or write files, resolve paths, interact with stdin/stdout/stderr or a
 * terminal, or launch subprocesses.
 *
 * The layer only supplies the runtime services listed by `BunServices`; it does
 * not provide unrelated platform services such as HTTP clients, HTTP servers,
 * sockets, workers, or Redis. Several of these core Bun services are backed by
 * the shared Node-compatible implementations used by the Bun adapters, so the
 * default path, stdio, terminal, and subprocess behavior follows the current
 * process and host platform. Libraries should continue to depend on the
 * individual service tags they use, while Bun applications, CLIs, and tests can
 * choose this layer or narrower service-specific layers depending on how much
 * of the Bun runtime they want to expose.
 *
 * @since 4.0.0
 */
import type { Crypto } from "effect/Crypto"
import type { FileSystem } from "effect/FileSystem"
import * as Layer from "effect/Layer"
import type { Path } from "effect/Path"
import type { Stdio } from "effect/Stdio"
import type { Terminal } from "effect/Terminal"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as BunChildProcessSpawner from "./BunChildProcessSpawner.ts"
import * as BunCrypto from "./BunCrypto.ts"
import * as BunFileSystem from "./BunFileSystem.ts"
import * as BunPath from "./BunPath.ts"
import * as BunStdio from "./BunStdio.ts"
import * as BunTerminal from "./BunTerminal.ts"

/**
 * The union of core services provided by the Bun platform layer, including child
 * process spawning, filesystem, path, stdio, and terminal services.
 *
 * @category models
 * @since 4.0.0
 */
export type BunServices = ChildProcessSpawner | Crypto | FileSystem | Path | Terminal | Stdio

/**
 * Provides the default Bun implementations for child process spawning,
 * filesystem, path, stdio, and terminal services.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<BunServices> = BunChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(
    BunFileSystem.layer,
    BunCrypto.layer,
    BunPath.layer,
    BunStdio.layer,
    BunTerminal.layer
  ))
)
