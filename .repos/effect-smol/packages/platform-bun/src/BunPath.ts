/**
 * Bun-backed layers for Effect's {@link Path} service.
 *
 * This module provides the `Path` service for Bun programs by reusing the
 * shared Node-compatible path implementation. Provide one of these layers when
 * Bun code should receive path operations from the Effect environment instead
 * of importing runtime path helpers directly.
 *
 * **Mental model**
 *
 * Bun exposes Node-compatible path and file URL behavior, so the default
 * {@link layer} follows the host operating system's rules. The
 * {@link layerPosix} and {@link layerWin32} variants pin parsing and formatting
 * to POSIX or Windows semantics for portable tests, generated paths, and
 * cross-platform tooling.
 *
 * **Common tasks**
 *
 * Use {@link layer} for normal Bun applications and CLIs. Use
 * {@link layerPosix} or {@link layerWin32} when code must produce stable path
 * syntax regardless of the machine running Bun. `BunServices.layer` already
 * includes {@link layer}, so import this module directly when only `Path` or a
 * fixed platform variant is needed.
 *
 * **Gotchas**
 *
 * Path operations are syntactic. They normalize and convert strings and
 * `file:` URLs, but they do not read the filesystem, check permissions, confirm
 * that a path exists, or make request URLs safe to use as local paths.
 *
 * @since 4.0.0
 */
import * as NodePath from "@effect/platform-node-shared/NodePath"
import type * as Layer from "effect/Layer"
import type { Path } from "effect/Path"

/**
 * Layer that provides the default `Path` service for Bun using the shared Node path implementation.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<Path> = NodePath.layer

/**
 * Layer that provides the POSIX `Path` service for Bun using the shared Node path implementation.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerPosix: Layer.Layer<Path> = NodePath.layerPosix

/**
 * Layer that provides the Win32 `Path` service for Bun using the shared Node path implementation.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerWin32: Layer.Layer<Path> = NodePath.layerWin32
