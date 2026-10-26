import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";

const FALLBACK_TRIAGE_COMMAND = "npx t3 triage";
const DOWNLOAD_URL = "https://t3.codes/download";
const ISSUE_URL = "https://github.com/pingdotgg/t3code/issues/new";
const LAST_FAILURE_KEY = "t3code:boot-failed-at";
const REPEAT_FAILURE_MS = 5 * 60_000;
const MAX_CAUSES = 3;
const MAX_ERROR_CHARS = 6_000;
const COPY_BLOCKED = "Copy was blocked. The text is selected so you can copy it manually.";
const UPDATE_DOWNLOAD_FAILED = "The update download failed. Try Download update again.";
const UPDATE_INSTALL_FAILED = "The update install failed. Try Restart to update again.";

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

/** The update button only appears when the desktop updater has a newer build to offer. */
export function updateActionFor(state: DesktopUpdateState | null | undefined) {
  switch (state?.status) {
    case "available":
      return { kind: "download" } as const;
    case "downloading":
      return { kind: "downloading", percent: Math.round(state.downloadPercent ?? 0) } as const;
    case "downloaded":
      return { kind: "install" } as const;
    default:
      return null;
  }
}

function safeString(value: unknown) {
  try {
    return String(value);
  } catch {
    return "";
  }
}

function describeOne(value: unknown) {
  if (value instanceof Error) {
    const header = value.message ? `${value.name}: ${value.message}` : value.name;
    // V8 stacks start with the header; Safari and Firefox stacks do not.
    const stack = typeof value.stack === "string" ? value.stack : "";
    return stack === header || stack.startsWith(`${header}\n`)
      ? stack
      : [header, stack].filter(Boolean).join("\n");
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? safeString(value);
  } catch {
    return safeString(value);
  }
}

