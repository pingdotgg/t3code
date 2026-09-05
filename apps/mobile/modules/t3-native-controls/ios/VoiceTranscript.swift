import Foundation
import NaturalLanguage
import CoreMedia

/// Replaces a recognizer's revisable passage without losing earlier passages.
struct VoiceTranscript {
  private struct Passage {
    let range: CMTimeRange
    let text: String
  }
  private var passages: [Passage] = []

  mutating func update(text: String, range: CMTimeRange) {
    passages.removeAll { $0.range.end > range.start || $0.range.start == range.start }
    passages.append(Passage(range: range, text: text))
  }

  var text: String { passages.map(\.text).joined() }
}

/// The newer recognizer owns the prefix; fast dictation supplies the unfinished tail.
enum VoiceDraft {
  static func merge(corrected: String, provisional: String) -> String {
    let correctedWords = words(in: corrected)
    let provisionalWords = words(in: provisional)
    guard !correctedWords.isEmpty else { return provisional }
    guard !provisionalWords.isEmpty else { return corrected }

    // Align to a prefix, leaving words the newer model hasn't reached on screen.
    // Discarding a common prefix keeps the usual case small, even for long dictation.
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
        // The engines can spell the same compound as one word or two ("timeout" / "time out").
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
    // On a tie, prefer replacing a mistaken word to inserting its correction beside it.
    let boundary = shared + (costs.lastIndex(of: minimum) ?? 0)
    guard boundary < provisionalWords.count else { return corrected }
    let tailStart = provisionalWords[boundary].range.lowerBound
    let previousEnd = boundary > 0 ? provisionalWords[boundary - 1].range.upperBound : provisional.startIndex
    let separator = provisional[previousEnd..<tailStart].filter(\.isWhitespace)
    return corrected.trimmingCharacters(in: .whitespacesAndNewlines) + separator + provisional[tailStart...]
  }

  private struct Word {
    let value: String
    let range: Range<String.Index>
  }

  private static func words(in text: String) -> [Word] {
    let tokenizer = NLTokenizer(unit: .word)
    tokenizer.string = text
    return tokenizer.tokens(for: text.startIndex..<text.endIndex).map {
      Word(value: text[$0].lowercased(), range: $0)
    }
  }
}
