import type * as machines from "@distilled.cloud/fly-io/machines";
import type { ScratchStack } from "@/Test/Alchemy";
import { scratchStack } from "@/Test/Core";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import {
  throughProxy,
  transportProxy,
  type TransportEvent,
} from "./transport.ts";

const metadataKeys = [
  "alchemy.stack",
  "alchemy.stage",
  "alchemy.id",
  "alchemy.type",
  "alchemy.replica",
  "alchemy.instance",
  "alchemy.fqn",
  "alchemy.base-name",
  "alchemy.generation",
  "alchemy.workload",
  "alchemy.sequence",
  "alchemy.count",
  "alchemy.image",
  "alchemy.phase",
  "alchemy.deployment-protocol",
  "alchemy.readiness-roles",
  "alchemy.readiness-role",
  "alchemy.predecessors",
  "alchemy.idle-policy-restored",
  "alchemy.checked-instance",
  "alchemy.min-secrets-version",
];

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown) =>
  typeof value === "string" ? value : undefined;
const metadataOf = (value: unknown) => {
  const metadata = record(value);
  return Object.fromEntries(
    metadataKeys.flatMap((key) =>
      typeof metadata[key] === "string" ? [[key, metadata[key] as string]] : [],
    ),
  );
};
const servicesOf = (value: unknown) =>
  Array.isArray(value)
    ? value.map((item) => {
        const service = record(item);
        return {
          protocol: string(service.protocol),
          port:
            typeof service.internal_port === "number"
              ? service.internal_port
              : undefined,
          autostop:
            service.autostop === true
              ? "stop"
              : service.autostop === "stop" || service.autostop === "suspend"
                ? service.autostop
                : "off",
          autostart:
            typeof service.autostart === "boolean"
              ? service.autostart
              : undefined,
          floor:
            typeof service.min_machines_running === "number"
              ? service.min_machines_running
              : undefined,
          ...(Array.isArray(service.checks)
            ? {
                checks: service.checks.map((value) => {
                  const check = record(value);
                  return {
                    type: string(check.type),
                    port:
                      typeof check.port === "number" ? check.port : undefined,
                    interval: string(check.interval),
                    timeout: string(check.timeout),
                    gracePeriod: string(check.grace_period),
                    method: string(check.method),
                    protocol: string(check.protocol),
                  };
                }),
              }
            : {}),
        };
      })
    : [];

export interface ReadinessEvent extends TransportEvent {
  metadata?: Record<string, string>;
  metadataOnly?: boolean;
  skipLaunch?: boolean;
  services?: ReturnType<typeof servicesOf>;
  serviceConfig?: string;
}

/** Only these two excluded suites install this observer; bodies and headers are never retained. */
export const readinessProxy = () =>
  transportProxy().pipe(
    Effect.map((proxy) => ({ ...proxy, readiness: [] as ReadinessEvent[] })),
    Effect.tap((proxy) =>
      Effect.addFinalizer(() =>
        Effect.forEach(
          Array.from(
            { length: Math.ceil(proxy.readiness.length / 50) },
            (_, index) => index,
          ),
          (index) =>
            Effect.logInfo("Idle/cadence readiness journal", {
              offset: index * 50,
              events: proxy.readiness.slice(index * 50, (index + 1) * 50),
            }),
          { discard: true },
        ),
      ),
    ),
  );

type ReadinessProxy = Effect.Success<ReturnType<typeof readinessProxy>>;

