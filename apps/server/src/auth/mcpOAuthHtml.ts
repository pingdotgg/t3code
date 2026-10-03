import type { RuntimeMode } from "@t3tools/contracts";

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

// Same words as the composer's permission menu, so the choice reads the same everywhere.
const RUNTIME_MODES: ReadonlyArray<{ readonly value: RuntimeMode; readonly label: string }> = [
  { value: "approval-required", label: "Supervised: it asks before running commands or editing" },
  { value: "auto-accept-edits", label: "Auto-accept edits" },
  { value: "auto", label: "Auto" },
  { value: "full-access", label: "Full access" },
];

const STYLES = `
  :root { color-scheme: light dark; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px 16px; background: #f6f7f9; color: #17191f; }
  main { width: min(100%, 480px); border: 1px solid rgba(23, 25, 31, 0.1); border-radius: 16px; background: #fff; padding: 28px; }
  h1 { margin: 0 0 8px; font-size: 20px; }
  p { margin: 0 0 16px; line-height: 1.5; color: #4b5060; }
  dl { margin: 0 0 20px; display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; font-size: 14px; }
  dt { color: #6b7080; }
  dd { margin: 0; word-break: break-word; }
  label { display: block; font-size: 14px; font-weight: 600; margin: 0 0 6px; }
  select, input { width: 100%; font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(23, 25, 31, 0.2); margin: 0 0 16px; background: inherit; color: inherit; }
  .warning { padding: 10px 12px; border-radius: 8px; background: rgba(234, 179, 8, 0.12); font-size: 14px; }
  .error { padding: 10px 12px; border-radius: 8px; background: rgba(239, 68, 68, 0.12); color: #b91c1c; font-size: 14px; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; }
  button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid rgba(23, 25, 31, 0.2); background: transparent; color: inherit; cursor: pointer; }
  button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  .hint { font-size: 13px; color: #6b7080; margin-top: -10px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; color: #e6e8ee; }
    main { background: #171a21; border-color: rgba(255, 255, 255, 0.1); }
    p, dt, .hint { color: #a0a6b4; }
    select, input, button { border-color: rgba(255, 255, 255, 0.2); }
    .error { color: #fca5a5; }
  }
`;

const shell = (title: string, body: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>${escapeHtml(title)}</title>
    <style>${STYLES}</style>
  </head>
  <body>
    <main>${body}</main>
  </body>
</html>`;

export interface ApprovalPageInput {
  readonly clientName: string;
  readonly redirectHost: string;
  readonly environmentHost: string;
  /** Every authorize parameter, carried through the form unchanged. */
  readonly hiddenParams: ReadonlyArray<readonly [string, string]>;
  /** Present when the owner's browser session may approve without a code. */
  readonly csrfToken?: string;
  readonly error?: string;
  readonly runtimeModeCeiling?: RuntimeMode;
}

export function renderApprovalPage(input: ApprovalPageInput): string {
  const selected = input.runtimeModeCeiling ?? "approval-required";
  const hidden = input.hiddenParams
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`,
    )
    .join("");
  const approval =
    input.csrfToken === undefined
      ? `<label for="pairing_code">Pairing code</label>
        <input id="pairing_code" name="pairing_code" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" required />
        <p class="hint">Create one in T3 Code under Settings → Connections, or run <code>t3 auth pairing create</code> on this machine.</p>`
      : `<input type="hidden" name="csrf_token" value="${escapeHtml(input.csrfToken)}" />`;
  return shell(
    "Connect an agent to T3 Code",
    `<h1>Connect an agent to T3 Code</h1>
    <p>An app wants to control threads on <strong>${escapeHtml(input.environmentHost)}</strong>.</p>
    <dl>
      <dt>App</dt><dd>${escapeHtml(input.clientName)} <span class="hint">(as the app names itself)</span></dd>
      <dt>Returns to</dt><dd>${escapeHtml(input.redirectHost)} on the computer that opened this page</dd>
      <dt>Access</dt><dd>Read, start, message and stop threads in every project</dd>
    </dl>
    <p class="warning">Only approve if you just started this sign-in from an agent you trust.</p>
    ${input.error === undefined ? "" : `<p class="error" role="alert">${escapeHtml(input.error)}</p>`}
    <form method="post">
      ${hidden}
      <label for="runtime_mode">Most it may allow an agent to do</label>
      <select id="runtime_mode" name="runtime_mode">
        ${RUNTIME_MODES.map(
          (mode) =>
            `<option value="${mode.value}"${mode.value === selected ? " selected" : ""}>${escapeHtml(mode.label)}</option>`,
        ).join("")}
      </select>
      ${approval}
      <div class="actions">
        <button type="submit" name="decision" value="deny">Deny</button>
        <button type="submit" name="decision" value="approve" class="primary">Approve</button>
      </div>
    </form>`,
  );
}

export function renderErrorPage(description: string): string {
  return shell(
    "Sign-in failed",
    `<h1>This sign-in cannot continue</h1>
    <p>${escapeHtml(description)}</p>
    <p>Close this page and start the sign-in again from your agent.</p>`,
  );
}
