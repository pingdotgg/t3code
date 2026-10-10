import type {
  PreviewStreamPasskeyRequest,
  PreviewStreamPasskeyResult,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

interface T3Passkeys {
  /** Set only in builds signed with Apple's browser entitlement; see app.config.ts. */
  readonly available: boolean;
  /** Answers with a `PreviewStreamPasskeyResult` in JSON. */
  readonly perform: (
    id: string,
    kind: "create" | "get",
    origin: string,
    options: string,
  ) => Promise<string>;
  readonly cancel: (id: string) => Promise<void>;
}

const native = Platform.OS === "ios" ? requireOptionalNativeModule<T3Passkeys>("T3Passkeys") : null;

/** This device answers server browser pages' passkey requests with its own passkeys. */
export const browserPasskeysAvailable = native?.available === true;

const NOT_ALLOWED: PreviewStreamPasskeyResult = { success: false, error: "NotAllowedError" };

/** Runs a page's passkey request through the system passkey sheet. */
export async function performBrowserPasskey(
  request: PreviewStreamPasskeyRequest,
): Promise<PreviewStreamPasskeyResult> {
  if (!native?.available) return NOT_ALLOWED;
  try {
    const result = await native.perform(
      request.id,
      request.kind,
      request.origin,
      JSON.stringify(request.publicKey),
    );
    // The server checks the credential before the page sees it.
    return JSON.parse(result) as PreviewStreamPasskeyResult;
  } catch {
    return NOT_ALLOWED;
  }
}

/** Closes the sheet for a request the page gave up on. */
export function cancelBrowserPasskey(id: string) {
  void native?.cancel(id).catch(() => undefined);
}
