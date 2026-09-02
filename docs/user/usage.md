# Review usage

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.

## Resume after a subscription limit

Automatic resume is on by default. After a provider usage limit, spend cap, capacity error, or
recognized temporary outage, T3 Code schedules a continuation in the same thread. A reported reset
time takes priority, including messages such as "try again at 7:41 PM". T3 Code waits one minute
past a parsed reset time, plus a small scheduling cushion. Without a reset time, it waits 20 minutes
three times, one hour five times, then six hours between later attempts. Each attempt sends a real
continuation prompt, not a status-only probe.

The automatic resume is stored on the T3 Code server, so it continues across page reloads and is
available in the desktop client. The computer hosting that server must be awake and T3 Code must be
running for the resume to happen on time. If the server was offline, it restores the schedule when
it starts again. Turn off **Resume when available** in **Settings → Integrations → Automatic
resume** to cancel pending retries and disable automatic scheduling for that environment. Sending
a new message manually also cancels the pending automatic resume.

A waiting notice shows the next attempt at the bottom of the conversation, including on existing
mobile clients. It updates as the schedule changes and disappears when waiting ends. It is not a
response from the model, and waiting does not mean the task is complete.
