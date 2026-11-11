import { describe, expect, it } from "vite-plus/test";

import {
  type CloudAccountSource,
  createCloudAccountService,
  planCloudAccountStep,
} from "./cloudAccountService.ts";

type Emit = (user: { readonly id: string } | null | undefined) => void;

function makeSource() {
  let listener: Parameters<CloudAccountSource["addListener"]>[0] | null = null;
  const source: CloudAccountSource = {
    addListener: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
  };
  const emit: Emit = (user) => listener?.({ user });
  return { source, emit, isSubscribed: () => listener !== null };
}

function makeService() {
  const log: string[] = [];
  const activated: Array<PromiseWithResolvers<void>> = [];
  const cleanedUp: Array<PromiseWithResolvers<void>> = [];
  const gates = new Map<
    string,
    { readonly started: PromiseWithResolvers<void>; readonly release: PromiseWithResolvers<void> }
  >();
  const service = createCloudAccountService<CloudAccountSource>({
    deactivate: () => log.push("deactivate"),
    detach: () => log.push("detach"),
    onSignOutTransition: () => log.push("signOutTransition"),
    cleanUp: async ({ accountId, wasActive }) => {
      log.push(`cleanUp:${accountId}:${wasActive}`);
      cleanedUp.shift()?.resolve();
    },
    prepare: async ({ accountId }) => {
      log.push(`prepare:${accountId}`);
      const gate = gates.get(accountId);
      gate?.started.resolve();
      await gate?.release.promise;
    },
    activate: ({ accountId, isAccountTransition }) => {
      log.push(`activate:${accountId}:${isAccountTransition}`);
      activated.shift()?.resolve();
    },
  });
  const nextActivation = () => {
    const deferred = Promise.withResolvers<void>();
    activated.push(deferred);
    return deferred.promise;
  };
  const nextCleanUp = () => {
    const deferred = Promise.withResolvers<void>();
    cleanedUp.push(deferred);
    return deferred.promise;
  };
  const gate = (accountId: string) => {
    const deferred = {
      started: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    gates.set(accountId, deferred);
    return deferred;
  };
  return { service, log, nextActivation, nextCleanUp, gate };
}

describe("planCloudAccountStep", () => {
  it("treats the first observation as a non-transition", () => {
    expect(planCloudAccountStep(undefined, "a")).toEqual({
      _tag: "SignIn",
      accountId: "a",
      switchFromAccountId: null,
      isAccountTransition: false,
    });
    expect(planCloudAccountStep(undefined, null)).toEqual({
      _tag: "SignOut",
      previousAccountId: null,
      isAccountTransition: false,
    });
  });

  it("ignores repeats and switches from the previous account", () => {
    expect(planCloudAccountStep("a", "a")).toEqual({ _tag: "None" });
    expect(planCloudAccountStep(null, null)).toEqual({ _tag: "None" });
    expect(planCloudAccountStep("a", "b")).toEqual({
      _tag: "SignIn",
      accountId: "b",
      switchFromAccountId: "a",
      isAccountTransition: true,
    });
  });
});

describe("createCloudAccountService", () => {
  it("activates once per account however often Clerk emits", async () => {
    const { service, log, nextActivation } = makeService();
    const { source, emit } = makeSource();
    service.attach(source);

    emit(undefined);
    expect(service.getState()).toEqual({ _tag: "Unobserved" });
    const activation = nextActivation();
    emit({ id: "a" });
    emit({ id: "a" });
    expect(service.getState()).toEqual({ _tag: "Activating", accountId: "a" });
    await activation;

    expect(service.getState()).toEqual({ _tag: "Active", accountId: "a" });
    expect(log).toEqual(["prepare:a", "activate:a:false"]);
  });

  it("drops credentials synchronously and cleans up before activating the next account", async () => {
    const { service, log, nextActivation } = makeService();
    const { source, emit } = makeSource();
    service.attach(source);
    const first = nextActivation();
    emit({ id: "a" });
    await first;
    log.length = 0;

    const second = nextActivation();
    emit({ id: "b" });
    expect(log).toEqual(["deactivate"]);
    await second;

    expect(log).toEqual(["deactivate", "cleanUp:a:true", "prepare:b", "activate:b:true"]);
  });

  it("cleans up on sign-out, including a signed-out first observation", async () => {
    const { service, log, nextActivation, nextCleanUp } = makeService();
    const { source, emit } = makeSource();
    service.attach(source);

    const initialCleanUp = nextCleanUp();
    emit(null);
    await initialCleanUp;
    expect(log).toEqual(["deactivate", "cleanUp:null:false"]);

    const activation = nextActivation();
    emit({ id: "a" });
    await activation;
    log.length = 0;

    const cleanUp = nextCleanUp();
    emit(null);
    await cleanUp;
    expect(service.getState()).toEqual({ _tag: "SignedOut" });
    expect(log).toEqual(["signOutTransition", "deactivate", "cleanUp:a:true"]);
  });

  it("never activates an account that signed out while it was activating", async () => {
    const { service, log, nextCleanUp, gate } = makeService();
    const { source, emit } = makeSource();
    service.attach(source);
    const prepared = gate("a");
    emit({ id: "a" });
    await prepared.started.promise;
    const cleanUp = nextCleanUp();
    emit(null);
    prepared.release.resolve();
    await cleanUp;

    expect(service.getState()).toEqual({ _tag: "SignedOut" });
    expect(log).toEqual(["prepare:a", "signOutTransition", "deactivate", "cleanUp:a:false"]);
  });

  it("retries a rejected activation on the next emission for the same account", async () => {
    const log: string[] = [];
    const failed = Promise.withResolvers<void>();
    const activated = Promise.withResolvers<void>();
    let attempts = 0;
    const service = createCloudAccountService<CloudAccountSource>({
      deactivate: () => log.push("deactivate"),
      detach: () => log.push("detach"),
      cleanUp: async ({ accountId, wasActive }) => {
        log.push(`cleanUp:${accountId}:${wasActive}`);
      },
      prepare: async ({ accountId }) => {
        attempts += 1;
        log.push(`prepare:${accountId}`);
        if (attempts === 1) {
          // Queued before the rejection, so the service's catch runs before
          // the test's `await failed.promise` continuation.
          queueMicrotask(failed.resolve);
          throw new Error("restore failed");
        }
      },
      activate: ({ accountId, isAccountTransition }) => {
        log.push(`activate:${accountId}:${isAccountTransition}`);
        activated.resolve();
      },
    });
    const { source, emit } = makeSource();
    service.attach(source);
    emit(null);
    emit({ id: "a" });
    await failed.promise;
    expect(service.getState()).toMatchObject({ _tag: "Failed", accountId: "a" });

    emit({ id: "a" });
    await activated.promise;

    expect(service.getState()).toEqual({ _tag: "Active", accountId: "a" });
    expect(log).toEqual([
      "deactivate",
      "cleanUp:null:false",
      "prepare:a",
      "prepare:a",
      "activate:a:true",
    ]);
  });

  it("detaches from a replaced Clerk instance", () => {
    const { service, log } = makeService();
    const first = makeSource();
    const second = makeSource();
    service.attach(first.source);
    service.attach(second.source);

    expect(first.isSubscribed()).toBe(false);
    expect(second.isSubscribed()).toBe(true);
    expect(log).toEqual(["detach"]);
  });

  it("releases credentials and stops observing when detached", async () => {
    const { service, log, nextActivation } = makeService();
    const { source, emit, isSubscribed } = makeSource();
    const detach = service.attach(source);
    const activation = nextActivation();
    emit({ id: "a" });
    await activation;

    detach();
    expect(isSubscribed()).toBe(false);
    expect(service.getState()).toEqual({ _tag: "Unobserved" });
    expect(log).toEqual(["prepare:a", "activate:a:false", "detach"]);
  });
});
