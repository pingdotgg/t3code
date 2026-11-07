import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { getBrowserOidcController } from "../../cloud/oidc/browserOidc";
import { Button } from "../ui/button";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

/** Where the identity provider sends the user back to; finishes the sign-in and returns to the app. */
export function OidcCallbackSurface() {
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(() =>
    getBrowserOidcController() === null
      ? "This build has no OpenID Connect provider configured."
      : null,
  );
  const started = useRef(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- completes the redirect from the identity provider exactly once when the page loads
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const controller = getBrowserOidcController();
    if (controller === null) return;
    controller
      .completeSignIn(window.location.href)
      .then((returnTo) => router.history.replace(returnTo))
      .catch((cause: unknown) =>
        setFailure(cause instanceof Error ? cause.message : "The sign-in could not be completed."),
      );
  }, [router]);

  return (
    <StandalonePage>
      <StandalonePageHeader
        context="T3 Connect"
        title={failure === null ? "Signing you in" : "Sign-in did not complete"}
        description={failure ?? "Finishing the sign-in with your identity provider…"}
      />
      {failure === null ? null : (
        <div className="mt-6">
          <Button
            type="button"
            onClick={() => {
              void getBrowserOidcController()
                ?.signIn("/")
                .catch((cause: unknown) =>
                  setFailure(cause instanceof Error ? cause.message : "Sign-in could not start."),
                );
            }}
          >
            Try again
          </Button>
        </div>
      )}
    </StandalonePage>
  );
}
