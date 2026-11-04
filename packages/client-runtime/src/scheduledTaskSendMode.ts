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
      "Steers the current turn. Without a turn that can take new input, nothing is sent and the run fails.",
  },
  restart: {
    label: "Restart",
    description:
      "Stops the current turn and starts over with this prompt. Without a turn that can take new input, nothing is sent and the run fails.",
  },
};
