import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProviderReauthenticateAttemptId,
  ServerProviderReauthenticateStatusResult as ProviderReauthenticationStatusResult,
  ThreadId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
} from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";

export interface ClaudeReauthenticationRequest {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
}

export type ClaudeReauthenticationAttempt = Pick<
  ProviderReauthenticationStatusResult,
  "attemptId" | "authorizationUrl"
>;

export type ClaudeReauthenticationBeginResult = ClaudeReauthenticationAttempt;

export interface ClaudeReauthenticationSubmitInput extends ClaudeReauthenticationRequest {
  readonly attemptId: ServerProviderReauthenticateAttemptId;
  readonly code: string;
}

export interface ClaudeReauthenticationCancelInput extends ClaudeReauthenticationRequest {
  readonly attemptId: ServerProviderReauthenticateAttemptId;
}

export type ClaudeReauthenticationStatusResult = Pick<
  ProviderReauthenticationStatusResult,
  "status" | "authorizationUrl" | "error"
>;

/**
 * The server owns the interactive Claude process. Mobile only starts an
 * attempt, forwards an optional pasted code, and cancels an abandoned one.
 * Keeping this boundary callback-based lets the sheet work with RPC commands
 * without coupling the UI to a particular command or transport shape.
 */
export interface ClaudeReauthenticationActions {
  readonly begin: (
    request: ClaudeReauthenticationRequest,
  ) => Promise<ClaudeReauthenticationBeginResult>;
  /** Reads the server-owned attempt so browser-only completion can resolve. */
  readonly getStatus: (
    input: Pick<ClaudeReauthenticationSubmitInput, "attemptId">,
  ) => Promise<ClaudeReauthenticationStatusResult>;
  readonly submitCode: (
    input: ClaudeReauthenticationSubmitInput,
  ) => Promise<ClaudeReauthenticationStatusResult>;
  readonly cancel: (input: ClaudeReauthenticationCancelInput) => Promise<void>;
}

export type ClaudeReauthenticationPhase =
  | "starting"
  | "waiting"
  | "submitting"
  | "success"
  | "error";

export interface ClaudeReauthenticationSheetProps {
  readonly visible: boolean;
  readonly request: ClaudeReauthenticationRequest;
  readonly actions: ClaudeReauthenticationActions;
  /**
   * The server may complete the browser callback without a pasted code. The
   * owning screen can set this once its session snapshot leaves auth_error.
   */
  readonly resolved?: boolean;
  /** Called after Claude authentication succeeds, before the sheet is closed. */
  readonly onSuccess?: () => Promise<void> | void;
  readonly onRequestClose: () => void;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return fallback;
}

function isActivePhase(phase: ClaudeReauthenticationPhase): boolean {
  return phase === "starting" || phase === "waiting" || phase === "submitting";
}

/**
 * Presents the Claude CLI's browser login in a native sheet. The browser URL
 * is opened on the mobile device, while a code pasted from that browser is
 * sent back to the server process when Claude asks for one.
 */
