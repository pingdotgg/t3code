@preconcurrency import AVFoundation
import FluidAudio
import Foundation
import Observation

public enum DictationState: Equatable, Sendable {
    case idle
    case recording
    /// Finalizing the utterance after the mic stops (tail flush + batch
    /// pass). Brief — models are already warm from the streaming preview.
    case processing
}

public enum DictationModelStatus: Equatable, Sendable {
    case notDownloaded
    case downloading(Double)
    case ready

    public var isDownloading: Bool {
        if case .downloading = self { return true }
        return false
    }
}

/// Drives the in-app dictation flow: mic capture → live Parakeet v3 sliding-
/// window partials (shown while the user speaks) → full-utterance batch pass
/// for the inserted text → optional on-device LLM polish applied in place.
/// Owned by AppModel; the composer's mic button and the Dictation settings
/// tab are both views over this one controller.
///
/// Latency shape: partials appear about a second into speech, the raw
/// transcript is inserted the moment the batch pass returns (models are warm
/// by then — they loaded while the user was speaking), and the cleanup pass
/// never blocks insertion; it swaps the polished text in afterwards.
@Observable
@MainActor
public final class DictationController {
    public private(set) var state: DictationState = .idle
    public private(set) var modelStatus: DictationModelStatus
    /// Transient user-facing failure, auto-dismissed after a few seconds.
    public private(set) var lastError: String?
    public var micPermissionDenied = false

    // MARK: Live preview

    /// Confirmed portion of the in-progress utterance (stable text).
    public private(set) var confirmedTranscript = ""
    /// Volatile tail of the in-progress utterance (may still change).
    public private(set) var volatileTranscript = ""
    /// Smoothed microphone peak level (0...1) for the live meter.
    public private(set) var audioLevel: Double = 0
    /// True while the cleanup pass is polishing an already-inserted
    /// transcript — the draft text will swap in place when it finishes.
    public private(set) var isPolishing = false

