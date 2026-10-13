// Registers a handler and an event handler, watches its activation signal, then fails to activate.
let log;

export function activate(context) {
  log = context.log;
  context.proposed.handle("leftover", () => "served after a failed activation");
  context.proposed.onEvent(() => log.info("event-delivered"));
  context.signal.addEventListener("abort", () => log.info("activation-aborted"));
  throw new Error("activation refused");
}

export function deactivate() {
  log.info("deactivate-called");
}
