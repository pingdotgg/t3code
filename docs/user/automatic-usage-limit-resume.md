# Automatic continuation after usage limits

When a Codex or Claude subscription limit stops a turn, T3 Code keeps the thread ready and
continues it after the provider's usage window resets. This is enabled by default.

The thread shows when it will continue. If the provider gives an exact reset time, T3 Code waits
for that time and a short grace period. If no reset time is available, it shows an estimated retry
time. Another limit response schedules the next attempt instead of abandoning the task.

Choose **Cancel** in the thread notice when you want to continue manually, switch to another agent,
or leave the task stopped. Sending a new message or changing the thread's agent also cancels the
scheduled continuation.

The schedule is stored with the thread, so restarting the T3 Code server does not lose it. To turn
the behavior off for the environment, disable **Automatically continue after usage limits reset**
under **Settings → General**. Disabling it also cancels waits that are already scheduled.

Automatic continuation applies only to recognized Codex and Claude subscription limits. Workspace
credit limits, spend controls, and ordinary provider errors are left stopped for you to handle.
