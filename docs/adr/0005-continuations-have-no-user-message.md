# Continuations have no user message

A Turn in T3 normally starts from a user message. Auto-continue has no user. Inserting a synthetic “Continue the Goal” row would make every client, including remote ones, show a speaker who did not speak, and those rows cannot be unsent.

We decided a Continuation is a Turn with no `thread.message-sent`. An Activity may record that the Goal continued. The assistant output is what the user sees.

This does not yet decide how the original `/goal` objective is shown on the first Turn.
