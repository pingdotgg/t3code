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
    // Normal suffix revisions leave a tiny tail, where the full matrix is cheaper.
    if correctedTail.count >= 64, let alignedBoundary = smallAlignedBoundary(
      corrected: correctedTail,
      provisional: provisionalTail
    ) {
      let boundary = shared + alignedBoundary
      guard boundary < provisionalWords.count else { return corrected }
      let tailStart = provisionalWords[boundary].range.lowerBound
      let previousEnd = boundary > 0
        ? provisionalWords[boundary - 1].range.upperBound
        : provisional.startIndex
      let separator = provisional[previousEnd..<tailStart].filter(\.isWhitespace)
      return corrected.trimmingCharacters(in: .whitespacesAndNewlines) + separator + provisional[tailStart...]
    }
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

  /// Computes the same boundary as the full edit-distance matrix when the two
  /// tails are already positionally aligned with only a few substitutions.
  /// Keep this uncommon large-tail path out of the normal merge's instruction body.
  @inline(never)
  private static func smallAlignedBoundary(
    corrected: ArraySlice<Word>,
    provisional: ArraySlice<Word>
  ) -> Int? {
    guard provisional.count >= corrected.count else { return nil }
    let corrected = Array(corrected)
    let provisional = Array(provisional)

    let maximumSubstitutions = 8
    let substitutions = zip(corrected, provisional).filter { $0.0.value != $0.1.value }.count
    guard substitutions <= maximumSubstitutions else { return nil }
    guard !hasCompoundAlignment(corrected: corrected, provisional: provisional) else { return nil }

    // The positional comparison gives an upper bound at corrected.count. With
    // no compound transitions, a path of that cost cannot leave this band.
    let infinity = substitutions + 1
    var costs = Array(repeating: infinity, count: provisional.count + 1)
    var next = costs
    for column in 0...min(substitutions, provisional.count) { costs[column] = column }
    var previousLower = 0
    var previousUpper = min(substitutions, provisional.count)

    for (rowIndex, word) in corrected.enumerated() {
      let row = rowIndex + 1
      let lower = max(0, row - substitutions)
      let upper = min(provisional.count, row + substitutions)
      for column in lower...upper { next[column] = infinity }
      if lower == 0 { next[0] = row }

      if upper >= max(1, lower) {
        for column in max(1, lower)...upper {
          let deletion = column >= previousLower && column <= previousUpper
            ? costs[column] + 1
            : infinity
          let insertion = column - 1 >= lower ? next[column - 1] + 1 : infinity
          let substitution = column - 1 >= previousLower && column - 1 <= previousUpper
            ? costs[column - 1] + (word.value == provisional[column - 1].value ? 0 : 1)
            : infinity
          next[column] = min(deletion, insertion, substitution)
        }
      }
      swap(&costs, &next)
      previousLower = lower
      previousUpper = upper
    }

    var minimum = infinity
    var boundary = corrected.count
    for column in previousLower...previousUpper where costs[column] <= minimum {
      minimum = costs[column]
      boundary = column
    }
    return boundary
  }

  private static func hasCompoundAlignment(
    corrected: [Word],
    provisional: [Word]
  ) -> Bool {
    let correctedValues = Set(corrected.map(\.value))
    for index in provisional.indices.dropFirst()
    where correctedValues.contains(provisional[index - 1].value + provisional[index].value) {
      return true
    }

    let provisionalValues = Set(provisional.map(\.value))
    for index in corrected.indices.dropFirst()
    where provisionalValues.contains(corrected[index - 1].value + corrected[index].value) {
      return true
    }
    return false
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
