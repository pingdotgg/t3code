import { ScheduledTaskSendMode } from "@t3tools/contracts";

export const SCHEDULED_TASK_SEND_MODES = ScheduledTaskSendMode.literals;

export const SCHEDULED_TASK_SEND_MODE_COPY: Record<
  ScheduledTaskSendMode,
  { readonly label: string; readonly description: string }
> = {
  queue: {
    label: "Queue",
    description: "Waits for the current turn to finish, then starts a new turn.",
  },
  auto: {
    label: "Steer or start",
    description:
      "Steers the current turn when it can take new input. Otherwise works like Queue, which starts a new turn when the thread is idle.",
  },
  steer: {
    label: "Steer only",
    description:
      "Steers the current turn, like steering from the composer. With no turn to steer, nothing is sent and the run fails. The first run starts the thread.",
  },
  restart: {
    label: "Restart",
    description:
      "Stops the current turn and starts over with this prompt, like restarting from the composer. With no turn to restart, nothing is sent and the run fails. The first run starts the thread.",
  },
};
