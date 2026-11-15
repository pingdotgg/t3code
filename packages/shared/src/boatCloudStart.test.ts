import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeBoatApi } from "./boatCloudApi.ts";
import {
  latestCliRelease,
  needsSnapshot,
  startingSnapshot,
  startMachine,
} from "./boatCloudStart.ts";
import { PAIRING_MARKER, parseRepository } from "./boatCloudVm.ts";

const repository = parseRepository("https://github.com/acme/app")!;
const SUBDOMAIN = "box-node-1";
const VM_URL = `https://${SUBDOMAIN}-3773.on.boat.dev`;

/** Boat with one running, lightly loaded VM whose server answers as `serverEnvironmentId`. */
const runningVm = (serverEnvironmentId: string) => {
  const calls: Array<string> = [];
  const commands: Array<string> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname.replace("/api/v1", "");
      calls.push(`${request.method} ${path}`);
      const body =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(request.body.body)) as { command?: string })
          : {};
      const reply = (json: unknown) => HttpClientResponse.fromWeb(request, Response.json(json));
      if (path === "/sandboxes") {
        return reply({
          sandboxes: [{ id: "vm-1", state: "ready", subdomain: SUBDOMAIN, environment: "base" }],
        });
      }
      if (path === "/sandboxes/vm-1/host") return reply({ url: `${VM_URL}/` });
      if (path !== "/sandboxes/vm-1/commands") return reply({});
      const command = body.command ?? "";
      commands.push(command);
      const descriptor = JSON.stringify({ environmentId: serverEnvironmentId });
      const pairing = JSON.stringify({ credential: "fresh-code" });
      let stdout = "";
      if (command.includes("/proc/loadavg")) stdout = "0.1 4 1000 900\n";
      else if (command.includes("git clone")) stdout = "";
      else if (command.includes("systemctl --user start t3code.service")) {
        stdout = command.includes(PAIRING_MARKER)
          ? `${descriptor}\n${PAIRING_MARKER}\n${pairing}`
          : descriptor;
      } else if (command.includes("auth pairing create")) stdout = pairing;
      return reply({ exitCode: 0, stdout });
    }),
  );
  return { api: makeBoatApi(http, "key"), calls, commands };
};

const start = (vm: ReturnType<typeof runningVm>, pairedEnvironmentId: string | null) =>
  startMachine({
    api: vm.api,
    repository,
    baseBranch: null,
    environment: "base",
    snapshot: "t3-code-0-1-9-boat-1",
    knownWorkspaceRoots: () => [],
    paired:
      pairedEnvironmentId === null
        ? []
        : [{ environmentId: EnvironmentId.make(pairedEnvironmentId), httpBaseUrl: VM_URL }],
    report: () => Effect.void,
  }).pipe(Effect.tap((started) => started.checkout));

describe("startMachine on a running VM", () => {
  it.effect("reconnects a paired client without waiting on Boat, hosting or pairing", () =>
    Effect.gen(function* () {
      const vm = runningVm("env-1");
      const started = yield* start(vm, "env-1");
      assert.isNull(started.pairingCode);
      assert.strictEqual(started.httpBaseUrl, VM_URL);
      assert.deepStrictEqual(
        vm.calls.filter((call) => !call.endsWith("/commands")),
        ["GET /sandboxes", "PATCH /sandboxes/vm-1"],
      );
      assert.isFalse(vm.commands.some((command) => command.includes("auth pairing create")));
    }),
  );

  it.effect("mints a code in the server command for a new client, or after the VM was reset", () =>
    Effect.gen(function* () {
      const fresh = runningVm("env-1");
      assert.strictEqual((yield* start(fresh, null)).pairingCode, "fresh-code");
      assert.strictEqual(
        fresh.commands.filter((command) => command.includes("auth pairing create")).length,
        1,
      );

      const reset = runningVm("env-2");
      assert.strictEqual((yield* start(reset, "env-1")).pairingCode, "fresh-code");
    }),
  );
});

describe("latestCliRelease", () => {
  const github = (tag: string) =>
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ tag_name: tag }))),
    );

  it.effect("finds the fork's build and refuses a latest release that is not one", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* latestCliRelease(github("boat-cli-v0.1.9-boat.1")), "0.1.9-boat.1");
      for (const tag of ["v0.1.9", "boat-cli-v0.1.9;reboot", "boat-cli-v1.2"]) {
        const error = yield* Effect.flip(latestCliRelease(github(tag)));
        assert.strictEqual(error.code, "cli_release");
      }
    }),
  );
});

describe("snapshot choice", () => {
  const saved = (name: string, status: string, createdAt: string) => ({ name, status, createdAt });
  const old = saved("t3-code-0-1-9-boat-1-skills", "ready", "2026-11-01T00:00:00Z");

  it("starts VMs from the newest ready snapshot, the previous one while the next saves", () => {
    const next = saved("t3-code-0-1-9-boat-2", "ready", "2026-11-02T00:00:00Z");
    assert.strictEqual(startingSnapshot([old, next]), next.name);
    assert.strictEqual(startingSnapshot([old, { ...next, status: "saving" }]), old.name);
    assert.isNull(startingSnapshot([saved("other", "ready", "2026-11-03T00:00:00Z")]));
  });

  it("saves each build once, and only a holder with skills replaces one saved without", () => {
    const plain = saved("t3-code-0-1-9-boat-2", "ready", "2026-11-02T00:00:00Z");
    const skills = saved("t3-code-0-1-9-boat-2-skills", "saving", "2026-11-02T00:00:00Z");
    for (const withSkills of [true, false]) {
      assert.isTrue(needsSnapshot([old], "0.1.9-boat.2", withSkills));
      assert.isFalse(needsSnapshot([skills], "0.1.9-boat.2", withSkills));
      assert.isTrue(needsSnapshot([{ ...skills, status: "failed" }], "0.1.9-boat.2", withSkills));
    }
    assert.isTrue(needsSnapshot([plain], "0.1.9-boat.2", true));
    assert.isFalse(needsSnapshot([plain], "0.1.9-boat.2", false));
  });
});
