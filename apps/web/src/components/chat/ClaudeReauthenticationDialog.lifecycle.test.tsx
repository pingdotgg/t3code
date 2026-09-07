import {
  EnvironmentId,
  ProviderInstanceId,
  ServerProviderReauthenticateAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../localApi", () => ({ readLocalApi: () => undefined }));
vi.mock("lucide-react", () => ({ CircleAlertIcon: () => null }));

vi.mock("../ui/alert", () => {
  const Container = ({ children }: { readonly children?: ReactNode }) => <>{children}</>;
  return { Alert: Container, AlertDescription: Container };
});

vi.mock("../ui/button", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));

vi.mock("../ui/dialog", () => {
  const Container = ({ children }: { readonly children?: ReactNode }) => <>{children}</>;
  return {
    Dialog: Container,
    DialogDescription: Container,
    DialogFooter: Container,
    DialogHeader: Container,
    DialogPanel: Container,
    DialogPopup: Container,
    DialogTitle: Container,
  };
});

vi.mock("../ui/input", () => ({ Input: () => <input /> }));
vi.mock("../ui/spinner", () => ({ Spinner: () => <span /> }));

import {
  ClaudeReauthenticationDialog,
  type ClaudeReauthenticationActions,
  type ClaudeReauthenticationAttempt,
  type ClaudeReauthenticationBeginResult,
  type ClaudeReauthenticationCancelInput,
  type ClaudeReauthenticationRequest,
  type ClaudeReauthenticationStatus,
} from "./ClaudeReauthenticationDialog";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

const request: ClaudeReauthenticationRequest = {
  environmentId: EnvironmentId.make("environment-test"),
  threadId: ThreadId.make("thread-test"),
  providerInstanceId: ProviderInstanceId.make("claude-test"),
};

function attempt(id: string): ClaudeReauthenticationAttempt {
  return {
    attemptId: ServerProviderReauthenticateAttemptId.make(id),
    authorizationUrl: `https://claude.example/${id}`,
  };
}

const succeededStatus: ClaudeReauthenticationStatus = {
  status: "succeeded",
  authorizationUrl: null,
  error: null,
  continuation: null,
  continuationError: null,
};

interface Harness {
  readonly actions: ClaudeReauthenticationActions;
  readonly begins: Array<Deferred<ClaudeReauthenticationBeginResult>>;
  readonly cancellations: Array<{
    readonly input: ClaudeReauthenticationCancelInput;
    readonly deferred: Deferred<void>;
  }>;
  readonly statuses: Array<Deferred<ClaudeReauthenticationStatus>>;
}

function makeHarness(): Harness {
  const begins: Array<Deferred<ClaudeReauthenticationBeginResult>> = [];
  const cancellations: Harness["cancellations"] = [];
  const statuses: Array<Deferred<ClaudeReauthenticationStatus>> = [];
  const begin = vi.fn(() => {
    const next = deferred<ClaudeReauthenticationBeginResult>();
    begins.push(next);
    return next.promise;
  });
  const cancel = vi.fn((input: ClaudeReauthenticationCancelInput) => {
    const next = { deferred: deferred<void>(), input };
    cancellations.push(next);
    return next.deferred.promise;
  });
  const getStatus = vi.fn(() => {
    const next = deferred<ClaudeReauthenticationStatus>();
    statuses.push(next);
    return next.promise;
  });
  const submitCode = vi.fn(async (): Promise<ClaudeReauthenticationStatus> => succeededStatus);

  return {
    actions: { begin, cancel, getStatus, submitCode },
    begins,
    cancellations,
    statuses,
  } satisfies Harness;
}

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
    await Promise.resolve();
  });
  renderer = null;
  vi.unstubAllGlobals();
});

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function renderDialog(open: boolean, actions: ClaudeReauthenticationActions) {
  return (
    <ClaudeReauthenticationDialog
      actions={actions}
      onOpenChange={() => {}}
      open={open}
      openAuthorizationUrl={() => undefined}
      request={request}
    />
  );
}