export function ClaudeReauthenticationSheet(props: ClaudeReauthenticationSheetProps) {
  const actionsRef = useRef(props.actions);
  actionsRef.current = props.actions;
  const requestRef = useRef(props.request);
  requestRef.current = props.request;
  const onSuccessRef = useRef(props.onSuccess);
  onSuccessRef.current = props.onSuccess;
  const visibleRef = useRef(props.visible);
  visibleRef.current = props.visible;
  const attemptRequestRef = useRef<ClaudeReauthenticationRequest | null>(null);
  const attemptIdRef = useRef<ServerProviderReauthenticateAttemptId | null>(null);
  const attemptGenerationRef = useRef(0);
  const beginInFlightRef = useRef(false);
  const startedForVisibleRef = useRef(false);
  const completionReportedRef = useRef(false);
  const openedAuthorizationUrlRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<ClaudeReauthenticationPhase>("starting");
  const [attemptId, setAttemptId] = useState<ServerProviderReauthenticateAttemptId | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [beginRetryNonce, setBeginRetryNonce] = useState(0);

  const markAuthenticated = useCallback(
    (completedAttemptId: ServerProviderReauthenticateAttemptId | null = attemptIdRef.current) => {
      if (completedAttemptId === null || attemptIdRef.current !== completedAttemptId) {
        return;
      }
      if (completionReportedRef.current) {
        return;
      }
      completionReportedRef.current = true;
      const completionGeneration = attemptGenerationRef.current;
      attemptIdRef.current = null;
      attemptRequestRef.current = null;
      setAttemptId(null);
      setPhase("success");
      setError(null);
      const callback = onSuccessRef.current;
      if (callback === undefined) {
        return;
      }
      void Promise.resolve(callback()).catch((cause: unknown) => {
        if (!visibleRef.current || attemptGenerationRef.current !== completionGeneration) {
          return;
        }
        setPhase("error");
        setError(errorMessage(cause, "Claude was authenticated, but the task could not continue."));
      });
    },
    [],
  );

  const cancelActiveAttempt = useCallback(() => {
    attemptGenerationRef.current += 1;
    const currentAttemptId = attemptIdRef.current;
    const requestForAttempt = attemptRequestRef.current ?? requestRef.current;
    attemptIdRef.current = null;
    attemptRequestRef.current = null;
    setAttemptId(null);
    if (currentAttemptId !== null) {
      void actionsRef.current
        .cancel({
          ...requestForAttempt,
          attemptId: currentAttemptId,
        })
        .catch(() => undefined);
    }
  }, []);

  const openAuthorizationUrl = useCallback(async (url: string, repeat = false) => {
    if (!repeat && openedAuthorizationUrlRef.current === url) {
      return;
    }
    if (!repeat) {
      openedAuthorizationUrlRef.current = url;
    }
    try {
      await Linking.openURL(url);
    } catch (cause) {
      if (!repeat) {
        openedAuthorizationUrlRef.current = null;
      }
      setPhase("error");
      setError(errorMessage(cause, "Could not open the Claude sign-in page."));
    }
  }, []);

  const startAttempt = useCallback(() => {
    if (beginInFlightRef.current) {
      return;
    }

    const generation = attemptGenerationRef.current + 1;
    attemptGenerationRef.current = generation;
    const requestForAttempt = requestRef.current;
    attemptRequestRef.current = requestForAttempt;
    beginInFlightRef.current = true;
    completionReportedRef.current = false;
    attemptIdRef.current = null;
    openedAuthorizationUrlRef.current = null;
    setAttemptId(null);
    setAuthorizationUrl(null);
    setCode("");
    setError(null);
    setPhase("starting");

    void actionsRef.current
      .begin(requestForAttempt)
      .then((result) => {
        if (
          !visibleRef.current ||
          generation !== attemptGenerationRef.current ||
          completionReportedRef.current
        ) {
          void actionsRef.current
            .cancel({
              ...requestForAttempt,
              attemptId: result.attemptId,
            })
            .catch(() => undefined);
          return;
        }
        const nextAuthorizationUrl = result.authorizationUrl?.trim() || null;
        attemptIdRef.current = result.attemptId;
        setAttemptId(result.attemptId);
        setAuthorizationUrl(nextAuthorizationUrl);
        setPhase(nextAuthorizationUrl === null ? "starting" : "waiting");
        if (nextAuthorizationUrl !== null) {
          void openAuthorizationUrl(nextAuthorizationUrl);
        }
      })
      .catch((cause: unknown) => {
        if (!visibleRef.current || generation !== attemptGenerationRef.current) {
          return;
        }
        setPhase("error");
        setError(errorMessage(cause, "Could not start Claude sign-in."));
      })
      .finally(() => {
        beginInFlightRef.current = false;
        if (visibleRef.current && generation !== attemptGenerationRef.current) {
          startedForVisibleRef.current = false;
          setBeginRetryNonce((value) => value + 1);
        }
      });
  }, [openAuthorizationUrl]);

  useEffect(() => {
    if (!props.visible) {
      visibleRef.current = false;
      startedForVisibleRef.current = false;
      cancelActiveAttempt();
      return;
    }
    visibleRef.current = true;
    if (startedForVisibleRef.current) {
      return;
    }
    startedForVisibleRef.current = true;
    let disposed = false;
    // React may replay mount effects in development. Waiting one microtask
    // keeps that replay from starting and immediately cancelling the CLI.
    queueMicrotask(() => {
      if (!disposed && visibleRef.current) {
        startAttempt();
      }
    });
    return () => {
      disposed = true;
      visibleRef.current = false;
      startedForVisibleRef.current = false;
      cancelActiveAttempt();
    };
  }, [beginRetryNonce, cancelActiveAttempt, props.visible, startAttempt]);

  useEffect(() => {
    if (!props.visible || !props.resolved || attemptId === null || !isActivePhase(phase)) {
      return;
    }
    markAuthenticated(attemptId);
  }, [attemptId, markAuthenticated, phase, props.resolved, props.visible]);

  useEffect(() => {
    const currentAttemptId = attemptId;
    if (!props.visible || currentAttemptId === null || !isActivePhase(phase)) {
      return;
    }

    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const status = await actionsRef.current.getStatus({ attemptId: currentAttemptId });
        if (cancelled || attemptIdRef.current !== currentAttemptId) {
          return;
        }

        if (status.authorizationUrl !== null && status.authorizationUrl !== authorizationUrl) {
          setAuthorizationUrl(status.authorizationUrl);
          void openAuthorizationUrl(status.authorizationUrl);
          if (phase !== "submitting") {
            setPhase("waiting");
          }
        }

        switch (status.status) {
          case "succeeded":
            markAuthenticated(currentAttemptId);
            return;
          case "failed":
          case "cancelled":
          case "expired":
            setPhase("error");
            setError(
              status.error ??
                (status.status === "expired"
                  ? "Claude sign-in timed out."
                  : "Claude sign-in did not complete."),
            );
            return;
          case "awaiting_code":
            if (phase !== "submitting") {
              setPhase(status.authorizationUrl === null ? "starting" : "waiting");
            }
            break;
          case "starting":
            if (phase !== "submitting") {
              setPhase(status.authorizationUrl === null ? "starting" : "waiting");
            }
            break;
        }
      } catch (cause: unknown) {
        if (!cancelled && attemptIdRef.current === currentAttemptId) {
          setPhase("error");
          setError(errorMessage(cause, "Could not read Claude sign-in status."));
        }
        return;
      }

      if (!cancelled && attemptIdRef.current === currentAttemptId) {
        timeout = setTimeout(() => void poll(), 1_000);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    };
  }, [attemptId, authorizationUrl, markAuthenticated, openAuthorizationUrl, phase, props.visible]);

  const close = useCallback(() => {
    visibleRef.current = false;
    cancelActiveAttempt();
    props.onRequestClose();
  }, [cancelActiveAttempt, props.onRequestClose]);

  const submitCode = useCallback(() => {
    const currentAttemptId = attemptIdRef.current;
    const trimmedCode = code.trim();
    if (currentAttemptId === null || trimmedCode.length === 0 || phase !== "waiting") {
      return;
    }

    setPhase("submitting");
    setError(null);
    const requestForAttempt = attemptRequestRef.current ?? requestRef.current;
    void actionsRef.current
      .submitCode({
        ...requestForAttempt,
        attemptId: currentAttemptId,
        code: trimmedCode,
      })
      // Submitting the code only writes to the server-owned CLI process. The
      // process still has to finish OAuth and refresh the provider, so the
      // status poll remains the source of truth for success.
      .then((status) => {
        if (attemptIdRef.current !== currentAttemptId) {
          return;
        }
        if (status.status === "succeeded") {
          markAuthenticated(currentAttemptId);
          return;
        }
        if (
          status.status === "failed" ||
          status.status === "cancelled" ||
          status.status === "expired"
        ) {
          attemptIdRef.current = null;
          setAttemptId(null);
          setPhase("error");
          setError(
            status.error ??
              (status.status === "expired"
                ? "Claude sign-in timed out."
                : "Claude sign-in did not complete."),
          );
        }
      })
      .catch((cause: unknown) => {
        if (!visibleRef.current || attemptIdRef.current !== currentAttemptId) {
          return;
        }
        setPhase("error");
        setError(errorMessage(cause, "Claude sign-in could not be completed."));
      });
  }, [code, markAuthenticated, phase]);

  const retry = useCallback(() => {
    cancelActiveAttempt();
    startAttempt();
  }, [cancelActiveAttempt, startAttempt]);

  return (
    <Modal
      animationType="fade"
      onRequestClose={close}
      statusBarTranslucent
      transparent
      visible={props.visible}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1"
      >
        <View className="flex-1 justify-center bg-backdrop px-5">
          <View className="max-h-[92%] w-full rounded-[28px] bg-card px-5 pb-5 pt-6">
            <ScrollView
              bounces={false}
              contentContainerStyle={{ gap: 14 }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <Text className="text-xl font-t3-bold">Sign in to Claude</Text>
              <Text className="text-sm leading-snug text-foreground-muted">
                Claude will open a sign-in page. Finish in your browser, then return here if it asks
                you to paste a code.
              </Text>

              {phase === "starting" ? (
                <View className="flex-row items-center gap-3 rounded-2xl bg-subtle px-4 py-3">
                  <ActivityIndicator colorClassName="accent-icon" size="small" />
                  <Text className="flex-1 text-sm text-foreground-muted">
                    {attemptId === null
                      ? "Starting Claude sign-in…"
                      : "Waiting for Claude sign-in…"}
                  </Text>
                </View>
              ) : null}

              {phase === "waiting" || phase === "submitting" ? (
                <>
                  <Pressable
                    accessibilityRole="button"
                    className="min-h-12 items-center justify-center rounded-2xl bg-primary px-4 py-3 active:opacity-80 disabled:opacity-50"
                    disabled={authorizationUrl === null}
                    onPress={() => {
                      if (authorizationUrl !== null) {
                        void openAuthorizationUrl(authorizationUrl, true);
                      }
                    }}
                  >
                    <Text className="text-sm font-t3-bold text-primary-foreground">
                      Open Claude sign-in
                    </Text>
                  </Pressable>
                  <View className="gap-2">
                    <Text className="text-sm font-t3-medium">Paste code if prompted</Text>
                    <TextInput
                      autoCapitalize="none"
                      autoCorrect={false}
                      editable={phase === "waiting"}
                      onChangeText={setCode}
                      onSubmitEditing={submitCode}
                      placeholder="Paste the code from Claude"
                      returnKeyType="done"
                      value={code}
                    />
                    <Pressable
                      accessibilityRole="button"
                      className="min-h-11 items-center justify-center rounded-2xl border border-border px-4 py-2 active:bg-subtle disabled:opacity-50"
                      disabled={phase !== "waiting" || code.trim().length === 0}
                      onPress={submitCode}
                    >
                      <Text className="text-sm font-t3-bold text-foreground">
                        {phase === "submitting" ? "Submitting…" : "Submit code"}
                      </Text>
                    </Pressable>
                  </View>
                  {phase === "submitting" ? (
                    <View className="flex-row items-center gap-2">
                      <ActivityIndicator colorClassName="accent-icon" size="small" />
                      <Text className="text-xs text-foreground-muted">
                        Completing Claude sign-in…
                      </Text>
                    </View>
                  ) : null}
                </>
              ) : null}

              {phase === "error" && error !== null ? <ErrorBanner message={error} /> : null}

              {phase === "success" ? (
                <View className="rounded-2xl border border-adaptive-emerald-300-a70-400-a28 bg-adaptive-emerald-100-a80-500-a12 px-4 py-3">
                  <Text className="text-sm font-t3-medium text-adaptive-emerald-700-300">
                    Claude is signed in. Your task will continue.
                  </Text>
                </View>
              ) : null}

              <View className="flex-row justify-end gap-2 pt-1">
                {phase === "error" ? (
                  <Pressable
                    accessibilityRole="button"
                    className="min-h-11 items-center justify-center rounded-2xl border border-border px-4 py-2 active:bg-subtle"
                    onPress={retry}
                  >
                    <Text className="text-sm font-t3-bold text-foreground">Try again</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  className="min-h-11 items-center justify-center rounded-2xl px-4 py-2 active:bg-subtle"
                  onPress={close}
                >
                  <Text className="text-sm font-t3-bold text-foreground-muted">
                    {phase === "success" ? "Done" : "Cancel"}
                  </Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
