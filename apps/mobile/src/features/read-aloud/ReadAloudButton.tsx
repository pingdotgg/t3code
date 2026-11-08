import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { createContext, memo, use, useEffect, type ReactNode } from "react";
import { ActivityIndicator, Pressable, type ColorValue } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { usePreparedConnection } from "../../state/session";
import { mobilePreferencesAtom } from "../../state/preferences";
import {
  startReadAloud,
  stopReadAloud,
  stopReadAloudFor,
  useReadAloudState,
} from "./readAloudPlayer";
import {
  DEFAULT_READ_ALOUD_VOICE,
  readAloudBaseUrl,
  resolveReadAloudServerUrl,
} from "./readAloudServer";

export function useReadAloudServerUrl(environmentId: EnvironmentId | null): string | null {
  const prepared = usePreparedConnection(environmentId);
  return resolveReadAloudServerUrl(
    Option.isSome(prepared)
      ? readAloudBaseUrl(prepared.value.target._tag, prepared.value.httpBaseUrl)
      : null,
  );
}

export function useReadAloudVoice(): string {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? (preferences.value.readAloudVoice ?? DEFAULT_READ_ALOUD_VOICE)
    : DEFAULT_READ_ALOUD_VOICE;
}

const ReadAloudOwnerContext = createContext<string | null>(null);

/**
 * Wraps a thread's replies: leaving the thread stops a reply from it that is still being read,
 * since the Stop button goes away with the thread.
 */
export function ReadAloudOwner(props: { readonly ownerKey: string; readonly children: ReactNode }) {
  const { ownerKey } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops audio from this thread when its screen goes away or shows another thread.
  useEffect(() => () => stopReadAloudFor(ownerKey), [ownerKey]);
  return <ReadAloudOwnerContext value={ownerKey}>{props.children}</ReadAloudOwnerContext>;
}

/** Speaker button on a reply: reads it aloud with the PC's natural voice. */
export const ReadAloudButton = memo(function ReadAloudButton(props: {
  readonly messageId: string;
  readonly markdown: string;
  readonly environmentId: EnvironmentId;
  readonly tintColor?: ColorValue;
  readonly iconSize?: number;
  readonly buttonSize?: number;
}) {
  const serverUrl = useReadAloudServerUrl(props.environmentId);
  const voice = useReadAloudVoice();
  const readAloud = useReadAloudState();
  const mine = readAloud.messageId === props.messageId;
  const loading = mine && readAloud.status === "loading";
  const playing = mine && readAloud.status === "playing";
  const ownerKey = use(ReadAloudOwnerContext);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={playing || loading ? "Stop reading aloud" : "Read aloud"}
      disabled={props.markdown.trim().length === 0}
      hitSlop={8}
      onPress={() => {
        if (mine && readAloud.status !== "idle") {
          stopReadAloud();
          return;
        }
        void startReadAloud({
          messageId: props.messageId,
          markdown: props.markdown,
          serverUrl,
          voice,
          ownerKey,
        });
      }}
      style={({ pressed }) => ({
        width: props.buttonSize ?? 30,
        height: props.buttonSize ?? 30,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 9,
        opacity: pressed ? 0.52 : 1,
      })}
    >
      {loading ? (
        <ActivityIndicator size="small" color={props.tintColor} />
      ) : (
        <SymbolView
          name={playing ? "stop.fill" : "speaker.wave.2"}
          size={props.iconSize ?? 13}
          tintColor={props.tintColor}
          tintColorClassName={props.tintColor ? undefined : "accent-foreground"}
        />
      )}
    </Pressable>
  );
});