describe("ClaudeReauthenticationDialog lifecycle", () => {
  it("keeps the app open when a noopener sign-in popup returns null", async () => {
    const openWindow = vi.fn(() => null);
    const navigate = vi.fn();
    vi.stubGlobal("window", { open: openWindow, location: { assign: navigate } });
    const harness = makeHarness();
    await act(async () => {
      renderer = create(
        <ClaudeReauthenticationDialog
          open
          request={request}
          actions={harness.actions}
          onOpenChange={() => {}}
        />,
      );
    });
    await flushMicrotasks();
    const loginAttempt = attempt("popup");
    harness.begins[0]!.resolve(loginAttempt);
    await flushMicrotasks();
    const signInButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Open Claude sign-in"));
    expect(signInButton).toBeDefined();
    await act(async () => {
      signInButton!.props.onClick();
    });
    await flushMicrotasks();
    expect(openWindow).toHaveBeenCalledWith(
      loginAttempt.authorizationUrl,
      "_blank",
      "noopener,noreferrer",
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(harness.cancellations).toHaveLength(0);
  });

  it("waits for a deferred cancellation before starting the reopened attempt", async () => {
    const harness = makeHarness();
    await act(async () => {
      renderer = create(renderDialog(true, harness.actions));
    });
    await flushMicrotasks();
    expect(harness.begins).toHaveLength(1);

    await act(async () => {
      renderer?.update(renderDialog(false, harness.actions));
    });
    await flushMicrotasks();
    expect(harness.cancellations).toHaveLength(0);

    await act(async () => {
      renderer?.update(renderDialog(true, harness.actions));
    });
    await flushMicrotasks();
    expect(harness.begins).toHaveLength(1);

    harness.begins[0]!.resolve(attempt("old"));
    await flushMicrotasks();
    expect(harness.cancellations).toHaveLength(1);
    expect(harness.cancellations[0]!.input.attemptId).toBe(
      ServerProviderReauthenticateAttemptId.make("old"),
    );
    expect(harness.begins).toHaveLength(1);

    harness.cancellations[0]!.deferred.resolve(undefined);
    await flushMicrotasks();
    expect(harness.begins).toHaveLength(2);

    harness.begins[1]!.resolve(attempt("new"));
    await flushMicrotasks();
    expect(harness.statuses).toHaveLength(1);

    harness.statuses[0]!.resolve(succeededStatus);
    await flushMicrotasks();
    expect(JSON.stringify(renderer?.toJSON())).toContain("Claude is authenticated.");
  });

  it("also serializes a completed attempt's cancellation before reopening", async () => {
    const harness = makeHarness();
    await act(async () => {
      renderer = create(renderDialog(true, harness.actions));
    });
    await flushMicrotasks();
    harness.begins[0]!.resolve(attempt("completed"));
    await flushMicrotasks();
    expect(harness.statuses).toHaveLength(1);

    await act(async () => {
      renderer?.update(renderDialog(false, harness.actions));
    });
    await flushMicrotasks();
    expect(harness.cancellations).toHaveLength(1);

    await act(async () => {
      renderer?.update(renderDialog(true, harness.actions));
    });
    await flushMicrotasks();
    expect(harness.begins).toHaveLength(1);

    harness.cancellations[0]!.deferred.resolve(undefined);
    await flushMicrotasks();
    expect(harness.begins).toHaveLength(2);

    harness.begins[1]!.resolve(attempt("reopened"));
    await flushMicrotasks();
    expect(harness.statuses).toHaveLength(2);

    await act(async () => {
      renderer?.update(renderDialog(false, harness.actions));
    });
    await flushMicrotasks();
    expect(harness.cancellations).toHaveLength(2);
    harness.cancellations[1]!.deferred.resolve(undefined);
    await flushMicrotasks();
  });
});
