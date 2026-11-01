// Sends notifications on request, so PluginNotifications.test.ts can check that they reach
// subscribers and are withdrawn when the process stops.
export function activate(context) {
  const { handle, notify } = context.proposed;
  handle("notify", async (input) => {
    await notify(input);
    return null;
  });
  handle("crash", () => process.exit(1));
}
