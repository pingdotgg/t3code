import Foundation

/// Pure draft-text edits for dictation results. Extracted from the composer
/// so the insertion and cleanup-replacement rules are directly testable.
public enum DictationDraft {
    /// Appends a finished transcript to the draft, separating it from any
    /// existing text with a single space.
    public static func appending(_ text: String, to draft: String) -> String {
        if draft.isEmpty { return text }
        if draft.hasSuffix(" ") || draft.hasSuffix("\n") { return draft + text }
        return draft + " " + text
    }

    /// Replaces the last occurrence of `original` in the draft, returning nil
    /// when it isn't there anymore. The cleanup pass swaps the raw transcript
    /// for the polished one; searching backwards lands the swap where the raw
    /// text was inserted even when the user kept typing after it, and a miss
    /// (the user edited or sent the text in the meantime) is a safe no-op.
    public static func replacingLastOccurrence(
        of original: String, with replacement: String, in draft: String
    ) -> String? {
        guard !original.isEmpty,
            let range = draft.range(of: original, options: .backwards)
        else { return nil }
        return draft.replacingCharacters(in: range, with: replacement)
    }
}
