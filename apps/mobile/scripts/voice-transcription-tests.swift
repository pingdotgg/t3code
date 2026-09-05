import AVFoundation
import Foundation
import Speech

@main
struct VoiceTranscriptionTests {
  @MainActor
  static func main() async throws {
    testDrafts()
    testPassages()
    if CommandLine.arguments.count > 1 {
      try await replay(URL(fileURLWithPath: CommandLine.arguments[1]))
    }
    print("PASS: native voice transcription tests")
  }

  static func testDrafts() {
    let cases = [
      ("", "Please show", "Please show"),
      ("Please show", "", "Please show"),
      ("Please", "Please show the words", "Please show the words"),
      ("Please show the words.", "Please show", "Please show the words."),
      ("Use exponential backoff", "Use exponential backup and retry", "Use exponential backoff and retry"),
      ("Use exponential backoff", "Use exponential backup and retry twice", "Use exponential backoff and retry twice"),
      ("Change the timeout", "Change the time out to five seconds", "Change the timeout to five seconds"),
      ("Use back off", "Use backoff and retry", "Use back off and retry"),
      ("Please run tests", "Please run the tests now", "Please run tests now"),
      ("Please run the tests", "Please run tests now", "Please run the tests now"),
      ("I said go", "I said go go again", "I said go go again"),
      ("Send it. Then wait", "Send it then wait for me", "Send it. Then wait for me"),
      ("That works.", "That works. Keep going", "That works. Keep going"),
      ("Hello, world!", "hello world and goodbye", "Hello, world! and goodbye"),
      ("你好世界", "你好世界今天很好", "你好世界今天很好"),
      ("Привет мир", "Привет мир сегодня", "Привет мир сегодня")
    ]
    for (corrected, provisional, expected) in cases {
      let actual = VoiceDraft.merge(corrected: corrected, provisional: provisional)
      precondition(actual == expected, "Merge: \(actual) != \(expected)")
    }
    let prefix = Array(repeating: "please run the tests", count: 250).joined(separator: " ")
    let corrected = "Use backoff " + prefix
    let provisional = "Use backup " + prefix + " and report the result"
    let start = ProcessInfo.processInfo.systemUptime
    precondition(VoiceDraft.merge(corrected: corrected, provisional: provisional) == corrected + " and report the result")
    print("Long draft merge: \(ProcessInfo.processInfo.systemUptime - start)s")
  }

  static func testPassages() {
    var transcript = VoiceTranscript()
    func range(_ start: Double, _ end: Double) -> CMTimeRange {
      CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 1000),
                  end: CMTime(seconds: end, preferredTimescale: 1000))
    }
    transcript.update(text: "Please show", range: range(0, 1))
    transcript.update(text: "Please show the words.", range: range(0, 2))
    transcript.update(text: " Keep", range: range(2, 3))
    // A subsequent passage can implicitly finalize the previous one without an isFinal event.
    precondition(transcript.text == "Please show the words. Keep")
    transcript.update(text: " Keep talking.", range: range(2, 4))
    precondition(transcript.text == "Please show the words. Keep talking.")
    transcript.update(text: "", range: range(2, 4))
    precondition(transcript.text == "Please show the words.")
  }

  @MainActor
  static func replay(_ url: URL) async throws {
    let (input, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    var events: [[String: Any]] = []
    var start = ProcessInfo.processInfo.systemUptime
    var interrupted = false
    let transcription = VoiceTranscription(emit: { text in
      let event: [String: Any] = ["seconds": ProcessInfo.processInfo.systemUptime - start, "text": text]
      events.append(event)
      print(String(data: try! JSONSerialization.data(withJSONObject: event, options: [.sortedKeys]), encoding: .utf8)!)
    }, interrupted: { interrupted = true })
    let format = try await transcription.start(input: input, locale: "en-US")
    let file = try AVAudioFile(forReading: url)
    let source = file.processingFormat
    let converter = AVAudioConverter(from: source, to: format)!
    converter.primeMethod = .none
    start = ProcessInfo.processInfo.systemUptime
    let frames = AVAudioFrameCount(source.sampleRate * 0.0213333333)
    while file.framePosition < file.length {
      let buffer = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: frames)!
      try file.read(into: buffer)
      let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * format.sampleRate / source.sampleRate) + 64)
      let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity)!
      let chunk = InputChunk(buffer)
      var error: NSError?
      let status = converter.convert(to: output, error: &error) { _, status in
        guard let buffer = chunk.take() else { status.pointee = .noDataNow; return nil }
        status.pointee = .haveData
        return buffer
      }
      precondition(status != .error && error == nil)
      if output.frameLength > 0 { continuation.yield(AnalyzerInput(buffer: output)) }
      let audioTime = Double(file.framePosition) / source.sampleRate
      if CommandLine.arguments.contains("--cancel"), audioTime >= 1.5 {
        continuation.finish()
        let count = events.count
        await transcription.cancel()
        do {
          _ = try await transcription.finish()
          preconditionFailure("Cancelled live recording returned a transcript")
        } catch is CancellationError {}
        precondition(events.count == count && !interrupted)
        print("PASS: cancellation during live recognition suppressed late text")
        return
      }
      let remaining = audioTime - (ProcessInfo.processInfo.systemUptime - start)
      if remaining > 0 { try await Task.sleep(for: .seconds(remaining)) }
    }
    let liveText = events.last?["text"] as? String ?? ""
    continuation.finish()
    let finishStarted = ProcessInfo.processInfo.systemUptime
    let final = try await transcription.finish()
    precondition(!interrupted)
    if let index = CommandLine.arguments.firstIndex(of: "--expect") {
      let expected = try String(contentsOfFile: CommandLine.arguments[index + 1], encoding: .utf8)
      func words(_ text: String) -> [String] {
        text.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
      }
      let expectedWords = words(expected)
      precondition(words(final) == expectedWords, "Final transcription differs from the spoken fixture")
      let livePrefix = zip(words(liveText), expectedWords).prefix { $0 == $1 }.count
      precondition(Double(livePrefix) / Double(expectedWords.count) >= 0.9,
                   "Live text lost the spoken sentence before Finish")
      print("PASS: live and final transcripts retain the spoken fixture")
    }
    let summary: [String: Any] = ["transcript": final, "firstResultSeconds": events.first?["seconds"] ?? NSNull(),
                                  "updates": events.count, "liveTranscriptBeforeFinish": liveText, "finishSeconds": ProcessInfo.processInfo.systemUptime - finishStarted]
    print("SUMMARY " + String(data: try JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys]), encoding: .utf8)!)
    let count = events.count
    await transcription.cancel()
    do {
      _ = try await transcription.finish()
      preconditionFailure("Finishing a cancelled transcription must fail")
    } catch is CancellationError {}
    precondition(events.count == count, "Cancelled transcription emitted text")
    let empty = VoiceTranscription(emit: { _ in preconditionFailure("Cancelled startup emitted text") }, interrupted: {})
    await empty.cancel()
    do {
      _ = try await empty.start(input: AsyncStream { $0.finish() }, locale: "en-US")
      preconditionFailure("Starting a cancelled transcription must fail")
    } catch is CancellationError {}
  }
}

private final class InputChunk: @unchecked Sendable {
  private var buffer: AVAudioPCMBuffer?
  init(_ buffer: AVAudioPCMBuffer) { self.buffer = buffer }
  func take() -> AVAudioPCMBuffer? { defer { buffer = nil }; return buffer }
}
