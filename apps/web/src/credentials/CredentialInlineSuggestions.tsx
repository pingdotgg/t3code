import type { SiteCredentialOption, VaultLoginsResponse } from "@t3tools/contracts";
import { KeyRoundIcon, LockKeyholeIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Popover, PopoverPopup } from "~/components/ui/popover";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { useStableCallback } from "~/hooks/useStableCallback";
import {
  executeReadyWebviewScript,
  isNewWebviewDocument,
  isWebviewDomReady,
  onWebviewDomReady,
} from "~/browser/webviewDomReady";
import {
  credentialInlineCommandScript,
  credentialInlineRect,
  credentialInlineWatchScript,
  parseCredentialInlineEvent,
  type CredentialInlineAnchor,
} from "./credentialInline";

let nextWatcher = 0;
const nextWatcherOwner = () => `inline-${(nextWatcher += 1)}`;
interface ScriptableWebview extends HTMLElement {
  executeJavaScript(code: string): Promise<unknown>;
}

/** Host-owned picker over the webview: websites never receive the account list. */
export function CredentialInlineSuggestions(props: {
  readonly runtimeTabId: string;
  readonly origin: string;
  readonly enabled: boolean;
  readonly items: ReadonlyArray<SiteCredentialOption>;
  readonly vault: { busy: boolean; result: VaultLoginsResponse | null; supported: boolean };
  readonly onFocus: () => void;
  readonly onChoose: (item: SiteCredentialOption) => Promise<void>;
  readonly onUnlock: () => Promise<void>;
}) {
  const { runtimeTabId, origin, enabled, items, vault } = props;
  const latest = useRef(props);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors props into a ref the guest-page watcher loop reads after awaits
  useEffect(() => {
    latest.current = props;
  });
  const [guestElement, setGuestElement] = useState<ScriptableWebview | null>(null);
  const [anchor, setAnchor] = useState<CredentialInlineAnchor | null>(null);
  const [open, setOpen] = useState(false);
  const [keyboard, setKeyboard] = useState(0);
  const popup = useRef<HTMLDivElement | null>(null);
  const channel = useRef<{ webview: ScriptableWebview; owner: string } | null>(null);
  const unlocking = useRef(false);

  // The keyboard effect calls this; a stable identity keeps rerenders from resending the command.
  const command = useStableCallback((name: "dismiss" | "keyboard", value: boolean = false) => {
    const current = channel.current;
    if (current)
      void executeReadyWebviewScript(
        current.webview,
        credentialInlineCommandScript(current.owner, name, value),
      );
  });
  const close = (restore = false) => {
    setOpen(false);
    const guest = channel.current?.webview;
    if (restore && guest && isWebviewDomReady(guest)) {
      try {
        guest.focus();
      } catch {
        // A guest being removed cannot receive focus.
      }
    }
    command("dismiss", restore);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches the inline-login watcher to the tab's webview and its navigation events while enabled
  useEffect(() => {
    if (!enabled || !origin.startsWith("https://")) return;
    let disposed = false,
      generation = 0;
    let webview: ScriptableWebview | undefined;
    let stopListeningForReady: (() => void) | undefined;
    const stop = () => {
      generation += 1;
      const current = channel.current;
      channel.current = null;
      if (current)
        void executeReadyWebviewScript(
          current.webview,
          credentialInlineCommandScript(current.owner, "dispose"),
        );
    };
    const start = () => {
      stop();
      setOpen(false);
      setAnchor(null);
      setKeyboard(0);
      if (!webview || disposed || !isWebviewDomReady(webview)) return;
      const guest = webview,
        owner = nextWatcherOwner(),
        current = generation;
      channel.current = { webview: guest, owner };
      void (async () => {
        let revision = -1;
        while (true) {
          if (disposed || current !== generation || !isWebviewDomReady(guest)) return;
          const value = await executeReadyWebviewScript(
            guest,
            credentialInlineWatchScript(owner, origin, revision),
          );
          if (disposed || current !== generation || !isWebviewDomReady(guest)) return;
          const event = parseCredentialInlineEvent(value);
          if (!event) {
            setOpen(false);
            return;
          }
          if (event.revision <= revision) return;
          revision = event.revision;
          setAnchor(event.anchor);
          if (!event.anchor || event.kind === "dismiss") {
            if (!unlocking.current) setOpen(false);
          } else if (event.kind === "focus") {
            setKeyboard(0);
            setOpen(true);
            latest.current.onFocus();
          } else if (event.kind === "keyboard") {
            setOpen(true);
            setKeyboard((value) => value + 1);
          }
        }
      })().catch(() => {
        // A document change destroys pending reads. dom-ready starts a new watcher.
        if (!disposed && current === generation) setOpen(false);
      });
    };
    const reset = () => {
      stop();
      setOpen(false);
      setAnchor(null);
      setKeyboard(0);
    };
    const navigate = (event: Event) => {
      if (isNewWebviewDocument(event)) reset();
    };
    const detach = () => {
      stopListeningForReady?.();
      webview?.removeEventListener("did-start-navigation", navigate);
      webview?.removeEventListener("render-process-gone", reset);
    };
    const attach = () => {
      const found = Array.from(
        document.querySelectorAll<ScriptableWebview>("webview[data-preview-tab]"),
      ).find((node) => node.isConnected && node.getAttribute("data-preview-tab") === runtimeTabId);
      if (found === webview) return;
      detach();
      reset();
      webview = found;
      setGuestElement(found ?? null);
      if (!webview) return;
      stopListeningForReady = onWebviewDomReady(webview, start);
      webview.addEventListener("did-start-navigation", navigate);
      webview.addEventListener("render-process-gone", reset);
      start();
    };
    // The hosted webview can attach after its toolbar or be replaced after a crash.
    const observer = new MutationObserver(attach);
    observer.observe(document.body, { childList: true, subtree: true });
    attach();
    return () => {
      disposed = true;
      observer.disconnect();
      detach();
      stop();
    };
  }, [channel, enabled, origin, runtimeTabId]);

  const shown = enabled && open && anchor !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the guest page whether the picker owns arrow keys
  useEffect(() => {
    command("keyboard", shown);
  }, [shown, command]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- schedules a frame to move DOM focus into the opened picker
  useEffect(() => {
    if (!shown || keyboard === 0) return;
    const frame = requestAnimationFrame(() =>
      popup.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [keyboard, shown]);

  if (!shown) return null;
  const virtualAnchor = {
    getBoundingClientRect: () => {
      return guestElement
        ? credentialInlineRect(anchor, guestElement.getBoundingClientRect())
        : new DOMRect();
    },
    contextElement: guestElement ?? undefined,
  };
  const groups = [
    { source: "vault", label: "Vault · this Mac" },
    { source: "test", label: "Test logins" },
  ] as const;
  return (
    <Popover
      open
      modal={false}
      onOpenChange={(next, details) => {
        if (next) return;
        // Guest focus is owned by the watcher; native unlock must keep this picker.
        const target = details.event?.target;
        if (
          (target === channel.current?.webview && details.reason === "outside-press") ||
          (details.reason === "focus-out" &&
            (unlocking.current ||
              !document.hasFocus() ||
              (details.event instanceof FocusEvent && details.event.relatedTarget === null)))
        ) {
          details.cancel();
          return;
        }
        close(details.reason === "escape-key");
      }}
    >
      <PopoverPopup
        ref={popup}
        anchor={virtualAnchor}
        align="start"
        sideOffset={6}
        initialFocus={false}
        finalFocus={false}
        aria-label="Saved logins for this field"
        width="md"
        padding="compact"
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          const buttons = Array.from(
            popup.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
          );
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
          event.preventDefault();
        }}
      >
        {groups.map(({ source, label }) => {
          const matches = items.filter((item) => item.source === source);
          if (matches.length === 0 && !(source === "vault" && vault.supported)) return null;
          return (
            <div role="group" aria-label={label} key={source} className="flex flex-col gap-1">
              <div className="px-2 py-1 text-muted-foreground text-xs">{label}</div>
              {matches.map((item) => (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm-multiline"
                  className="w-full justify-start"
                  key={item.id}
                  onClick={() => {
                    close();
                    void latest.current.onChoose(item);
                  }}
                >
                  <KeyRoundIcon data-icon="inline-start" />
                  <span className="flex min-w-0 flex-col text-left">
                    <span className="truncate">{item.title}</span>
                    {item.username && item.username !== item.title ? (
                      <span className="truncate text-muted-foreground text-xs">
                        {item.username}
                      </span>
                    ) : null}
                  </span>
                </Button>
              ))}
              {source === "vault" && vault.busy ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm-multiline"
                  className="w-full justify-start"
                  disabled
                >
                  <Spinner data-icon="inline-start" /> Checking Vault…
                </Button>
              ) : null}
              {source === "vault" &&
              (vault.result?.status === "locked" || vault.result?.status === "error") ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm-multiline"
                  className="w-full justify-start"
                  disabled={vault.busy}

                  onClick={() => {
                    unlocking.current = true;
                    void latest.current.onUnlock().finally(() => {
                      unlocking.current = false;
                    });
                  }}
                >
                  <LockKeyholeIcon data-icon="inline-start" />
                  {vault.result.status === "locked" ? "Unlock Vault…" : "Retry Vault…"}
                </Button>
              ) : null}
              {source === "vault" &&
              !vault.busy &&
              vault.result?.status === "ok" &&
              matches.length === 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm-multiline"
                  className="w-full justify-start"
                  disabled
                >
                  No Vault logins for this site
                </Button>
              ) : null}
              {source === "vault" && !vault.busy && vault.result?.status === "unavailable" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm-multiline"
                  className="w-full justify-start"
                  disabled
                >
                  Vault is not installed
                </Button>
              ) : null}
            </div>
          );
        })}
      </PopoverPopup>
    </Popover>
  );
}
