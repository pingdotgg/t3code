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
  /// Long dictation aligns only the corrected text's last words, so a persistent early
  /// disagreement can't make every partial realign the whole transcript.
  private static let alignmentWindow = 48

  static func merge(corrected: String, provisional: String) -> String {
    let correctedWords = words(in: corrected)
    let provisionalWords = words(in: provisional)
    guard !correctedWords.isEmpty else { return provisional }
    guard !provisionalWords.isEmpty else { return corrected }

    // Discarding a common prefix keeps the usual case small.
    var shared = 0
    while shared < min(correctedWords.count, provisionalWords.count),
      correctedWords[shared].value == provisionalWords[shared].value { shared += 1 }
    let anchored = correctedWords.count - shared <= alignmentWindow
    let rowStart = anchored ? shared : correctedWords.count - alignmentWindow
    let columnStart = anchored ? shared : min(max(shared, rowStart - alignmentWindow), provisionalWords.count)
    let rows = correctedWords[rowStart...]
    let columns = provisionalWords[columnStart...]

    // Edit distance from the corrected words to each provisional prefix. An anchored
    // alignment starts at the shared prefix; a windowed one may start anywhere.
    var costs = anchored ? Array(0...columns.count) : Array(repeating: 0, count: columns.count + 1)
    var precedingCosts = costs
    for (row, word) in rows.enumerated() {
      var next = [row + 1]
      for (column, candidate) in columns.enumerated() {
        var cost = min(costs[column + 1] + 1, next[column] + 1,
                       costs[column] + (word.value == candidate.value ? 0 : 1))
        // The engines can spell the same compound as one word or two ("timeout" / "time out").
        if column > 0, word.value == provisionalWords[columnStart + column - 1].value + candidate.value {
          cost = min(cost, costs[column - 1])
        }
        if row > 0, correctedWords[rowStart + row - 1].value + word.value == candidate.value {
          cost = min(cost, precedingCosts[column])
        }
        next.append(cost)
      }
      precedingCosts = costs
      costs = next
    }
    let minimum = costs.min() ?? 0
    // On a tie, prefer replacing a mistaken word to inserting its correction beside it.
    let boundary = columnStart + (costs.lastIndex(of: minimum) ?? 0)
    guard boundary < provisionalWords.count else { return corrected }
    let tailStart = provisionalWords[boundary].range.lowerBound
    let previousEnd = boundary > 0 ? provisionalWords[boundary - 1].range.upperBound : provisional.startIndex
    let corrected = corrected.trimmingCharacters(in: .whitespacesAndNewlines)
    let separator = separator(after: corrected, provisional[previousEnd..<tailStart])
    return corrected + separator + provisional[tailStart...]
  }

  private static func separator(after corrected: String, _ provisional: Substring) -> String {
    guard corrected.last?.isLetter == true || corrected.last?.isNumber == true else {
      return provisional.filter(\.isWhitespace)
    }
    return String(provisional)
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
