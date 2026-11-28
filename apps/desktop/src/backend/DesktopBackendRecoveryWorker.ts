import { make } from "./DesktopBackendRecovery.ts";
import type { RecoveryWorkerMessage } from "./DesktopBackendRecoveryProcess.ts";

process.once("disconnect", () => process.exit(0));

const pending: Array<Promise<void>> = [];
const send = (message: RecoveryWorkerMessage) => {
  const sent = new Promise<void>((resolve) => {
    if (process.send === undefined) resolve();
    else process.send(message, () => resolve());
  });
  pending.push(sent);
  return sent;
};

async function run() {
  const [operation, appDataDirectory, stateDir, launcherPid, backendPid] = process.argv.slice(2);
  if (appDataDirectory === undefined || stateDir === undefined) return;
  const recovery = make({
    appDataDirectory,
    stateDir,
    launcherPid: Number(launcherPid),
    onRecovery: (pid) => void send({ type: "recovering", pid }),
    onError: (failed) => void send({ type: "error", operation: failed }),
  });
  if (operation === "track") {
    const record = await recovery.track(Number(backendPid));
    if (record !== undefined) await send({ type: "tracked", record });
  } else if (operation === "recover") {
    await recovery.recover();
  }
}

void run()
  .then(() => Promise.all(pending))
  .finally(() => process.disconnect?.());
