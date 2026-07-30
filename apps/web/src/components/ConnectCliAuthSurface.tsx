import { encodeConnectAuthCode, readConnectAuthorizeRequest } from "@t3tools/shared/connectAuth";
import { useEffect, useState } from "react";

import {
  buildConnectCliAuthorizeUrl,
  readConnectCliAuthState,
  rememberConnectCliAuthState,
} from "../cloud/connectCliAuth";

export function ConnectCliAuthorizeSurface() {
  const [request] = useState(() => readConnectAuthorizeRequest(new URL(window.location.href)));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!request) return;
    const url = buildConnectCliAuthorizeUrl(request);
    if (!url) {
      setError("T3 Connect authorization is not configured for this hosted app.");
      return;
    }
    rememberConnectCliAuthState(request.state);
    window.location.assign(url);
  }, [request]);

  return (
    <main className="mx-auto mt-24 max-w-lg px-6 font-sans">
      <h1 className="text-2xl font-semibold">Connecting your terminal</h1>
      <p className="mt-3 text-muted-foreground">
        {error ??
          (request
            ? "Redirecting to sign in and authorize T3 Connect."
            : "This link is incomplete. Re-run `t3 connect` and open the new URL.")}
      </p>
    </main>
  );
}

export function ConnectCliCallbackSurface() {
  const [result] = useState(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code")?.trim() ?? "";
    const state = url.searchParams.get("state")?.trim() ?? "";
    return code && state ? { code, state } : null;
  });
  const [expectedState] = useState(readConnectCliAuthState);

  const valid = result !== null && expectedState !== null && result.state === expectedState;
  const code = valid && result ? encodeConnectAuthCode(result) : null;

  return (
    <main className="mx-auto mt-24 max-w-lg px-6 font-sans">
      <h1 className="text-2xl font-semibold">
        {code ? "Almost connected" : "Authorization did not complete"}
      </h1>
      <p className="mt-3 text-muted-foreground">
        {code
          ? "Copy this one-time code into the terminal that started T3 Connect."
          : "This callback is invalid, expired, or belongs to a different request. Re-run `t3 connect` and try again."}
      </p>
      {code ? (
        <code className="mt-6 block break-all rounded border p-4 font-mono text-sm select-all">
          {code}
        </code>
      ) : null}
    </main>
  );
}
