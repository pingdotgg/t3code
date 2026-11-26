import type * as Koffi from "koffi";

export type AudioCppAudio = {
  /** Interleaved samples in [-1, 1]. */
  readonly samples: Float32Array;
  readonly sampleRate: number;
  readonly channels: number;
};

export type AudioCppSynthesisRequest = {
  readonly text: string;
  /** Omit when the model should pick its own language. */
  readonly language?: string;
  /** Request options the model spec declares, such as `voice_id` or `speed`. */
  readonly options?: Readonly<Record<string, string>>;
  /** The speaker a voice-cloning model imitates. */
  readonly voiceAudio?: AudioCppAudio;
};

export type AudioCppSpeechStream = {
  /** Synthesizes the model's next text chunk; `undefined` once the text is spoken. */
  readonly next: () => AudioCppAudio | undefined;
  readonly close: () => void;
};

export type AudioCppModel = {
  readonly family: string;
  readonly backend: string;
  readonly languages: readonly string[];
  /** One stream at a time: starting another resets the first. */
  readonly stream: (request: AudioCppSynthesisRequest) => AudioCppSpeechStream;
  readonly dispose: () => void;
};

export type AudioCppLibrary = {
  readonly buildVersion: string;
  /**
   * Opens a text-to-speech session, streaming when the model can, falling back to the CPU when
   * `backend` fails.
   */
  readonly loadSpeechModel: (
    path: string,
    options: {
      readonly backend: string;
      readonly threads: number;
      /** The unpacked espeak-ng-data directory, for families that cannot find it themselves. */
      readonly espeakDirectory?: () => string | undefined;
    },
  ) => AudioCppModel;
};

/**
 * Binds audio.cpp's C ABI. Self-contained so a worker can inline it with `toString()`:
 * reference nothing from module scope. Calls block the thread, so run it off the server's.
 */
