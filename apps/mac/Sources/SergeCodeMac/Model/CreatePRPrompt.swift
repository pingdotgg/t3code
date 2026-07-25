import Foundation

/// Canned "open a pull request" instruction for the agent, shared by the
/// follow-up bar's Create PR button (sent as its own message) and the
/// composer's auto-PR toggle (appended to the user's message). Plain
/// user-message text either way, so it works identically across providers.
enum CreatePRPrompt {
    /// UserDefaults key for the composer's "create PR when done" toggle.
    static let autoCreateDefaultsKey = "autoCreatePROnSend"

    private static let guidelines = """
        Guidelines:
        - Review the full diff of this branch before writing anything.
        - Commit any uncommitted changes with clear, conventional commit messages.
        - Push the branch and open the PR against the repository's default branch.
        - Use a concise, imperative PR title.
        - In the PR body, summarize what changed and why, and note how it was verified.
        - Follow the repository's PR template and contribution guidelines if present.
        """

    /// Sent as a standalone user message (the follow-up bar's Create PR button).
    static let standalone = """
        Please create a pull request for the work in this session.

        \(guidelines)
        """

    /// Appended to an outgoing composer message when the auto-PR toggle is on.
    /// The leading blank lines separate it from the user's own text.
    static let messageSuffix = """


        When you finish the work above, also create a pull request for it.

        \(guidelines)
        """
}
