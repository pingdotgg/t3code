// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off globalRandom:off extendsNativeError:off - Plain-TypeScript game bridge core (sockets, files, vendor HTTP), unit-tested without an Effect runtime; GameDevService wraps it.
import { describe, expect, it } from "vite-plus/test";

import { listenBridge } from "./gameBridgeHttp.ts";
import { GameBridgeRegistry, type BridgeHello, type RegistryClock } from "./gameBridgeRegistry.ts";

class FakeClock implements RegistryClock {
  time = Date.parse("2026-11-19T12:00:00.000Z");
  #timers = new Map<number, { at: number; callback: () => void }>();
  #next = 1;
  now = () => this.time;
  setTimeout = (callback: () => void, ms: number) => {
    const id = this.#next++;
    this.#timers.set(id, { at: this.time + ms, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimeout = (handle: ReturnType<typeof setTimeout>) => {
    this.#timers.delete(handle as unknown as number);
  };
  advance(ms: number) {
    this.time += ms;
    for (const [id, timer] of [...this.#timers]) {
      if (timer.at <= this.time) {
        this.#timers.delete(id);
        timer.callback();
      }
    }
  }
}

const hello = (overrides: Partial<BridgeHello> = {}): BridgeHello => ({
  protocol: 1,
  engine: "unity",
  editorVersion: "6000.3.29f1",
  pluginVersion: "1.0.0",
  instanceId: "unity-instance-1",
  projectRoot: "/work/game",
  projectName: "Game",
  placeKey: null,
  operations: ["scene.tree", "object.update", "playtest.start", "viewport.capture", "made.up"],
  playState: "edit",
  ...overrides,
});

describe("GameBridgeRegistry", () => {
  it("delivers commands to a waiting poll and resolves the caller with the result", async () => {
    const registry = new GameBridgeRegistry(() => "token");
    const session = registry.hello(hello());
    expect(session.operations).toEqual(["scene.tree", "object.update", "playtest.start", "viewport.capture"]);
    const poll = registry.poll(session.sessionId)!;
    const call = registry.call(session.sessionId, "scene.tree", { depth: 2 }, { timeoutMs: 5_000, actor: "agent", summary: "Inspect scene" });
    const [command] = await poll;
    expect(command).toMatchObject({ operation: "scene.tree", args: { depth: 2 } });
    registry.results(session.sessionId, [{ id: command!.id, ok: true, value: { roots: ["Main Camera"] } }]);
    await expect(call).resolves.toMatchObject({ ok: true, value: { roots: ["Main Camera"] } });
    expect(registry.projectState("/work/game")?.timeline.at(-1)).toMatchObject({ kind: "agent-action", operation: "scene.tree", ok: true });
  });

  it("refuses operations the editor did not advertise", async () => {
    const registry = new GameBridgeRegistry(() => "token");
    const session = registry.hello(hello());
    await expect(
      registry.call(session.sessionId, "object.delete", {}, { timeoutMs: 1_000, actor: "agent", summary: "delete" }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("does not support object.delete") });
  });

  it("keeps the session across a script reload, replays reads, and fails in-flight writes", async () => {
    const clock = new FakeClock();
    const registry = new GameBridgeRegistry(() => "token", undefined, clock);
    const session = registry.hello(hello());
    const read = registry.call(session.sessionId, "scene.tree", {}, { timeoutMs: 60_000, actor: "agent", summary: "read" });
    const write = registry.call(session.sessionId, "object.update", {}, { timeoutMs: 60_000, actor: "agent", summary: "write" });
    expect(await registry.poll(session.sessionId)).toHaveLength(2);
    registry.events(session.sessionId, [{ type: "reloading" }]);
    expect(registry.session(session.sessionId)?.state).toBe("reloading");
    const again = registry.hello(hello());
    expect(again.sessionId).toBe(session.sessionId);
    await expect(write).resolves.toMatchObject({ ok: false, error: expect.stringContaining("reloaded scripts") });
    const [replayed] = await registry.poll(session.sessionId)!;
    expect(replayed?.operation).toBe("scene.tree");
    registry.results(session.sessionId, [{ id: replayed!.id, ok: true, value: [] }]);
    await expect(read).resolves.toMatchObject({ ok: true });
  });

  it("keeps a command the editor reports as still running across a reload", async () => {
    const registry = new GameBridgeRegistry(() => "token");
    const session = registry.hello(hello({ operations: ["tests.run"] }));
    const tests = registry.call(session.sessionId, "tests.run", { mode: "PlayMode" }, { timeoutMs: 60_000, actor: "agent", summary: "tests" });
    const [command] = await registry.poll(session.sessionId)!;
    registry.events(session.sessionId, [{ type: "reloading" }]);
    registry.hello(hello({ operations: ["tests.run"], inflight: [command!.id] }));
    const next = registry.poll(session.sessionId)!;
    registry.results(session.sessionId, [{ id: command!.id, ok: true, value: { passed: 4, failed: 0 } }]);
    await expect(tests).resolves.toMatchObject({ ok: true, value: { passed: 4 } });
    registry.goodbye(session.sessionId);
    await expect(next).resolves.toEqual([]);
  });

  it("times out calls, disconnects silent editors, and stores captures out of band", async () => {
    const clock = new FakeClock();
    const registry = new GameBridgeRegistry(() => "token", undefined, clock);
    const session = registry.hello(hello());
    const call = registry.call(session.sessionId, "playtest.start", {}, { timeoutMs: 10_000, actor: "user", summary: "Play" });
    clock.advance(10_001);
    await expect(call).resolves.toMatchObject({ ok: false, error: expect.stringContaining("did not finish") });

    const capture = registry.call(session.sessionId, "viewport.capture", {}, { timeoutMs: 10_000, actor: "agent", summary: "Capture" });
    const [command] = await registry.poll(session.sessionId)!;
    registry.results(session.sessionId, [
      { id: command!.id, ok: true, value: { capture: { mimeType: "image/png", dataBase64: "iVBORw0KGgo=", width: 2, height: 1 } } },
    ]);
    const outcome = await capture;
    expect(outcome.captureId).not.toBeNull();
    expect(registry.capture(outcome.captureId!)).toMatchObject({ width: 2, mimeType: "image/png" });
    expect(JSON.stringify(outcome.value)).not.toContain("iVBORw0KGgo=");

    clock.advance(46_000);
    registry.sweep();
    expect(registry.session(session.sessionId)?.state).toBe("disconnected");
  });

  it("counts playtests, redacts secrets in logs, and tracks compile errors", () => {
    const registry = new GameBridgeRegistry(() => "token");
    const session = registry.hello(hello());
    registry.events(session.sessionId, [
      { type: "play_state", state: "playing" },
      { type: "log", level: "error", message: "NullReferenceException with key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" },
      { type: "play_state", state: "edit" },
      { type: "compile", messages: [{ severity: "error", message: "CS0103: The name 'x' does not exist", file: "Assets/A.cs", line: 3 }] },
    ]);
    const state = registry.projectState("/work/game")!;
    expect(state.playtests).toBe(1);
    const error = state.timeline.find((entry) => entry.kind === "error")!;
    expect(error.playtest).toBe(1);
    expect(error.text).not.toContain("abcdefghijklmnop");
    expect(state.session.compileErrorCount).toBe(1);
  });

  it("binds Roblox places to projects and resolves pending approvals", async () => {
    const registry = new GameBridgeRegistry(() => "token", { resolvePlace: (key) => (key === "123:Obby" ? "/work/obby" : null) });
    const known = registry.hello(hello({ engine: "roblox", instanceId: "studio-1", projectRoot: null, placeKey: "123:Obby" }));
    expect(known.projectRoot).toBe("/work/obby");
    const unknown = registry.hello(hello({ engine: "roblox", instanceId: "studio-2", projectRoot: null, placeKey: "9:New" }));
    expect(unknown.projectRoot).toBeNull();
    registry.bind(unknown.sessionId, "/work/new");
    expect(registry.sessionForProject("/work/new")?.sessionId).toBe(unknown.sessionId);

    const approval = registry.requestApproval({ sessionId: known.sessionId, projectRoot: "/work/obby", operation: "object.delete", summary: "Delete Workspace.Lava", threadId: null }, 60_000);
    const [pending] = registry.approvals("/work/obby");
    expect(registry.approvals("/work/other")).toHaveLength(0);
    registry.resolveApproval(pending!.approvalId, true);
    await expect(approval).resolves.toBe(true);
  });

  it("rejects mismatched plugin protocols", () => {
    const registry = new GameBridgeRegistry(() => "token");
    expect(() => registry.hello(hello({ protocol: 2 }))).toThrow(/Update Continuum/);
  });
});

describe("bridge HTTP listener", () => {
  it("speaks the long-poll protocol on loopback and requires the token", async () => {
    const registry = new GameBridgeRegistry(() => "secret-token");
    const listener = await listenBridge(registry, 0);
    const base = `http://127.0.0.1:${listener.port}`;
    try {
      expect(await (await fetch(`${base}/v1/status`)).json()).toEqual({ product: "continuum", protocol: 1 });
      expect((await fetch(`${base}/v1/hello`, { method: "POST", body: "{}" })).status).toBe(401);
      const auth = { authorization: "Bearer secret-token", "content-type": "application/json" };
      const helloResponse = await fetch(`${base}/v1/hello`, { method: "POST", headers: auth, body: JSON.stringify(hello()) });
      const { sessionId } = (await helloResponse.json()) as { sessionId: string };
      const poll = fetch(`${base}/v1/poll?session=${sessionId}`, { headers: auth }).then((response) => response.json());
      const call = registry.call(sessionId, "scene.tree", {}, { timeoutMs: 5_000, actor: "agent", summary: "tree" });
      const { commands } = (await poll) as { commands: Array<{ id: string }> };
      await fetch(`${base}/v1/results`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ session: sessionId, results: [{ id: commands[0]!.id, ok: true, value: { count: 3 } }] }),
      });
      await expect(call).resolves.toMatchObject({ ok: true, value: { count: 3 } });
      // A web page could reach loopback; Origin marks it and the bridge refuses it.
      const fromPage = await fetch(`${base}/v1/hello`, { method: "POST", headers: { ...auth, origin: "https://evil.example" }, body: "{}" });
      expect(fromPage.status).toBe(403);
    } finally {
      await listener.close();
    }
  });
});
