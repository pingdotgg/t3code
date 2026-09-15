# Voice

Voice lets you talk to T3 Code instead of typing. You ask in plain language; T3 finds the work,
answers with evidence, opens the right thread in your window, starts new work with the model you
name, and reports back when longer research finishes.

> Voice is available on web and desktop. The mobile app cannot start voice sessions yet.

## What you can do

- **Find and open work by meaning.** "Show me the thread where I was planning the Macroscope and
  CodeRabbit trials." Voice searches thread titles and message content across your connected
  environments, reads the likely matches, and opens the best one in your attached T3 window. If two
  threads are equally likely, it asks one short clarifying question instead of guessing.
- **Ask about work.** "Catch me up on the Oracle project." Answers cite the project, thread, and
  dates they came from, and distinguish completed work from proposals.
- **Continue existing work.** "Ask that thread for an update." Voice resolves the existing
  thread and sends it a follow-up, preserving its conversation, model and workspace. If the
  target is unclear or missing, it asks or reports the problem instead of creating a replacement.
- **Start work.** "Start a thread in Oracle on my other machine using <model> to investigate this."
  Voice resolves the environment, project, and model from what that environment actually reports,
  creates the thread, reads back what was created, and opens it. Retrying the same request never
  creates a duplicate.
- **Delegate longer research.** "Research this question and let me know when it's done." The work
  runs in a real T3 thread. You can keep talking, interrupt, or hang up; the result is delivered
  once when it is ready, and survives the voice call ending.

## Requirements

- **A connected environment that offers voice.** The environment's server advertises voice only
  when an OpenAI API key is configured on it (see [Server setup](#server-setup)). If no connected
  environment offers voice, the voice panel does not appear at all.
- **A session with operate access.** Starting a voice session creates billed OpenAI sessions, so it
  requires a session with operate permission on the environment providing voice. A read-only
  session never sees the voice entry point.

## Using voice

The voice panel sits in the corner of the chat surface. Press **Connect** and allow microphone
access. Speak normally; the panel keeps a running transcript like a chat, oldest entry first, with
each of your utterances labeled **You** and each of the assistant's labeled **Assistant**. Words
appear in place as they are recognized, and an utterance you interrupt or add to late still lands
on its own entry. The transcript keeps the latest 200 entries and scrolls only while you are
already reading the newest one; scroll up to reread history without being pulled back down. Use
**Mute** to stop the microphone without ending the session, and **End** to close it. While T3 is
working on your behalf, the panel shows which tool is running. **Clear** empties the transcript
and status lines, and reconnecting starts a fresh transcript.

When voice opens a thread, a short chime confirms that the window reached the destination.
Successful navigation does not need a spoken title or sentence. Errors and necessary questions
are still spoken. New empty drafts use the same chime and do not start a worker.

Fast commands are enabled by default. Turn off **Try fast commands** before connecting to use
managed delegation instead.

Sessions are also saved on your device, so a finished or interrupted conversation can be
reviewed, exported, or deleted later; see [Voice history](voice-history.md).

## Starting work safely

- Name the environment, project, and model explicitly when it matters. Only models the target
  environment reports as available are offered; anything else is refused before anything is created.
- A created thread runs with T3's normal runtime default for that project, and the project's
  worktree preference is honored. Voice never grants extra permissions to the worker.
- Retrying or repeating a creation request reuses the original outcome. Changing the destination
  starts a new request instead of editing the old one.
- A spoken "done" is never treated as proof. Voice reads back the created thread's actual model and
  session status before reporting success.

## Research profiles

Longer research runs in T3 threads using a worker model. Two profiles are available: **routine**
for quick lookups and **deep** for longer investigations. Profiles are configured per client
(browser), stored under the local storage key `t3code:voice-worker-profiles:v1` as JSON:

```json
{
  "routine": { "instanceId": "<provider instance id>", "model": "<model slug>" },
  "deep": { "instanceId": "<provider instance id>", "model": "<model slug>" }
}
```

Both values must come from the target environment's own model catalog. There is no settings screen
for profiles yet; until one ships, research by profile requires this configuration, and an
unconfigured profile reports that no worker model is available rather than picking one for you.
Naming a model explicitly in your request always works without profiles.

Research results are delivered exactly once, keyed to the thread and turn that produced them. If
the voice call ends before the work finishes, the result is delivered when you reconnect. Across a
client crash the delivery is at-least-once: in rare cases a finished result can be repeated once.

## Server setup

Open **Settings → Integrations → Voice** and select the environment you want to use. With
administrator access, add an OpenAI API key with GPT Live access and save. Reload the app to
show the voice panel, then connect and allow microphone access. API usage is billed to that key.

The same section lets you replace or remove the key, choose the speech and reasoning models,
and enable fast commands on this device. Removing the key disables new voice sessions. End any
active voice call first. Model changes apply when you next connect. Keys stay on the selected
server and are never returned to the settings page.

For unattended setup, place the key in `secrets/openai-api-key.bin` under the server's T3 data
directory, next to `state.sqlite`, with permissions `600`.

- **Overrides (optional).** A `voice-broker-config.bin` file in the same directory holds JSON that
  overrides the defaults:

  ```json
  {
    "liveModel": "<speech model>",
    "backendModel": "<delegation backend model>",
    "instructions": "<speech-side instructions>",
    "delegationInstructions": "<backend instructions>"
  }
  ```

  Defaults are the `gpt-live-1` speech model and the `gpt-5.6-terra` backend. A malformed override
  file is ignored and the defaults are used.

## When access is denied or revoked

- A session with only read permission does not see the voice entry point. A direct start attempt
  through such a session is refused with an insufficient-scope error and nothing is created.
- If your session is revoked, the next voice action fails with an authentication error and the
  panel reports it. Voice does not silently retry in a loop.
- A disconnected or unknown environment produces an explicit error such as "could not search
  environment X". It is never reported as "no matches".

## Known limitations

- Web and desktop only; the mobile app has no voice UI yet.
- Session accounting (usage and close records) is kept in server memory and resets when the server
  restarts.
- Archived threads can be found by title when you ask for archived threads explicitly; their
  message content is not searchable.
- Research delivery can lag the worker finishing by a couple of seconds (the observation cadence).
- Timing and usage figures depend on live API behavior and are reported only when actually
  measured; none are promised.
