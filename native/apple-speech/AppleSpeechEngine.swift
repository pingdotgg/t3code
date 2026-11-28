// Adapted from AppleTranscriptionImpl.swift in @react-native-ai/apple (MIT, Callstack).
import AVFoundation
import Foundation
import Speech

@available(iOS 26, macOS 26, *)
enum AppleSpeechEngine {
  enum Failure: LocalizedError {
    case unavailable
    case unsupportedLocale(String)
    case unknownAssetStatus

    var errorDescription: String? {
      switch self {
      case .unavailable: return "Speech transcription is not available."
      case .unsupportedLocale(let locale): return "Locale not supported: \(locale)"
      case .unknownAssetStatus: return "Unknown asset inventory status."
      }
    }
  }

  static var isAvailable: Bool { SpeechTranscriber.isAvailable }

  static func supportedLocales() async throws -> [String] {
    try requireAvailable()
    return await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) }
  }

  private static func requireAvailable() throws {
    guard isAvailable else {
      throw Failure.unavailable
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

  static func prepare(_ identifier: String) async throws -> String {
    try requireAvailable()
    guard
      let locale = await SpeechTranscriber.supportedLocale(
        equivalentTo: Locale(identifier: identifier))
    else {
      throw Failure.unsupportedLocale(identifier)
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
      throw Failure.unsupportedLocale(identifier)
    @unknown default:
      throw Failure.unknownAssetStatus
    }
    return locale.identifier(.bcp47)
  }

  static func transcribe(_ identifier: String, file: URL) async throws -> String {
    try requireAvailable()
    guard file.isFileURL else { throw CocoaError(.fileReadUnsupportedScheme) }
    let audioFile = try AVAudioFile(forReading: file)
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

}
