/**
 * Standard Node.js service bundle for Effect applications.
 *
 * `NodeServices.layer` provides the Node implementations of the core services
 * most command-line programs and server entrypoints need: child process
 * spawning, cryptography, filesystem access, path operations, stdio, terminal
 * interaction, and related process I/O.
 *
 * **Mental model**
 *
 * Application code should depend on the individual Effect service tags it uses,
 * such as `FileSystem`, `Path`, or `Stdio`. This module is the composition
 * point for a Node runtime: provide the aggregate layer once near the program
 * boundary, and those service requirements are satisfied by Node-backed
 * implementations.
 *
 * **Common tasks**
 *
 * - Install the default Node platform services for a CLI, script, or process
 *   entrypoint with {@link layer}
 * - Use narrower modules such as `NodeFileSystem`, `NodePath`, or `NodeStdio`
 *   when a test or embedded runtime should expose only one service
 * - Keep libraries platform-independent by requiring service tags instead of
 *   importing this module directly
 *
 * **Gotchas**
 *
 * This is not every Node integration in `@effect/platform-node`. HTTP clients,
 * HTTP servers, sockets, workers, Redis, and other specialized integrations
 * still have their own modules and layers. Providing this layer also means
 * effects can reach real process resources such as the filesystem, stdio,
 * terminal handles, and child processes.
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
import * as NodeChildProcessSpawner from "./NodeChildProcessSpawner.ts"
import * as NodeCrypto from "./NodeCrypto.ts"
import * as NodeFileSystem from "./NodeFileSystem.ts"
import * as NodePath from "./NodePath.ts"
import * as NodeStdio from "./NodeStdio.ts"
import * as NodeTerminal from "./NodeTerminal.ts"

/**
 * The union of core services provided by the Node platform layer, including
 * child process spawning, filesystem, path, stdio, and terminal services.
 *
 * @category models
 * @since 4.0.0
 */
export type NodeServices = ChildProcessSpawner | Crypto | FileSystem | Path | Stdio | Terminal

/**
 * Provides the default Node implementations for child process spawning,
 * filesystem, path, stdio, and terminal services.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<NodeServices> = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.mergeAll(
    NodeFileSystem.layer,
    NodeCrypto.layer,
    NodePath.layer,
    NodeStdio.layer,
    NodeTerminal.layer
  )
)
