// Adapted from AppleTranscriptionImpl.swift in @react-native-ai/apple (MIT, Callstack),
// including this repo's patch, so the Mac and iPhone transcribe the same way.
//
// t3-apple-speech available                      -> {"value":""}
// t3-apple-speech prepare <locale>               -> {"value":"en-US"}  (resolved locale)
// t3-apple-speech transcribe <locale> <wav-path> -> {"value":"..."}    (transcript)
// Exit codes are consumed by AppleSpeech.ts; failures print one message line to stderr.

import AVFoundation
import Foundation
import Speech

private enum ExitCode: Int32 {
  case failure = 1
  case unsupportedLocale = 2
  case unavailable = 3
  case usage = 64
}

private struct Failure: Error {
  let code: ExitCode
  let message: String
}

@main
struct AppleSpeech {
  static func main() async {
    let arguments = Array(CommandLine.arguments.dropFirst())
    do {
      switch (arguments.first, arguments.count) {
      case ("available", 1):
        try requireAvailable()
        try write("")
      case ("prepare", 2):
        try write(try await prepare(arguments[1]))
      case ("transcribe", 3):
        try write(try await transcribe(arguments[1], path: arguments[2]))
      default:
        throw Failure(code: .usage, message: "Unknown command.")
      }
    } catch let failure as Failure {
      fail(failure.code, failure.message)
    } catch {
      fail(.failure, error.localizedDescription)
    }
  }

  private static func requireAvailable() throws {
    guard SpeechTranscriber.isAvailable else {
      throw Failure(code: .unavailable, message: "Speech transcription is not available on this Mac.")
    }
  }

  private static func makeTranscriber(for locale: Locale) -> SpeechTranscriber {
    let preset = SpeechTranscriber.Preset.timeIndexedTranscriptionWithAlternatives
    return SpeechTranscriber(
      locale: locale,
      transcriptionOptions: preset.transcriptionOptions,
      reportingOptions: preset.reportingOptions.subtracting([.alternativeTranscriptions]),
      attributeOptions: preset.attributeOptions
    )
  }

  private static func prepare(_ identifier: String) async throws -> String {
    try requireAvailable()
    guard
      let locale = await SpeechTranscriber.supportedLocale(
        equivalentTo: Locale(identifier: identifier))
    else {
      throw Failure(code: .unsupportedLocale, message: "Locale not supported: \(identifier)")
    }
    let transcriber = makeTranscriber(for: locale)
    switch await AssetInventory.status(forModules: [transcriber]) {
    case .installed:
      break
    case .supported, .downloading:
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        try await request.downloadAndInstall()
      }
    case .unsupported:
      throw Failure(
        code: .unsupportedLocale, message: "Assets not supported for locale: \(identifier)")
    @unknown default:
      throw Failure(code: .failure, message: "Unknown asset inventory status.")
    }
    return locale.identifier(.bcp47)
  }

  private static func transcribe(_ identifier: String, path: String) async throws -> String {
    try requireAvailable()
    let audioFile = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    let transcriber = makeTranscriber(for: Locale(identifier: identifier))
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let collector = Task { () throws -> [String] in
      var texts: [String] = []
      for try await result in transcriber.results where result.isFinal {
        let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { texts.append(text) }
      }
      return texts
    }
    do {
      if let lastSampleTime = try await analyzer.analyzeSequence(from: audioFile) {
        try await analyzer.finalizeAndFinish(through: lastSampleTime)
      } else {
        await analyzer.cancelAndFinishNow()
      }
      return try await collector.value.joined(separator: " ")
    } catch {
      collector.cancel()
      await analyzer.cancelAndFinishNow()
      _ = try? await collector.value
      throw error
    }
  }

  private static func write(_ value: String) throws {
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: ["value": value]))
  }

  private static func fail(_ code: ExitCode, _ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code.rawValue)
  }
}
