/**
 * Optional account-lifecycle operations a provider driver may expose (fork f1).
 *
 * Declared in its own module rather than inline in `ProviderDriver.ts` so the
 * upstream file carries a single type-import line plus a single optional
 * field. Drivers without a native login protocol simply omit `auth` and every
 * consumer degrades to "sign in via the CLI".
 *
 * Both operations are `R = never`: a driver materializes them inside its own
 * `create` scope, where the infrastructure services it needs are already in
 * hand, so transport layers never have to thread a spawner around.
 *
 * @module provider/ProviderAuthOps
 */
import type {
  ProviderAuthError,
  ProviderSignInEvent,
  ProviderSignInMode,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export interface ProviderAuthOps {
  /**
   * Sign-in modes this driver can drive. Copied verbatim onto
   * `ServerProvider.authMethods` so the client can render the right default
   * without knowing anything about the driver.
   */
  readonly authMethods: ReadonlyArray<ProviderSignInMode>;
  /**
   * Run one sign-in. The returned stream owns the provider process for the
   * duration of the handshake: **closing the stream cancels the login and
   * tears the process down**, which is why there is no separate cancel RPC.
   *
   * Handshake problems (spawn failure, timeout, a rejected code) arrive as a
   * `failed` event rather than a stream error, so the UI can offer "try
   * again" in place; the error channel is reserved for refusals that happen
   * before a login exists.
   */
  readonly startSignIn: (input: {
    readonly mode: ProviderSignInMode;
  }) => Stream.Stream<ProviderSignInEvent, ProviderAuthError>;
  /**
   * Drop the instance's credentials through the provider's own logout call.
   * t3 never deletes credential files itself — the provider CLI owns them.
   */
  readonly signOut: Effect.Effect<void, ProviderAuthError>;
}
