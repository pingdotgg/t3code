// Shows a notification on every connected client when a turn ends, naming the thread
// and how the turn ended, or that finishing it failed. The notification offers to open
// the thread.
const OUTCOMES = {
  completed: { verb: "finished", tone: "success" },
  failed: { verb: "failed", tone: "error" },
  interrupted: { verb: "was interrupted", tone: "warning" },
  cancelled: { verb: "was cancelled", tone: "neutral" },
};

// The step that failed after the turn itself ended. It says nothing about the outcome.
const OPERATIONS = {
  "capture-checkpoint": "Saving the checkpoint failed.",
  "refresh-workspace": "Refreshing the workspace failed.",
  "record-finalized": "Recording the result failed.",
};

/** The notification for an event, or undefined for event types this plugin does not know. */
function describe(event) {
  const thread = event.thread?.title || "A thread";
  if (event.type === "run.finalized") {
    const outcome = OUTCOMES[event.outcome] ?? { verb: "ended", tone: "neutral" };
    return { title: `${thread} ${outcome.verb}`, tone: outcome.tone };
  }
  if (event.type === "run.finalization-failed") {
    const body = OPERATIONS[event.operation];
    return {
      title: `${thread}: finishing the turn failed`,
      tone: "warning",
      ...(body === undefined ? {} : { body }),
    };
  }
  // New event types may be added; ignore them.
  return undefined;
}

export function activate(context) {
  const { onEvent, notify } = context.proposed;
  onEvent(async (event) => {
    const notification = describe(event);
    if (notification === undefined) return;
    try {
      await notify({ ...notification, threadId: event.threadId });
    } catch (error) {
      // Notifications are rate limited. Skip this one instead of throwing, which would
      // fail the page and deliver the same events again.
      context.log.warn(`Skipped a notification: ${error.message}`);
    }
  });
}
