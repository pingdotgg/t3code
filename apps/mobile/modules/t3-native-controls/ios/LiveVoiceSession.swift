import AVFoundation
import Speech

enum LiveVoiceError: Error {
  case unavailable, busy, audioFormat
}

/// AVAudioConverter pulls each tap buffer synchronously, at most once.
private final class VoiceConversionChunk: @unchecked Sendable {
  private var buffer: AVAudioPCMBuffer?
  init(_ buffer: AVAudioPCMBuffer) { self.buffer = buffer }
  func take() -> AVAudioPCMBuffer? {
    defer { buffer = nil }
    return buffer
  }
}

@available(iOS 26.0, *)
@MainActor
final class LiveVoiceSession {
  let id: String
  private let emit: ([String: Any]) -> Void
  private let engine = AVAudioEngine()
  private var analyzer: SpeechAnalyzer?
  private var input: AsyncStream<AnalyzerInput>.Continuation?
  private var resultsTask: Task<Void, Error>?
  private var observers: [NSObjectProtocol] = []
  private var tapInstalled = false
  private var ending = false
  private var committed = ""
  private var transcript = ""
  private var startedAt: TimeInterval = 0
  private var lastMeterAt: TimeInterval = 0

  init(id: String, emit: @escaping ([String: Any]) -> Void) {
    self.id = id
    self.emit = emit
  }

  // Progressive system dictation exposes word-by-word hypotheses and corrections.
  private static func makeTranscriber(locale: Locale) -> DictationTranscriber {
    DictationTranscriber(locale: locale, preset: .progressiveLongDictation)
  }

  static func prepare(locale: String) async throws -> String? {
    guard let supported = await DictationTranscriber.supportedLocale(
      equivalentTo: Locale(identifier: locale)
    ) else { return nil }
    let transcriber = makeTranscriber(locale: supported)
    if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      try await install.downloadAndInstall()
    }
    return supported.identifier
  }

  func start(locale: String, limit: Double) async throws {
    let transcriber = Self.makeTranscriber(locale: Locale(identifier: locale))
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    self.analyzer = analyzer
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
    else { throw LiveVoiceError.audioFormat }
    let node = engine.inputNode
    let sourceFormat = node.outputFormat(forBus: 0)
    guard sourceFormat.sampleRate > 0, sourceFormat.channelCount > 0,
      let converter = AVAudioConverter(from: sourceFormat, to: format)
    else { throw LiveVoiceError.audioFormat }
    converter.primeMethod = .none
    let (sequence, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    input = continuation
    resultsTask = Task { @MainActor [weak self] in
      do {
        for try await result in transcriber.results {
          guard let self else { return }
          let text = String(result.text.characters)
          // Apple revises the current segment; finalized segments become its prefix.
          transcript = committed + text
          if result.isFinal { committed = transcript }
          emit(["sessionId": id, "transcript": transcript])
        }
      } catch {
        if let self, !ending {
          emit(["sessionId": id, "error": "Live dictation was interrupted."])
        }
        throw error
      }
    }
    let ratio = format.sampleRate / sourceFormat.sampleRate
    node.installTap(onBus: 0, bufferSize: 4096, format: sourceFormat) { [weak self] buffer, _ in
      let decibels = Self.decibels(for: buffer)
      Task { @MainActor [weak self] in self?.meter(decibels, limit: limit) }
      do {
        if let converted = try Self.convert(buffer, using: converter, to: format, ratio: ratio) {
          continuation.yield(AnalyzerInput(buffer: converted))
        }
      } catch {
        Task { @MainActor [weak self] in self?.interrupted() }
      }
    }
    tapInstalled = true
    try await analyzer.start(inputSequence: sequence)
    startedAt = ProcessInfo.processInfo.systemUptime
    engine.prepare()
    try engine.start()
    for name in [AVAudioSession.interruptionNotification, AVAudioSession.mediaServicesWereResetNotification,
                 NSNotification.Name.AVAudioEngineConfigurationChange] {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        Task { @MainActor [weak self] in self?.interrupted() }
      })
    }
  }

  private nonisolated static func decibels(for buffer: AVAudioPCMBuffer) -> Float {
    var sum: Float = 0
    if let samples = buffer.floatChannelData?[0] {
      for frame in 0..<Int(buffer.frameLength) { sum += samples[frame] * samples[frame] }
    }
    let rms = (sum / Float(max(1, buffer.frameLength))).squareRoot()
    return 20 * log10(max(rms, 0.000001))
  }

  private nonisolated static func convert(
    _ buffer: AVAudioPCMBuffer,
    using converter: AVAudioConverter,
    to format: AVAudioFormat,
    ratio: Double
  ) throws -> AVAudioPCMBuffer? {
    let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up) + 64)
    guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
      throw LiveVoiceError.audioFormat
    }
    var error: NSError?
    let chunk = VoiceConversionChunk(buffer)
    let status = converter.convert(to: converted, error: &error) { _, inputStatus in
      guard let pending = chunk.take() else {
        inputStatus.pointee = .noDataNow
        return nil
      }
      inputStatus.pointee = .haveData
      return pending
    }
    if status == .error || error != nil { throw LiveVoiceError.audioFormat }
    return converted.frameLength > 0 ? converted : nil
  }

  private func meter(_ decibels: Float, limit: Double) {
    guard !ending else { return }
    let now = ProcessInfo.processInfo.systemUptime
    let elapsed = now - startedAt
    if now - lastMeterAt >= 0.08 {
      lastMeterAt = now
      emit(["sessionId": id, "durationMillis": elapsed * 1000, "metering": decibels])
    }
    if elapsed >= limit {
      teardownCapture()
      emit(["sessionId": id, "ended": true])
    }
  }

  private func interrupted() {
    guard !ending else { return }
    teardownCapture()
    emit(["sessionId": id, "error": "Voice recording was interrupted."])
  }

  func stop() async throws -> String {
    teardownCapture()
    do {
      try await analyzer?.finalizeAndFinishThroughEndOfInput()
      try await resultsTask?.value
      analyzer = nil
      resultsTask = nil
      return transcript
    } catch {
      await cancel()
      throw error
    }
  }

  func cancel() async {
    teardownCapture()
    await analyzer?.cancelAndFinishNow()
    resultsTask?.cancel()
    _ = try? await resultsTask?.value
    analyzer = nil
    resultsTask = nil
  }

  private func teardownCapture() {
    ending = true
    observers.forEach(NotificationCenter.default.removeObserver)
    observers.removeAll()
    if tapInstalled {
      engine.inputNode.removeTap(onBus: 0)
      tapInstalled = false
    }
    engine.stop()
    input?.finish()
    input = nil
  }
}
