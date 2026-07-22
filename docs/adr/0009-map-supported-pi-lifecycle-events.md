# Map supported Pi lifecycle events into T3 Code

The Pi adapter will map all Pi RPC lifecycle information with a clear T3 Code equivalent, including streaming text and thinking, tool calls and progress, turn completion, retries, compaction, and queued work. Provider-specific UI is deferred only when Pi exposes an interaction that has no safe or faithful T3 Code representation, such as a custom terminal widget.
