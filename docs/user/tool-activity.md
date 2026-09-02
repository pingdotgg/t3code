# Tool activity

Open a tool-group summary in the conversation to see its individual calls.
The summary line names what happened ("Ran 8 commands and changed 3 files") and, on the right, how
many calls failed and how long the group took when the provider reports timings.
Select the group summary again to collapse it.

Inside a group, each call is one row.
Commands show the directory they ran in as a small chip instead of a `cd` prefix, the command itself,
and on the right the duration, a non-zero exit code, or the +/- line counts for file changes.
A failed command shows the first line of its output under the command without expanding.
The agent's progress notes read as quiet section labels above the calls they describe.
Select a row to see the full output excerpt or the diff for changed files.

Long groups scroll inside a bounded area without expanding the whole conversation. Faded edges
indicate more calls above or below. Short groups use only the space they need.
Collapsing and reopening a group preserves your reading position and any open call details.

Recognized T3 tools use descriptive labels in both the running summary and individual rows.
Labels follow the call's state, such as "Clicking" while running and "Clicked" after success.
Failed, declined, and stopped calls say what happened without implying success.
Preview browser actions use a globe icon. Other T3 tools keep the T3 mark.
Group summaries count browser actions separately, such as "Used browser 18 times" or
"Ran 4 commands and used browser 15 times". Browser-only groups also use a globe icon.

Command summaries show the program inside a shell wrapper, such as "Running vp" for
`/bin/zsh -lc 'vp test run'`. Expanded rows keep the full command.
