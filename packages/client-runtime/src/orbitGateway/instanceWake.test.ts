import { describe, expect, it, vi } from "vite-plus/test";

import {
  createOrbitGatewayClient,
  type OrbitGatewayRequest,
  type OrbitGatewayResponse,
} from "./client.ts";
import { fakeOperationNotices } from "./fixtures/fakeOperationNotices.ts";
import { createOrbitInstanceWaker } from "./instanceWake.ts";

const op = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 501,
  kind: "instance.wake",
  status,
  target_id: 41,
  poll_after_seconds: status === "succeeded" || status === "failed" ? null : 1,
  ...extra,
});
const ok = (data: unknown, status = 200): OrbitGatewayResponse => ({
  status,
  body: JSON.stringify({ data }),
});
const error = (status: number, code: string): OrbitGatewayResponse => ({
  status,
  body: JSON.stringify({ error: { code, message: `Orbit says ${code}.`, details: {} } }),
});

function gateway(answers: Array<OrbitGatewayResponse | Error>) {
  const requests: OrbitGatewayRequest[] = [];
  let clock = 0;
  const client = createOrbitGatewayClient(
    async (request) => {
      requests.push(request);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("no more answers");
      if (answer instanceof Error) throw answer;
      return answer;
    },
    { realtime: false },
  );
  const waker = createOrbitInstanceWaker({
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    newKey: () => "conn-wake-test",
  });
  return { client, waker, requests };
}

describe("createOrbitInstanceWaker", () => {
  it("wakes a frozen Instance whose 202 already carries a succeeded Operation", async () => {
    const { client, waker, requests } = gateway([ok(op("succeeded"), 202)]);
    await expect(waker.wake(client, 41)).resolves.toEqual({ kind: "awake" });
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/instances/41/wake",
        body: {},
        idempotencyKey: "conn-wake-test",
        root: true,
      },
    ]);
  });

  it("follows a pending wake through the generic Operation read until it succeeds", async () => {
    const { client, waker, requests } = gateway([
      ok(op("pending"), 202),
      ok(op("running")),
      ok(op("succeeded")),
    ]);
    await expect(waker.wake(client, 41)).resolves.toEqual({ kind: "awake" });
    expect(requests.slice(1)).toEqual([
      { method: "GET", path: "/operations/501", root: true },
      { method: "GET", path: "/operations/501", root: true },
    ]);
  });

  it("waits on the wake's notices with the sequence it read, not on a timer", async () => {
    const notices = fakeOperationNotices();
    const { client } = gateway([
      ok(op("pending", { sequence: 3 }), 202),
      ok(op("running", { sequence: 5 })),
      ok(op("succeeded", { sequence: 6 })),
    ]);
    const sleeps: number[] = [];
    const live = createOrbitInstanceWaker({
      now: () => 0,
      sleep: (ms) => {
        sleeps.push(ms);
        return new Promise(() => {});
      },
      newKey: () => "conn-wake-test",
    });
    const woke = live.wake({ ...client, operationNotices: notices.operationNotices }, 41);
    await vi.waitFor(() => expect(notices.waiting(501)).toBe(true));
    notices.notify(501);
    await vi.waitFor(() => expect(notices.readSequences(501)).toHaveLength(2));
    notices.notify(501);
    await expect(woke).resolves.toEqual({ kind: "awake" });
    // A notice at or below these is one the reader has already read.
    expect(notices.readSequences(501)).toEqual([3, 5]);
    expect(notices.stopped).toEqual([501]);
  });

  it("shares one wake between two callers for the same Instance", async () => {
    const { client, waker, requests } = gateway([ok(op("succeeded"), 202)]);
    const [first, second] = await Promise.all([waker.wake(client, 41), waker.wake(client, 41)]);
    expect(first).toEqual({ kind: "awake" });
    expect(second).toEqual({ kind: "awake" });
    expect(requests).toHaveLength(1);
    expect(waker.inFlight(41)).toBe(false);
  });

  it("tries again while Orbit is busy with a sleep", async () => {
    const { client, waker, requests } = gateway([
      error(409, "instance.lifecycle_busy"),
      ok(op("succeeded"), 202),
    ]);
    await expect(waker.wake(client, 41)).resolves.toEqual({ kind: "awake" });
    expect(requests).toHaveLength(2);
  });

  it("reports a failed Operation with its code", async () => {
    const { client, waker } = gateway([
      ok(op("running"), 202),
      ok(op("failed", { error_code: "instance.t3_unready" })),
    ]);
    await expect(waker.wake(client, 41)).resolves.toMatchObject({
      kind: "failed",
      code: "instance.t3_unready",
    });
  });

  it("reports an unreachable Gateway as a failure", async () => {
    const { client, waker } = gateway([new Error("net::ERR_CONNECTION_REFUSED")]);
    await expect(waker.wake(client, 41)).resolves.toMatchObject({
      kind: "failed",
      code: "gateway.unreachable",
    });
  });

  it("calls a 404 on the wake call unsupported, and a 404 on the Operation read a failure", async () => {
    const older = gateway([error(404, "http.404")]);
    await expect(older.waker.wake(older.client, 41)).resolves.toEqual({ kind: "unsupported" });

    const gone = gateway([ok(op("running"), 202), error(404, "http.404")]);
    await expect(gone.waker.wake(gone.client, 41)).resolves.toMatchObject({
      kind: "failed",
      code: "http.404",
    });
  });

  it("gives up on a wake that does not end", async () => {
    const answers = [ok(op("running"), 202)];
    for (let index = 0; index < 200; index += 1) answers.push(ok(op("running")));
    const { client, waker } = gateway(answers);
    await expect(waker.wake(client, 41)).resolves.toMatchObject({
      kind: "failed",
      code: "operation.timeout",
    });
  });
});
