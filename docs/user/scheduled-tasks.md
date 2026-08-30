# Scheduled tasks

Scheduled tasks send a saved prompt on a recurring interval or at selected local times. A task can
post back into an existing thread or create a new thread for each run.

An agent with access to T3 Code orchestration can run an existing task immediately. This manual run
does not enable, disable, or otherwise edit the schedule. It does count as a run and recalculates the
next occurrence from the task's current schedule.

An accepted manual-run result means T3 Code durably queued or started the prompt. The agent turn may
still be running. Retrying with the same request key returns the original target run instead of
starting a duplicate.
