import AVFoundation
import Foundation
import OSLog
import Speech
import UIKit

@MainActor
enum FeatureVoiceInputAdapterFactory {
    static func make() -> any FeatureVoiceInputAdapter {
        if #available(iOS 26.0, *) {
            return AppleVoiceInputAdapter()
        }
        return UnsupportedVoiceInputAdapter()
    }
}

@MainActor
private final class UnsupportedVoiceInputAdapter: FeatureVoiceInputAdapter {
    let isSupported = false
    let localeIdentifier = Locale.current.identifier

    func prepare() async throws {}
    func requestMicrophonePermission() async -> FeatureVoiceMicrophonePermission { .denied }
    func startRecording(maximumDuration: TimeInterval) async throws {}
    func stopRecording() async throws -> URL { throw AppleVoiceInputError.unavailable }
    func transcribe(recordingURL: URL) async throws -> String {
        throw AppleVoiceInputError.unavailable
    }
    func cancelTranscription() async {}
    func cleanup() async {}
}

private enum AppleVoiceInputError: Error {
    case unavailable
    case unsupportedLocale
    case recordingFailed
    case noMicrophoneInput
}

/// Voice failures show one short message in the composer. The real error goes
/// here so a failure on a device can be read in Console.
private let voiceInputLogger = Logger(subsystem: "com.t3tools.t3code", category: "VoiceInput")

private struct AppleVoiceAudioSessionConfiguration {
    let category: AVAudioSession.Category
    let mode: AVAudioSession.Mode
    let options: AVAudioSession.CategoryOptions
    let preferredInput: AVAudioSessionPortDescription?
}

/// Converts microphone buffers to the file format and writes them to disk.
/// The input tap calls `append` on an audio thread while the recorder actor
/// calls `finish`, so a lock guards the converter and the file.
@available(iOS 26.0, *)
final class AppleVoiceRecordingWriter: @unchecked Sendable {
    private let lock = NSLock()
    private var file: AVAudioFile?
    // Rebuilt when the input format changes, for example after a route change.
    private var converter: AVAudioConverter?
    private var remainingFrames: AVAudioFramePosition
    private var didLogFailure = false

    init(url: URL, fileFormat: AVAudioFormat, maximumDuration: TimeInterval) throws {
        let file = try AVAudioFile(
            forWriting: url,
            settings: fileFormat.settings,
            commonFormat: fileFormat.commonFormat,
            interleaved: fileFormat.isInterleaved
        )
        self.file = file
        remainingFrames = AVAudioFramePosition(maximumDuration * file.processingFormat.sampleRate)
    }

    /// `format` must be the input node's current output format. A tap in any
    /// other format raises an exception.
    func install(on input: AVAudioInputNode, format: AVAudioFormat) {
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [self] buffer, _ in
            append(buffer)
        }
    }

    func finish() {
        lock.lock()
        defer { lock.unlock() }
        file?.close()
        file = nil
        converter = nil
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        defer { lock.unlock() }
        guard let file, remainingFrames > 0 else { return }
        do {
            let output = try convert(buffer, to: file.processingFormat)
            output.frameLength = AVAudioFrameCount(
                min(AVAudioFramePosition(output.frameLength), remainingFrames)
            )
            try file.write(from: output)
            remainingFrames -= AVAudioFramePosition(output.frameLength)
        } catch {
            guard !didLogFailure else { return }
            didLogFailure = true
            voiceInputLogger.error("Voice recording dropped audio: \(error, privacy: .public)")
        }
    }

    private func convert(
        _ buffer: AVAudioPCMBuffer,
        to format: AVAudioFormat
    ) throws -> AVAudioPCMBuffer {
        guard buffer.format != format else { return buffer }
        if converter?.inputFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: format)
        }
        guard let converter else { throw AppleVoiceInputError.recordingFailed }
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 1
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
            throw AppleVoiceInputError.recordingFailed
        }
        var consumed = false
        var conversionError: NSError?
        // `.noDataNow` keeps the converter's resampler state for the next tap buffer.
        let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
            if consumed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            inputStatus.pointee = .haveData
            return buffer
        }
        if status == .error { throw conversionError ?? AppleVoiceInputError.recordingFailed }
        return output
    }
}