export const readinessActor = (
  parent: ScratchStack,
  title: string,
  file: string,
  proxy: ReadinessProxy,
  beforeRequest?: (event: ReadinessEvent) => Effect.Effect<void>,
) =>
  Effect.sync(() => {
    const observer = Layer.effect(
      HttpClient.HttpClient,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return HttpClient.transform(client, (response, request) =>
          Effect.gen(function* () {
            const event = yield* Effect.sync(() => {
              const path = new URL(request.url).pathname;
              if (!/\/apps\/[^/]+\/machines(?:\/|$)/.test(path))
                return undefined;
              const event: ReadinessEvent = {
                sequence: proxy.readiness.length,
                stage: "request",
                method: request.method,
                path,
                machineId: path.match(/\/machines\/([^/]+)/)?.[1],
              };
              if (request.body._tag === "Uint8Array") {
                try {
                  const body = record(
                    JSON.parse(new TextDecoder().decode(request.body.body)),
                  );
                  const config = record(body.config);
                  const metadata = record(body.metadata ?? config.metadata);
                  event.metadata = metadataOf(metadata);
                  event.phase = event.metadata["alchemy.phase"];
                  event.skipLaunch =
                    typeof body.skip_launch === "boolean"
                      ? body.skip_launch
                      : undefined;
                  event.metadataOnly =
                    Object.keys(body).length === 1 &&
                    "metadata" in body &&
                    Object.keys(metadata).every(
                      (key) =>
                        metadataKeys.includes(key) &&
                        typeof metadata[key] === "string",
                    );
                } catch {
                  // An unreadable body cannot qualify for the bookkeeping exemption.
                }
              }
              proxy.readiness.push(event);
              return event;
            });
            if (event && beforeRequest) yield* beforeRequest(event);
            const result = yield* response;
            if (event) {
              const value =
                result.status >= 200 &&
                result.status < 300 &&
                /\/machines(?:\/[^/]+)?$/.test(event.path)
                  ? yield* result.json.pipe(
                      Effect.catch(() => Effect.succeed(undefined)),
                    )
                  : undefined;
              yield* Effect.sync(() => {
                const machine = record(value);
                const config = record(machine.config);
                const observed: ReadinessEvent = {
                  ...event,
                  // Receipt here is after the unmodified proxy forwarded the response.
                  stage: "forwarded",
                  status: result.status,
                };
                if (typeof machine.id === "string") {
                  observed.machineId = machine.id;
                  observed.instanceId = string(machine.instance_id);
                  observed.state = string(machine.state);
                  observed.cordoned =
                    typeof machine.cordoned === "boolean"
                      ? machine.cordoned
                      : undefined;
                  observed.digest = string(record(machine.image_ref).digest);
                  observed.metadata = metadataOf(config.metadata);
                  observed.phase = observed.metadata["alchemy.phase"];
                  observed.services = servicesOf(config.services);
                  observed.serviceConfig = JSON.stringify(observed.services);
                  observed.checks = Array.isArray(machine.checks)
                    ? machine.checks.map((item) => {
                        const check = record(item);
                        return {
                          name: string(check.name),
                          status: string(check.status),
                        };
                      })
                    : [];
                }
                proxy.readiness.push(observed);
              });
            }
            return result;
          }),
        );
      }),
    ).pipe(Layer.provideMerge(throughProxy(() => proxy.url)));
    const actor = scratchStack(
      { providers: observer, stage: parent.stage },
      title,
      file,
    );
    expect(actor.name).toBe(parent.name);
    expect(actor.stage).toBe(parent.stage);
    expect(actor.state).not.toBe(parent.state);
    return actor;
  });

export const retires = (event: TransportEvent, ids: readonly string[]) =>
  event.stage === "request" &&
  ids.includes(event.machineId!) &&
  (event.path.endsWith("/cordon") ||
    event.path.endsWith("/stop") ||
    event.path.endsWith("/suspend") ||
    (event.path.endsWith("/metadata") && event.phase === "retiring") ||
    (event.method === "DELETE" && /\/machines\/[^/]+$/.test(event.path)));

const identity = (metadata: Record<string, string> | undefined) =>
  Object.fromEntries(
    Object.entries(metadata ?? {}).filter(
      ([key]) => key !== "alchemy.phase" && key !== "alchemy.checked-instance",
    ),
  );