/** Hosts can name private machines, and pairing tokens live in query strings and hashes. */
function redact(text: string) {
  return text
    .replace(/\b[a-z][\w+.-]*:\/\/[^\s/?#'"()]+/gi, "")
    .replace(/[?#][^\s'"()]*=[^\s'"()]*?((?::\d+){1,2})?(?=[\s'"()]|$)/g, "$1");
}

export interface BootErrorEnvironment {
  readonly version: string;
  readonly channel: string;
  readonly surface: "desktop" | "web";
  readonly platform: string;
  readonly userAgent: string;
  readonly time: string;
}

/** Plain text that is shown and copied as-is, so users see exactly what they share. */
export function buildErrorReport(error: unknown, environment: BootErrorEnvironment) {
  const parts: Array<string> = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current != null && !seen.has(current) && parts.length <= MAX_CAUSES) {
    seen.add(current);
    const text = describeOne(current);
    parts.push(parts.length === 0 ? text : `Caused by: ${text}`);
    current = current instanceof Error ? current.cause : undefined;
  }
  let details = redact(parts.join("\n") || "(no error message)");
  if (details.length > MAX_ERROR_CHARS) {
    details = `${details.slice(0, MAX_ERROR_CHARS)}\n[truncated]`;
  }
  return [
    details,
    "",
    `Version: ${environment.version}`,
    `Channel: ${environment.channel}`,
    `Surface: ${environment.surface}`,
    `Platform: ${environment.platform}`,
    `User agent: ${environment.userAgent}`,
    `Time: ${environment.time}`,
  ].join("\n");
}

function clientPlatform(bridge: DesktopBridge | undefined) {
  try {
    return bridge?.getClientPlatform?.() ?? navigator.platform;
  } catch {
    return navigator.platform;
  }
}

function readEnvironment(bridge: DesktopBridge | undefined): BootErrorEnvironment {
  const version = import.meta.env.APP_VERSION;
  return {
    version,
    channel:
      import.meta.env.VITE_RELEASE_CHANNEL || /-(nightly|preview)\./.exec(version)?.[1] || "stable",
    surface: bridge ? "desktop" : "web",
    platform: clientPlatform(bridge),
    userAgent: navigator.userAgent,
    time: new Date().toISOString(),
  };
}

/** Opens More options by default when startup already failed in this tab a moment ago. */
function isRepeatFailure(now: number) {
  try {
    const previous = Number(sessionStorage.getItem(LAST_FAILURE_KEY));
    sessionStorage.setItem(LAST_FAILURE_KEY, String(now));
    return now - previous < REPEAT_FAILURE_MS;
  } catch {
    return false;
  }
}

const icon = (paths: string) =>
  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const COPY_ICON = icon(
  '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
);
const CHECK_ICON = icon('<path d="M20 6 9 17l-5-5"/>');

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: ReadonlyArray<Node | string> = [],
) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function selectContents(target: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(target);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function copySelection() {
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  }
}

/** Plain http has no Clipboard API, but the legacy copy command still works on a selection. */
function copyText(target: HTMLElement, onCopied: () => void, onBlocked: (hint: string) => void) {
  const fallback = () => {
    selectContents(target);
    if (copySelection()) return onCopied();
    onBlocked(
      /Mac|iPhone|iPad/.test(navigator.platform) ? "Press ⌘C to copy" : "Press Ctrl+C to copy",
    );
  };
  const clipboard = window.isSecureContext ? navigator.clipboard : undefined;
  if (typeof clipboard?.writeText !== "function") return fallback();
  clipboard.writeText(target.textContent ?? "").then(onCopied, fallback);
}

function mountUpdateButton(
  bridge: DesktopBridge,
  button: HTMLButtonElement,
  note: HTMLParagraphElement,
  announce: (text: string) => void,
) {
  let action: ReturnType<typeof updateActionFor> = null;
  const render = (state: DesktopUpdateState) => {
    action = updateActionFor(state);
    button.hidden = action === null;
    // aria-disabled keeps keyboard focus on the button while the download runs.
    button.setAttribute("aria-disabled", String(action?.kind === "downloading"));
    if (action?.kind === "download") button.textContent = "Download update";
    if (action?.kind === "downloading")
      button.textContent = `Downloading update (${action.percent}%)`;
    if (action?.kind === "install") button.textContent = "Restart to update";
    const failure = !action
      ? ""
      : state.errorContext === "download"
        ? UPDATE_DOWNLOAD_FAILED
        : state.errorContext === "install"
          ? UPDATE_INSTALL_FAILED
          : "";
    if (failure === note.textContent) return;
    note.textContent = failure;
    note.hidden = !failure;
    if (failure) announce(failure);
  };
  button.addEventListener("click", () => {
    const run =
      action?.kind === "install"
        ? bridge.installUpdate()
        : action?.kind === "download"
          ? bridge.downloadUpdate()
          : undefined;
    run?.then(
      (result) => render(result.state),
      (error: unknown) => console.warn("Could not update T3 Code.", error),
    );
  });
  // A pushed state is newer than the initial read, so the read must not overwrite it.
  let pushed = false;
  try {
    bridge.onUpdateState((state) => {
      pushed = true;
      render(state);
    });
    bridge.getUpdateState().then(
      (state) => pushed || render(state),
      (error: unknown) => console.warn("Could not read the desktop update state.", error),
    );
  } catch (error) {
    console.warn("Could not read the desktop update state.", error);
  }
}

export function showBootError(error: unknown) {
  console.error("T3 Code failed to start.", error);
  const bootShell = document.getElementById("boot-shell");
  if (!bootShell) return;

  const bridge = window.desktopBridge;
  const environment = readEnvironment(bridge);
  const offline = !bridge && navigator.onLine === false;

  const status = element("span", { className: "boot-error-sr" });
  status.setAttribute("aria-live", "polite");
  // Clearing first makes screen readers announce a repeated message.
  let announcement: ReturnType<typeof setTimeout> | undefined;
  const announce = (text: string) => {
    clearTimeout(announcement);
    status.textContent = "";
    announcement = setTimeout(() => (status.textContent = text), 100);
  };

  const message = element("div", {}, [
    element("h1", { textContent: "T3 Code failed to start" }),
    element("p", {
      textContent: offline
        ? "This browser appears to be offline. Check the connection, then reload."
        : "We are not sure why. Try a reload first.",
    }),
  ]);
  message.setAttribute("role", "alert");

  const reload = element("button", {
    id: "boot-error-reload",
    type: "button",
    textContent: "Reload",
  });
  reload.addEventListener("click", () => window.location.reload());
  const update = element("button", { id: "boot-error-update", type: "button", hidden: true });
  const updateNote = element("p", { id: "boot-error-update-note", hidden: true });
  if (bridge) mountUpdateButton(bridge, update, updateNote, announce);

  const command = element("code", { textContent: FALLBACK_TRIAGE_COMMAND });
  const copyCommand = element("button", {
    className: "boot-error-icon",
    type: "button",
    title: "Copy command",
    innerHTML: COPY_ICON,
  });
  copyCommand.setAttribute("aria-label", "Copy command");
  copyCommand.addEventListener("click", () =>
    copyText(
      command,
      () => {
        copyCommand.innerHTML = CHECK_ICON;
        copyCommand.title = "Copied";
        copyCommand.setAttribute("aria-label", "Copied");
        announce("Copied to clipboard.");
      },
      (hint) => {
        copyCommand.textContent = hint;
        copyCommand.title = hint;
        copyCommand.setAttribute("aria-label", hint);
        announce(COPY_BLOCKED);
      },
    ),
  );
  void resolveTriageCommand(bridge).then((value) => (command.textContent = value));

  let report = "(no error message)";
  try {
    report = buildErrorReport(error, environment);
  } catch (reportError) {
    console.warn("Could not describe the startup error.", reportError);
  }
  const details = element("pre", { id: "boot-error-details", tabIndex: 0, textContent: report });
  const copyDetails = element("button", { type: "button", textContent: "Copy error details" });
  copyDetails.addEventListener("click", () =>
    copyText(
      details,
      () => {
        copyDetails.textContent = "Copied";
        announce("Copied to clipboard.");
      },
      (hint) => {
        copyDetails.textContent = hint;
        announce(COPY_BLOCKED);
      },
    ),
  );

  const issue = new URL(ISSUE_URL);
  issue.searchParams.set("template", "bug_report.yml");
  issue.searchParams.set("title", "T3 Code failed to start");
  issue.searchParams.set("area", "apps/web");
  issue.searchParams.set("version", `${environment.version} (${environment.channel})`);
  issue.searchParams.set("environment", `${environment.surface}, ${environment.platform}`);
  const link = (href: string, textContent: string) =>
    element("a", { href, textContent, target: "_blank", rel: "noreferrer" });
  const nightly = environment.channel === "nightly";

  const more = element("details", { open: isRepeatFailure(Date.now()) }, [
    element("summary", { textContent: "More options if it keeps failing" }),
    ...(bridge
      ? [
          link(
            nightly ? `${DOWNLOAD_URL}?channel=nightly` : DOWNLOAD_URL,
            nightly
              ? "Download and reinstall the latest nightly build"
              : "Download and reinstall T3 Code",
          ),
        ]
      : []),
    element("div", {}, [
      element("p", {
        textContent:
          "Run this on the computer that runs T3 Code. Your agent can check the local logs and help you file a bug report.",
      }),
      element("div", { id: "boot-error-command" }, [command, copyCommand]),
    ]),
    element("div", {}, [
      details,
      element("p", {
        textContent: "Details may include local file paths and names. Check before sharing.",
      }),
      element("div", { id: "boot-error-report" }, [
        copyDetails,
        link(issue.href, "File a bug report on GitHub"),
      ]),
    ]),
  ]);

  bootShell.replaceChildren(
    element("div", { id: "boot-error" }, [
      message,
      element("div", { id: "boot-error-actions" }, [reload, update]),
      updateNote,
      more,
      status,
    ]),
  );
}