export function bindAudioCpp(koffi: typeof Koffi, libraryPath: string): AudioCppLibrary {
  const lib = koffi.load(libraryPath);
  // Anonymous types, so binding twice in one process does not collide on names.
  const Registry = koffi.pointer(koffi.opaque());
  const Model = koffi.pointer(koffi.opaque());
  const Session = koffi.pointer(koffi.opaque());
  const Request = koffi.pointer(koffi.opaque());
  const Result = koffi.pointer(koffi.opaque());
  const Event = koffi.pointer(koffi.opaque());
  const BackendConfig = koffi.struct({ backend: "const char *", device: "int", threads: "int" });
  const out = (type: string | Koffi.TypeObject) => koffi.out(koffi.pointer(type));
  const native = {
    abiVersion: lib.func("audiocpp_abi_version", "uint32_t", []),
    buildVersion: lib.func("audiocpp_build_version", "const char *", []),
    lastError: lib.func("audiocpp_last_error", "const char *", []),
    statusString: lib.func("audiocpp_status_string", "const char *", ["int"]),
    registryCreate: lib.func("audiocpp_registry_create", "int", ["const char *", out(Registry)]),
    registryFree: lib.func("audiocpp_registry_free", "void", [Registry]),
    modelLoad: lib.func("audiocpp_model_load", "int", [
      Registry,
      "const char *",
      "void *",
      "void *",
      out(Model),
    ]),
    modelFree: lib.func("audiocpp_model_free", "void", [Model]),
    modelFamily: lib.func("audiocpp_model_family", "const char *", [Model]),
    modelSupports: lib.func("audiocpp_model_supports", "int", [
      Model,
      "const char *",
      "const char *",
    ]),
    languageCount: lib.func("audiocpp_model_language_count", "size_t", [Model]),
    language: lib.func("audiocpp_model_language", "int", [Model, "size_t", out("const char *")]),
    sessionCreate: lib.func("audiocpp_session_create", "int", [
      Model,
      "const char *",
      "const char *",
      koffi.pointer(BackendConfig),
      "void *",
      out(Session),
    ]),
    sessionFree: lib.func("audiocpp_session_free", "void", [Session]),
    sessionRun: lib.func("audiocpp_session_run", "int", [Session, Request, out(Result)]),
    resultFree: lib.func("audiocpp_result_free", "void", [Result]),
    optionsCreate: lib.func("audiocpp_options_create", "void *", []),
    optionsSet: lib.func("audiocpp_options_set", "int", ["void *", "const char *", "const char *"]),
    optionsFree: lib.func("audiocpp_options_free", "void", ["void *"]),
    streamStart: lib.func("audiocpp_stream_start", "int", [Session, Request]),
    streamNextEvent: lib.func("audiocpp_stream_next_event", "int", [Session, out(Event)]),
    streamReset: lib.func("audiocpp_stream_reset", "int", [Session]),
    eventFree: lib.func("audiocpp_event_free", "void", [Event]),
    eventAsResult: lib.func("audiocpp_event_as_result", Result, [Event]),
    namedAudioCount: lib.func("audiocpp_result_named_audio_count", "size_t", [Result]),
    resultAudio: lib.func("audiocpp_result_audio", "int", [
      Result,
      out("void *"),
      out("size_t"),
      out("int"),
      out("int"),
    ]),
    namedAudio: lib.func("audiocpp_result_named_audio", "int", [
      Result,
      "size_t",
      out("const char *"),
      out("void *"),
      out("size_t"),
      out("int"),
      out("int"),
    ]),
    requestCreate: lib.func("audiocpp_request_create", Request, []),
    requestFree: lib.func("audiocpp_request_free", "void", [Request]),
    requestSetText: lib.func("audiocpp_request_set_text", "int", [
      Request,
      "const char *",
      "const char *",
    ]),
    requestSetOption: lib.func("audiocpp_request_set_option", "int", [
      Request,
      "const char *",
      "const char *",
    ]),
    requestSetVoiceAudio: lib.func("audiocpp_request_set_voice_audio", "int", [
      Request,
      "float *",
      "size_t",
      "int",
      "int",
    ]),
  };
  // Refuse a library whose major ABI differs from the one these signatures describe.
  if (native.abiVersion() >>> 16 !== 0) throw new Error("Unsupported audio.cpp ABI version.");
  const check = (status: number, operation: string) => {
    if (status === 0) return;
    const detail = native.lastError();
    throw new Error(
      `audio.cpp ${operation} failed (${native.statusString(status)})${detail ? `: ${detail}` : ""}`,
    );
  };
  const registry: [unknown] = [null];
  check(native.registryCreate(null, registry), "registry creation");

  const openSession = (
    model: unknown,
    mode: string,
    backend: string,
    threads: number,
    sessionOptions: Readonly<Record<string, string>>,
  ) => {
    const session: [unknown] = [null];
    const options = native.optionsCreate();
    try {
      for (const [key, value] of Object.entries(sessionOptions))
        check(native.optionsSet(options, key, value), `session option ${key}`);
      check(
        native.sessionCreate(model, "tts", mode, { backend, device: 0, threads }, options, session),
        `${backend} session creation`,
      );
    } finally {
      native.optionsFree(options);
    }
    return session[0];
  };
  // Chunked families name each piece; families that generate in one pass do not.
  const readAudio = (result: unknown) => {
    const samples: [unknown] = [null];
    const frames: [number | bigint] = [0];
    const sampleRate: [number] = [0];
    const channels: [number] = [0];
    check(
      Number(native.namedAudioCount(result)) > 0
        ? native.namedAudio(result, 0, [""], samples, frames, sampleRate, channels)
        : native.resultAudio(result, samples, frames, sampleRate, channels),
      "audio read",
    );
    const length = Number(frames[0]) * channels[0];
    // decode copies the samples before the result is freed; a koffi.view ArrayBuffer
    // over native memory aborts the process under Electron.
    const copy: Float32Array = length
      ? koffi.decode(samples[0], koffi.array("float", length, "Typed"))
      : new Float32Array(0);
    return { samples: copy, sampleRate: sampleRate[0], channels: channels[0] };
  };

  return {
    buildVersion: native.buildVersion(),
    loadSpeechModel(path, { backend, threads, espeakDirectory }) {
      const loaded: [unknown] = [null];
      check(native.modelLoad(registry[0], path, null, null, loaded), "model load");
      const model = loaded[0];
      let session: unknown;
      let sessionBackend = backend;
      const streaming = native.modelSupports(model, "tts", "streaming") === 1;
      const mode = streaming ? "streaming" : "offline";
      try {
        if (!streaming && !native.modelSupports(model, "tts", "offline"))
          throw new Error("This model does not support text to speech.");
        let sessionOptions: Record<string, string> = {};
        const open = (target: string) => {
          try {
            return openSession(model, mode, target, threads, sessionOptions);
          } catch (error) {
            // Some families read espeak-ng-data only from an explicit path; failing once unpacks it.
            const directory = /espeak-ng-data directory/.test(String(error)) && espeakDirectory?.();
            if (!directory) throw error;
            sessionOptions = { [`${native.modelFamily(model)}.espeak_data_path`]: directory };
            return openSession(model, mode, target, threads, sessionOptions);
          }
        };
        try {
          session = open(backend);
        } catch (error) {
          if (backend === "cpu") throw error;
          sessionBackend = "cpu";
          session = open("cpu");
        }
      } catch (error) {
        native.modelFree(model);
        throw error;
      }
      const languages: string[] = [];
      for (let index = 0; index < native.languageCount(model); index++) {
        const language: [string] = [""];
        if (native.language(model, index, language) === 0 && language[0])
          languages.push(language[0]);
      }
      return {
        family: native.modelFamily(model),
        backend: sessionBackend,
        languages,
        stream({ text, language, options = {}, voiceAudio }) {
          const request = native.requestCreate();
          if (!request) throw new Error("audio.cpp could not allocate a request.");
          const build = () => {
            check(native.requestSetText(request, text, language ?? null), "request text");
            for (const [key, value] of Object.entries(options))
              check(native.requestSetOption(request, key, value), `request option ${key}`);
            if (voiceAudio)
              check(
                native.requestSetVoiceAudio(
                  request,
                  voiceAudio.samples,
                  voiceAudio.samples.length / voiceAudio.channels,
                  voiceAudio.sampleRate,
                  voiceAudio.channels,
                ),
                "voice audio",
              );
          };
          if (!streaming) {
            // Generates the whole text in one call, which `next` makes so it can be cancelled first.
            let pending = true;
            const close = () => {
              if (!pending) return;
              pending = false;
              native.requestFree(request);
            };
            return {
              next() {
                if (!pending) return undefined;
                const result: [unknown] = [null];
                try {
                  build();
                  check(native.sessionRun(session, request, result), "synthesis");
                  return readAudio(result[0]);
                } finally {
                  if (result[0]) native.resultFree(result[0]);
                  close();
                }
              },
              close,
            };
          }
          try {
            build();
            // Starting copies the request into the session, so it can be freed right away.
            check(native.streamStart(session, request), "stream start");
          } finally {
            native.requestFree(request);
          }
          let open = true;
          const close = () => {
            if (!open) return;
            open = false;
            native.streamReset(session);
          };
          return {
            next() {
              if (!open) return undefined;
              const event: [unknown] = [null];
              try {
                check(native.streamNextEvent(session, event), "synthesis");
              } catch (error) {
                close();
                throw error;
              }
              if (!event[0]) {
                close();
                return undefined;
              }
              try {
                return readAudio(native.eventAsResult(event[0]));
              } finally {
                native.eventFree(event[0]);
              }
            },
            close,
          };
        },
        dispose() {
          native.sessionFree(session);
          native.modelFree(model);
        },
      };
    },
  };
}
