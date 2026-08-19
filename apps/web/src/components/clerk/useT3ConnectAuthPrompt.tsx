import { useEffect, useRef, useState } from "react";

import { useT3ConnectAuth } from "../../cloud/connectAuth";
import { isElectron } from "../../env";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

/**
 * Opens T3 Connect sign-in. On the web this is Clerk's modal; on desktop the
 * system browser handles the whole flow, so `authPrompt` renders a small
 * waiting dialog that closes itself once the environment server reports the
 * session. The dialog also accepts a pasted authorization code for browsers
 * that landed on the hosted out-of-band page instead of the loopback
 * callback, and offers a retry once a pending attempt ends without a session
 * (cancelled, denied, or timed out).
 */
export function useT3ConnectAuthPrompt() {
  const auth = useT3ConnectAuth();
  const [promptOpen, setPromptOpen] = useState(false);
  const [attemptFailed, setAttemptFailed] = useState(false);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [submittingCode, setSubmittingCode] = useState(false);
  const sawPendingRef = useRef(false);

  useEffect(() => {
    if (auth.isSignedIn) {
      setPromptOpen(false);
    }
  }, [auth.isSignedIn]);

  // The provider stops watching once pendingLogin settles; an attempt that
  // settled without a session failed, and the dialog must say so instead of
  // promising to update on its own.
  useEffect(() => {
    if (auth.pendingLogin) {
      sawPendingRef.current = true;
    } else if (promptOpen && sawPendingRef.current && !auth.isSignedIn) {
      setAttemptFailed(true);
    }
  }, [auth.isSignedIn, auth.pendingLogin, promptOpen]);

  const startAttempt = () => {
    sawPendingRef.current = false;
    setAttemptFailed(false);
    setCode("");
    setCodeError(null);
    auth.signIn();
  };

  const openAuthPrompt = () => {
    startAttempt();
    if (isElectron) {
      setPromptOpen(true);
    }
  };

  const submitCode = async () => {
    const value = code.trim();
    if (!auth.submitLoginCode || !value || submittingCode) return;
    setSubmittingCode(true);
    setCodeError(null);
    const error = await auth.submitLoginCode(value);
    setSubmittingCode(false);
    setCodeError(error);
    if (error === null) {
      setCode("");
    }
  };

  const authPrompt = isElectron ? (
    <Dialog open={promptOpen} onOpenChange={setPromptOpen}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Sign in to T3 Connect</DialogTitle>
          <DialogDescription>
            {attemptFailed ? "The sign-in did not complete." : "Finish signing in in your browser."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {attemptFailed ? (
            <p className="text-sm text-muted-foreground">
              The browser sign-in was cancelled or timed out.
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                This window updates on its own when you are done.
                {auth.authorizationUrl ? (
                  <>
                    {" "}
                    Nothing opened?{" "}
                    <a
                      className="text-foreground underline underline-offset-2"
                      href={auth.authorizationUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Open the sign-in page
                    </a>
                    .
                  </>
                ) : null}
              </p>
              {auth.submitLoginCode ? (
                <div className="mt-4 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Got an authorization code instead? Paste it here.
                  </p>
                  <div className="flex gap-2">
                    <Input
                      aria-label="Authorization code"
                      autoComplete="off"
                      placeholder="Authorization code"
                      spellCheck={false}
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void submitCode();
                      }}
                    />
                    <Button
                      disabled={submittingCode || code.trim().length === 0}
                      variant="outline"
                      onClick={() => void submitCode()}
                    >
                      Use code
                    </Button>
                  </div>
                  {codeError ? <p className="text-xs text-destructive">{codeError}</p> : null}
                </div>
              ) : null}
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setPromptOpen(false)}>
            Cancel
          </Button>
          {attemptFailed ? <Button onClick={startAttempt}>Try again</Button> : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  ) : null;

  return { authPrompt, openAuthPrompt };
}
