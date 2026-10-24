import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSelfUpdateCapability,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const Item = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literals(["app", "server", "provider"]),
  environmentId: EnvironmentId,
  label: Schema.String,
  fromVersion: Schema.NullOr(Schema.String),
  targetVersion: Schema.String,
  driver: Schema.NullOr(ProviderDriverKind),
  instanceId: Schema.NullOr(ProviderInstanceId),
  continueThreads: Schema.Boolean,
  autoResume: Schema.optionalKey(Schema.Boolean),
  status: Schema.Literals(["pending", "claimed", "done", "failed", "skipped", "unknown"]),
  claimId: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  retryRequested: Schema.optionalKey(Schema.Boolean),
  selfUpdate: Schema.optionalKey(ServerSelfUpdateCapability),
});
export type UpdatePlanItem = typeof Item.Type;

export const UpdateExecutionPlan = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Schema.String,
  primaryEnvironmentId: Schema.NullOr(EnvironmentId),
  sourceVersion: Schema.String,
  createdAt: Schema.Number,
  phase: Schema.Literals(["local", "awaiting-local", "servers", "providers", "paused", "complete"]),
  pausedReason: Schema.NullOr(
    Schema.Literals([
      "later",
      "download-failed",
      "install-refused",
      "wrong-version",
      "not-applied",
      "expired",
      "storage",
      "unknown",
    ]),
  ),
  items: Schema.Array(Item),
});
export type UpdateExecutionPlan = typeof UpdateExecutionPlan.Type;

export interface UpdatePlanStore {
  read(): Promise<UpdateExecutionPlan | null>;
  change(
    update: (plan: UpdateExecutionPlan | null) => UpdateExecutionPlan | null,
  ): Promise<UpdateExecutionPlan | null>;
}

export type ItemResolution =
  | { readonly status: "ready" }
  | { readonly status: "wait" }
  | { readonly status: "done" | "skipped" | "failed" | "unknown"; readonly message?: string };

export interface UpdatePlanPorts {
  readonly claimId: string;
  readonly recoveringClaims?: boolean;
  readonly isClaimOwnerAlive?: (claimId: string | null) => Promise<boolean>;
  readonly appVersion: string;
  readonly now: () => number;
  readonly ready: (plan: UpdateExecutionPlan) => boolean;
  readonly notAppliedVersion: () => string | null;
  readonly resolve: (item: UpdatePlanItem, recovering: boolean) => ItemResolution;
  readonly download: (item: UpdatePlanItem) => Promise<boolean>;
  readonly waitForMaintenance: () => Promise<void>;
  readonly maintenanceReady: () => boolean;
  readonly countdown: () => Promise<boolean>;
  readonly install: (item: UpdatePlanItem) => Promise<boolean>;
  readonly execute: (item: UpdatePlanItem) => Promise<ItemResolution>;
}

const UPDATE_PLAN_MAX_AGE_MS = 60 * 60 * 1000;

export const exactUpdateVersion = (a: string, b: string) =>
  a.replace(/^v/, "") === b.replace(/^v/, "");

