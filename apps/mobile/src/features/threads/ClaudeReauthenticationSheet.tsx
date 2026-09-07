import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProviderReauthenticateAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import {
  taskContinuationMessage,
  transitionClaudeReauthenticationState,
  type ClaudeReauthenticationAttempt,
  type ClaudeReauthenticationSheetState,
  type ClaudeReauthenticationStatus,
} from "./ClaudeReauthenticationState";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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

export type ClaudeReauthenticationBeginResult = ClaudeReauthenticationAttempt;

export interface ClaudeReauthenticationSubmitInput extends ClaudeReauthenticationRequest {
  readonly attemptId: ServerProviderReauthenticateAttemptId;
  readonly code: string;
}

export interface ClaudeReauthenticationCancelInput extends ClaudeReauthenticationRequest {
  readonly attemptId: ServerProviderReauthenticateAttemptId;
}

export interface ClaudeReauthenticationStatusInput extends ClaudeReauthenticationRequest {
  readonly attemptId: ServerProviderReauthenticateAttemptId;
}

/**
 * The server owns the interactive Claude process. Mobile only starts an
 * attempt, forwards an optional pasted code, and cancels an abandoned one.
 */
export interface ClaudeReauthenticationActions {
  readonly begin: (
    request: ClaudeReauthenticationRequest,
  ) => Promise<ClaudeReauthenticationBeginResult>;
  readonly getStatus: (
    input: ClaudeReauthenticationStatusInput,
  ) => Promise<ClaudeReauthenticationStatus>;
  readonly submitCode: (
    input: ClaudeReauthenticationSubmitInput,
  ) => Promise<ClaudeReauthenticationStatus>;
  readonly cancel: (input: ClaudeReauthenticationCancelInput) => Promise<void>;
}

export interface ClaudeReauthenticationSheetProps {
  readonly visible: boolean;
  readonly request: ClaudeReauthenticationRequest;
  readonly actions: ClaudeReauthenticationActions;
  readonly onRequestClose: () => void;
}

const INITIAL_STATE: ClaudeReauthenticationSheetState = { phase: "starting" };
const STATUS_POLL_INTERVAL_MS = 1_000;

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return fallback;
}

function isActiveState(
  state: ClaudeReauthenticationSheetState,
): state is Extract<
  ClaudeReauthenticationSheetState,
  { readonly attempt: ClaudeReauthenticationAttempt }
> {
  return state.phase === "waiting" || state.phase === "submitting";
}

function attemptFromState(
  state: ClaudeReauthenticationSheetState,
): ClaudeReauthenticationAttempt | null {
  return "attempt" in state ? (state.attempt ?? null) : null;
}

/**
 * Presents Claude's browser login in a native sheet. The login process stays
 * on the environment machine, while the URL and optional code are handled here.
 */
