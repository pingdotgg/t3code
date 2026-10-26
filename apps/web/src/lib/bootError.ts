import type { DesktopBridge } from "@t3tools/contracts";

const FALLBACK_TRIAGE_COMMAND = "npx t3 triage";

/** The Windows launcher is a `.cmd` run from PowerShell, which needs `&` to run a quoted path. */
function launcherCommand(launcherPath: string) {
  if (launcherPath.endsWith(".cmd")) {
    return /^[\w:\\.-]+$/.test(launcherPath)
      ? launcherPath
      : `& '${launcherPath.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
  }
  return /^[\w@%+=:,./-]+$/.test(launcherPath)
    ? launcherPath
    : `'${launcherPath.replaceAll("'", `'"'"'`)}'`;
}

/** Desktop can run its bundled launcher without Node; everything else falls back to npx. */
export async function resolveTriageCommand(bridge: DesktopBridge | undefined) {
  try {
    const state = await bridge?.cliCommand?.getState();
    // Windows reports onPath from its PATH entry alone; only an existing launcher proves it runs.
    if (state?.launcherPath) {
      return state.onPath ? "t3 triage" : `${launcherCommand(state.launcherPath)} triage`;
    }
  } catch (error) {
    console.warn("Could not read the desktop CLI state.", error);
  }
  return FALLBACK_TRIAGE_COMMAND;
}

const icon = (paths: string) =>
  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const COPY_ICON = icon(
  '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
);
const CHECK_ICON = icon('<path d="M20 6 9 17l-5-5"/>');

export function showBootError(error: unknown) {
  console.error("T3 Code failed to start.", error);
  const bootShell = document.getElementById("boot-shell");
  if (!bootShell) return;

  const content = document.createElement("div");
  content.id = "boot-error";
  content.setAttribute("role", "alert");

  const title = document.createElement("h1");
  title.textContent = "T3 Code could not load";
  content.append(title);

  if (import.meta.env.DEV && error instanceof Error) {
    const detail = document.createElement("p");
    detail.append(Object.assign(document.createElement("code"), { textContent: error.message }));
    content.append(detail);
  }

  const reload = document.createElement("button");
  reload.id = "boot-error-reload";
  reload.type = "button";
  reload.textContent = "Reload";
  reload.addEventListener("click", () => window.location.reload());

  const hint = document.createElement("p");
  hint.textContent = "If reloading does not help, run this in a terminal to find the cause:";

  const command = document.createElement("code");
  command.textContent = FALLBACK_TRIAGE_COMMAND;
  const commandRow = document.createElement("div");
  commandRow.id = "boot-error-command";
  commandRow.append(command);
  // The clipboard API exists only in secure contexts, such as HTTPS and the desktop app.
  if (window.isSecureContext) {
    const copy = document.createElement("button");
    copy.id = "boot-error-copy";
    copy.type = "button";
    copy.title = "Copy command";
    copy.setAttribute("aria-label", "Copy command");
    copy.innerHTML = COPY_ICON;
    copy.addEventListener("click", () => {
      navigator.clipboard.writeText(command.textContent ?? "").then(
        () => {
          copy.innerHTML = CHECK_ICON;
          copy.setAttribute("aria-label", "Copied");
        },
        (copyError) => console.warn("Could not copy the triage command.", copyError),
      );
    });
    commandRow.append(copy);
  }

  const triage = document.createElement("div");
  triage.id = "boot-error-triage";
  triage.append(hint, commandRow);

  content.append(reload, triage);
  bootShell.replaceChildren(content);

  void resolveTriageCommand(window.desktopBridge).then((value) => (command.textContent = value));
}
