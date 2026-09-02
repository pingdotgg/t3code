# Tool activity

Open a tool-group summary in the conversation to see its individual calls. Each row has an icon;
select a row to inspect its details. Select the group summary again to collapse it.

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
