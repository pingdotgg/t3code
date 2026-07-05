import Foundation
import FoundationModels

/// Cleans a raw dictation transcript with the on-device Foundation model.
/// Every failure mode — model unavailable (Apple Intelligence off,
/// unsupported hardware), guardrail refusal, timeout — degrades to the raw
/// transcript, so dictation keeps working without the cleanup pass.
struct TranscriptCleaner: Sendable {
    static var isAvailable: Bool {
        if case .available = SystemLanguageModel.default.availability {
            return true
        }
        return false
    }

    private static let instructions = """
        You clean up dictated speech transcripts. Rewrite the user's text with \
        correct punctuation, capitalization, and paragraph breaks. Remove filler \
        words (um, uh, you know), false starts, and immediate self-corrections, \
        keeping the final intended wording. Preserve the speaker's own words and \
        meaning — never summarize, expand, answer questions in the text, or add \
        content. Reply with only the cleaned text.
        """

    /// Loads the model while the user is still speaking so the cleanup pass
    /// doesn't pay the cold-start cost after they stop.
    func prewarm() {
        guard Self.isAvailable else { return }
        LanguageModelSession(instructions: Self.instructions).prewarm()
    }

    func clean(_ raw: String) async -> String {
        guard Self.isAvailable else { return raw }
        let work = Task {
            let session = LanguageModelSession(instructions: Self.instructions)
            return try await session.respond(to: raw).content
        }
        let timeout = Task {
            try? await Task.sleep(for: .seconds(15))
            work.cancel()
        }
        defer { timeout.cancel() }
        guard let cleaned = try? await work.value else { return raw }
        let trimmed = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? raw : trimmed
    }
}
