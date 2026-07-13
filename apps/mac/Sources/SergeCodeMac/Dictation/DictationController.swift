import AVFoundation
import FluidAudio
import Foundation
import Observation

public enum DictationState: Equatable, Sendable {
    case idle
    case recording
    /// Transcribing and (optionally) cleaning the finished utterance.
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

/// Drives the in-app dictation flow: mic capture → local Parakeet v3
/// transcription → optional on-device LLM cleanup → `insertHandler`.
/// Owned by AppModel; the composer's mic button and the Dictation settings
/// tab are both views over this one controller.
@Observable
@MainActor
public final class DictationController {
    public private(set) var state: DictationState = .idle
    public private(set) var modelStatus: DictationModelStatus
    /// Transient user-facing failure, auto-dismissed after a few seconds.
    public private(set) var lastError: String?
    public var micPermissionDenied = false

    /// Set by the composer; receives `(threadID, transcript)`. The threadID
    /// is the one selected when recording *started* (captured in
    /// `startRecording`), not whatever thread happens to be selected when
    /// transcription finishes — the user may switch threads mid-recording.
    public var insertHandler: ((String, String) -> Void)?

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
    private var asrManager: AsrManager?
    /// The composer that owned the recording when it started. The live
    /// handler may be rebound while transcription is in flight.
    private var recordingInsertHandler: ((String, String) -> Void)?
    /// The thread selected when recording started — the transcript is
    /// delivered to this thread even if the selection changes mid-recording.
    private var recordingThreadID: String?
    /// In-flight load, shared so the recording warm-up and finishRecording
    /// don't both load the models.
    private var asrLoadTask: Task<AsrManager, Error>?
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
            do {
                try recorder.start()
                recordingInsertHandler = insertHandler
                recordingThreadID = threadID
                state = .recording
                // Warm both models while the user is speaking so the
                // transcript lands near-instantly after they stop.
                if cleanupEnabled { cleaner.prewarm() }
                Task { [weak self] in
                    _ = try? await self?.loadedASRManager()
                }
            } catch {
                presentError("Could not start the microphone.")
            }
        }
    }

    private func finishRecording() {
        let recordingInsertHandler = recordingInsertHandler
        let recordingThreadID = recordingThreadID
        self.recordingInsertHandler = nil
        self.recordingThreadID = nil
        state = .processing
        let language = Language(rawValue: languageCode)
        Task {
            defer { state = .idle }
            guard let buffer = recorder.stop() else {
                presentError("No audio was captured.")
                return
            }
            do {
                let manager = try await loadedASRManager()
                let result = try await manager.transcribeUtterance(buffer, language: language)
                let raw = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !raw.isEmpty else {
                    presentError("Didn't catch that — nothing was transcribed.")
                    return
                }
                let text = cleanupEnabled ? await cleaner.clean(raw) : raw
                if let recordingThreadID {
                    recordingInsertHandler?(recordingThreadID, text)
                }
            } catch let error as ASRError where isTooShort(error) {
                presentError("Recording was too short to transcribe.")
            } catch {
                presentError("Transcription failed.")
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
                let manager = AsrManager(config: .default)
                try await manager.loadModels(models)
                asrManager = manager
                modelStatus = .ready
            } catch {
                modelStatus = .notDownloaded
                presentError("Model download failed. Check your connection and try again.")
            }
        }
    }

    public func removeModel() {
        guard modelStatus == .ready, state == .idle else { return }
        asrManager = nil
        asrLoadTask?.cancel()
        asrLoadTask = nil
        do {
            try FileManager.default.removeItem(at: modelCacheDirectory)
            modelStatus = .notDownloaded
        } catch {
            presentError("Could not remove the dictation model.")
        }
    }

    private func loadedASRManager() async throws -> AsrManager {
        if let asrManager { return asrManager }
        if let asrLoadTask { return try await asrLoadTask.value }
        // Models are on disk (modelStatus == .ready) but not loaded yet this
        // launch; downloadAndLoad short-circuits the network when files exist.
        let task = Task {
            let models = try await AsrModels.downloadAndLoad(version: .v3)
            let manager = AsrManager(config: .default)
            try await manager.loadModels(models)
            return manager
        }
        asrLoadTask = task
        defer { asrLoadTask = nil }
        let manager = try await task.value
        asrManager = manager
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
