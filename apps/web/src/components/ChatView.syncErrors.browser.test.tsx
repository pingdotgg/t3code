import { createMemoryHistory } from "@tanstack/react-router";
import {
  EnvironmentAuthorizationError,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2DispatchCommandError,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadDetails } from "~/state/threads";
import {
  ENVIRONMENT_ID,
  fakeDriver,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

// The environment session outlives a render, so its failing subscriptions need their own file.
it("keeps synchronization failures separate from local errors and first-load send eligibility", async () => {
  const cold = threadWithHistory("cold-sync-failure", 1);
  const warm = threadWithHistory("warm-sync-failure", 1);
  using _environment = installFakeEnvironment([cold, warm]);
  const firstFailure = Deferred.makeUnsafe<void>();
  const nextFailure = Deferred.makeUnsafe<void>();
  let warmSubscriptions = 0;
  const connect = fakeDriver.connect;
  using _connect = vi.spyOn(fakeDriver, "connect").mockImplementation((entry) =>
    connect(entry).pipe(
      Effect.map((lease) => ({
        ...lease,
        session: {
          ...lease.session,
          client: new Proxy(lease.session.client, {
            get(target, method, receiver) {
              if (method === ORCHESTRATION_V2_WS_METHODS.subscribeThread) {
                return (
                  input: Parameters<
                    (typeof target)[typeof ORCHESTRATION_V2_WS_METHODS.subscribeThread]
                  >[0],
                ) => {
                  if (input.threadId === cold.id) {
                    return Stream.fail(
                      new EnvironmentAuthorizationError({
                        message: "Thread history unavailable",
                        requiredScope: "orchestration:read",
                      }),
                    );
                  }
                  warmSubscriptions += 1;
                  const initial =
                    warmSubscriptions === 1
                      ? target[ORCHESTRATION_V2_WS_METHODS.subscribeThread](input).pipe(
                          Stream.take(2),
                        )
                      : Stream.empty;
                  return initial.pipe(
                    Stream.concat(
                      Stream.fromEffect(
                        Deferred.await(warmSubscriptions === 1 ? firstFailure : nextFailure).pipe(
                          Effect.andThen(Effect.die(new Error("Broken thread stream"))),
                        ),
                      ),
                    ),
                  );
                };
              }
              if (method === ORCHESTRATION_V2_WS_METHODS.dispatchCommand) {
                return (
                  command: Parameters<
                    (typeof target)[typeof ORCHESTRATION_V2_WS_METHODS.dispatchCommand]
                  >[0],
                ) =>
                  Effect.fail(
                    new OrchestrationV2DispatchCommandError({
                      commandId: command.commandId,
                      commandType: command.type,
                      message: "Local send failed",
                    }),
                  );
              }
              return Reflect.get(target, method, receiver);
            },
          }),
        },
      })),
    ),
  );
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${cold.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("Thread history unavailable", { exact: true })).toBeVisible();
  await page.getByTestId("composer-editor").fill("Do not send before history arrives");
  await expect
    .element(page.getByRole("button", { name: /^(Submit message|Messages loading)$/ }))
    .toBeDisabled();

  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: warm.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${warm.id}.`)).toBeVisible();
  await act(() => Deferred.doneUnsafe(firstFailure, Effect.void));
  const syncFailure = page.getByText("Could not synchronize the thread.", { exact: true });
  await expect.element(syncFailure).toBeVisible();
  const threadState = environmentThreadDetails.stateAtom({
    environmentId: ENVIRONMENT_ID,
    threadId: warm.id,
  });
  const firstSyncFailure = appAtomRegistry.get(threadState).error;
  await page.getByTestId("composer-editor").fill("Retry the work");
  await page.getByRole("button", { name: "Submit message", exact: true }).click();
  await expect.element(page.getByTestId("composer-editor")).toHaveTextContent("Retry the work");
  await expect.element(page.getByText("Local send failed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Dismiss error" }).click();
  await expect
    .element(page.getByText("Local send failed", { exact: true }))
    .not.toBeInTheDocument();

  await expect.element(syncFailure).toBeVisible();
  await page.getByRole("button", { name: "Dismiss error" }).click();
  await expect.element(syncFailure).not.toBeInTheDocument();

  document.dispatchEvent(new Event("visibilitychange"));
  await vi.waitFor(() => expect(warmSubscriptions).toBe(2));
  await act(() => Deferred.doneUnsafe(nextFailure, Effect.void));
  await vi.waitFor(() => {
    const failure = appAtomRegistry.get(threadState).error;
    expect(failure).toMatchObject({ _tag: "Some", value: "Could not synchronize the thread." });
    expect(failure).not.toBe(firstSyncFailure);
  });
  await expect.element(syncFailure).not.toBeInTheDocument();
  await expect
    .element(page.getByText("Local send failed", { exact: true }))
    .not.toBeInTheDocument();
});
