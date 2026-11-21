import type { DesktopBridge, DesktopDatabaseUpgradeProgress } from "@t3tools/contracts";

const POLL_INTERVAL_MS = 500;

function render(progress: DesktopDatabaseUpgradeProgress) {
  const container = document.createElement("div");
  container.id = "boot-upgrade";
  container.setAttribute("role", "status");

  const title = document.createElement("div");
  title.id = "boot-upgrade-title";
  const { step, total } = progress;
  title.textContent =
    step !== null && total !== null
      ? `Upgrading the database (${step} of ${total})`
      : "Upgrading the database";

  const note = document.createElement("div");
  note.id = "boot-upgrade-note";
  note.textContent = "This can take a few minutes after an update. Keep T3 Code open.";

  container.append(title);
  if (step !== null && total !== null && total > 0) {
    const bar = document.createElement("div");
    bar.id = "boot-upgrade-bar";
    bar.setAttribute("role", "progressbar");
    // oxlint-disable-next-line t3code/no-untranslated-copy -- the splash renders before the i18n runtime loads
    bar.setAttribute("aria-label", "Database upgrade");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", String(total));
    // The server reports the migration it is starting, so the ones before it are done.
    bar.setAttribute("aria-valuenow", String(step - 1));
    const fill = document.createElement("div");
    fill.id = "boot-upgrade-fill";
    fill.style.width = `${Math.min(100, Math.max(0, ((step - 1) / total) * 100))}%`;
    bar.append(fill);
    container.append(bar);
  }
  container.append(note);
  return container;
}

/** Shows the local server's database upgrade under the splash logo until the app replaces it. */
export function watchDatabaseUpgrade(bridge: DesktopBridge | undefined = window.desktopBridge) {
  const read = bridge?.getDatabaseUpgradeProgress;
  if (!read) return;
  const bootShell = document.getElementById("boot-shell");
  if (!bootShell) return;

  let shown = "";
  const poll = async () => {
    // React's first render detaches the splash, and a boot error replaces its contents.
    if (!bootShell.isConnected || document.getElementById("boot-error")) return;
    const progress = await read().catch(() => null);
    if (!bootShell.isConnected || document.getElementById("boot-error")) return;
    const key = progress === null ? "" : `${progress.step}/${progress.total}`;
    if (key !== shown) {
      shown = key;
      document.getElementById("boot-upgrade")?.remove();
      if (progress !== null) bootShell.append(render(progress));
    }
    setTimeout(poll, POLL_INTERVAL_MS);
  };
  void poll();
}
