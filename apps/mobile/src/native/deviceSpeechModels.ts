import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { EnvironmentSpeechModel } from "@t3tools/contracts";
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
  Schema.Struct({ revision: Schema.Int, states: Schema.Record(Schema.String, NativeState) }),
);
const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  size: Schema.Int.check(Schema.isGreaterThan(0)),
  languages: Schema.Array(Schema.String),
  benchmark: EnvironmentSpeechModel.fields.benchmark,
  canRun: Schema.optionalKey(Schema.Boolean),
});
type Model = typeof Model.Type;
type CatalogState =
  | { readonly kind: "checking" | "unavailable" }
  | { readonly kind: "ready"; readonly states: Readonly<Record<string, typeof NativeState.Type>> };

interface DeviceSpeechModule {
  addListener(
    event: "deviceSpeechModelStates",
    listener: (snapshot: unknown) => void,
  ): EventSubscription;
  getDeviceSpeechCatalog?: () => unknown;
  getDeviceSpeechModelStates(): Promise<unknown>;
  startDeviceSpeechModelDownload(modelId: string): Promise<void>;
  cancelDeviceSpeechModelDownload(modelId: string): Promise<void>;
  removeDeviceSpeechModel(modelId: string): Promise<void>;
  transcribeWithDeviceSpeechModel(
    modelId: string,
    id: string,
    uri: string,
  ): Promise<{ readonly text: string; readonly language?: string }>;
  cancelDeviceSpeechInference(id: string): Promise<void>;
}

const native =
  Platform.OS === "ios"
    ? requireOptionalNativeModule<DeviceSpeechModule>("T3VoiceTranscription")
    : null;
export const deviceSpeechCatalog = Option.getOrElse(
  Schema.decodeUnknownOption(Schema.Array(Model))(native?.getDeviceSpeechCatalog?.()),
  () => [],
);

export const findRunnableDeviceSpeechModel = (id: string) =>
  deviceSpeechCatalog.find((model) => model.id === id && model.canRun !== false);

export const deviceSpeechModelStatesAtom = Atom.make<CatalogState>((get) => {
  if (!native || deviceSpeechCatalog.length === 0) return { kind: "unavailable" };

  let revision = -1;
  const accept = (payload: unknown) => {
    const snapshot = decodeSnapshot(payload);
    if (Option.isNone(snapshot) || snapshot.value.revision <= revision) return;
    revision = snapshot.value.revision;
    get.setSelf({ kind: "ready", states: snapshot.value.states });
  };
  const refresh = () => {
    void native.getDeviceSpeechModelStates().then(accept, () => {
      if (revision === -1) get.setSelf({ kind: "unavailable" });
    });
  };
  const events = native.addListener("deviceSpeechModelStates", accept);
  get.addFinalizer(() => events.remove());
  get.addFinalizer(subscribeAppActive(refresh));
  refresh();
  return { kind: "checking" };
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:device-speech-models"));

export const deviceSpeechModelActions =
  native && deviceSpeechCatalog.length > 0
    ? {
        download: (id: string) => native.startDeviceSpeechModelDownload(id),
        cancel: (id: string) => native.cancelDeviceSpeechModelDownload(id),
        remove: (id: string) => native.removeDeviceSpeechModel(id),
      }
    : null;

export const deviceSpeechTranscriber = (model: Model): VoiceTranscriber => ({
  prepare: async ({ signal }) => {
    throwIfVoiceTranscriptionAborted(signal);
    const snapshot =
      native && deviceSpeechCatalog.length > 0
        ? decodeSnapshot(await native.getDeviceSpeechModelStates())
        : Option.none();
    throwIfVoiceTranscriptionAborted(signal);
    if (!native || Option.isNone(snapshot) || snapshot.value.states[model.id]?.kind !== "ready") {
      throw new VoiceTranscriptionError({
        code: "unavailable",
        message: m(
          msg("Download {model} in Settings → Voice to use it for dictation.", {
            model: model.name,
          }),
        ),
      });
    }
    let locale = "auto";
    return {
      get locale() {
        return locale;
      },
      transcribe: async (uri, { signal }) => {
        throwIfVoiceTranscriptionAborted(signal);
        const id = uuidv4();
        let cancellation: Promise<void> | undefined;
        const abort = () => {
          cancellation = native.cancelDeviceSpeechInference(id).catch(() => {});
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          const transcript = await native.transcribeWithDeviceSpeechModel(model.id, id, uri);
          throwIfVoiceTranscriptionAborted(signal);
          locale = transcript.language ?? "auto";
          return transcript.text;
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
});
