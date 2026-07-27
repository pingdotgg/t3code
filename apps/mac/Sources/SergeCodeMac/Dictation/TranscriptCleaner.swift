import Foundation
import FoundationModels

/// Cleans a raw dictation transcript with the on-device Foundation model.
/// Every failure mode — model unavailable (Apple Intelligence off,
/// unsupported hardware), guardrail refusal, timeout, or a reply that isn't
/// a cleanup of what was said — degrades to the raw transcript, so dictation
/// keeps working without the cleanup pass.
///
/// The prompt framing and the reply vetting both live in `TranscriptCleanup`.
struct TranscriptCleaner: Sendable {
    static var isAvailable: Bool {
        if case .available = SystemLanguageModel.default.availability {
            return true
        }
        return false
    }

    /// Loads the model while the user is still speaking so the cleanup pass
    /// doesn't pay the cold-start cost after they stop.
    func prewarm() {
        guard Self.isAvailable else { return }
        LanguageModelSession(instructions: TranscriptCleanup.instructions).prewarm()
    }

    func clean(_ raw: String) async -> String {
        guard Self.isAvailable else { return raw }
        let work = Task {
            let session = LanguageModelSession(instructions: TranscriptCleanup.instructions)
            // Deterministic decoding: this is a rewrite, not a creative
            // task, and sampling is what lets a small model wander off into
            // answering the transcript. `temperature` rather than
            // `samplingMode: .greedy` because the label for the latter
            // changed in the macOS 27 SDK and CI builds against 26.
            let options = GenerationOptions(
                temperature: 0,
                maximumResponseTokens: TranscriptCleanup.responseTokenBudget(for: raw))
            return try await session.respond(
                to: TranscriptCleanup.prompt(for: raw), options: options
            ).content
        }
        let timeout = Task {
            try? await Task.sleep(for: .seconds(15))
            work.cancel()
        }
        defer { timeout.cancel() }
        // `work` is unstructured, so cancelling the polish task has to be
        // forwarded by hand or the model keeps generating into the void.
        let candidate = await withTaskCancellationHandler {
            try? await work.value
        } onCancel: {
            work.cancel()
        }
        guard let candidate,
            let cleaned = TranscriptCleanup.accepted(candidate: candidate, raw: raw)
        else { return raw }
        return cleaned
    }
}
