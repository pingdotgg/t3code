import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  finishOpenRouterSignIn,
  getOpenRouterSignInStatus,
  startOpenRouterSignIn,
} from "@t3tools/client-runtime/voice-input";
import { useGT } from "gt-react";
import { useEffect, useId, useState } from "react";
import { ensureLocalApi } from "../../localApi";
import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
import { OpenRouterIcon } from "../Icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "waiting"; readonly state: string }
  | { readonly kind: "code"; readonly state: string };

/**
 * Signs in with OpenRouter, which creates a key for the environment. OpenRouter returns to the
 * environment when it can; otherwise it shows a code to paste here.
 */
export function OpenRouterSignIn({
  prepared,
  disabled,
  onSignedIn,
}: {
  readonly prepared: PreparedConnection;
  readonly disabled?: boolean;
  readonly onSignedIn: () => void;
}) {
  const gt = useGT();
  const codeId = useId();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  const start = async () => {
    setError("");
    setPhase({ kind: "starting" });
    try {
      const signIn = await runEnvironmentSpeech(startOpenRouterSignIn(prepared));
      await ensureLocalApi().shell.openExternal(signIn.authorizationUrl);
      setPhase({ kind: signIn.pasteCode ? "code" : "waiting", state: signIn.state });
    } catch {
      setError(gt("Couldn’t start signing in with OpenRouter. Try again."));
      setPhase({ kind: "idle" });
    }
  };

  const waitingFor = phase.kind === "waiting" ? phase.state : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- OpenRouter finishes in another tab or the system browser; coming back is when the sign-in may have finished.
  useEffect(() => {
    if (waitingFor === null) return;
    let checking = false;
    // Asks about this sign-in, not whether a key exists, so replacing a saved key works too.
    const check = () => {
      if (checking || document.visibilityState !== "visible") return;
      checking = true;
      void runEnvironmentSpeech(getOpenRouterSignInStatus(prepared, waitingFor)).then(
        ({ status }) => {
          checking = false;
          if (status === "signed-in") return onSignedIn();
          if (status === "pending") return;
          setError(
            status === "rejected"
              ? gt("OpenRouter didn’t accept this sign-in. Sign in again.")
              : status === "unavailable"
                ? gt("Couldn’t reach OpenRouter. Try again.")
                : gt("This OpenRouter sign-in expired. Sign in again."),
          );
          setPhase({ kind: "idle" });
        },
        () => {
          // Checked again the next time this window comes back.
          checking = false;
        },
      );
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [waitingFor, prepared, onSignedIn, gt]);

  const finish = async (state: string) => {
    setError("");
    try {
      await runEnvironmentSpeech(finishOpenRouterSignIn(prepared, state, code.trim()));
      onSignedIn();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : gt("OpenRouter didn’t accept this code. Sign in again."),
      );
    }
  };

  if (phase.kind === "code")
    return (
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (code.trim()) void finish(phase.state);
        }}
      >
        <Label htmlFor={codeId}>{gt("Code from OpenRouter")}</Label>
        <div className="flex gap-2">
          <Input
            id={codeId}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={code}
            disabled={disabled}
            onChange={(event) => setCode(event.target.value)}
          />
          <Button type="submit" variant="outline" disabled={disabled || !code.trim()}>
            {gt("Finish")}
          </Button>
        </div>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <OrPasteKey />
      </form>
    );

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button
          type="button"
          variant="outline"
          disabled={disabled || phase.kind === "starting"}
          onClick={() => void start()}
        >
          <OpenRouterIcon aria-hidden />
          {phase.kind === "waiting" ? gt("Sign in again") : gt("Sign in with OpenRouter")}
        </Button>
        {phase.kind === "waiting" && (
          <p className="text-sm text-muted-foreground" role="status">
            {gt("Finish signing in on OpenRouter, then come back here.")}
          </p>
        )}
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <OrPasteKey />
    </div>
  );
}

/** Separates signing in from the key field below it, which is the other way to set up OpenRouter. */
function OrPasteKey() {
  const gt = useGT();
  return (
    <p className="flex items-center gap-3 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
      {gt("or paste an API key")}
    </p>
  );
}
