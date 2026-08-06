# Thread subtitles

Thread subtitles are short, generated status lines that answer **what is happening in this thread right now?** They appear directly below the thread title in the chat header, project sidebar, session grid, command palette, and mobile thread lists.

The title and subtitle have different jobs:

- The **title** is the durable mission, such as “Add passkey authentication”. You can rename it and it stays stable across turns.
- The **subtitle** is the current step or latest outcome, such as “validating the iOS sign-in flow” or “passkey fallback verified”. T3 Code owns and updates it automatically.

## How generation works

When a new turn starts, T3 Code removes the previous outcome and asks the configured **Text generation model** for a concise working subtitle. When the turn and its checkpoint finish, it generates the final outcome or handoff for that turn. The generator uses the durable title plus a small, recent digest of user messages, assistant messages, attachment names, and activity summaries. Newer context receives the most weight.

Generated subtitles are limited to one plain-text line of 3–10 words and 72 characters. They do not replace a manually chosen title and cannot rename the thread.

Subtitle generation is best effort and runs separately from the coding agent turn. A missing model, unavailable provider, or generation error never delays or fails the actual work. If working-status generation fails, the cleared subtitle stays empty; if completion generation fails, the last truthful working subtitle remains. A late result is discarded when a newer user message or turn has already taken over, so an old status cannot overwrite newer work.

The selected writer comes from **Settings → General → Text generation model**. This is the same global model used for thread-title generation. Source-control writer overrides do not affect thread subtitles.

## Persistence and search

The current subtitle is stored with the thread on its T3 server. Web, desktop, mobile, and remotely connected clients therefore show the same status after synchronization or reload. It also remains visible in archived history until another turn starts.

Thread search includes subtitle text in the project sidebar, command palette, mobile Home lists, and archived-thread search. Technical metadata such as branch, environment, and provider remains separate so the subtitle can stay focused on the work itself.
