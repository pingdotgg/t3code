import type {
  EnvironmentId,
  ProviderAuthAction,
  ProviderAuthSessionId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { selectProviderAuthSetupCandidates } from "@t3tools/client-runtime/state/provider-auth";
import * as Cause from "effect/Cause";
import { FileTextIcon, LoaderIcon, TerminalIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useTheme } from "../../hooks/useTheme";
import { useEnvironmentQuery } from "../../state/query";
import { providerAuthEnvironment } from "../../state/providerAuth";
import { usePrimaryEnvironment } from "../../state/environments";
import { primaryServerProvidersAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { GhosttyTheme } from "../../terminal/ghostty/core";
import { GhosttyTerminalSurface } from "../../terminal/ghostty/surface";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

interface ProviderAuthTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly action: ProviderAuthAction;
  readonly activeSessionId?: ProviderAuthSessionId | undefined;
}

interface ProviderAuthDialogState extends ProviderAuthTarget {
  readonly sessionId: ProviderAuthSessionId | null;
  readonly error: string | null;
}

interface ProviderAuthControllerValue {
  readonly openProviderAuth: (target: ProviderAuthTarget) => void;
  readonly isProviderAuthOpen: boolean;
}

const ProviderAuthControllerContext = createContext<ProviderAuthControllerValue | null>(null);

export function useProviderAuthController(): ProviderAuthControllerValue {
  const value = useContext(ProviderAuthControllerContext);
  if (value === null) {
    throw new Error("useProviderAuthController must be used inside ProviderAuthController");
  }
  return value;
}

function authTerminalTheme(theme: "light" | "dark"): GhosttyTheme {
  return theme === "dark"
    ? {
        background: { r: 14, g: 18, b: 24 },
        foreground: { r: 237, g: 241, b: 247 },
        cursor: { r: 180, g: 203, b: 255 },
        selectionBackground: "rgba(180, 203, 255, 0.25)",
      }
    : {
        background: { r: 255, g: 255, b: 255 },
        foreground: { r: 28, g: 33, b: 41 },
        cursor: { r: 38, g: 56, b: 78 },
        selectionBackground: "rgba(37, 63, 99, 0.2)",
      };
}

function formatFailure(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim() ? error.message : "Authentication failed.";
}

function ProviderAuthTerminal({ state }: { readonly state: ProviderAuthDialogState }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<GhosttyTerminalSurface | null>(null);
  const writtenHistoryRef = useRef("");
  const latestHistoryRef = useRef("");
  const [viewMode, setViewMode] = useState<"transcript" | "terminal">("transcript");
  const [transcript, setTranscript] = useState("");
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const { resolvedTheme } = useTheme();
  const resolvedThemeRef = useRef(resolvedTheme);
  resolvedThemeRef.current = resolvedTheme;
  const write = useAtomCommand(providerAuthEnvironment.write, { reportFailure: false });
  const resize = useAtomCommand(providerAuthEnvironment.resize, { reportFailure: false });
  const cancel = useAtomCommand(providerAuthEnvironment.cancel, { reportFailure: false });
  const attach = useEnvironmentQuery(
    state.sessionId === null
      ? null
      : providerAuthEnvironment.attach({
          environmentId: state.environmentId,
          input: { sessionId: state.sessionId },
        }),
  );
  const snapshot = attach.data;
  latestHistoryRef.current = snapshot?.history ?? "";

  useEffect(() => {
    const mount = mountRef.current;
    const sessionId = state.sessionId;
    if (mount === null || sessionId === null) return;
    let disposed = false;
    let surface: GhosttyTerminalSurface | null = null;
    setTranscript("");
    setTerminalError(null);
    void GhosttyTerminalSurface.create(mount, {
      theme: authTerminalTheme(resolvedThemeRef.current),
      onData: (data) => {
        void write({ environmentId: state.environmentId, input: { sessionId, data } });
      },
      onResize: (cols, rows) => {
        void resize({ environmentId: state.environmentId, input: { sessionId, cols, rows } });
      },
      onSelectionChange: () => undefined,
      onCopy: (text) => void navigator.clipboard?.writeText(text),
      beforeKey: () => true,
      onLinkActivate: (text) => window.open(text, "_blank", "noopener,noreferrer"),
    })
      .then((created) => {
        if (disposed) {
          created.dispose();
          return;
        }
        surface = created;
        terminalRef.current = created;
        created.setTheme(authTerminalTheme(resolvedThemeRef.current));
        writtenHistoryRef.current = latestHistoryRef.current;
        if (writtenHistoryRef.current) created.resetAndWrite(writtenHistoryRef.current);
        setTranscript(created.getTranscript());
        if (viewModeRef.current === "terminal") created.focus();
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        const message =
          cause instanceof Error && cause.message.trim()
            ? cause.message
            : "Could not initialize the authentication terminal.";
        setTerminalError(message);
      });
    return () => {
      disposed = true;
      surface?.dispose();
      if (terminalRef.current === surface) terminalRef.current = null;
      writtenHistoryRef.current = "";
    };
  }, [resize, state.environmentId, state.sessionId, write]);

  useEffect(() => {
    terminalRef.current?.setTheme(authTerminalTheme(resolvedTheme));
  }, [resolvedTheme]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal === null) return;
    if (viewMode === "terminal") {
      terminal.focus();
    } else {
      terminal.input.blur();
    }
  }, [viewMode]);

  useEffect(() => {
    const surface = terminalRef.current;
    const history = snapshot?.history ?? "";
    if (surface === null || history === writtenHistoryRef.current) return;
    if (history.startsWith(writtenHistoryRef.current)) {
      surface.write(history.slice(writtenHistoryRef.current.length));
    } else {
      surface.resetAndWrite(history);
    }
    writtenHistoryRef.current = history;
    setTranscript(surface.getTranscript());
  }, [snapshot?.history]);

  const status = snapshot?.status;
  const message = state.error ?? terminalError ?? attach.error ?? snapshot?.message ?? null;

  return (
    <div className="space-y-3 px-6 pb-4">
      <div className="flex items-start justify-between gap-4">
        <p id="provider-auth-view-help" className="text-sm text-muted-foreground">
          {viewMode === "transcript"
            ? "Select and copy the provider's output below. Use the interactive terminal if it asks for keyboard input."
            : "Keyboard input is sent directly to the provider. Return to the transcript to select and copy its output."}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          aria-describedby="provider-auth-view-help"
          onClick={() =>
            setViewMode((current) => (current === "transcript" ? "terminal" : "transcript"))
          }
        >
          {viewMode === "transcript" ? (
            <>
              <TerminalIcon /> Interactive terminal
            </>
          ) : (
            <>
              <FileTextIcon /> View transcript
            </>
          )}
        </Button>
      </div>
      <div className="relative h-[min(22rem,52vh)] overflow-hidden rounded-lg border bg-white dark:bg-[#0e1218]">
        <pre
          className={
            viewMode === "transcript"
              ? "h-full overflow-auto whitespace-pre-wrap p-2 font-mono text-xs text-foreground select-text"
              : "hidden"
          }
        >
          {transcript}
        </pre>
        <div
          ref={mountRef}
          className={
            viewMode === "terminal"
              ? "absolute inset-0"
              : "invisible pointer-events-none absolute inset-0"
          }
          onClick={() => terminalRef.current?.focus()}
        />
      </div>
      {state.sessionId === null && state.error === null ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderIcon className="size-4 animate-spin" /> Starting provider authentication…
        </p>
      ) : null}
      {message ? (
        <p
          className={
            status === "succeeded" && terminalError === null
              ? "text-sm text-success"
              : status === "failed" ||
                  state.error !== null ||
                  terminalError !== null ||
                  attach.error !== null
                ? "text-sm text-destructive"
                : "text-sm text-muted-foreground"
          }
        >
          {message}
        </p>
      ) : null}
      {status === "running" && state.sessionId ? (
        <Button
          variant="destructive"
          onClick={() =>
            void cancel({
              environmentId: state.environmentId,
              input: { sessionId: state.sessionId! },
            })
          }
        >
          Cancel session
        </Button>
      ) : null}
    </div>
  );
}