export function ClaudeReauthenticationSheet(props: ClaudeReauthenticationSheetProps) {
  const [state, setState] = useState<ClaudeReauthenticationSheetState>(INITIAL_STATE);
  const [code, setCode] = useState("");
  const stateRef = useRef<ClaudeReauthenticationSheetState>(INITIAL_STATE);
  const actionsRef = useRef(props.actions);
  const requestRef = useRef(props.request);
  const activeRequestRef = useRef<ClaudeReauthenticationRequest | null>(null);
  const activeAttemptIdRef = useRef<ServerProviderReauthenticateAttemptId | null>(null);
  const attemptGenerationRef = useRef(0);
  const visibleRef = useRef(props.visible);
  const startedForVisibleRef = useRef(false);
  const beginInFlightRef = useRef(false);
  const pendingBeginRef = useRef<Promise<ClaudeReauthenticationBeginResult> | null>(null);
  const cancellationByAttemptRef = useRef(new Map<string, Promise<void>>());
  const cancellationBarrierRef = useRef(Promise.resolve());
  const openedAuthorizationUrlRef = useRef<string | null>(null);
  const pollingCleanupRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    actionsRef.current = props.actions;
    requestRef.current = props.request;
    visibleRef.current = props.visible;
  }, [props.actions, props.request, props.visible]);

  const updateState = useCallback((next: ClaudeReauthenticationSheetState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const stopPolling = useCallback(() => {
    pollingCleanupRef.current?.();
    pollingCleanupRef.current = null;
  }, []);

  const cancelAttempt = useCallback(
    (
      requestForAttempt: ClaudeReauthenticationRequest,
      attemptId: ServerProviderReauthenticateAttemptId,
    ) => {
      const key = String(attemptId);
      const existing = cancellationByAttemptRef.current.get(key);
      if (existing !== undefined) return existing;

      const cancellation = actionsRef.current.cancel({ ...requestForAttempt, attemptId }).then(
        () => undefined,
        () => undefined,
      );
      cancellationByAttemptRef.current.set(key, cancellation);
      void cancellation.then(() => {
        if (cancellationByAttemptRef.current.get(key) === cancellation) {
          cancellationByAttemptRef.current.delete(key);
        }
      });
      return cancellation;
    },
    [],
  );

  const cancelActiveAttempt = useCallback((): Promise<void> => {
    const currentAttemptId = activeAttemptIdRef.current;
    const requestForAttempt = activeRequestRef.current;
    const pendingBegin = pendingBeginRef.current;
    activeAttemptIdRef.current = null;
    activeRequestRef.current = null;
    stopPolling();

    const cancellations: Array<Promise<void>> = [];
    if (currentAttemptId !== null && requestForAttempt !== null) {
      cancellations.push(cancelAttempt(requestForAttempt, currentAttemptId));
    }
    if (pendingBegin !== null && requestForAttempt !== null) {
      cancellations.push(
        pendingBegin.then(
          (attempt) =>
            attempt.attemptId.trim().length === 0
              ? undefined
              : cancelAttempt(requestForAttempt, attempt.attemptId),
          () => undefined,
        ),
      );
    }
    return Promise.all(cancellations).then(() => undefined);
  }, [cancelAttempt, stopPolling]);

  const invalidateAttempt = useCallback(() => {
    attemptGenerationRef.current += 1;
    startedForVisibleRef.current = false;
    const cancellation = Promise.all([cancellationBarrierRef.current, cancelActiveAttempt()]).then(
      () => undefined,
    );
    cancellationBarrierRef.current = cancellation;
    return cancellation;
  }, [cancelActiveAttempt]);

  const isCurrentAttempt = useCallback(
    (generation: number, attemptId: ServerProviderReauthenticateAttemptId) =>
      visibleRef.current &&
      generation === attemptGenerationRef.current &&
      activeAttemptIdRef.current === attemptId,
    [],
  );

  const finishSuccess = useCallback(
    (
      generation: number,
      attemptId: ServerProviderReauthenticateAttemptId,
      status: ClaudeReauthenticationStatus,
    ) => {
      if (!isCurrentAttempt(generation, attemptId) || status.status !== "succeeded") return;
      activeAttemptIdRef.current = null;
      activeRequestRef.current = null;
      stopPolling();
      updateState({
        phase: "success",
        continuation: status.continuation,
        continuationError: status.continuationError,
      });
    },
    [isCurrentAttempt, stopPolling, updateState],
  );

  const openAuthorizationUrl = useCallback(
    async (
      url: string,
      generation: number,
      attemptId: ServerProviderReauthenticateAttemptId,
      repeat = false,
    ) => {
      if (!isCurrentAttempt(generation, attemptId)) return;
      if (!repeat && openedAuthorizationUrlRef.current === url) return;
      if (!repeat) openedAuthorizationUrlRef.current = url;
      try {
        await Linking.openURL(url);
      } catch (cause: unknown) {
        if (!isCurrentAttempt(generation, attemptId)) return;
        if (!repeat) openedAuthorizationUrlRef.current = null;
        updateState({
          phase: "error",
          message: errorMessage(cause, "Could not open the Claude sign-in page."),
        });
      }
    },
    [isCurrentAttempt, updateState],
  );

  const startPolling = useCallback(
    (
      attempt: ClaudeReauthenticationAttempt,
      requestForAttempt: ClaudeReauthenticationRequest,
      generation: number,
    ) => {
      stopPolling();
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const stop = () => {
        stopped = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };
      pollingCleanupRef.current = stop;

      const poll = async () => {
        if (stopped || !isCurrentAttempt(generation, attempt.attemptId)) return;
        try {
          const status = await actionsRef.current.getStatus({
            ...requestForAttempt,
            attemptId: attempt.attemptId,
          });
          if (stopped || !isCurrentAttempt(generation, attempt.attemptId)) return;
          const nextState = transitionClaudeReauthenticationState({
            previous: stateRef.current,
            attempt,
            status,
          });
          if (nextState.phase === "success") {
            finishSuccess(generation, attempt.attemptId, status);
            return;
          }
          if (nextState.phase === "error") {
            stopPolling();
            activeAttemptIdRef.current = null;
            activeRequestRef.current = null;
            updateState(nextState);
            return;
          }
          if (nextState.phase !== "starting" && nextState.attempt.authorizationUrl !== null) {
            const previousUrl = attempt.authorizationUrl;
            if (nextState.attempt.authorizationUrl !== previousUrl) {
              void openAuthorizationUrl(
                nextState.attempt.authorizationUrl,
                generation,
                attempt.attemptId,
              );
            }
          }
          updateState(nextState);
          timer = setTimeout(() => void poll(), STATUS_POLL_INTERVAL_MS);
        } catch (cause: unknown) {
          if (stopped || !isCurrentAttempt(generation, attempt.attemptId)) return;
          stopPolling();
          updateState({
            phase: "error",
            message: errorMessage(cause, "Could not read Claude sign-in status."),
            ...(attempt.authorizationUrl === null ? {} : { attempt }),
          });
        }
      };

      void poll();
    },
    [finishSuccess, isCurrentAttempt, openAuthorizationUrl, stopPolling, updateState],
  );

  const startAttempt = useCallback(() => {
    if (!visibleRef.current || beginInFlightRef.current) return;

    const generation = ++attemptGenerationRef.current;
    const requestForAttempt = requestRef.current;
    activeRequestRef.current = requestForAttempt;
    activeAttemptIdRef.current = null;
    beginInFlightRef.current = true;
    setCode("");
    openedAuthorizationUrlRef.current = null;
    updateState(INITIAL_STATE);

    const beginPromise = actionsRef.current.begin(requestForAttempt);
    pendingBeginRef.current = beginPromise;
    void beginPromise
      .then(
        (result) => {
          if (!visibleRef.current || generation !== attemptGenerationRef.current) {
            if (result.attemptId.trim().length > 0) {
              void cancelAttempt(requestForAttempt, result.attemptId);
            }
            return;
          }
          if (result.attemptId.trim().length === 0) {
            activeRequestRef.current = null;
            updateState({ phase: "error", message: "Claude did not return a sign-in attempt." });
            return;
          }
          const normalizedAttempt = {
            ...result,
            authorizationUrl: result.authorizationUrl?.trim() || null,
          };
          activeAttemptIdRef.current = normalizedAttempt.attemptId;
          updateState(
            normalizedAttempt.authorizationUrl === null
              ? { phase: "starting", attempt: normalizedAttempt }
              : { phase: "waiting", attempt: normalizedAttempt },
          );
          startPolling(normalizedAttempt, requestForAttempt, generation);
          if (normalizedAttempt.authorizationUrl !== null) {
            void openAuthorizationUrl(
              normalizedAttempt.authorizationUrl,
              generation,
              normalizedAttempt.attemptId,
            );
          }
        },
        (cause: unknown) => {
          if (!visibleRef.current || generation !== attemptGenerationRef.current) return;
          activeAttemptIdRef.current = null;
          activeRequestRef.current = null;
          updateState({
            phase: "error",
            message: errorMessage(cause, "Could not start Claude sign-in."),
          });
        },
      )
      .finally(() => {
        beginInFlightRef.current = false;
        if (pendingBeginRef.current === beginPromise) pendingBeginRef.current = null;
      });
  }, [cancelAttempt, openAuthorizationUrl, startPolling, updateState]);

  useEffect(() => {
    visibleRef.current = props.visible;
    if (!props.visible) {
      startedForVisibleRef.current = false;
      void invalidateAttempt();
      return;
    }
    if (startedForVisibleRef.current) return;
    startedForVisibleRef.current = true;
    let cancelled = false;
    // Defer startup past Strict Mode's setup/cleanup replay so development mounts do not create an
    // attempt that the replay immediately cancels.
    queueMicrotask(() => {
      void cancellationBarrierRef.current.then(() => {
        if (!cancelled && visibleRef.current) startAttempt();
      });
    });
    return () => {
      cancelled = true;
      if (visibleRef.current) {
        visibleRef.current = false;
        void invalidateAttempt();
      }
    };
  }, [invalidateAttempt, props.visible, startAttempt]);

  const onRequestClose = props.onRequestClose;
  const close = useCallback(() => {
    visibleRef.current = false;
    void invalidateAttempt();
    onRequestClose();
  }, [invalidateAttempt, onRequestClose]);

  const submitCode = useCallback(() => {
    if (!isActiveState(state) || state.phase === "submitting") return;
    const attemptId = state.attempt.attemptId;
    const generation = attemptGenerationRef.current;
    const requestForAttempt = activeRequestRef.current;
    const trimmedCode = code.trim();
    if (
      requestForAttempt === null ||
      activeAttemptIdRef.current !== attemptId ||
      trimmedCode.length === 0
    ) {
      return;
    }

    updateState({ phase: "submitting", attempt: state.attempt });
    void actionsRef.current
      .submitCode({
        ...requestForAttempt,
        attemptId,
        code: trimmedCode,
      })
      .then((status) => {
        if (!isCurrentAttempt(generation, attemptId)) return;
        const nextState = transitionClaudeReauthenticationState({
          previous: stateRef.current,
          attempt: state.attempt,
          status,
        });
        if (nextState.phase === "success") {
          finishSuccess(generation, attemptId, status);
        } else if (nextState.phase === "error") {
          stopPolling();
          activeAttemptIdRef.current = null;
          activeRequestRef.current = null;
          updateState(nextState);
        } else {
          updateState(nextState);
        }
      })
      .catch((cause: unknown) => {
        if (!isCurrentAttempt(generation, attemptId)) return;
        stopPolling();
        updateState({
          phase: "error",
          message: errorMessage(cause, "Claude sign-in could not be completed."),
          attempt: state.attempt,
        });
      });
  }, [code, finishSuccess, isCurrentAttempt, state, stopPolling, updateState]);

  const retry = useCallback(async () => {
    if (stateRef.current.phase !== "error") return;
    const cancellation = invalidateAttempt();
    setCode("");
    openedAuthorizationUrlRef.current = null;
    updateState(INITIAL_STATE);
    await cancellation;
    if (visibleRef.current) startAttempt();
  }, [invalidateAttempt, startAttempt, updateState]);

  const phase = state.phase;
  const attempt = attemptFromState(state);
  const authorizationUrl = attempt?.authorizationUrl ?? null;
  const attemptId = attempt?.attemptId ?? null;
  const isSubmitting = phase === "submitting";

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
                    disabled={authorizationUrl === null || isSubmitting}
                    onPress={() => {
                      if (authorizationUrl !== null && attemptId !== null) {
                        void openAuthorizationUrl(
                          authorizationUrl,
                          attemptGenerationRef.current,
                          attemptId,
                          true,
                        );
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
                        {isSubmitting ? "Submitting…" : "Submit code"}
                      </Text>
                    </Pressable>
                  </View>
                  {isSubmitting ? (
                    <View className="flex-row items-center gap-2">
                      <ActivityIndicator colorClassName="accent-icon" size="small" />
                      <Text className="text-xs text-foreground-muted">
                        Completing Claude sign-in…
                      </Text>
                    </View>
                  ) : null}
                </>
              ) : null}

              {phase === "error" && state.message !== undefined ? (
                <ErrorBanner message={state.message} />
              ) : null}

              {phase === "success" ? (
                <View className="gap-2">
                  <View className="rounded-2xl border border-adaptive-emerald-300-a70-400-a28 bg-adaptive-emerald-100-a80-500-a12 px-4 py-3">
                    <Text className="text-sm font-t3-medium text-adaptive-emerald-700-300">
                      Claude is signed in.
                    </Text>
                  </View>
                  <Text className="px-1 text-sm text-foreground-muted">
                    {taskContinuationMessage(state.continuation, state.continuationError)}
                  </Text>
                </View>
              ) : null}

              <View className="flex-row justify-end gap-2 pt-1">
                {phase === "error" ? (
                  <Pressable
                    accessibilityRole="button"
                    className="min-h-11 items-center justify-center rounded-2xl border border-border px-4 py-2 active:bg-subtle"
                    onPress={() => void retry()}
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
