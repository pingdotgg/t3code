import type { BrowserWindow } from "electron";

import type { PasskeyCeremonyResult } from "./PasskeyBridge.ts";

export interface PasskeyCeremonyContext {
  /** The committed origin of the frame that asked; never the page's own claim. */
  readonly origin: string;
  readonly nativeWindowHandle: Buffer;
  readonly window: BrowserWindow;
  readonly signal: AbortSignal;
}

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