function ProviderAuthSetupPrompt() {
  const environment = usePrimaryEnvironment();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const { isProviderAuthOpen, openProviderAuth } = useProviderAuthController();
  const storageKey = environment ? `t3:provider-auth-setup:${environment.environmentId}` : null;
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const candidates = selectProviderAuthSetupCandidates(providers);
  const dismissed =
    storageKey === null ||
    dismissedKey === storageKey ||
    (typeof window !== "undefined" && window.localStorage.getItem(storageKey) === "dismissed");

  const dismiss = () => {
    if (storageKey === null) return;
    window.localStorage.setItem(storageKey, "dismissed");
    setDismissedKey(storageKey);
  };

  return (
    <Dialog
      open={!dismissed && !isProviderAuthOpen && candidates.length > 0}
      onOpenChange={(open) => !open && !isProviderAuthOpen && dismiss()}
    >
      <DialogPopup className="w-[min(32rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>Connect your coding agents</DialogTitle>
          <DialogDescription>
            Sign in without leaving T3 Code. Credentials stay in this environment, including when it
            runs in an isolated container.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 px-6 pb-2">
          {candidates.map((provider) => {
            const activeSession = provider.authManagement?.activeSession;
            const displayName = provider.displayName ?? provider.driver;
            return (
              <div
                key={provider.instanceId}
                className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{displayName}</p>
                  <p className="text-xs text-muted-foreground">
                    {activeSession ? "Authentication in progress" : "Ready to sign in"}
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => {
                    if (!environment) return;
                    openProviderAuth({
                      environmentId: environment.environmentId,
                      instanceId: provider.instanceId,
                      displayName,
                      action: activeSession?.action ?? "signIn",
                      ...(activeSession ? { activeSessionId: activeSession.sessionId } : {}),
                    });
                  }}
                >
                  {activeSession ? "Continue" : "Sign in"}
                </Button>
              </div>
            );
          })}
        </div>
        <DialogFooter variant="bare">
          <Button variant="ghost" onClick={dismiss}>
            Maybe later
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function ProviderAuthController({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<ProviderAuthDialogState | null>(null);
  const [signOutConfirmation, setSignOutConfirmation] = useState<ProviderAuthTarget | null>(null);
  const startInvocationRef = useRef(0);
  const start = useAtomCommand(providerAuthEnvironment.start, { reportFailure: false });

  const beginProviderAuth = useCallback(
    (target: ProviderAuthTarget) => {
      const invocation = ++startInvocationRef.current;
      setState({
        ...target,
        sessionId: target.activeSessionId ?? null,
        error: null,
      });
      if (target.activeSessionId !== undefined) return;
      void start({
        environmentId: target.environmentId,
        input: { instanceId: target.instanceId, action: target.action, cols: 90, rows: 24 },
      }).then((result) => {
        setState((current) => {
          if (
            invocation !== startInvocationRef.current ||
            current === null ||
            current.environmentId !== target.environmentId ||
            current.instanceId !== target.instanceId ||
            current.action !== target.action
          ) {
            return current;
          }
          return result._tag === "Success"
            ? { ...current, sessionId: result.value.sessionId }
            : { ...current, error: formatFailure(result.cause) };
        });
      });
    },
    [start],
  );
  const openProviderAuth = useCallback(
    (target: ProviderAuthTarget) => {
      if (target.action === "signOut" && target.activeSessionId === undefined) {
        setSignOutConfirmation(target);
        return;
      }
      beginProviderAuth(target);
    },
    [beginProviderAuth],
  );

  const close = useCallback(() => setState(null), []);
  const controllerValue = useMemo(
    () => ({
      openProviderAuth,
      isProviderAuthOpen: state !== null || signOutConfirmation !== null,
    }),
    [openProviderAuth, signOutConfirmation, state],
  );

  return (
    <ProviderAuthControllerContext.Provider value={controllerValue}>
      {children}
      <ProviderAuthSetupPrompt />
      <Dialog
        open={signOutConfirmation !== null}
        onOpenChange={(open) => !open && setSignOutConfirmation(null)}
      >
        <DialogPopup className="w-[min(28rem,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle>Sign out of {signOutConfirmation?.displayName}?</DialogTitle>
            <DialogDescription>
              This removes that provider's credentials from the selected environment. Other
              environments are not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSignOutConfirmation(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = signOutConfirmation;
                setSignOutConfirmation(null);
                if (target) beginProviderAuth(target);
              }}
            >
              Sign out
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog open={state !== null} onOpenChange={(open) => !open && close()}>
        <DialogPopup className="w-[min(48rem,calc(100vw-2rem))] max-w-none" showCloseButton>
          {state ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {state.action === "signIn" ? "Sign in to" : "Sign out of"} {state.displayName}
                </DialogTitle>
                <DialogDescription>
                  This session runs inside the selected T3 environment. Follow the provider's
                  prompts below.
                </DialogDescription>
              </DialogHeader>
              <ProviderAuthTerminal state={state} />
              <DialogFooter>
                <Button variant="outline" onClick={close}>
                  Close
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogPopup>
      </Dialog>
    </ProviderAuthControllerContext.Provider>
  );
}