/// Owns the shared audio session and the audio engine off the main thread.
/// Session activation, route selection, and engine start wait on the audio
/// server. That can take seconds, for example while a Bluetooth headset switches
/// to its microphone profile, and it froze the app when it ran on the main actor.
///
/// Audio comes from an `AVAudioEngine` input tap in the hardware format and is
/// converted to the analyzer's format. Do not go back to `AVAudioRecorder`: it
/// needs fixed encoder settings and reports a setup failure only as `false`.
@available(iOS 26.0, *)
private actor AppleVoiceRecorder {
    private let audioSession = AVAudioSession.sharedInstance()
    private var engine: AVAudioEngine?
    private var writer: AppleVoiceRecordingWriter?
    private var configurationObserver: (any NSObjectProtocol)?
    private var previousConfiguration: AppleVoiceAudioSessionConfiguration?
    private var preferredInputWasTouched = false

    /// Starts recording to `url` and returns the connected microphones so the
    /// caller can remember them. `fileFormat` is the analyzer's format; without
    /// one the file keeps the hardware format.
    func start(
        url: URL,
        fileFormat: AVAudioFormat?,
        maximumDuration: TimeInterval,
        microphoneOrder: [FeatureMicrophoneEntry]
    ) throws -> [FeatureMicrophoneInput] {
        stop()
        let previous = AppleVoiceAudioSessionConfiguration(
            category: audioSession.category,
            mode: audioSession.mode,
            options: audioSession.categoryOptions,
            preferredInput: audioSession.preferredInput
        )
        do {
            try audioSession.setCategory(.record, mode: .measurement, options: [.allowBluetoothHFP])
            previousConfiguration = previous
            try audioSession.setActive(true)
            let inputs = selectPreferredMicrophone(order: microphoneOrder)

            let engine = AVAudioEngine()
            self.engine = engine
            let inputFormat = try currentInputFormat(of: engine)
            let writer = try AppleVoiceRecordingWriter(
                url: url,
                fileFormat: fileFormat ?? inputFormat,
                maximumDuration: maximumDuration
            )
            self.writer = writer
            writer.install(on: engine.inputNode, format: inputFormat)
            // A new route, such as a headset switching to its microphone
            // profile, stops the engine and can change the input format.
            configurationObserver = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange,
                object: engine,
                queue: nil
            ) { [weak self] _ in
                Task { await self?.restartAfterConfigurationChange() }
            }
            engine.prepare()
            try engine.start()
            voiceInputLogger.info(
                "Voice recording started. Input: \(inputFormat, privacy: .public). File: \(fileFormat ?? inputFormat, privacy: .public). Route: \(self.audioSession.currentRoute.inputs.map(\.portType.rawValue), privacy: .public)"
            )
            return inputs
        } catch {
            stop()
            throw error
        }
    }

    /// Stops any recording, closes the file, and restores the session the app had before.
    func stop() {
        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
            self.configurationObserver = nil
        }
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            self.engine = nil
        }
        writer?.finish()
        writer = nil
        guard let previousConfiguration else { return }
        if preferredInputWasTouched {
            try? audioSession.setPreferredInput(previousConfiguration.preferredInput)
            preferredInputWasTouched = false
        }
        try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
        try? audioSession.setCategory(
            previousConfiguration.category,
            mode: previousConfiguration.mode,
            options: previousConfiguration.options
        )
        self.previousConfiguration = nil
    }

    private func restartAfterConfigurationChange() {
        guard let engine, let writer, !engine.isRunning else { return }
        do {
            engine.inputNode.removeTap(onBus: 0)
            let inputFormat = try currentInputFormat(of: engine)
            writer.install(on: engine.inputNode, format: inputFormat)
            engine.prepare()
            try engine.start()
            voiceInputLogger.info("Voice recording moved to input \(inputFormat, privacy: .public)")
        } catch {
            voiceInputLogger.error(
                "Voice recording stopped after a route change: \(error, privacy: .public)"
            )
        }
    }

    /// The format follows the active microphone, often 48 kHz on device. It
    /// has no channels while no input is available.
    private func currentInputFormat(of engine: AVAudioEngine) throws -> AVAudioFormat {
        let format = engine.inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw AppleVoiceInputError.noMicrophoneInput
        }
        return format
    }

    private func selectPreferredMicrophone(
        order: [FeatureMicrophoneEntry]
    ) -> [FeatureMicrophoneInput] {
        // iOS only exposes connected inputs after the recording session is configured.
        let ports = audioSession.availableInputs ?? []
        let inputs = ports.map {
            FeatureMicrophoneInput(uid: $0.uid, name: $0.portName, portType: $0.portType.rawValue)
        }
        let order = FeatureMicrophonePriority.order(
            FeatureMicrophonePriority.remembering(inputs, in: order)
        )
        guard let preferred = FeatureMicrophonePriority.preferredInput(inputs, order: order),
              let port = ports.first(where: { $0.uid == preferred.uid }),
              port.uid != audioSession.preferredInput?.uid else { return inputs }
        preferredInputWasTouched = true
        // A route can disappear between enumeration and selection. Keep the iOS route in that case.
        try? audioSession.setPreferredInput(port)
        return inputs
    }
}