export async function runUpdatePlan(store: UpdatePlanStore, ports: UpdatePlanPorts): Promise<void> {
  const initial = await store.read();
  if (!initial || initial.phase === "paused" || initial.phase === "complete") return;
  const change = (update: (plan: UpdateExecutionPlan) => UpdateExecutionPlan) =>
    store.change((plan) => (plan?.id === initial.id ? update(plan) : plan));
  const pause = (reason: NonNullable<UpdateExecutionPlan["pausedReason"]>) =>
    change((plan) => ({
      ...plan,
      phase: "paused",
      pausedReason: reason,
    }));
  const pauseAbandonedClaim = async (item: UpdatePlanItem) => {
    if (
      ports.isClaimOwnerAlive
        ? await ports.isClaimOwnerAlive(item.claimId)
        : !ports.recoveringClaims
    )
      return;
    await change((plan) =>
      plan.phase === initial.phase &&
      plan.items.some(
        (current) =>
          current.key === item.key &&
          current.status === "claimed" &&
          current.claimId === item.claimId,
      )
        ? { ...plan, phase: "paused", pausedReason: "unknown" }
        : plan,
    );
  };
  if (
    ports.now() < initial.createdAt ||
    ports.now() - initial.createdAt >= UPDATE_PLAN_MAX_AGE_MS
  ) {
    await pause("expired");
    return;
  }
  if (!ports.ready(initial)) return;
  if (
    initial.items.some(
      (item) =>
        item.kind === "server" &&
        (item.status === "unknown" ||
          (initial.phase === "providers" &&
            (item.status === "pending" || item.status === "claimed"))),
    )
  ) {
    await pause("unknown");
    return;
  }
  const settle = (item: UpdatePlanItem, result: ItemResolution) => {
    if (result.status === "wait" || result.status === "ready") return Promise.resolve(null);
    return change((plan) => {
      const matches = (current: UpdatePlanItem) =>
        current.key === item.key &&
        current.status === item.status &&
        current.claimId === item.claimId;
      if (!plan.items.some(matches)) return plan;
      return {
        ...plan,
        ...(item.kind === "server" &&
        result.status === "unknown" &&
        plan.phase !== "paused" &&
        plan.phase !== "complete"
          ? { phase: "paused" as const, pausedReason: "unknown" as const }
          : {}),
        items: plan.items.map((current) =>
          matches(current)
            ? { ...current, status: result.status, message: result.message ?? null }
            : current,
        ),
      };
    });
  };
  const releaseUndispatched = (item: UpdatePlanItem) =>
    change((plan) => {
      const matches = (current: UpdatePlanItem) =>
        current.key === item.key &&
        current.status === "claimed" &&
        current.claimId === ports.claimId &&
        current.claimId === item.claimId;
      if (!plan.items.some(matches)) return plan;
      return {
        ...plan,
        ...(item.kind === "app" && plan.phase === "awaiting-local"
          ? { phase: "local" as const }
          : {}),
        items: plan.items.map((current) =>
          matches(current) ? { ...current, status: "pending", claimId: null } : current,
        ),
      };
    });
  const claim = async (item: UpdatePlanItem) => {
    let claimed = false;
    await change((plan) => ({
      ...plan,
      items: plan.items.map((current) => {
        if (
          plan.phase !== initial.phase ||
          current.key !== item.key ||
          current.status !== "pending"
        )
          return current;
        claimed = true;
        return { ...current, status: "claimed", claimId: ports.claimId };
      }),
    }));
    return claimed ? { ...item, status: "claimed" as const, claimId: ports.claimId } : null;
  };
  const app = initial.items.find((item) => item.kind === "app");
  if (app?.status === "done" && !exactUpdateVersion(ports.appVersion, app.targetVersion)) return;
  if (
    (!app || app.status === "skipped") &&
    !exactUpdateVersion(ports.appVersion, initial.sourceVersion) &&
    !initial.items.some(
      (item) =>
        item.kind === "server" &&
        item.environmentId === initial.primaryEnvironmentId &&
        exactUpdateVersion(ports.appVersion, item.targetVersion),
    )
  ) {
    await pause("wrong-version");
    return;
  }
  if (initial.phase === "awaiting-local") {
    if (!app || app.claimId === ports.claimId) return;
    if (ports.notAppliedVersion() === app.targetVersion) {
      await pause("not-applied");
      return;
    }
    if (exactUpdateVersion(ports.appVersion, initial.sourceVersion)) {
      await pauseAbandonedClaim(app);
      return;
    }
    if (!exactUpdateVersion(ports.appVersion, app.targetVersion)) {
      await pause("wrong-version");
      return;
    }
    await settle(app, { status: "done" });
    await change((plan) =>
      plan.phase === "awaiting-local" ? { ...plan, phase: "servers" } : plan,
    );
    return runUpdatePlan(store, ports);
  }
  if (initial.phase === "local") {
    if (!app) return;
    if (app.status === "claimed") {
      if (app.claimId !== ports.claimId) await pauseAbandonedClaim(app);
      return;
    }
    const claimed = await claim(app);
    if (!claimed) return;
    if (!(await ports.download(claimed))) {
      await pause("download-failed");
      return;
    }
    try {
      await ports.waitForMaintenance();
    } catch {
      await pause("unknown");
      return;
    }
    const beforeCountdown = await store.read();
    if (
      beforeCountdown?.id !== initial.id ||
      beforeCountdown.phase !== "local" ||
      !ports.ready(beforeCountdown)
    ) {
      await releaseUndispatched(claimed);
      return;
    }
    if (!(await ports.countdown())) {
      await pause("later");
      return;
    }
    try {
      await ports.waitForMaintenance();
    } catch {
      await pause("unknown");
      return;
    }
    const beforeInstall = await store.read();
    if (
      beforeInstall?.id !== initial.id ||
      beforeInstall.phase !== "local" ||
      !ports.ready(beforeInstall)
    ) {
      await releaseUndispatched(claimed);
      return;
    }
    const awaiting = await change((plan) =>
      plan.phase === "local" ? { ...plan, phase: "awaiting-local" } : plan,
    );
    try {
      await ports.waitForMaintenance();
    } catch {
      await pause("unknown");
      return;
    }
    const admitted = await store.read();
    if (
      awaiting?.phase !== "awaiting-local" ||
      admitted?.id !== initial.id ||
      admitted.phase !== "awaiting-local" ||
      !ports.ready(admitted) ||
      !admitted.items.some(
        (item) =>
          item.key === claimed.key && item.status === "claimed" && item.claimId === ports.claimId,
      ) ||
      !ports.maintenanceReady()
    ) {
      await releaseUndispatched(claimed);
      return;
    }
    if (!(await ports.install(claimed))) await pause("install-refused");
    return;
  }
  const kind = initial.phase === "servers" ? "server" : "provider";
  await Promise.all(
    initial.items
      .filter((item) => item.kind === kind)
      .map(async (item) => {
        if (item.status !== "pending" && item.status !== "claimed") return;
        if (item.status === "claimed") {
          if (item.claimId !== ports.claimId) {
            const resolution = ports.resolve(item, true);
            if (resolution.status === "unknown" || resolution.status === "ready") {
              await pauseAbandonedClaim(item);
            } else await settle(item, resolution);
          }
          return;
        }
        if (
          kind === "provider" &&
          initial.items.some(
            (server) =>
              server.kind === "server" &&
              server.environmentId === item.environmentId &&
              server.status !== "done",
          )
        ) {
          await settle(item, {
            status: "skipped",
            message: "T3 update did not finish on this device",
          });
          return;
        }
        const resolution = ports.resolve(item, false);
        if (resolution.status !== "ready") {
          await settle(item, resolution);
          return;
        }
        const claimed = await claim(item);
        if (!claimed) return;
        const beforeDispatch = await store.read();
        if (
          beforeDispatch?.id !== initial.id ||
          beforeDispatch.phase !== initial.phase ||
          !ports.ready(beforeDispatch) ||
          !beforeDispatch.items.some(
            (current) =>
              current.key === claimed.key &&
              current.status === "claimed" &&
              current.claimId === ports.claimId,
          )
        ) {
          await releaseUndispatched(claimed);
          return;
        }
        if (
          kind === "provider" &&
          beforeDispatch.items.some(
            (server) =>
              server.kind === "server" &&
              (server.status === "pending" ||
                server.status === "claimed" ||
                server.status === "unknown"),
          )
        ) {
          await releaseUndispatched(claimed);
          await pause("unknown");
          return;
        }
        const fresh = ports.resolve(claimed, false);
        if (fresh.status !== "ready") {
          if (fresh.status === "wait") await releaseUndispatched(claimed);
          else await settle(claimed, fresh);
          return;
        }
        let result: ItemResolution;
        try {
          result = await ports.execute(claimed);
        } catch (error) {
          result = {
            status: "failed",
            message: error instanceof Error ? error.message : "Update failed",
          };
        }
        if (result.status === "ready" || result.status === "wait")
          result = { status: "unknown", message: "Update did not return a confirmed result" };
        await settle(claimed, result);
      }),
  );
  const final = await change((plan) => {
    if (
      plan.phase === initial.phase &&
      plan.items.some((item) => item.kind === "server" && item.status === "unknown")
    )
      return {
        ...plan,
        phase: "paused",
        pausedReason: "unknown",
      };
    if (
      plan.phase !== initial.phase ||
      plan.items.some(
        (item) => item.kind === kind && (item.status === "pending" || item.status === "claimed"),
      )
    )
      return plan;
    return { ...plan, phase: kind === "server" ? "providers" : "complete" };
  });
  if (final?.phase === "providers" && initial.phase === "servers")
    await runUpdatePlan(store, ports);
}
