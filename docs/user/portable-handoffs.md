# Context in portable handoffs

When you switch providers mid-thread, continue after a portable restart, or fork a thread the provider cannot resume natively, Hyakki transfers a budgeted selection of conversation history to the new provider session.

## What transfers

- Short conversations transfer intact.
- Longer conversations prioritize the original request, recent user/assistant turns (including partial work from interrupted turns), and key activity like command outcomes.
- Your new prompt is never shortened to make history fit.
- Codex receives historical messages directly when supported; other providers receive attributed conversation context.
- Reasoning traces, raw tool-call state, and attachments are not copied.
- Omitted history is referenced so the agent can retrieve saved messages on demand using Hyakki's thread-reading tool. Still, repeat any critical constraint in your next message if you want to be sure.

## Context limits and configuration

If the target session doesn't have enough context room, Hyakki automatically starts a fresh provider session with a bounded history selection and sends your request—no manual `/compact` needed. If your request and attachments alone exceed the model's window, shorten the message or choose a larger-context model.

- **History budget**: Operators can set `HYAKKI_CONTEXT_HANDOFF_TOKEN_CAP` (default `16000`, range `1024`–`64000`) to adjust the initial history allowance. Imported history has a separate 64,000-byte ceiling.
- **Fallback estimates**: When a model doesn't report capacity, Hyakki assumes a 128,000-token window, reserves at least 16,000 tokens (or 25%) for instructions/tools/work, and conservatively estimates 1 token per UTF-8 byte, 8,192 tokens per image, and 4,096 tokens per other attachment.
- Running background work stays intact during recovery—let it finish or stop it before retrying a handoff.
