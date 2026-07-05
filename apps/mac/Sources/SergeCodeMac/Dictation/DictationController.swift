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

    /// Set by the composer; receives the final transcript.
    public var insertHandler: ((String) -> Void)?

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
    private static let cleanupKey = "dictation.cleanupEnabled"
    private static let languageKey = "dictation.language"

    private let recorder = AudioRecorder()
    private let cleaner = TranscriptCleaner()
    private var asrManager: AsrManager?
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

    public func toggleRecording() {
        switch state {
        case .recording:
            finishRecording()
        case .idle where modelStatus == .ready:
            startRecording()
        default:
            break
        }
    }

    private func startRecording() {
        lastError = nil
        Task {
            guard await AudioRecorder.requestPermission() else {
                micPermissionDenied = true
                return
            }
            guard state == .idle else { return }
            do {
                try recorder.start()
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
                insertHandler?(text)
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
        try? FileManager.default.removeItem(at: modelCacheDirectory)
        modelStatus = .notDownloaded
    }

    private func loadedASRManager() async throws -> AsrManager {
        if let asrManager { return asrManager }
        // Models are on disk (modelStatus == .ready) but not loaded yet this
        // launch; downloadAndLoad short-circuits the network when files exist.
        let models = try await AsrModels.downloadAndLoad(version: .v3)
        let manager = AsrManager(config: .default)
        try await manager.loadModels(models)
        asrManager = manager
        return manager
    }

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
}