    /// The full live preview line: stable text followed by the volatile tail.
    public var liveTranscript: String {
        [confirmedTranscript, volatileTranscript]
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    /// Set by the composer; receives `(threadID, transcript)` with the raw
    /// final transcript. The threadID is the one selected when recording
    /// *started* (captured in `startRecording`), not whatever thread happens
    /// to be selected when transcription finishes — the user may switch
    /// threads mid-recording.
    public var insertHandler: ((String, String) -> Void)?
    /// Set by the composer; receives `(threadID, rawText, polishedText)` when
    /// the cleanup pass finishes. The raw text was already inserted; the
    /// handler locates and replaces it, no-opping when the user has since
    /// edited or sent it.
    public var replaceHandler: ((String, String, String) -> Void)?

    public var cleanupEnabled: Bool {
        didSet { UserDefaults.standard.set(cleanupEnabled, forKey: Self.cleanupKey) }
    }
    /// A `Language` raw value, or `autoLanguage` to let the model detect.
    public var languageCode: String {
        didSet { UserDefaults.standard.set(languageCode, forKey: Self.languageKey) }
    }

    public var cleanupAvailable: Bool { TranscriptCleaner.isAvailable }
    public var modelCacheDirectory: URL { AsrModels.defaultCacheDirectory(for: .v3) }

    public static let autoLanguage = "auto"
    /// Parakeet v3's supported language hints, exposed as plain codes so the
    /// settings UI doesn't need to import FluidAudio.
    public static let supportedLanguageCodes: [String] = Language.allCases.map(\.rawValue)
    private static let cleanupKey = "dictation.cleanupEnabled"
    private static let languageKey = "dictation.language"

    private let recorder = AudioRecorder()
    private let cleaner = TranscriptCleaner()
    /// Loaded CoreML models, shared by the per-recording streaming session
    /// and the batch manager so each recording doesn't reload them.
    private var asrModels: AsrModels?
    private var batchManager: AsrManager?
    /// In-flight load, shared so the recording warm-up, streaming session,
    /// and finishRecording don't all load the models.
    private var modelsLoadTask: Task<AsrModels, Error>?
    /// Resolves to the streaming session's own final transcript — the
    /// fallback inserted text when the batch pass fails.
    private var streamingTask: Task<String?, Never>?
    /// Feeds tap buffers into the streaming session in capture order.
    private var audioContinuation: AsyncStream<AVAudioPCMBuffer>.Continuation?
    /// The composer that owned the recording when it started. The live
    /// handlers may be rebound while transcription is in flight.
    private var recordingInsertHandler: ((String, String) -> Void)?
    private var recordingReplaceHandler: ((String, String, String) -> Void)?
    /// The thread selected when recording started — the transcript is
    /// delivered to this thread even if the selection changes mid-recording.
    private var recordingThreadID: String?
    private var polishTask: Task<Void, Never>?
    private var errorDismissTask: Task<Void, Never>?

    public init() {
        let defaults = UserDefaults.standard
        cleanupEnabled = defaults.object(forKey: Self.cleanupKey) as? Bool ?? true
        languageCode = defaults.string(forKey: Self.languageKey) ?? Self.autoLanguage
        modelStatus =
            AsrModels.modelsExist(
                at: AsrModels.defaultCacheDirectory(for: .v3), version: .v3)
            ? .ready : .notDownloaded
    }

    // MARK: - Recording

    /// - Parameter threadID: the currently selected thread, captured as the
    ///   recording's destination when a new recording starts. Ignored when
    ///   stopping (the destination was already captured at start).
    public func toggleRecording(threadID: String?) {
        switch state {
        case .recording:
            finishRecording()
        case .idle where modelStatus == .ready:
            guard let threadID else {
                presentError("Select a thread before recording.")
                return
            }
            startRecording(threadID: threadID)
        default:
            break
        }
    }

    private func startRecording(threadID: String) {
        lastError = nil
        Task {
            guard await AudioRecorder.requestPermission() else {
                micPermissionDenied = true
                return
            }
            guard state == .idle else { return }
            // Tap buffers flow into an ordered, unbounded stream. While the
            // models are still loading they simply accumulate here, so speech
            // from the very first second is never lost; once the streaming
            // session is up it drains the backlog and keeps up in real time.
            let (audioStream, audioContinuation) = AsyncStream<AVAudioPCMBuffer>.makeStream()
            self.audioContinuation = audioContinuation
            confirmedTranscript = ""
            volatileTranscript = ""
            audioLevel = 0
            recorder.onBuffer = { [weak self] buffer, level in
                audioContinuation.yield(buffer)
                Task { @MainActor [weak self] in
                    self?.audioLevel = Double(level)
                }
            }
            do {
                try recorder.start()
            } catch {
                recorder.onBuffer = nil
                audioContinuation.finish()
                self.audioContinuation = nil
                presentError("Could not start the microphone.")
                return
            }
            recordingInsertHandler = insertHandler
            recordingReplaceHandler = replaceHandler
            recordingThreadID = threadID
            state = .recording
            // Warm both models while the user is speaking: the cleanup model
            // so polish is quick, and the ASR models for the streaming
            // preview (and, by extension, the batch pass at the end).
            if cleanupEnabled { cleaner.prewarm() }
            streamingTask = Task { [weak self] in
                guard let self else { return nil }
                return await self.runStreamingSession(audioStream: audioStream)
            }
        }
    }

    /// Runs the sliding-window preview session for one recording: loads the
    /// shared models, streams tap buffers in order, mirrors confirmed/
    /// volatile text onto the controller, and returns the session's own
    /// final transcript once the audio stream ends. Any failure degrades to
    /// nil — the preview disappears and the batch pass remains authoritative.
    private func runStreamingSession(audioStream: AsyncStream<AVAudioPCMBuffer>) async -> String? {
        var session: SlidingWindowAsrManager?
        var updatesTask: Task<Void, Never>?
        defer {
            updatesTask?.cancel()
            if let session {
                Task { await session.cancel() }
            }
        }
        do {
            let models = try await loadedASRModels()
            let manager = SlidingWindowAsrManager(config: .livePreview)
            session = manager
            try await manager.loadModels(models)
            try await manager.startStreaming()

            let updateStream = await manager.transcriptionUpdates
            updatesTask = Task { [weak self] in
                for await _ in updateStream {
                    guard let self else { return }
                    self.confirmedTranscript = await manager.confirmedTranscript
                    self.volatileTranscript = await manager.volatileTranscript
                }
            }

            for await buffer in audioStream {
                await manager.streamAudio(buffer)
            }

            // Audio ended (user stopped): flush the tail and build the
            // session's final transcript.
            let final = try await manager.finish()
            return final.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            return nil
        }
    }

    private func finishRecording() {
        let recordingInsertHandler = recordingInsertHandler
        let recordingReplaceHandler = recordingReplaceHandler
        let recordingThreadID = recordingThreadID
        self.recordingInsertHandler = nil
        self.recordingReplaceHandler = nil
        self.recordingThreadID = nil
        state = .processing
        let language = Language(rawValue: languageCode)
        let streamingTask = self.streamingTask
        self.streamingTask = nil
        Task {
            // Closing the stream lets the preview session drain its backlog
            // and flush the tail; its final transcript is the fallback if
            // the batch pass fails.
            recorder.onBuffer = nil
            audioContinuation?.finish()
            audioContinuation = nil
            let buffer = recorder.stop()
            audioLevel = 0

            guard let buffer else {
                _ = await streamingTask?.value
                presentError("No audio was captured.")
                state = .idle
                return
            }

            var raw = ""
            var transcriptionError: Error?
            do {
                let manager = try await loadedASRManager()
                let result = try await manager.transcribeUtterance(buffer, language: language)
                raw = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
            } catch {
                transcriptionError = error
            }

            // The streaming session resolved while the batch pass ran, so
            // this await is already satisfied in practice.
            var streamed = ""
            if let streamingTask {
                streamed = await streamingTask.value ?? ""
            }
            if raw.isEmpty { raw = streamed }

            guard !raw.isEmpty else {
                if let error = transcriptionError as? ASRError, isTooShort(error) {
                    presentError("Recording was too short to transcribe.")
                } else if transcriptionError != nil {
                    presentError("Transcription failed.")
                } else {
                    presentError("Didn't catch that — nothing was transcribed.")
                }
                state = .idle
                confirmedTranscript = ""
                volatileTranscript = ""
                return
            }

            // Insert the raw transcript immediately — the polish pass swaps
            // it in place when it finishes, so cleanup never blocks text.
            if let recordingThreadID {
                recordingInsertHandler?(recordingThreadID, raw)
            }
            state = .idle
            confirmedTranscript = ""
            volatileTranscript = ""

            guard cleanupEnabled, let recordingThreadID else { return }
            polishTask?.cancel()
            isPolishing = true
            polishTask = Task { [weak self] in
                guard let self else { return }
                let cleaned = await self.cleaner.clean(raw)
                guard !Task.isCancelled else { return }
                self.isPolishing = false
                guard cleaned != raw else { return }
                recordingReplaceHandler?(recordingThreadID, raw, cleaned)
            }
        }
    }

    private func isTooShort(_ error: ASRError) -> Bool {
        if case .invalidAudioData = error { return true }
        return false
    }

    // MARK: - Model download

    public func downloadModel() {
        guard modelStatus == .notDownloaded else { return }
        modelStatus = .downloading(0)
        Task {
            do {
                let models = try await AsrModels.downloadAndLoad(version: .v3) { progress in
                    let fraction = progress.fractionCompleted
                    Task { @MainActor [weak self] in
                        guard let self, case .downloading = self.modelStatus else { return }
                        self.modelStatus = .downloading(fraction)
                    }
                }
                asrModels = models
                batchManager = nil  // rebuilt lazily from the fresh models
                modelStatus = .ready
            } catch {
                modelStatus = .notDownloaded
                presentError("Model download failed. Check your connection and try again.")
            }
        }
    }

    public func removeModel() {
        guard modelStatus == .ready, state == .idle else { return }
        asrModels = nil
        batchManager = nil
        modelsLoadTask?.cancel()
        modelsLoadTask = nil
        do {
            try FileManager.default.removeItem(at: modelCacheDirectory)
            modelStatus = .notDownloaded
        } catch {
            presentError("Could not remove the dictation model.")
        }
    }

    /// The shared CoreML models, loading them on first use. When the files
    /// are already on disk (modelStatus == .ready) `downloadAndLoad`
    /// short-circuits the network and just loads them into memory.
    private func loadedASRModels() async throws -> AsrModels {
        if let asrModels { return asrModels }
        if let modelsLoadTask { return try await modelsLoadTask.value }
        let task = Task {
            try await AsrModels.downloadAndLoad(version: .v3)
        }
        modelsLoadTask = task
        defer { modelsLoadTask = nil }
        let models = try await task.value
        asrModels = models
        return models
    }

    /// The batch manager that produces the final inserted transcript. Kept
    /// warm across recordings; wraps the same loaded models as the
    /// per-recording streaming sessions.
    private func loadedASRManager() async throws -> AsrManager {
        if let batchManager { return batchManager }
        let models = try await loadedASRModels()
        let manager = AsrManager(config: .default)
        try await manager.loadModels(models)
        batchManager = manager
        return manager
    }

    #if DEBUG
        /// UIProbe/E2E hook: run the real transcribe → clean pipeline on an
        /// audio file instead of the microphone (downloads models if absent).
        public func processAudioFileForProbe(_ url: URL) async throws -> (raw: String, cleaned: String) {
            let manager = try await loadedASRManager()
            let result = try await manager.transcribeFile(url, language: Language(rawValue: languageCode))
            let raw = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
            let cleaned = await cleaner.clean(raw)
            return (raw, cleaned)
        }
    #endif

    // MARK: - Errors

    private func presentError(_ message: String) {
        lastError = message
        errorDismissTask?.cancel()
        errorDismissTask = Task {
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled else { return }
            lastError = nil
        }
    }
}

extension SlidingWindowAsrConfig {
    /// Low-latency window layout for the live preview: a 1 s chunk with 2 s
    /// of left context and 0.5 s of lookahead emits an update roughly once
    /// per second of speech. Preview text is volatile by design — the
    /// inserted transcript always comes from the full-utterance batch pass,
    /// so this layout trades a little chunk-level accuracy for immediacy.
    static let livePreview = SlidingWindowAsrConfig(
        chunkSeconds: 1.0,
        hypothesisChunkSeconds: 1.0,
        leftContextSeconds: 2.0,
        rightContextSeconds: 0.5,
        minContextForConfirmation: 2.0,
        confirmationThreshold: 0.75)
}

extension AsrManager {
    /// Single-utterance transcription with a fresh decoder state. Lives in an
    /// actor extension so the `inout` state never crosses the actor boundary.
    func transcribeUtterance(
        _ buffer: AVAudioPCMBuffer, language: Language?
    ) async throws -> ASRResult {
        var decoderState = TdtDecoderState.make(decoderLayers: decoderLayerCount)
        return try await transcribe(buffer, decoderState: &decoderState, language: language)
    }

    func transcribeFile(_ url: URL, language: Language?) async throws -> ASRResult {
        var decoderState = TdtDecoderState.make(decoderLayers: decoderLayerCount)
        return try await transcribe(url, decoderState: &decoderState, language: language)
    }
}