export const readinessChecksPassing = (
  checks: ReadinessEvent["checks"],
  expected: readonly string[],
) => {
  if (
    !checks ||
    expected.length === 0 ||
    new Set(expected).size !== expected.length
  )
    return false;
  const allowed = new Set([
    ...expected,
    ...expected
      .filter((name) => name.startsWith("servicecheck-"))
      .map(
        (name) => `bg_deployments_compat-${name.slice("servicecheck-".length)}`,
      ),
  ]);
  const reported = new Set(checks.map((check) => check.name));
  return (
    reported.size === checks.length &&
    expected.every((name) => reported.has(name)) &&
    checks.every(
      (check) =>
        check.name !== undefined &&
        allowed.has(check.name) &&
        check.status === "passing",
    )
  );
};

const sameMetadata = (left: ReadinessEvent, right: ReadinessEvent) =>
  left.method === "PUT" &&
  right.method === "PUT" &&
  left.path.endsWith("/metadata") &&
  left.path === right.path &&
  left.metadataOnly === true &&
  right.metadataOnly === true &&
  left.metadata !== undefined &&
  right.metadata !== undefined &&
  JSON.stringify(Object.entries(left.metadata).sort()) ===
    JSON.stringify(Object.entries(right.metadata).sort());

/** Fresh GET receipt proves observation order, not the remote check sample's timestamp. */
export const assertReadinessCommit = (
  events: readonly ReadinessEvent[],
  priorIds: readonly string[],
  candidates: machines.Machine[],
  runningSlots: readonly number[],
  checkNames: readonly string[],
  allowIdle: boolean,
) => {
  const retirement =
    priorIds.length > 0
      ? events.findIndex((event) => retires(event, priorIds))
      : events.length;
  expect(retirement).toBeGreaterThan(0);
  const ordered = [...candidates].sort(
    (a, b) =>
      Number(a.config?.metadata?.["alchemy.replica"]) -
      Number(b.config?.metadata?.["alchemy.replica"]),
  );
  const ids = ordered.map((machine) => machine.id!);
  const creates = events
    .filter(
      (event) =>
        event.stage === "forwarded" &&
        event.method === "POST" &&
        event.path.endsWith("/machines") &&
        ids.includes(event.machineId!),
    )
    .map((event) => event.sequence);
  const mutations = events.filter(
    (event) =>
      event.stage === "request" &&
      event.method !== "GET" &&
      !event.path.endsWith("/lease") &&
      (ids.includes(event.machineId!) || creates.includes(event.sequence)),
  );
  const isCommit = (event: ReadinessEvent) =>
    event.method === "PUT" &&
    event.path.endsWith("/metadata") &&
    event.phase === "active" &&
    event.metadataOnly === true;
  const isValidating = (event: ReadinessEvent) =>
    event.method === "PUT" &&
    event.path.endsWith("/metadata") &&
    event.phase === "validating" &&
    event.metadataOnly === true;
  const successful = (event: ReadinessEvent) =>
    event.status! >= 200 && event.status! < 300;
  const operations: {
    request: ReadinessEvent;
    machineId: string;
    completed: number;
  }[] = [];
  for (const request of mutations) {
    const receipts = events.filter(
      (event) =>
        event.sequence === request.sequence &&
        event.stage === "forwarded" &&
        event.method === request.method &&
        event.path === request.path,
    );
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0]!;
    const completed = events.indexOf(receipt);
    const requested = events.indexOf(request);
    expect(completed).toBeGreaterThan(requested);
    expect(completed).toBeLessThan(retirement);
    const machineId = request.machineId ?? receipt.machineId!;
    if (request.path.endsWith("/start") && receipt.status === 412) {
      const candidate = ordered.find((machine) => machine.id === machineId)!;
      const commit = events.findIndex(
        (event) => isCommit(event) && event.machineId === machineId,
      );
      expect(
        events.some(
          (event, index) =>
            index > completed &&
            index < commit &&
            event.stage === "forwarded" &&
            event.method === "GET" &&
            successful(event) &&
            event.machineId === machineId &&
            event.state === "started" &&
            event.instanceId === candidate.instance_id,
        ),
      ).toBe(true);
      continue;
    }
    const previous = operations.findLast(
      (operation) => operation.machineId === machineId,
    );
    // Only settled, retryable metadata failures may join an equivalent retry.
    if (
      previous &&
      !successful(events[previous.completed]!) &&
      sameMetadata(previous.request, request)
    ) {
      expect([429, 500, 502, 503, 504]).toContain(
        events[previous.completed]!.status,
      );
      expect(previous.completed).toBeLessThan(requested);
      previous.completed = completed;
    } else {
      operations.push({ request, machineId, completed });
    }
  }
  for (const operation of operations) {
    expect(successful(events[operation.completed]!)).toBe(true);
  }
  const commits = operations.filter((operation) => isCommit(operation.request));
  expect(commits).toHaveLength(ordered.length);
  expect(commits.map((operation) => operation.machineId).sort()).toEqual(
    [...ids].sort(),
  );
  expect(commits.at(-1)?.machineId).toBe(ordered[0]!.id);
  const firstCommit = events.indexOf(commits[0]!.request);
  expect(firstCommit).toBeGreaterThan(0);
  const invalidating = operations.filter(
    (operation) => !isCommit(operation.request),
  );
  expect(invalidating.length).toBeGreaterThan(0);
  const reset = Math.max(
    ...invalidating.map((operation) => operation.completed),
  );
  expect(reset).toBeLessThan(firstCommit);
  const zeroCommit = events.indexOf(commits.at(-1)!.request);
  for (const operation of commits.slice(0, -1)) {
    expect(operation.completed).toBeLessThan(zeroCommit);
  }

  for (const [slot, machine] of ordered.entries()) {
    const id = machine.id!;
    const run = runningSlots.includes(slot);
    const commit = commits.find(
      (operation) => operation.machineId === id,
    )!.request;
    const finalMetadata = metadataOf(machine.config?.metadata);
    const finalServices = servicesOf(machine.config?.services);
    if (allowIdle) {
      expect(finalServices.length).toBeGreaterThan(0);
      expect(finalServices.every((service) => service.autostop !== "off")).toBe(
        true,
      );
    }
    expect(finalMetadata["alchemy.replica"]).toBe(String(slot));
    expect(finalMetadata["alchemy.readiness-role"]).toBe(run ? "run" : "idle");
    expect(finalMetadata["alchemy.readiness-roles"]).toBe(
      ordered
        .map((_, index) => (runningSlots.includes(index) ? "run" : "idle"))
        .join(","),
    );
    expect(finalMetadata["alchemy.phase"]).toBe("active");
    expect(finalMetadata["alchemy.idle-policy-restored"]).toBe("true");
    expect(commit.metadata).toEqual(finalMetadata);
    expect(machine.cordoned).toBe(false);
    for (const key of [
      "alchemy.stack",
      "alchemy.stage",
      "alchemy.id",
      "alchemy.type",
      "alchemy.instance",
      "alchemy.fqn",
      "alchemy.generation",
      "alchemy.workload",
      "alchemy.image",
    ]) {
      expect(finalMetadata[key]).toBeDefined();
    }
    const observations = events.flatMap((event, index) => {
      if (
        index >= firstCommit ||
        event.stage !== "forwarded" ||
        event.method !== "GET" ||
        !event.path.endsWith(`/machines/${id}`) ||
        event.machineId !== id ||
        event.status !== 200
      )
        return [];
      const requested = events.findIndex(
        (request) =>
          request.stage === "request" && request.sequence === event.sequence,
      );
      return requested >= 0 && requested < index
        ? [{ event, index, requested }]
        : [];
    });
    const pending = observations.findLast(({ requested }) => requested > reset);
    expect(pending).toBeDefined();
    if (!pending) continue;
    expect(pending.event.phase).toBe("validating");
    expect(pending.event.metadata?.["alchemy.idle-policy-restored"]).toBe(
      "true",
    );
    expect(pending.event.instanceId).toBe(machine.instance_id);
    let proof = pending;
    if (run && pending.event.state !== "started") {
      expect(allowIdle).toBe(true);
      expect(["stopped", "suspended"]).toContain(pending.event.state);
      const targetReset = Math.max(
        -1,
        ...invalidating
          .filter(
            (operation) =>
              operation.machineId === id && !isValidating(operation.request),
          )
          .map((operation) => operation.completed),
      );
      const restored = observations.findLast(
        ({ event, requested, index }) =>
          requested > targetReset &&
          index < pending.index &&
          ["promoting", "validating"].includes(event.phase ?? "") &&
          event.metadata?.["alchemy.idle-policy-restored"] === "true" &&
          event.instanceId === pending.event.instanceId &&
          event.state === "started" &&
          readinessChecksPassing(event.checks, checkNames),
      );
      expect(restored).toBeDefined();
      if (!restored) continue;
      proof = restored;
    } else if (run) {
      expect(readinessChecksPassing(proof.event.checks, checkNames)).toBe(true);
    } else {
      expect(["created", "stopped", "suspended"]).toContain(
        pending.event.state,
      );
    }
    expect(proof.event.instanceId).toBeDefined();
    expect(proof.event.digest).toBe(machine.image_ref?.digest);
    expect(proof.event.services).toEqual(finalServices);
    expect(proof.event.cordoned).toBe(false);
    expect(identity(proof.event.metadata)).toEqual(identity(finalMetadata));
    expect(commit.metadata).toEqual({
      ...pending.event.metadata,
      "alchemy.phase": "active",
      ...(run ? { "alchemy.checked-instance": proof.event.instanceId } : {}),
    });
    if (run) {
      expect(commit.metadata?.["alchemy.checked-instance"]).toBe(
        proof.event.instanceId,
      );
      expect(
        allowIdle ? ["started", "stopped", "suspended"] : ["started"],
      ).toContain(machine.state);
    } else {
      expect(["created", "stopped", "suspended"]).toContain(machine.state);
      for (const created of events.filter(
        (event) =>
          event.stage === "forwarded" &&
          event.method === "POST" &&
          event.path.endsWith("/machines") &&
          event.machineId === id,
      )) {
        expect(created.skipLaunch).toBe(true);
      }
      expect(
        events.some(
          (event) =>
            event.machineId === id &&
            ((event.stage === "request" && event.path.endsWith("/start")) ||
              (event.stage === "forwarded" && event.state === "started")),
        ),
      ).toBe(false);
    }
    // Idle proof survives only the unchanged pending stamp and final commit.
    for (const operation of invalidating.filter(
      (operation) =>
        operation.machineId === id && operation.completed > proof.index,
    )) {
      expect(isValidating(operation.request)).toBe(true);
      expect(events.indexOf(operation.request)).toBeGreaterThan(proof.index);
      expect(operation.request.metadata).toEqual({
        ...proof.event.metadata,
        "alchemy.phase": "validating",
      });
    }
    for (const later of events
      .slice(proof.index + 1)
      .filter(
        (event) =>
          event.stage === "forwarded" &&
          event.machineId === id &&
          event.status! >= 200 &&
          event.status! < 300 &&
          event.path.endsWith(`/machines/${id}`),
      )) {
      expect(later.instanceId).toBe(proof.event.instanceId);
      expect(later.digest).toBe(proof.event.digest);
      expect(later.services).toEqual(finalServices);
      expect(identity(later.metadata)).toEqual(identity(finalMetadata));
      expect(later.metadata?.["alchemy.idle-policy-restored"]).toBe("true");
      expect(["promoting", "validating", "active"]).toContain(later.phase);
      expect(later.cordoned).toBe(false);
      if (run) {
        expect(
          allowIdle ? ["started", "stopped", "suspended"] : ["started"],
        ).toContain(later.state);
        if (later.state === "started" && events.indexOf(later) < firstCommit) {
          expect(readinessChecksPassing(later.checks, checkNames)).toBe(true);
        }
        if (later.phase === "active") {
          expect(later.metadata?.["alchemy.checked-instance"]).toBe(
            proof.event.instanceId,
          );
        }
      }
    }
  }
};
