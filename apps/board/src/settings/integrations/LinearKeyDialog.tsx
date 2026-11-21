import { RegistryContext } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, IssueTrackerKind } from "@t3tools/contracts";
import { ExternalLink, LoaderCircle, Lock } from "lucide-react";
import { type FormEvent, useContext, useId, useState } from "react";

import { openInBrowser } from "../../browser/browserTabs";
import { issueTrackerEnvironment } from "../../state/issues";
import { failureText } from "../failureText";

const PERSONAL_KEYS_URL = "https://linear.app/settings/account/security";
const WORKSPACE_API_URL = "https://linear.app/settings/api";

const link = "inline-flex items-center gap-1 text-focus underline-offset-2 hover:underline";

/** The key lives only in this field and in the one request, so it is never written to a file or a log. */
export function LinearKeyDialog({
  environmentId,
  tracker,
  helpUrl,
  replacing,
  onClose,
}: {
  environmentId: EnvironmentId;
  tracker: string;
  helpUrl: string | null;
  replacing: boolean;
  onClose: () => void;
}) {
  const registry = useContext(RegistryContext);
  const inputId = useId();
  const errorId = useId();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    const token = key.trim();
    if (token === "" || busy) return;
    setBusy(true);
    setError(null);
    const result = await runAtomCommand(
      registry,
      issueTrackerEnvironment.connect,
      { environmentId, input: { tracker: IssueTrackerKind.make(tracker), token } },
      // A failure's cause can carry the request, so it stays out of the console.
      { reportFailure: false, reportDefect: false },
    );
    setBusy(false);
    if (result._tag === "Success") {
      setKey("");
      onClose();
      return;
    }
    setError(failureText(result));
  };

  return (
    <div
      className="fixed inset-0 z-30 grid place-items-center bg-black/50"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) onClose();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label="Add Linear access"
        onSubmit={(event) => void connect(event)}
        className="flex w-[480px] max-w-[92vw] flex-col gap-3 rounded-xl border border-line bg-panel p-4 shadow-panel"
      >
        <h2 className="text-[15px] leading-tight font-semibold">Add Linear access</h2>
        <p className="text-xs text-muted">
          Paste a Personal API key for the Linear workspace you want the board to use.{" "}
          {replacing && "The engine replaces the key it has stored."}
        </p>
        <div className="space-y-2">
          <label htmlFor={inputId} className="text-xs text-muted">
            Personal API key
          </label>
          <input
            id={inputId}
            autoFocus
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="lin_api_..."
            value={key}
            disabled={busy}
            aria-invalid={error !== null}
            aria-describedby={error === null ? undefined : errorId}
            onChange={(event) => {
              setKey(event.target.value);
              setError(null);
            }}
            className="w-full rounded-md border border-line bg-bg px-2 py-1.5 text-fg placeholder:text-faint disabled:opacity-60"
          />
        </div>
        {error !== null && (
          <p id={errorId} role="alert" className="text-xs break-words text-red-400">
            {error}
          </p>
        )}
        <div className="space-y-2 text-xs leading-relaxed text-muted">
          <p>
            Create a Personal API key from Account &gt; Security &amp; Access. Use Linear to choose
            the intended workspace before creating the key.
          </p>
          <p>
            A key with full access shows every team the account can reach. A restricted key shows
            only the teams it permits. If member API keys are blocked, ask a workspace admin to
            allow them from the workspace's API settings.
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              className={link}
              onClick={() => openInBrowser(helpUrl ?? PERSONAL_KEYS_URL)}
            >
              <ExternalLink className="size-3" aria-hidden />
              Personal API keys
            </button>
            <span className="text-faint">|</span>
            <button type="button" className={link} onClick={() => openInBrowser(WORKSPACE_API_URL)}>
              <ExternalLink className="size-3" aria-hidden />
              Workspace API settings
            </button>
          </div>
        </div>
        <p className="flex items-center gap-1.5 text-[11px] text-faint">
          <Lock className="size-3 shrink-0" aria-hidden />
          The engine stores this key as a secret. The board never writes it to a file.
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-2.5 py-1 text-muted hover:text-fg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || key.trim() === ""}
            className="inline-flex items-center gap-1.5 rounded-md bg-fg px-2.5 py-1 font-medium text-bg disabled:opacity-50"
          >
            {busy && <LoaderCircle className="size-3.5 animate-spin" aria-hidden />}
            {busy ? "Verifying..." : "Add Linear access"}
          </button>
        </div>
      </form>
    </div>
  );
}
