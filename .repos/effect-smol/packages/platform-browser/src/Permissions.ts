/**
 * Effect service for the browser Permissions API.
 *
 * This module wraps `navigator.permissions` in a `Permissions` service and a
 * browser-backed layer. It lets browser programs query whether a capability is
 * currently `granted`, `prompt`, or `denied` before deciding which UI or
 * feature flow to show for geolocation, notifications, clipboard access,
 * camera, microphone, persistent storage, and other browser-gated features.
 *
 * **Mental model**
 *
 * A permission query is a status read, not an access request. The service
 * delegates to `navigator.permissions.query({ name })` and returns the browser's
 * `PermissionStatus`, while browser rejections are represented as
 * `PermissionsError` values.
 *
 * **Common tasks**
 *
 * - Check whether a feature is already available before rendering a prompt or
 *   settings path.
 * - Require permission querying through Effect context instead of reaching for
 *   the ambient `navigator` in application code.
 * - Provide the live browser implementation with `layer`.
 *
 * **Gotchas**
 *
 * Browser support for permission names and states is uneven, and unsupported or
 * invalid descriptors may reject. Some permissions are only meaningful in
 * secure contexts or after user activation. Returned `PermissionStatus` objects
 * can change when the user updates browser settings or responds to prompts; if
 * you subscribe to `change` or `onchange`, clean up listeners with the
 * surrounding Effect scope.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const TypeId = "~@effect/platform-browser/Permissions"
const ErrorTypeId = "~@effect/platform-browser/Permissions/PermissionsError"

/**
 * Wrapper on the Permission API (`navigator.permissions`) with methods for
 * querying status of permissions.
 *
 * @category models
 * @since 4.0.0
 */
export interface Permissions {
  readonly [TypeId]: typeof TypeId

  /**
   * Returns the state of a user permission on the global scope.
   */
  readonly query: <Name extends PermissionName>(
    name: Name
  ) => Effect.Effect<
    // `name` is identical to the name passed to Permissions.query
    // https://developer.mozilla.org/en-US/docs/Web/API/PermissionStatus
    Omit<PermissionStatus, "name"> & { name: Name },
    PermissionsError
  >
}

/**
 * Error reason for an `InvalidStateError` raised by the browser Permissions API.
 *
 * @category errors
 * @since 4.0.0
 */
export class PermissionsInvalidStateError extends Data.TaggedError("InvalidStateError")<{
  readonly cause: unknown
}> {
  override get message(): string {
    return this._tag
  }
}

/**
 * Error reason for a `TypeError` raised by the browser Permissions API.
 *
 * @category errors
 * @since 4.0.0
 */
export class PermissionsTypeError extends Data.TaggedError("TypeError")<{
  readonly cause: unknown
}> {
  override get message(): string {
    return this._tag
  }
}

/**
 * Union of browser Permissions API error reasons represented by the service.
 *
 * @category errors
 * @since 4.0.0
 */
export type PermissionsErrorReason = PermissionsInvalidStateError | PermissionsTypeError

/**
 * Tagged error wrapping a browser Permissions API failure reason.
 *
 * @category errors
 * @since 4.0.0
 */
export class PermissionsError extends Data.TaggedError("PermissionsError")<{
  readonly reason: PermissionsErrorReason
}> {
  constructor(props: { readonly reason: PermissionsErrorReason }) {
    super({
      ...props,
      cause: props.reason.cause
    } as any)
  }

  readonly [ErrorTypeId] = ErrorTypeId

  override get message(): string {
    return this.reason.message
  }
}

/**
 * Service tag for browser permission querying.
 *
 * **When to use**
 *
 * Use when an Effect needs to require or provide browser permission querying
 * through the context.
 *
 * @category services
 * @since 4.0.0
 */
export const Permissions: Context.Service<Permissions, Permissions> = Context.Service<Permissions>(TypeId)

/**
 * Provides the `Permissions` service using the browser `navigator.permissions` API.
 *
 * **When to use**
 *
 * Use when browser programs need a live `Permissions` service backed by the
 * ambient `navigator.permissions` implementation.
 *
 * **Details**
 *
 * `query` delegates to `navigator.permissions.query({ name })` and wraps
 * rejected browser operations in `PermissionsError`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<Permissions> = Layer.succeed(
  Permissions,
  Permissions.of({
    [TypeId]: TypeId,
    query: (name) =>
      Effect.tryPromise({
        try: () => navigator.permissions.query({ name }) as Promise<any>,
        catch: (cause) =>
          new PermissionsError({
            reason: cause instanceof DOMException
              ? new PermissionsInvalidStateError({ cause })
              : new PermissionsTypeError({ cause })
          })
      })
  })
)
