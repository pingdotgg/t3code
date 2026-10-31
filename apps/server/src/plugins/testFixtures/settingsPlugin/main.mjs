// Reads its settings and uses its storage on request so PluginSettings.test.ts and the live
// proof can check what the plugin sees. It never writes into its own directory.
let modeAtActivation;
let api;

export async function activate(context) {
  const { handle, settings, storage } = context.proposed;
  api = { log: context.log, settings };
  // Host calls work before the plugin reports ready.
  modeAtActivation = await settings.get("mode");
  handle("activationMode", () => modeAtActivation ?? null);
  handle("read", async ({ key }) => {
    const value = await settings.get(key);
    return value === undefined ? { unset: true } : { value };
  });
  handle("store", async ({ key, value }) => {
    await storage.set(key, value);
    return null;
  });
  handle("load", async ({ key }) => {
    const value = await storage.get(key);
    return value === undefined ? { missing: true } : { value };
  });
  handle("drop", async ({ key }) => {
    await storage.delete(key);
    return null;
  });
  handle("keys", () => storage.keys());
  // Reports how each call settled, so a refusal is visible to the caller.
  handle("attempt", async ({ method, key, value }) => {
    try {
      const result = method === "set" ? await storage.set(key, value) : await settings.get(key);
      return { ok: true, result: result ?? null };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });
  handle("exit", () => process.exit(1));
  // Logs each refusal, so a test can hold the accepted calls until one is refused.
  handle("burst", async ({ count }) => {
    const calls = Array.from({ length: count }, (_, index) => storage.get(`burst-${index}`));
    for (const call of calls) call.catch(() => context.log.info("host-call-refused"));
    const results = await Promise.allSettled(calls);
    return results.map((result) => (result.status === "fulfilled" ? "ok" : result.reason.message));
  });
}

// Reports whether the server still answers a revoked plugin.
export async function deactivate() {
  try {
    await api.settings.get("mode");
    api.log.info("deactivate: answered");
  } catch (error) {
    api.log.info(`deactivate: ${error.message}`);
  }
}
