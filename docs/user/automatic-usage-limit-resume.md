# Automatic continuation after usage limits

When a Codex or Claude subscription limit stops a turn, T3 Code keeps the thread ready and
continues it after the provider's usage window resets. This is enabled by default.

The thread shows when it will continue. If the provider gives an exact reset time, T3 Code waits
for that time and a short grace period. If no reset time is available, it shows an estimated retry
time. Another limit response schedules the next attempt instead of abandoning the task.

Messages sent during the wait stay queued on the thread. When the limit resets, T3 Code sends them
to the agent in order, including image attachments, as part of one resumed turn.

Choose **Cancel** in the thread notice when you want to leave the task stopped. Switching to another
agent cancels the wait and starts the new turn immediately.

The schedule is stored with the thread, so restarting the T3 Code server does not lose it. To turn
the behavior off for the environment, disable **Automatically continue after usage limits reset**
under **Settings → General**. Disabling it also cancels waits that are already scheduled.

Automatic continuation applies only to recognized Codex and Claude subscription limits. Workspace
credit limits, spend controls, and ordinary provider errors are left stopped for you to handle.
