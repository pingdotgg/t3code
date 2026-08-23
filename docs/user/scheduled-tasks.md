# Schedule agent runs

Scheduled tasks let T3 Code start an agent turn for you at a set time — a nightly
"run the test suite and report failures", a follow-up tomorrow morning, or a recurring
chore on a fixed interval. Runs happen on the machine running your T3 server, even when
no app window is open.

## Create a task

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Scroll to **Scheduled tasks**.
4. Pick the thread the run should append to.
5. Pick a schedule: once in 1 hour, once tomorrow at 9:00, every day at 9:00, or every
   Monday at 9:00.
6. Type the prompt and select **Schedule**.

Each run sends your prompt to the thread as if you had typed it at that moment. The run
uses the thread's model selection and permission mode.

## Cancel a task

Open **Settings → Projects → Scheduled tasks** and select **Cancel** next to the task.
Cancelled tasks stay visible until the panel is refreshed elsewhere.

## Good to know

- Tasks are stored with your server's data and survive restarts. If the server is down
  when a fire time passes, the run happens once when the server starts again — missed
  intervals never stack up.
- Recurring tasks keep their schedule even if a run starts late; each next run is spaced
  from the previous scheduled time, not from when the last one actually ran.
- A task can be cancelled from any connected client.
