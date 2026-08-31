# Droid

Droid is Factory's coding agent. T3 Code connects to the Factory Droid CLI on the machine running
the server, so you can use your own Factory subscription while working from the web, desktop, or
mobile app.

Droid support is in Early Access. Enable it from the Droid provider card in Settings after
installing and authenticating the CLI.

## Install And Log In

Install Factory Droid.

macOS and Linux:

```bash
curl -fsSL https://app.factory.ai/cli -o install-droid.sh
# Review the downloaded script, then run it:
sh install-droid.sh
rm install-droid.sh
```

Windows:

```powershell
curl.exe -fsSL https://app.factory.ai/cli/windows -o install-droid.ps1
# Review the downloaded script, then run it:
powershell -ExecutionPolicy Bypass -File .\install-droid.ps1
Remove-Item .\install-droid.ps1
```

Installations from these commands support automatic updates. Run `droid update` to check and update
manually.

Then start Droid in a terminal:

```bash
droid
```

Follow the browser sign-in flow. Run this on the machine that runs the T3 Code server. Droid stores
the resulting Factory account credentials in that user's Factory home.

The Droid card can detect that a credential source is present, but that detection is not a live
Factory identity check. Until Droid exposes an identity probe for this flow, T3 Code reports the
credential state as unverified rather than claiming that the account or key is authenticated. If a
request fails, run `droid` in a terminal to refresh the login and try again.

For automation, set `FACTORY_API_KEY` in the Droid provider's Environment variables section in
Settings. Mark it as sensitive so T3 Code stores it as a server secret and does not send it back to
the app after saving. When both are present, the API key takes precedence over the stored Factory
account login.

## Models And Reasoning

T3 Code fetches the available models from Droid dynamically. Each model advertises the reasoning
efforts it supports, and those choices appear with the model in the picker. The list can change as
Factory adds or updates models without requiring a T3 Code update.

You can change the model or reasoning effort in an existing thread. T3 Code applies the new choice
before it sends the next message to Droid.

For private metadata generation that requires a schema, T3 Code requests Droid's native structured
output and validates the returned object. It does not scrape JSON out of assistant text.

## Slash Commands And Skills

T3 Code reads your Droid slash commands and skills when it checks the provider, so they appear in the
composer alongside every other provider's. Custom commands keep their argument hints, and skills keep
their descriptions and provider-owned source. Skills Droid does not let you invoke directly stay out
of the list.

Commands and skills resolve on the machine running the server against the server's working
directory, so project-local entries are discovered alongside personal ones. Add a command or skill,
refresh the Droid card in Settings, and it shows up.

## Permission Modes

T3 Code maps its permission modes onto Droid's command confirmation levels:

| T3 Code mode                   | Droid behavior                                    |
| ------------------------------ | ------------------------------------------------- |
| Supervised (approval required) | Confirms every command and file change            |
| Auto-accept edits              | Automatically allows edits and read-only commands |
| Auto                           | Also allows reversible commands without prompting |
| Full access                    | Allows all commands without prompting             |

Approvals appear inline in the conversation. Rejecting one cancels the current turn; send another
message to tell Droid how to proceed.

## Plan Mode

When T3 Code's plan mode is enabled, it uses Droid's Spec Mode. Droid researches and writes a plan
before implementation, then presents the plan approval as an approval request in the conversation.
Approve it to begin implementation. Rejecting it cancels the turn; send another message in plan mode
to refine the plan. On approval, Droid may continue in the current Factory session or hand the work
to a successor session. T3 Code keeps both paths on the same thread, and the turn continues streaming
through the handoff.

## Context And Subagents

Droid compacts long conversations automatically, so the context meter shows the live context after
compaction rather than lifetime usage. When Droid delegates work to a subagent, it appears as a task
in the conversation with its own completion state.

If you send another message while Droid is working, T3 Code treats it as steering for the active
turn. Droid may fold it into the current run or process it immediately afterward.

## Session Resume

Droid sessions resume across T3 Code server restarts. Reopen the same thread and continue where you
left off instead of starting a new Droid conversation.

After reopening a resumed thread, you can still request checkpoint rollback. T3 Code starts the
Droid session as needed, rewinds it, and continues future messages from the rewound conversation.

## Early Access

Droid support is still evolving. Model metadata, reasoning choices, approval behavior, and session
resume may change as the Factory CLI develops. If a session behaves unexpectedly, update Factory
Droid, refresh its status in Settings, and start a new thread if the existing session cannot resume.
