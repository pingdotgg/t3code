import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  finishOpenRouterSignIn,
  getCloudSpeechKeys,
  startOpenRouterSignIn,
} from "@t3tools/client-runtime/voice-input";
import { useGT } from "gt-react";
import { useEffect, useId, useState } from "react";
import { ensureLocalApi } from "../../localApi";
import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "waiting" }
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
      setPhase(signIn.pasteCode ? { kind: "code", state: signIn.state } : { kind: "waiting" });
    } catch {
      setError(gt("Couldn’t start signing in with OpenRouter. Try again."));
      setPhase({ kind: "idle" });
    }
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- OpenRouter finishes in another tab or the system browser; coming back is when the key may have arrived.
  useEffect(() => {
    if (phase.kind !== "waiting") return;
    let checking = false;
    const check = () => {
      if (checking || document.visibilityState !== "visible") return;
      checking = true;
      void runEnvironmentSpeech(getCloudSpeechKeys(prepared)).then(
        (keys) => {
          checking = false;
          if (keys.openrouter) onSignedIn();
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
  }, [phase.kind, prepared, onSignedIn]);

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
      </form>
    );

  return (
    <div className="grid gap-2">
      <Button
        type="button"
        variant="outline"
        disabled={disabled || phase.kind === "starting"}
        onClick={() => void start()}
      >
        {phase.kind === "waiting" ? gt("Sign in again") : gt("Sign in with OpenRouter")}
      </Button>
      {phase.kind === "waiting" && (
        <p className="text-sm text-muted-foreground" role="status">
          {gt("Finish signing in on OpenRouter, then come back here.")}
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
