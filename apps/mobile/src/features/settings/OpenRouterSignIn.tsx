import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  finishOpenRouterSignIn,
  getOpenRouterSignInStatus,
  startOpenRouterSignIn,
} from "@t3tools/client-runtime/voice-input";
import { useGT } from "gt-react-native";
import { useEffect, useState } from "react";
import { AppState, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { Button } from "../../components/ui/Button";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { runSpeech } from "../voice-input/voiceDestination";

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
    setPhase({ kind: signIn.pasteCode ? "code" : "waiting", state: signIn.state });
  };

  const waitingFor = phase.kind === "waiting" ? phase.state : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- OpenRouter finishes in the browser; returning to the app is when the sign-in may have finished.
  useEffect(() => {
    if (waitingFor === null) return;
    // Asks about this sign-in, not whether a key exists, so replacing a saved key works too.
    const subscription = AppState.addEventListener("change", (appState) => {
      if (appState !== "active") return;
      void runSpeech(getOpenRouterSignInStatus(prepared, waitingFor)).then(
        ({ status }) => {
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
          // Checked again the next time the app comes back.
        },
      );
    });
    return () => subscription.remove();
  }, [waitingFor, prepared, onSignedIn, gt]);

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
          tone="contrast"
          size="compact"
          leading={<ProviderIcon provider="openrouter" size={16} />}
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
      {/* The key field below is the other way to set up OpenRouter. */}
      <View className="flex-row items-center gap-3">
        <View className="h-px flex-1 bg-border-subtle" />
        <Text textRole="footnote" className="text-foreground-muted">
          {gt("or paste an API key")}
        </Text>
        <View className="h-px flex-1 bg-border-subtle" />
      </View>
    </View>
  );
}
