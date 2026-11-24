import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { Option } from "effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { requireOptionalNativeModule, type EventSubscription } from "expo";
import { msg } from "gt-react-native";
import { Platform } from "react-native";
import { m } from "../i18n/messages";
import { subscribeAppActive } from "../lib/appState";
import { uuidv4 } from "../lib/uuid";

const NativeState = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("downloading"),
    percent: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  }),
  Schema.Struct({
    kind: Schema.Literals(["missing", "verifying", "cancelling", "ready", "failed"]),
  }),
]);
const decodeSnapshot = Schema.decodeUnknownOption(
  Schema.Struct({ revision: Schema.Int, state: NativeState }),
);
type ModelState = typeof NativeState.Type | { readonly kind: "checking" | "unavailable" };

interface ParakeetUltraModule {
  addListener(
    event: "parakeetUltraState",
    listener: (snapshot: unknown) => void,
  ): EventSubscription;
  getParakeetUltraSize?: () => number;
  getParakeetUltraState(): Promise<unknown>;
  startParakeetUltraDownload(): Promise<void>;
  cancelParakeetUltraDownload(): Promise<void>;
  removeParakeetUltra(): Promise<void>;
  transcribeWithParakeetUltra(id: string, uri: string): Promise<string>;
  cancelParakeetUltraTranscription(id: string): Promise<void>;
}

const native =
  Platform.OS === "ios"
    ? requireOptionalNativeModule<ParakeetUltraModule>("T3VoiceTranscription")
    : null;
export const parakeetUltraSize = native?.getParakeetUltraSize?.() ?? null;

export const parakeetUltraStateAtom = Atom.make<ModelState>((get) => {
  if (!native || parakeetUltraSize === null) return { kind: "unavailable" };

  let revision = -1;
  const accept = (payload: unknown) => {
    const snapshot = decodeSnapshot(payload);
    if (Option.isNone(snapshot) || snapshot.value.revision <= revision) return;
    revision = snapshot.value.revision;
    get.setSelf(snapshot.value.state);
  };
  const refresh = () => {
    void native.getParakeetUltraState().then(accept, () => {
      if (revision === -1) get.setSelf({ kind: "unavailable" });
    });
  };
  const events = native.addListener("parakeetUltraState", accept);
  get.addFinalizer(() => events.remove());
  get.addFinalizer(subscribeAppActive(refresh));
  refresh();
  return { kind: "checking" };
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:parakeet-ultra"));

export const parakeetUltraActions =
  native && parakeetUltraSize !== null
    ? {
        download: () => native.startParakeetUltraDownload(),
        cancel: () => native.cancelParakeetUltraDownload(),
        remove: () => native.removeParakeetUltra(),
      }
    : null;

export const parakeetUltraTranscriber: VoiceTranscriber = {
  prepare: async ({ signal }) => {
    throwIfVoiceTranscriptionAborted(signal);
    const snapshot =
      native && parakeetUltraSize !== null
        ? decodeSnapshot(await native.getParakeetUltraState())
        : Option.none();
    throwIfVoiceTranscriptionAborted(signal);
    if (!native || Option.isNone(snapshot) || snapshot.value.state.kind !== "ready") {
      throw new VoiceTranscriptionError({
        code: "unavailable",
        message: m(
          msg("Download {model} in Settings → Voice to use it for dictation.", {
            model: "Parakeet Ultra",
          }),
        ),
      });
    }
    return {
      locale: "auto",
      transcribe: async (uri, { signal }) => {
        throwIfVoiceTranscriptionAborted(signal);
        const id = uuidv4();
        let cancellation: Promise<void> | undefined;
        const abort = () => {
          cancellation = native.cancelParakeetUltraTranscription(id).catch(() => {});
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          const text = await native.transcribeWithParakeetUltra(id, uri);
          throwIfVoiceTranscriptionAborted(signal);
          return text;
        } catch (error) {
          throwIfVoiceTranscriptionAborted(signal);
          throw new VoiceTranscriptionError({
            code: "transcription-failed",
            message: m(msg("Voice transcription failed.")),
            cause: error,
          });
        } finally {
          signal.removeEventListener("abort", abort);
          await cancellation;
        }
      },
    };
  },
};
