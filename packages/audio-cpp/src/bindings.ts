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
  /** Opens a streaming text-to-speech session, falling back to the CPU when `backend` fails. */
  readonly loadSpeechModel: (
    path: string,
    options: { readonly backend: string; readonly threads: number },
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
    streamStart: lib.func("audiocpp_stream_start", "int", [Session, Request]),
    streamNextEvent: lib.func("audiocpp_stream_next_event", "int", [Session, out(Event)]),
    streamReset: lib.func("audiocpp_stream_reset", "int", [Session]),
    eventFree: lib.func("audiocpp_event_free", "void", [Event]),
    eventAsResult: lib.func("audiocpp_event_as_result", Result, [Event]),
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

  const openSession = (model: unknown, backend: string, threads: number) => {
    const session: [unknown] = [null];
    check(
      native.sessionCreate(
        model,
        "tts",
        "streaming",
        { backend, device: 0, threads },
        null,
        session,
      ),
      `${backend} session creation`,
    );
    return session[0];
  };

  return {
    buildVersion: native.buildVersion(),
    loadSpeechModel(path, { backend, threads }) {
      const loaded: [unknown] = [null];
      check(native.modelLoad(registry[0], path, null, null, loaded), "model load");
      const model = loaded[0];
      let session: unknown;
      let sessionBackend = backend;
      try {
        if (!native.modelSupports(model, "tts", "streaming"))
          throw new Error("This model does not support streaming text to speech.");
        try {
          session = openSession(model, backend, threads);
        } catch (error) {
          if (backend === "cpu") throw error;
          sessionBackend = "cpu";
          session = openSession(model, "cpu", threads);
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
        stream({ text, language, options = {} }) {
          const request = native.requestCreate();
          if (!request) throw new Error("audio.cpp could not allocate a request.");
          try {
            check(native.requestSetText(request, text, language ?? null), "request text");
            for (const [key, value] of Object.entries(options))
              check(native.requestSetOption(request, key, value), `request option ${key}`);
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
                const id: [string] = [""];
                const samples: [unknown] = [null];
                const frames: [number | bigint] = [0];
                const sampleRate: [number] = [0];
                const channels: [number] = [0];
                check(
                  native.namedAudio(
                    native.eventAsResult(event[0]),
                    0,
                    id,
                    samples,
                    frames,
                    sampleRate,
                    channels,
                  ),
                  "audio read",
                );
                const length = Number(frames[0]) * channels[0];
                // The view borrows event memory, so copy it before the event is freed.
                const copy = new Float32Array(length);
                if (length) copy.set(new Float32Array(koffi.view(samples[0], length * 4)));
                return { samples: copy, sampleRate: sampleRate[0], channels: channels[0] };
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
