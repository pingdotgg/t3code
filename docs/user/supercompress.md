# SuperCompress

Use SuperCompress when long pastes and tool dumps are burning tokens on every coding-agent turn.

T3 Code can compress bulky _context_ before the request reaches Codex, Claude, Cursor, Grok, or OpenCode. Your ask stays as you wrote it.

## Connect SuperCompress

1. Create an API key at [supercompress.dev/dashboard](https://www.supercompress.dev/dashboard).
2. In T3 Code, open **Settings → General → SuperCompress**.
3. Turn **Compress bulky context before agent turns** on.
4. Paste your `sc_…` API key.
5. Leave the minimum size at `800` characters unless you know you want shorter pastes compressed too.

The key is stored with your environment’s server settings (same class of secret as other provider credentials on that machine).

## What gets compressed

On each turn start, T3 Code:

1. Splits your message into a short **ask** and the remaining **context**
2. Sends only the context to SuperCompress
3. Rebuilds the provider prompt as `ask + compressed context`
4. Leaves the message shown in the thread unchanged

Short messages are left alone. If SuperCompress is unreachable or returns no savings, T3 Code sends the original text (fail-open).

## When to use it

- Pasting long logs, traces, or file dumps into a turn
- Forwarding large agent transcripts as context
- Keeping provider context windows colder without rewriting your ask

SuperCompress does not replace provider-native context compaction. It runs earlier, on the text you are about to send.

## Turn it off

Toggle the setting off, or clear the API key. Existing thread history is unchanged.
