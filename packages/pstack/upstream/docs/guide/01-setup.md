# Set up pstack

[Guide](./README.md) · Next: [Poteto mode](./02-poteto-mode.md)

## Enable the pack

T3 Code owns the pstack runtime pack and exposes `$pstack:` composer chips when pstack is enabled. Select `$pstack:poteto-mode` for a task. This native port is intended to replace the upstream pack at the server's vendoring boundary; it is not a marketplace plugin to install separately in each harness. See the repository README for integration status.

## Choose your models

Run `$pstack:setup-pstack`. It reads the available providers and asks for a reasoning budget: unlimited, large, medium, or small. Confirm the 17 role choices, including each panel's seats. A new configuration starts with the pack’s default role seeds, and setup checks the advertised options and project evidence when assigning seats. On a repeat run, setup keeps working seats and shows its proposed additions and replacements. The models file belongs to this environment and applies on the next invocation. Another environment needs its own choices.

During a run, T3 supplies the absolute pack and models paths and exact resolved role targets in `<t3_pstack>`. Skills use those targets. An inherited seat runs on the parent model. Missing required roles stop the affected spawn.

## Run your first task

Attach `$pstack:poteto-mode` and describe the outcome, for example `fix the stale project title after reconnect`. The parent selects a playbook, tracks its steps, delegates bounded work, and verifies the result. Attach the skill to each new task. There is no sticky mode to enable.

Use `$pstack:poteto-help` for routing. Read [understand](./03-understand.md), [design](./04-design.md), or [verify and ship](./06-verify-and-ship.md) for focused workflows. Long runs need a checkable finish condition; [overnight](./07-overnight.md) covers event wakes and scheduled checks.
