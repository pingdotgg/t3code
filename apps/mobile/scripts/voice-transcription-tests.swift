import AVFoundation
import Foundation
import NaturalLanguage
import Speech

@main
struct VoiceTranscriptionTests {
  @MainActor
  static func main() async throws {
    testDrafts()
    testDraftParity()
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

  static func testDraftParity() {
    let retainedTail = VoiceDraft.merge(
      corrected: "Repair the repeated go go command",
      provisional: "Prepare the repeated go go command and keep the unfinished tail"
    )
    precondition(retainedTail == "Repair the repeated go go command and keep the unfinished tail")

    let longWords = (0..<750).map { "token\($0)" }
    var correctedLongWords = Array(longWords.dropLast(8))
    var provisionalLongWords = longWords
    correctedLongWords[0] = "repair0"
    provisionalLongWords[0] = "prepare0"
    let correctedLong = correctedLongWords.joined(separator: " ")
    let provisionalLong = provisionalLongWords.joined(separator: " ")
    precondition(
      VoiceDraft.merge(corrected: correctedLong, provisional: provisionalLong) ==
        OriginalVoiceDraft.merge(corrected: correctedLong, provisional: provisionalLong)
    )

    func requireLongParity(_ correctedWords: [String], _ provisionalWords: [String], name: String) {
      let corrected = correctedWords.joined(separator: " ")
      let provisional = provisionalWords.joined(separator: " ")
      let expected = OriginalVoiceDraft.merge(corrected: corrected, provisional: provisional)
      let actual = VoiceDraft.merge(corrected: corrected, provisional: provisional)
      precondition(actual == expected, "Long \(name) merge: \(actual) != \(expected)")
    }

    // A repeated tail gives the final matrix row the same minimum at two
    // boundaries. The merge must retain the original last-minimum choice.
    requireLongParity(
      ["stop"] + Array(repeating: "go", count: 79),
      Array(repeating: "go", count: 88),
      name: "repeated tie"
    )

    var balancedCorrected = (0..<80).map { "balanced\($0)" }
    let balancedProvisional = balancedCorrected + (0..<8).map { "retained\($0)" }
    balancedCorrected.remove(at: 1)
    balancedCorrected.insert("replacement", at: 70)
    requireLongParity(balancedCorrected, balancedProvisional, name: "balanced insert-delete")

    let compoundCorrected = ["timeout"] + (1..<80).map { "compound\($0)" }
    let compoundProvisional = ["time", "out"] + (1..<80).map { "compound\($0)" } +
      (0..<8).map { "retainedCompound\($0)" }
    requireLongParity(compoundCorrected, compoundProvisional, name: "compound fallback")

    var random = DeterministicRandom(state: 0x9879_C0DE)
    let vocabulary = ["go", "go", "time", "out", "timeout", "repair", "prepare", "the", "tail"]
    for sample in 0..<2_000 {
      let provisionalCount = random.integer(in: 1...40)
      var provisional = (0..<provisionalCount).map { _ in random.element(vocabulary) }
      var corrected = provisional
      for _ in 0..<random.integer(in: 0...5) {
        switch random.integer(in: 0...2) {
        case 0 where !corrected.isEmpty:
          corrected[random.integer(in: 0...(corrected.count - 1))] = random.element(vocabulary)
        case 1 where corrected.count > 1:
          corrected.remove(at: random.integer(in: 0...(corrected.count - 1)))
        default:
          corrected.insert(random.element(vocabulary), at: random.integer(in: 0...corrected.count))
        }
      }
      if random.integer(in: 0...1) == 0, !provisional.isEmpty { provisional[0] = "prepare" }
      let correctedText = corrected.joined(separator: sample.isMultiple(of: 3) ? "  " : " ")
      let provisionalText = provisional.joined(separator: sample.isMultiple(of: 5) ? "  " : " ")
      let expected = OriginalVoiceDraft.merge(
        corrected: correctedText,
        provisional: provisionalText
      )
      let actual = VoiceDraft.merge(corrected: correctedText, provisional: provisionalText)
      precondition(actual == expected, "Random merge \(sample): \(actual) != \(expected)")
    }

    for sample in 0..<500 {
      let correctedCount = random.integer(in: 64...220)
      let provisionalCount = correctedCount + random.integer(in: 0...12)
      var provisional = (0..<provisionalCount).map { "token\($0)" }
      var corrected = Array(provisional.prefix(correctedCount))
      for edit in 0..<random.integer(in: 1...8) {
        corrected[random.integer(in: 0...(corrected.count - 1))] = "changed\(sample)_\(edit)"
      }
      if sample.isMultiple(of: 2) { provisional.append("retainedTail\(sample)") }
      let correctedText = corrected.joined(separator: " ")
      let provisionalText = provisional.joined(separator: " ")
      let expected = OriginalVoiceDraft.merge(
        corrected: correctedText,
        provisional: provisionalText
      )
      let actual = VoiceDraft.merge(corrected: correctedText, provisional: provisionalText)
      precondition(actual == expected, "Aligned random merge \(sample): \(actual) != \(expected)")
    }
    print("PASS: optimized draft merge matches 3 long and 2,500 randomized original outputs")
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

private enum OriginalVoiceDraft {
  private struct Word {
    let value: String
    let range: Range<String.Index>
  }

  static func merge(corrected: String, provisional: String) -> String {
    let correctedWords = words(in: corrected)
    let provisionalWords = words(in: provisional)
    guard !correctedWords.isEmpty else { return provisional }
    guard !provisionalWords.isEmpty else { return corrected }

    var shared = 0
    while shared < min(correctedWords.count, provisionalWords.count),
      correctedWords[shared].value == provisionalWords[shared].value { shared += 1 }
    let correctedTail = correctedWords.dropFirst(shared)
    let provisionalTail = provisionalWords.dropFirst(shared)
    var costs = Array(0...provisionalTail.count)
    var precedingCosts = costs
    for (row, word) in correctedTail.enumerated() {
      var next = [row + 1]
      for (column, candidate) in provisionalTail.enumerated() {
        var cost = min(costs[column + 1] + 1, next[column] + 1,
                       costs[column] + (word.value == candidate.value ? 0 : 1))
        if column > 0, word.value == provisionalWords[shared + column - 1].value + candidate.value {
          cost = min(cost, costs[column - 1])
        }
        if row > 0, correctedWords[shared + row - 1].value + word.value == candidate.value {
          cost = min(cost, precedingCosts[column])
        }
        next.append(cost)
      }
      precedingCosts = costs
      costs = next
    }
    let minimum = costs.min() ?? 0
    let boundary = shared + (costs.lastIndex(of: minimum) ?? 0)
    guard boundary < provisionalWords.count else { return corrected }
    let tailStart = provisionalWords[boundary].range.lowerBound
    let previousEnd = boundary > 0 ? provisionalWords[boundary - 1].range.upperBound : provisional.startIndex
    let separator = provisional[previousEnd..<tailStart].filter(\.isWhitespace)
    return corrected.trimmingCharacters(in: .whitespacesAndNewlines) + separator + provisional[tailStart...]
  }

  private static func words(in text: String) -> [Word] {
    let tokenizer = NLTokenizer(unit: .word)
    tokenizer.string = text
    return tokenizer.tokens(for: text.startIndex..<text.endIndex).map {
      Word(value: text[$0].lowercased(), range: $0)
    }
  }
}

private struct DeterministicRandom {
  var state: UInt64

  mutating func integer(in range: ClosedRange<Int>) -> Int {
    state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
    return range.lowerBound + Int(state % UInt64(range.count))
  }

  mutating func element(_ values: [String]) -> String {
    values[integer(in: 0...(values.count - 1))]
  }
}

private final class InputChunk: @unchecked Sendable {
  private var buffer: AVAudioPCMBuffer?
  init(_ buffer: AVAudioPCMBuffer) { self.buffer = buffer }
  func take() -> AVAudioPCMBuffer? { defer { buffer = nil }; return buffer }
}
