# Codex Micro

The Work Louder Codex Micro is a desk controller with six agent keys, seven command keys, a knob,
and an analog stick. In the desktop app, the agent keys follow your threads and light up with
their state, and the other controls run T3 Code commands.

Connect it over USB-C or Bluetooth. **Settings** > **Codex Micro** appears while it is connected.

## Agent keys

Each agent key holds a thread from this machine and shows its state: blue while it works, orange
when it needs an approval or an answer, green when it finished and you haven't opened it, red when
it failed. The key of the thread you have open is highlighted. Tap a key to open its thread; tap it
twice to also bring T3 Code forward, or turn on **Focus T3 Code with a single tap**. A thread keeps
its key while it stays among the six shown, so lights don't move around as other threads change.

Under **Agent keys**, choose which threads the keys follow: waiting, unread, and active threads
first (the default), your pinned threads, or the most recently updated ones. You can also pin a
specific thread to a key.

## Command keys, knob, and stick

By default the command keys approve, decline, and stop, start a new thread, and toggle the terminal,
the diff, and the command palette. **Approve** and **Decline** answer the open thread's pending
request, or the first waiting one on the agent keys. **Stop** acts on the open thread, or on the only
one running. When an action has nothing to act on, T3 Code tells you instead of guessing.

Turn the knob to move between the agent keys' threads and click it to bring T3 Code forward, or
switch the knob to move through all threads. Hold the knob to open these settings. The stick moves
between threads and through navigation history.

Any of these can run another command. A command uses its current keybinding, so it follows your
**Keybindings** settings.

## If the device isn't detected

- **macOS:** T3 Code needs Input Monitoring. Allow T3 Code in **System Settings** > **Privacy &
  Security** > **Input Monitoring** and reconnect the device.
- **Linux:** your user needs access to the device's hidraw node, usually through a udev rule for
  vendor `303a`, product `8360`.
