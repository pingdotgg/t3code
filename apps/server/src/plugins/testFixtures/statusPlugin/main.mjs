// Sets statuses on request, so PluginStatus.test.ts can check that they reach clients and are
// taken back when the process stops.
export function activate(context) {
  const { handle, status } = context.proposed;
  handle("status", async (input) => {
    await status.set(input);
    return null;
  });
  handle("crash", () => process.exit(1));
}
