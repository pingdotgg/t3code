import { previewFailure, type PreviewFailure } from "./previewFailure";
import type { PreviewFailureCode } from "./previewFailureMessages";

export type PreviewUnlock = { readonly type: "unlock"; readonly password: string };
export type PreviewPassword = { readonly type: "password"; readonly incorrect: boolean };

// Keep the encrypted input in the worker while the form is open. A retry only sends the password.
export function previewUnlock<Request extends { type: string }>(
  open: (request: Request, password?: string) => Promise<void>,
  reply: (result: PreviewPassword | ({ type: "error" } & PreviewFailure)) => void,
  fallback: PreviewFailureCode,
) {
  let locked: Request | undefined;
  let working = false;
  return async (request: Request | PreviewUnlock) => {
    const input = request.type === "unlock" ? locked : (request as Request);
    if (!input || (input.type === "open" && working)) return;
    if (input.type === "open") working = true;
    try {
      await open(input, "password" in request ? request.password : undefined);
      if (input.type === "open") locked = undefined;
    } catch (cause) {
      const failure = previewFailure(cause, fallback);
      if (failure.code === "password-required" || failure.code === "password-incorrect") {
        locked = input;
        reply({ type: "password", incorrect: failure.code === "password-incorrect" });
      } else {
        if (input.type === "open") locked = undefined;
        reply({ type: "error", ...failure });
      }
    } finally {
      if (input.type === "open") working = false;
    }
  };
}
