import type { PasskeyCeremonyResult } from "./PasskeyBridge.ts";

/** What the shared bridge has already checked before a backend runs a ceremony. */
export interface PasskeyCeremonyContext {
  /** The committed origin of the frame that asked; never the page's own claim. */
  readonly origin: string;
  /** The window the system sheet attaches to. */
  readonly nativeWindowHandle: Buffer;
}

/**
 * One platform's way to create and use passkeys for a preview page. The
 * bridge in `Passkeys.ts` owns everything platform-neutral: which frame may
 * ask, focus, one ceremony at a time, the deadline, and dropping results for
 * a page that navigated away. A backend only talks to the platform.
 */
export interface PasskeyBackend {
  readonly create: (
    publicKey: PublicKeyCredentialCreationOptions,
    context: PasskeyCeremonyContext,
  ) => Promise<PasskeyCeremonyResult>;
  readonly get: (
    publicKey: PublicKeyCredentialRequestOptions,
    context: PasskeyCeremonyContext,
  ) => Promise<PasskeyCeremonyResult>;
}