@available(iOS 26.0, *)
@MainActor
private final class AppleVoiceInputAdapter: FeatureVoiceInputAdapter {
    private let recorder = AppleVoiceRecorder()
    private let fileManager = FileManager.default
    private var transcriber: SpeechTranscriber?
    private var analyzerFormat: AVAudioFormat?
    private var analyzer: SpeechAnalyzer?
    private var recordingURL: URL?
    private var ownedRecordingURLs = Set<URL>()
    private var previousIdleTimerDisabled: Bool?

    var isSupported: Bool { SpeechTranscriber.isAvailable }
    private(set) var localeIdentifier = Locale.current.identifier

    func prepare() async throws {
        do {
            guard SpeechTranscriber.isAvailable else { throw AppleVoiceInputError.unavailable }
            guard let locale = await SpeechTranscriber.supportedLocale(
                equivalentTo: Locale.current
            ) else {
                throw AppleVoiceInputError.unsupportedLocale
            }

            let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
            if let request = try await AssetInventory.assetInstallationRequest(
                supporting: [transcriber]
            ) {
                try await request.downloadAndInstall()
            }
            self.transcriber = transcriber
            analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(
                compatibleWith: [transcriber]
            )
            localeIdentifier = locale.identifier
        } catch {
            voiceInputLogger.error("Voice input could not prepare: \(error, privacy: .public)")
            throw error
        }
    }

    func requestMicrophonePermission() async -> FeatureVoiceMicrophonePermission {
        await AVAudioApplication.requestRecordPermission() ? .granted : .denied
    }

    func startRecording(maximumDuration: TimeInterval) async throws {
        // Uncompressed PCM in the analyzer's format, so transcription reads it without conversion.
        let url = fileManager.temporaryDirectory
            .appendingPathComponent("t3-voice-\(UUID().uuidString)")
            .appendingPathExtension("caf")
        ownedRecordingURLs.insert(url)
        recordingURL = url

        let preferences = FeatureMicrophonePreferences.shared
        let inputs: [FeatureMicrophoneInput]
        do {
            inputs = try await recorder.start(
                url: url,
                fileFormat: analyzerFormat,
                maximumDuration: maximumDuration,
                microphoneOrder: preferences.entries
            )
        } catch {
            voiceInputLogger.error("Voice recording could not start: \(error, privacy: .public)")
            throw error
        }
        preferences.remember(inputs)
        if previousIdleTimerDisabled == nil {
            previousIdleTimerDisabled = UIApplication.shared.isIdleTimerDisabled
        }
        UIApplication.shared.isIdleTimerDisabled = true
    }

    func stopRecording() async throws -> URL {
        guard let recordingURL else { throw AppleVoiceInputError.recordingFailed }
        await stopAudio()
        return recordingURL
    }

    func transcribe(recordingURL: URL) async throws -> String {
        guard let transcriber else { throw AppleVoiceInputError.unavailable }
        let audioFile = try AVAudioFile(forReading: recordingURL)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        self.analyzer = analyzer

        let collector = Task { () throws -> [String] in
            var segments: [String] = []
            for try await result in transcriber.results where result.isFinal {
                segments.append(String(result.text.characters))
            }
            return segments
        }

        do {
            try await analyzer.start(inputAudioFile: audioFile, finishAfterFile: true)
            let segments = try await collector.value
            if self.analyzer === analyzer { self.analyzer = nil }
            return segments.joined(separator: " ").trimmingCharacters(
                in: .whitespacesAndNewlines
            )
        } catch {
            voiceInputLogger.error("Voice transcription failed: \(error, privacy: .public)")
            collector.cancel()
            await analyzer.cancelAndFinishNow()
            _ = try? await collector.value
            if self.analyzer === analyzer { self.analyzer = nil }
            throw error
        }
    }

    func cancelTranscription() async {
        await analyzer?.cancelAndFinishNow()
    }

    func cleanup() async {
        await stopAudio()
        if let analyzer {
            await analyzer.cancelAndFinishNow()
            self.analyzer = nil
        }
        for url in ownedRecordingURLs {
            try? fileManager.removeItem(at: url)
        }
        ownedRecordingURLs.removeAll()
        recordingURL = nil
        transcriber = nil
        analyzerFormat = nil
    }

    private func stopAudio() async {
        await recorder.stop()
        if let previousIdleTimerDisabled {
            UIApplication.shared.isIdleTimerDisabled = previousIdleTimerDisabled
            self.previousIdleTimerDisabled = nil
        }
    }
}
