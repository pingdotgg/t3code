# Devin

Install and authenticate the Devin CLI (`devin auth login`) on the machine
running your environment, then enable it in **Settings > Providers**. See
[provider setup](./install.md#providers). T3 Code talks to `devin acp`, so any
account-signed Devin CLI works — including SWE models such as `swe-2-high`.

## Models

The model list comes from `devin models list` for the signed-in account.
**Adaptive** is the default and routes between models automatically. After
changing login or team model access, use **Refresh provider status** in
**Settings > Providers**.

## Approvals

Devin follows the shared [permission modes](./permission-modes.md), mapped onto
Devin's session modes. **Supervised** runs Devin's default permission policy
and prompts for risky actions; **Auto-accept edits** maps to Code, **Auto** to
Smart, and **Full access** to Bypass Permissions. Plan turns run in Plan mode
and the previous mode is restored afterwards.
