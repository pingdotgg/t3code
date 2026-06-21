---
name: t3code-approval-operator
description: Finds and responds to pending T3 Code provider approvals and user-input requests through the t3 CLI. Use when a thread is blocked waiting for approval/input, the user asks to approve/deny tool use, answer provider prompts, unblock a turn, or inspect pending requests.
---

# T3 Code Approval Operator

Use `t3 approval` and `t3 input` to unblock turns waiting for human decisions.

## Quick start

```sh
t3 approval list
t3 approval list --thread <thread>
t3 approval respond <thread> <request-id> --approve
t3 approval respond <thread> <request-id> --deny
t3 input list
t3 input respond <thread> <request-id> --answers '{"key":"value"}'
```

## Approval workflow

1. Locate pending approvals with `t3 approval list` or `t3 approval list --thread <thread>`.
2. Read the request payload and summary.
3. Decide only within the user’s stated policy.
4. Respond:

```sh
t3 approval respond <thread> <request-id> --decision accept
t3 approval respond <thread> <request-id> --decision acceptForSession
t3 approval respond <thread> <request-id> --decision decline
t3 approval respond <thread> <request-id> --decision cancel
```

Use `--approve` as shorthand for `accept` and `--deny` as shorthand for `decline`.

## User-input workflow

1. Locate pending prompts with `t3 input list` or `t3 input list --thread <thread>`.
2. Read the request schema/payload from the list output.
3. Provide a JSON object:

```sh
t3 input respond <thread> <request-id> --answers '{"answer":"..."}'
t3 input respond <thread> <request-id> --answers '{}' --answers-file answers.json
```

Prefer `--answers-file` for large or structured answers.

## Safety

- Never approve destructive, credential, network, publish, or privilege-escalating actions unless the user clearly authorized them.
- Prefer `decline` over `acceptForSession` when uncertain.
- Do not fabricate user-input answers; ask the user when the required answer is not known.
- After responding, inspect or stream the thread if the user asked you to confirm it is unblocked.
