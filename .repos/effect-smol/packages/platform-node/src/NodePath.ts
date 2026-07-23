/**
 * Node.js layers for Effect's `Path` service.
 *
 * This module adapts Node's path and file URL behavior to the
 * platform-independent `Path` service. Provide one of its layers when a Node
 * program needs to build, normalize, parse, resolve, or convert paths without
 * depending directly on `node:path`.
 *
 * **Mental model**
 *
 * `Path` is a syntactic service: it manipulates strings and `file:` URLs. It
 * does not read the filesystem, check permissions, or validate that paths
 * exist. The selected layer decides which separator, drive-letter, UNC, and URL
 * conversion rules are used.
 *
 * **Common tasks**
 *
 * Use `layer` for host-platform Node semantics, `layerPosix` for stable POSIX
 * behavior, and `layerWin32` for stable Windows behavior. `NodeServices.layer`
 * already includes `layer`, so import this module directly when a program wants
 * only path support or a platform-specific variant.
 *
 * **Gotchas**
 *
 * Results that are correct on one platform may not be portable to another.
 * `fromFileUrl` and `toFileUrl` use Node's `node:url` conversion rules and
 * report invalid conversions as `BadArgument` failures.
 *
 * @since 4.0.0
 */
import * as NodePath from "@effect/platform-node-shared/NodePath"
import type * as Layer from "effect/Layer"
import type { Path } from "effect/Path"

/**
 * Provides the default Node `Path` service using the platform's `node:path`
 * implementation.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<Path> = NodePath.layer

/**
 * Provides the `Path` service using Node's POSIX path implementation,
 * regardless of the host platform.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerPosix: Layer.Layer<Path> = NodePath.layerPosix

/**
 * Provides the `Path` service using Node's Windows path implementation,
 * regardless of the host platform.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerWin32: Layer.Layer<Path> = NodePath.layerWin32
