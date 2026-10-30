import AVFoundation
import Foundation
import Speech

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    FileHandle.standardOutput.write(data + Data([10]))
}

enum VoiceError: LocalizedError {
    case unavailable, language, microphone, recording
    var errorDescription: String? {
        switch self {
        case .unavailable: "Voice input requires a supported Mac running macOS 26 or later."
        case .language: "Apple speech recognition does not support this Mac's language."
        case .microphone: "Allow microphone access in System Settings → Privacy & Security → Microphone."
        case .recording: "Could not record microphone audio."
        }
    }
}

final class RecordingDelegate: NSObject, AVAudioRecorderDelegate {
    let continuation: AsyncStream<String>.Continuation
    init(_ continuation: AsyncStream<String>.Continuation) { self.continuation = continuation }
    func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        continuation.yield(flag ? "stop" : "error")
    }
    func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        continuation.yield("error")
    }
}

@available(macOS 26, *)
func transcribe(_ url: URL, locale: Locale) async throws -> String {
    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let results = Task {
        var text = ""
        for try await result in transcriber.results { text += String(result.text.characters) }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    do {
        let file = try AVAudioFile(forReading: url)
        if let end = try await analyzer.analyzeSequence(from: file) {
            try await analyzer.finalizeAndFinish(through: end)
        } else {
            await analyzer.cancelAndFinishNow()
        }
        return try await results.value
    } catch {
        await analyzer.cancelAndFinishNow()
        results.cancel()
        throw error
    }
}

@main
struct VoiceInput {
    @MainActor static func main() async {
        let arguments = CommandLine.arguments
        guard #available(macOS 26, *), SpeechTranscriber.isAvailable else {
            emit(["type": "unavailable", "message": VoiceError.unavailable.localizedDescription])
            return
        }
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: Locale.preferredLanguages.first ?? Locale.current.identifier)) else {
            emit(["type": "unavailable", "message": VoiceError.language.localizedDescription])
            return
        }
        if arguments.contains("--probe") {
            emit(["type": "available", "locale": locale.identifier])
            return
        }
        do {
            if !arguments.contains("--transcribe") {
                let allowed = await AVCaptureDevice.requestAccess(for: .audio)
                guard allowed else { throw VoiceError.microphone }
            }
            let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
            if let installation = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                try await installation.downloadAndInstall()
            }
            let url: URL
            if arguments.count == 3, arguments[1] == "--transcribe" {
                url = URL(fileURLWithPath: arguments[2])
            } else {
                guard arguments.count == 3, arguments[1] == "--record" else { throw VoiceError.recording }
                url = URL(fileURLWithPath: arguments[2]).appendingPathComponent("recording.caf")
                let (commands, continuation) = AsyncStream<String>.makeStream()
                FileHandle.standardInput.readabilityHandler = { handle in
                    let data = handle.availableData
                    continuation.yield(data.isEmpty ? "cancel" : String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
                }
                defer { FileHandle.standardInput.readabilityHandler = nil }
                let recorder = try AVAudioRecorder(url: url, settings: [
                    AVFormatIDKey: kAudioFormatLinearPCM,
                    AVSampleRateKey: 44100,
                    AVNumberOfChannelsKey: 1,
                    AVLinearPCMBitDepthKey: 16
                ])
                let delegate = RecordingDelegate(continuation)
                recorder.delegate = delegate
                guard recorder.record(forDuration: 310) else { throw VoiceError.recording }
                emit(["type": "recording", "locale": locale.identifier])
                let command = await commands.first(where: { _ in true })
                recorder.stop()
                withExtendedLifetime(delegate) {}
                guard command == "stop" else {
                    if command == "error" { throw VoiceError.recording }
                    return
                }
            }
            emit(["type": "transcript", "locale": locale.identifier, "text": try await transcribe(url, locale: locale)])
        } catch {
            emit(["type": "error", "message": error.localizedDescription])
        }
    }
}
