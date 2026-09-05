import AVFoundation
import Speech

enum LiveVoiceError: Error {
  case unavailable, busy, audioFormat
}

/// Runs both on-device recognizers over the same audio, with no periodic forced finalization.
@available(iOS 26.0, macOS 26.0, *)
@MainActor
final class VoiceTranscription {
  private let emit: (String) -> Void
  private let interrupted: () -> Void
  private var analyzer: SpeechAnalyzer?
  private var tasks: [Task<Void, Error>] = []
  private var corrected = VoiceTranscript()
  private var provisional = VoiceTranscript()
  private var lastEmission = ""
  private var revision = 0
  private var cancelled = false
  private var ending = false

  init(emit: @escaping (String) -> Void, interrupted: @escaping () -> Void) {
    self.emit = emit
    self.interrupted = interrupted
  }

  private static func modules(locale: Locale) async -> (SpeechTranscriber, DictationTranscriber?) {
    let corrected = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
    let fastLocale = await DictationTranscriber.supportedLocale(equivalentTo: locale)
    let provisional = fastLocale.map { DictationTranscriber(locale: $0, preset: .progressiveLongDictation) }
    return (corrected, provisional)
  }

  static func prepare(locale: String) async throws -> String? {
    guard SpeechTranscriber.isAvailable,
      let supported = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: locale))
    else { return nil }
    let (corrected, provisional) = await modules(locale: supported)
    var modules: [any SpeechModule] = [corrected]
    if let provisional { modules.append(provisional) }
    if let install = try await AssetInventory.assetInstallationRequest(supporting: modules) {
      try await install.downloadAndInstall()
    }
    return supported.identifier
  }

  func start(input: AsyncStream<AnalyzerInput>, locale: String) async throws -> AVAudioFormat {
    let (corrected, provisional) = await Self.modules(locale: Locale(identifier: locale))
    try checkActive()
    var modules: [any SpeechModule] = [corrected]
    if let provisional { modules.append(provisional) }
    let analyzer = SpeechAnalyzer(
      modules: modules, options: .init(priority: .userInitiated, modelRetention: .lingering)
    )
    self.analyzer = analyzer
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: modules)
    else { throw LiveVoiceError.audioFormat }
    try await analyzer.prepareToAnalyze(in: format)
    try checkActive()
    tasks.append(collect(corrected.results, isCorrection: true, text: { String($0.text.characters) }))
    if let provisional { tasks.append(collect(provisional.results, isCorrection: false, text: { String($0.text.characters) })) }
    try await analyzer.start(inputSequence: input)
    try checkActive()
    return format
  }

  private func collect<Results: AsyncSequence & Sendable>(
    _ results: Results, isCorrection: Bool, text: @escaping (Results.Element) -> String
  ) -> Task<Void, Error> where Results.Element: SpeechModuleResult {
    Task(priority: .userInitiated) { @MainActor [weak self] in
      do {
        for try await result in results {
          guard let self else { return }
          try checkActive()
          let text = text(result)
          if isCorrection {
            corrected.update(text: text, range: result.range)
          } else {
            provisional.update(text: text, range: result.range)
          }
          revision += 1
          let currentRevision = revision
          let correctedText = corrected.text
          let provisionalText = provisional.text
          // Long recordings must not spend their alignment time on the UI thread.
          let draft = await Task.detached(priority: .userInitiated) {
            VoiceDraft.merge(corrected: correctedText, provisional: provisionalText)
          }.value
          try checkActive()
          if currentRevision == revision { publish(draft) }
        }
      } catch {
        if let self, !ending, !cancelled { interrupted() }
        throw error
      }
    }
  }

  func finish() async throws -> String {
    ending = true
    try checkActive()
    try await analyzer?.finalizeAndFinishThroughEndOfInput()
    for task in tasks { try await task.value }
    try checkActive()
    analyzer = nil
    tasks.removeAll()
    // Once all audio is processed, only the newer model decides the final transcript.
    let text = corrected.text
    publish(text)
    return text
  }

  func cancel() async {
    cancelled = true
    ending = true
    tasks.forEach { $0.cancel() }
    await analyzer?.cancelAndFinishNow()
    for task in tasks { _ = try? await task.value }
    tasks.removeAll()
    analyzer = nil
  }

  private func checkActive() throws {
    if cancelled { throw CancellationError() }
    try Task.checkCancellation()
  }

  private func publish(_ text: String) {
    guard text != lastEmission else { return }
    lastEmission = text
    emit(text)
  }
}
