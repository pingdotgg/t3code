# Stop pauses the Goal

Stop already ends the current Turn. With auto-continue, leaving the Goal active would start another Turn as soon as the Session is ready.

We decided Stop pauses the Goal. Resume is explicit. Stop is not Clear: the objective stays on the Thread until the user resumes, replaces, or clears it.

This is distinct from Snooze (inbox overlay) and Settle (lifecycle overlay). Those do not mean Pause unless we later decide they should.
