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

/** A word a forced aligner found, in seconds from the start of the audio it was given. */
export type AudioCppAlignedWord = {
  readonly word: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
};

export type AudioCppAligner = {
  readonly backend: string;
  /** Times each word of `text` in `audio`, in order; words with nothing to align are left out. */
  readonly align: (request: {
    readonly audio: AudioCppAudio;
    readonly text: string;
    readonly language: string;
    /** Request options the model spec declares, such as `star_frequency`. */
    readonly options?: Readonly<Record<string, string>>;
  }) => ReadonlyArray<AudioCppAlignedWord>;
  readonly dispose: () => void;
};

export type AudioCppLibrary = {
  readonly buildVersion: string;
  /** Opens a forced-alignment session, falling back to the CPU when `backend` fails. */
  readonly loadAligner: (
    path: string,
    options: { readonly backend: string; readonly threads: number },
  ) => AudioCppAligner;
  /**
   * Opens a text-to-speech session, streaming when the model can, falling back to the CPU when
   * `backend` fails.
   */
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
    sessionRun: lib.func("audiocpp_session_run", "int", [Session, Request, out(Result)]),
    resultFree: lib.func("audiocpp_result_free", "void", [Result]),
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
    requestSetAudio: lib.func("audiocpp_request_set_audio", "int", [
      Request,
      "float *",
      "size_t",
      "int",
      "int",
    ]),
    wordCount: lib.func("audiocpp_result_word_count", "size_t", [Result]),
    word: lib.func("audiocpp_result_word", "int", [
      Result,
      "size_t",
      out("const char *"),
      out("int64_t"),
      out("int64_t"),
      out("float"),
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

  const openSession = (model: unknown, mode: string, backend: string, threads: number) => {
    const session: [unknown] = [null];
    check(
      native.sessionCreate(model, "tts", mode, { backend, device: 0, threads }, null, session),
      `${backend} session creation`,
    );
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
    loadAligner(path, { backend, threads }) {
      const loaded: [unknown] = [null];
      check(native.modelLoad(registry[0], path, null, null, loaded), "model load");
      const model = loaded[0];
      const open = (target: string) => {
        const session: [unknown] = [null];
        check(
          native.sessionCreate(
            model,
            "align",
            "offline",
            { backend: target, device: 0, threads },
            null,
            session,
          ),
          `${target} session creation`,
        );
        return session[0];
      };
      let session: unknown;
      let sessionBackend = backend;
      try {
        if (!native.modelSupports(model, "align", "offline"))
          throw new Error("This model does not support forced alignment.");
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
      return {
        backend: sessionBackend,
        align({ audio, text, language, options = {} }) {
          const request = native.requestCreate();
          if (!request) throw new Error("audio.cpp could not allocate a request.");
          const result: [unknown] = [null];
          try {
            check(native.requestSetText(request, text, language), "request text");
            check(
              native.requestSetAudio(
                request,
                audio.samples,
                audio.samples.length / audio.channels,
                audio.sampleRate,
                audio.channels,
              ),
              "request audio",
            );
            for (const [key, value] of Object.entries(options))
              check(native.requestSetOption(request, key, value), `request option ${key}`);
            check(native.sessionRun(session, request, result), "alignment");
            const words: AudioCppAlignedWord[] = [];
            for (let index = 0; index < Number(native.wordCount(result[0])); index++) {
              const word: [string] = [""];
              const start: [number | bigint] = [0];
              const end: [number | bigint] = [0];
              check(native.word(result[0], index, word, start, end, [0]), "word read");
              words.push({
                word: word[0],
                startSeconds: Number(start[0]) / audio.sampleRate,
                endSeconds: Number(end[0]) / audio.sampleRate,
              });
            }
            return words;
          } finally {
            if (result[0]) native.resultFree(result[0]);
            native.requestFree(request);
          }
        },
        dispose() {
          native.sessionFree(session);
          native.modelFree(model);
        },
      };
    },
    loadSpeechModel(path, { backend, threads }) {
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
        try {
          session = openSession(model, mode, backend, threads);
        } catch (error) {
          if (backend === "cpu") throw error;
          sessionBackend = "cpu";
          session = openSession(model, mode, "cpu", threads);
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
