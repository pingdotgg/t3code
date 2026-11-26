import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  finishOpenRouterSignIn,
  getCloudSpeechKeys,
  startOpenRouterSignIn,
} from "@t3tools/client-runtime/voice-input";
import { useGT } from "gt-react-native";
import { useEffect, useState } from "react";
import { AppState, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { runSpeech } from "../voice-input/voiceDestination";

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
  onSignedIn,
}: {
  readonly prepared: PreparedConnection;
  readonly onSignedIn: () => void;
}) {
  const gt = useGT();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  const start = async () => {
    setError("");
    setPhase({ kind: "starting" });
    const signIn = await runSpeech(startOpenRouterSignIn(prepared)).catch(() => null);
    const opened =
      signIn !== null && (await tryOpenExternalUrl(signIn.authorizationUrl, "provider-auth"));
    if (!signIn || !opened) {
      setError(gt("Couldn’t start signing in with OpenRouter. Try again."));
      setPhase({ kind: "idle" });
      return;
    }
    setPhase(signIn.pasteCode ? { kind: "code", state: signIn.state } : { kind: "waiting" });
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- OpenRouter finishes in the browser; returning to the app is when the key may have arrived.
  useEffect(() => {
    if (phase.kind !== "waiting") return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void runSpeech(getCloudSpeechKeys(prepared)).then(
        (keys) => {
          if (keys.openrouter) onSignedIn();
        },
        () => {
          // Checked again the next time the app comes back.
        },
      );
    });
    return () => subscription.remove();
  }, [phase.kind, prepared, onSignedIn]);

  const finish = async (state: string) => {
    setError("");
    try {
      await runSpeech(finishOpenRouterSignIn(prepared, state, code.trim()));
      onSignedIn();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : gt("OpenRouter didn’t accept this code. Sign in again."),
      );
    }
  };

  return (
    <View className="gap-3">
      {phase.kind === "code" ? (
        <>
          <TextInput
            accessibilityLabel={gt("Code from OpenRouter")}
            placeholder={gt("Code from OpenRouter")}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            className="rounded-lg border border-border-subtle px-3 py-2 text-foreground"
            value={code}
            onChangeText={setCode}
          />
          <Button
            label={gt("Finish")}
            size="compact"
            disabled={!code.trim()}
            onPress={() => void finish(phase.state)}
          />
        </>
      ) : (
        <Button
          label={phase.kind === "waiting" ? gt("Sign in again") : gt("Sign in with OpenRouter")}
          size="compact"
          disabled={phase.kind === "starting"}
          onPress={() => void start()}
        />
      )}
      {phase.kind === "waiting" && (
        <Text textRole="footnote" className="text-foreground-muted">
          {gt("Finish signing in on OpenRouter, then come back here.")}
        </Text>
      )}
      {error ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
