# Voice conversations

A voice conversation turns a spoken request into a normal turn in the task you
started it from. The model selected in that task does the work, with its usual
permissions and approvals; voice carries the request there and speaks the answer
back. To dictate text into a draft instead, see [Voice input](./voice-input.md).

Start a conversation with the voice button in the composer on web or desktop. One
voice session runs at a time and it belongs to the task it started in — end voice
to move to another task. Ending voice leaves work the agent already started running.

## Choosing how voice connects

Open **Settings** → **Voice** → **Voice conversations**.

- **Codex account · GPT-Live** uses the ChatGPT sign-in of your Codex provider
  (**Settings** → **Providers**). It needs no OpenAI API key, and it requires a
  Codex version with GPT-Live support and a ChatGPT plan that includes it.
- **OpenAI API · Realtime** uses an OpenAI API key stored on the environment and
  bills that key. The voice, model, speed and turn-detection options below the
  picker apply to this connection.

Either way, the agent you delegate to keeps using its own provider sign-in, so a
Claude task answers through your Claude subscription.

Voice conversations capture from the microphone chosen under **Settings** →
**Voice** → **Input** → **Microphone**, the same one dictation uses. If that
device is missing when a session starts, voice falls back to the system default.

Changing any of these applies to the next voice session.

## What voice can do

- Spoken requests run as turns in the selected task. Approval prompts and results
  appear in that task, not in the voice panel.
- Voice says it is asking, then reads the agent's answer out when it arrives.
  Asking the same thing again while the agent works does not start a second turn.
- With **OpenAI API · Realtime**, voice can also page through earlier messages,
  search the web through Parallel, and edit unsent composer text. The Codex
  account connection only routes requests to the selected agent.
