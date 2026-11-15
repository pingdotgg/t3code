import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeBoatApi } from "./boatCloudApi.ts";
import { latestCliRelease, snapshotIsOutdated, startMachine } from "./boatCloudStart.ts";
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
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ tag_name: tag, published_at: "2026-11-16T10:00:00Z" }),
        ),
      ),
    );

  it.effect("finds the fork's build and rebuilds only snapshots saved before it", () =>
    Effect.gen(function* () {
      const release = yield* latestCliRelease(github("boat-cli-v0.1.9-boat.1"));
      assert.deepStrictEqual(release, {
        version: "0.1.9-boat.1",
        publishedAt: "2026-11-16T10:00:00Z",
      });
      const saved = (createdAt: string | null) => ({ status: "ready", createdAt });
      assert.isTrue(snapshotIsOutdated(saved("2026-11-14T08:00:00Z"), release));
      assert.isTrue(snapshotIsOutdated(saved(null), release));
      assert.isFalse(snapshotIsOutdated(saved("2026-11-16T10:05:00Z"), release));
      assert.isFalse(snapshotIsOutdated({ status: "saving", createdAt: null }, release));
    }),
  );

  it.effect("refuses a latest release that is not a Boat cloud build", () =>
    Effect.gen(function* () {
      for (const tag of ["v0.1.9", "boat-cli-v0.1.9;reboot", "boat-cli-v1.2"]) {
        const error = yield* Effect.flip(latestCliRelease(github(tag)));
        assert.strictEqual(error.code, "cli_release");
      }
    }),
  );
});
