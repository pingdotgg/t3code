# Tips

On web and desktop, a new thread shows up to three tips under the composer. New tips
arrive slowly: two on the first day, then at most one on each day you start a new
thread. When T3 Code sees you use a feature, its tip stops showing.

**Settings → Tips** lists every tip with its status. T3 Code checks **Tried it** when
it sees you use a feature, and you can change it yourself. You can also bring back a
hidden tip there, or turn off **Tips on new threads**.

Each browser and the desktop app keep their own tip progress. When telemetry is on, it reports
which tips you saw, opened, hid, brought back, or tried. See [Telemetry](./telemetry.md).

## Boring sidebar

Prefer threads grouped by project? Turn on **Settings → Labs → Boring sidebar**.
You can switch back to the inbox sidebar at any time. [Thread sidebar](./thread-sidebar.md)

## Dictate with a local model

Dictate into the composer. Voice input can transcribe on a computer you choose,
instead of a cloud service. Open **Settings → Voice** to choose where it runs. [Voice input](./voice-input.md)

## Claude can start Codex threads

When Claude and Codex are both set up, ask a Claude thread to hand work to Codex. For
example:

> Start a Codex subagent to review this project for bugs and missing tests. Tell me what it finds.

The Codex thread reports back to the Claude thread when it is done.

## Use T3 Code from your phone

Get the [iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824)
or [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code) app
and connect it to the computer that runs your threads, with T3 Connect or a pairing
link. [Mobile app](./install.md#mobile-app)

## Threads can start other threads

Ask an agent to split work into new threads. For example:

> Start two new threads in this project: one to find slow tests and one to find
> unused exports. Send me links to both.

With [linked environments](./remote-access.md#link-another-environment), an agent
can start threads on your other computers too.

## Side chats with /btw

After your first message in a thread, send one that starts with `/btw` to ask a side
question. The answer opens in a side chat, and the thread keeps working. [Side chats](./thread-sidebar.md#side-chats)

## Control your other computers

Install T3 Code on the other computer, or run `npx t3@latest up` there. Then connect with
T3 Connect or Tailscale. [Remote access](./remote-access.md)

## Use T3 Code from other apps

Apps that support MCP, such as Poke, Grok Bot, and ChatGPT, can start threads and check on
them for you. [Outside agents](./outside-agents.md)

## Simulators and emulators

Agents can run your mobile app on an iOS Simulator or Android Emulator, even on a
remote Mac. [Devices](./devices.md#ssh-device-hosts)
