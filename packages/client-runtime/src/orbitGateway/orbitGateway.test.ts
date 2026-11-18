import { describe, expect, it } from "vite-plus/test";
import {
  createOrbitGatewayClient,
  orbitGatewayPathWithQuery,
  isFinalPairingError,
  isPairingRevokedError,
  OrbitGatewayError,
  startableOrbitProject,
  type OrbitGatewayRequest,
  type OrbitGatewayWorkspace,
} from "./client.ts";
import { orbitInstanceFromEnvironment, preferredOrbitInstance } from "./orbitInstance.ts";
import { mergeWorkspaces, sameWorkspaces } from "./workspaceMerge.ts";

const workspace = (id: string, name = id, extra: Partial<OrbitGatewayWorkspace> = {}) =>
  ({
    id,
    name,
    color: "sky",
    icon: null,
    image: null,
    projectRefs: [],
    projectKeys: [],
    ...extra,
  }) as OrbitGatewayWorkspace;
const ids = (list: readonly OrbitGatewayWorkspace[]) =>
  list.map((entry) => `${entry.id}:${entry.name}`);

describe("mergeWorkspaces", () => {
  const base = [workspace("a"), workspace("b"), workspace("c")];

  it("keeps edits from both devices to different workspaces", () => {
    const local = [workspace("a", "A local"), workspace("b"), workspace("c")];
    const remote = [workspace("a"), workspace("b", "B remote"), workspace("c")];
    expect(ids(mergeWorkspaces(base, local, remote))).toEqual(["a:A local", "b:B remote", "c:c"]);
  });

  it("lets the local edit win when both devices changed the same workspace", () => {
    const local = [workspace("a", "mine"), workspace("b"), workspace("c")];
    const remote = [workspace("a", "theirs"), workspace("b"), workspace("c")];
    expect(ids(mergeWorkspaces(base, local, remote))).toEqual(["a:mine", "b:b", "c:c"]);
  });

  it("removes a workspace deleted on one side and untouched on the other", () => {
    expect(ids(mergeWorkspaces(base, [workspace("a"), workspace("c")], base))).toEqual([
      "a:a",
      "c:c",
    ]);
    expect(ids(mergeWorkspaces(base, base, [workspace("b"), workspace("c")]))).toEqual([
      "b:b",
      "c:c",
    ]);
  });

  it("keeps a workspace one side deleted while the other edited it", () => {
    const local = [workspace("a"), workspace("b", "edited"), workspace("c")];
    const remote = [workspace("a"), workspace("c")];
    expect(ids(mergeWorkspaces(base, local, remote))).toEqual(["a:a", "b:edited", "c:c"]);
  });

  it("keeps a workspace another device edited while this one deleted it", () => {
    const local = [workspace("a"), workspace("c")];
    const remote = [workspace("a"), workspace("b", "edited"), workspace("c")];
    expect(ids(mergeWorkspaces(base, local, remote))).toEqual(["a:a", "b:edited", "c:c"]);
  });

  it("keeps new workspaces from both sides next to their neighbours", () => {
    const local = [workspace("a"), workspace("x"), workspace("b"), workspace("c")];
    const remote = [workspace("a"), workspace("b"), workspace("c"), workspace("y")];
    expect(ids(mergeWorkspaces(base, local, remote))).toEqual(["a:a", "x:x", "b:b", "c:c", "y:y"]);
  });

  it("uses the local order when only this device reordered", () => {
    const local = [workspace("c"), workspace("a"), workspace("b")];
    const remote = [workspace("a"), workspace("b", "B remote"), workspace("c")];
    expect(ids(mergeWorkspaces(base, local, remote))).toEqual(["c:c", "a:a", "b:B remote"]);
  });

  it("compares strings as the Gateway stores them", () => {
    const stored = workspace("a", "Work", { icon: null, image: null, projectRefs: ["env:p"] });
    const sent = workspace("a", " Work ", { icon: "  ", image: "", projectRefs: [" env:p ", ""] });
    expect(sameWorkspaces([stored], [sent])).toBe(true);
    expect(sameWorkspaces([stored], [workspace("a", "Work", { icon: "folder" })])).toBe(false);
  });

  it("compares content, not identity", () => {
    expect(
      sameWorkspaces(
        base,
        base.map((entry) => ({ ...entry })),
      ),
    ).toBe(true);
    expect(
      sameWorkspaces(base, [workspace("a", "a", { projectRefs: ["env:p"] }), base[1]!, base[2]!]),
    ).toBe(false);
  });
});

describe("createOrbitGatewayClient", () => {
  const respond = (status: number, body: unknown) => async () => ({
    status,
    body: JSON.stringify(body),
  });

  it("reads the calling node and its profile", async () => {
    const client = createOrbitGatewayClient(
      respond(200, {
        data: {
          id: 8,
          name: "nick",
          wireguard_ip: "10.44.0.6",
          profile: {
            id: 1,
            name: "Nick",
            settings_version: 2,
            updated_at: "2026-10-10T00:00:00+00:00",
          },
          profile_channel: "private-conn-profile.9f2c4e1ab07d4c3e8a5b6f0d1e2c3b4a",
        },
      }),
    );
    await expect(client.me()).resolves.toEqual({
      id: 8,
      name: "nick",
      wireguardIp: "10.44.0.6",
      profile: { id: 1, name: "Nick", settingsVersion: 2, updatedAt: "2026-10-10T00:00:00+00:00" },
      profileChannel: "private-conn-profile.9f2c4e1ab07d4c3e8a5b6f0d1e2c3b4a",
    });
    // A channel of any other form is not followed.
    for (const profileChannel of [null, undefined, "private-orbit", "private-conn-profile.ABC"]) {
      const other = createOrbitGatewayClient(
        respond(200, {
          data: { id: 8, name: "nick", profile: null, profile_channel: profileChannel },
        }),
      );
      await expect(other.me()).resolves.toMatchObject({ profileChannel: null });
    }
  });

  it("sends the read version with a workspace replace and only the keys the Gateway accepts", async () => {
    const sent: OrbitGatewayRequest[] = [];
    const client = createOrbitGatewayClient(async (request) => {
      sent.push(request);
      return {
        status: 200,
        body: JSON.stringify({
          data: { profile_id: 1, version: 3, settings: { workspaces: [] }, updated_at: "now" },
        }),
      };
    });
    const extra = { ...workspace("a"), lastThread: "x" } as OrbitGatewayWorkspace;
    await client.replaceWorkspaces(1, 2, [extra]);
    expect(sent[0]).toEqual({
      method: "PUT",
      path: "/profiles/1/settings",
      body: { version: 2, settings: { workspaces: [workspace("a")] } },
    });
  });

  it("reads the section versions and who changed them, and tolerates a Gateway without them", async () => {
    const withSections = createOrbitGatewayClient(
      respond(200, {
        data: {
          profile_id: 1,
          version: 4,
          updated_at: "now",
          settings: { workspaces: [], appearance: { schema: 1 } },
          sections: {
            appearance: { version: 3, updated_at: "2026-10-10T10:00:00Z", updated_by: "phone" },
            "devices.desktop": { version: 1, updated_at: "later", updated_by: { name: "mac" } },
          },
        },
      }),
    );
    const read = await withSections.settings(1);
    expect(read.document.appearance).toEqual({ schema: 1 });
    expect(read.sections).toEqual({
      appearance: { version: 3, updatedAt: "2026-10-10T10:00:00Z", updatedBy: "phone" },
      "devices.desktop": { version: 1, updatedAt: "later", updatedBy: "mac" },
    });

    const legacy = createOrbitGatewayClient(
      respond(200, {
        data: { profile_id: 1, version: 4, updated_at: "now", settings: { workspaces: [] } },
      }),
    );
    expect((await legacy.settings(1)).sections).toBeNull();
  });

  it("patches sections with the versions it read and reports a stale one as a conflict", async () => {
    const sent: OrbitGatewayRequest[] = [];
    const client = createOrbitGatewayClient(async (request) => {
      sent.push(request);
      return {
        status: 200,
        body: JSON.stringify({
          data: {
            profile_id: 1,
            version: 5,
            settings: { workspaces: [] },
            updated_at: "now",
            sections: {},
          },
        }),
      };
    });
    await client.patchSections(1, {
      appearance: { version: 2, value: { schema: 1 } },
      "devices.desktop": { version: 0, value: null },
    });
    expect(sent[0]).toEqual({
      method: "PATCH",
      path: "/profiles/1/settings",
      body: {
        sections: {
          appearance: { version: 2, value: { schema: 1 } },
          "devices.desktop": { version: 0, value: null },
        },
      },
    });

    const stale = createOrbitGatewayClient(
      respond(409, {
        error: {
          code: "conn.settings_version_conflict",
          message: "stale",
          details: { current_version: 6, sections: { appearance: 3 } },
        },
      }),
    );
    await expect(stale.patchSections(1, {})).rejects.toMatchObject({
      status: 409,
      details: { sections: { appearance: 3 } },
    });
  });

  it("sends workspaces the way the Gateway stores them and never the other sections", async () => {
    const sent: OrbitGatewayRequest[] = [];
    const client = createOrbitGatewayClient(async (request) => {
      sent.push(request);
      return {
        status: 200,
        body: JSON.stringify({
          data: { profile_id: 1, version: 3, settings: { workspaces: [] }, updated_at: "now" },
        }),
      };
    });
    await client.replaceWorkspaces(1, 2, [
      workspace("a", "  Work ", { icon: " ", image: "", projectRefs: [" env:p ", " "] }),
    ]);
    await client.replaceWorkspaces(1, 3, []);
    // A PUT replaces every device type, so devices are only ever written by PATCH.
    expect(sent[0]!.body).toEqual({
      version: 2,
      settings: { workspaces: [workspace("a", "Work", { projectRefs: ["env:p"] })] },
    });
    expect(sent[1]!.body).toEqual({ version: 3, settings: { workspaces: [] } });
  });

  it("turns the Gateway's error envelope into an OrbitGatewayError", async () => {
    const client = createOrbitGatewayClient(
      respond(409, {
        error: {
          code: "conn.settings_version_conflict",
          message: "stale",
          details: { current_version: 5 },
        },
      }),
    );
    const error = await client.settings(1).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(OrbitGatewayError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      _tag: "OrbitGatewayError",
      code: "conn.settings_version_conflict",
      status: 409,
      details: { current_version: 5 },
    });
    expect(JSON.parse(JSON.stringify(error))).toMatchObject({
      _tag: "OrbitGatewayError",
      code: "conn.settings_version_conflict",
      status: 409,
      details: { current_version: 5 },
    });
  });

  it("reports a transport failure as unreachable", async () => {
    const client = createOrbitGatewayClient(async () => {
      throw new Error("ECONNREFUSED");
    });
    const error = await client.environments().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(OrbitGatewayError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: "gateway.unreachable", status: 0 });
  });

  it("asks for the Projects that cannot start threads only when told to", async () => {
    const requests: OrbitGatewayRequest[] = [];
    const client = createOrbitGatewayClient(async (request) => {
      requests.push(request);
      return { status: 200, body: JSON.stringify({ data: [] }) };
    });
    await client.projects();
    await client.projects({ includeUnavailable: false });
    await client.projects({ includeUnavailable: true });
    expect(requests.map((request) => request.query)).toEqual([
      undefined,
      undefined,
      { include_unavailable: "1" },
    ]);
    expect(orbitGatewayPathWithQuery(requests[2]!)).toBe("/projects?include_unavailable=1");
    expect(orbitGatewayPathWithQuery(requests[0]!)).toBe("/projects");
  });

  describe("checkInstanceName", () => {
    const check = async (status: number, body: unknown) => {
      const requests: OrbitGatewayRequest[] = [];
      const client = createOrbitGatewayClient(async (request) => {
        requests.push(request);
        return respond(status, body)();
      });
      const result = client.checkInstanceName(66, "pricing");
      return { result, requests };
    };

    it("sends the name as the only query and reads each reason", async () => {
      const { result, requests } = await check(200, {
        data: { name: "pricing", available: true, reason: null, domain: "pricing.bench.test" },
      });
      await expect(result).resolves.toEqual({
        name: "pricing",
        available: true,
        reason: null,
        domain: "pricing.bench.test",
      });
      expect(requests[0]).toMatchObject({
        method: "GET",
        path: "/projects/66/instances/check",
        query: { name: "pricing" },
      });
      for (const reason of ["taken", "invalid", "default", "domain_invalid"] as const) {
        const answer = await (
          await check(200, { data: { name: "pricing", available: false, reason, domain: null } })
        ).result;
        expect(answer).toEqual({ name: "pricing", available: false, reason, domain: null });
      }
    });

    it("tolerates a missing name, an unknown reason and a missing domain", async () => {
      await expect(
        (await check(200, { data: { available: false, reason: "reserved" } })).result,
      ).resolves.toEqual({ name: "pricing", available: false, reason: null, domain: null });
      await expect(
        (await check(200, { data: { available: true, reason: "taken", domain: " " } })).result,
      ).resolves.toEqual({ name: "pricing", available: true, reason: null, domain: null });
    });

    it("fails on an answer without available, on 409 default_missing and when unreachable", async () => {
      await expect((await check(200, { data: { name: "pricing" } })).result).rejects.toMatchObject({
        code: "gateway.response_invalid",
      });
      await expect(
        (
          await check(409, {
            error: { code: "instance.default_missing", message: "No ready default Instance." },
          })
        ).result,
      ).rejects.toMatchObject({
        code: "instance.default_missing",
        message: "No ready default Instance.",
        status: 409,
      });
      const client = createOrbitGatewayClient(async () => {
        throw new Error("timed out");
      });
      await expect(client.checkInstanceName(66, "pricing")).rejects.toMatchObject({
        code: "gateway.unreachable",
      });
    });
  });

  describe("pair", () => {
    const pairing = {
      id: 1851,
      environment_id: "env-spike",
      node_id: 8,
      node_name: "nick",
      client_label: "nick via Orbit vfkeru69",
      issued_at: "2026-11-10T06:45:00+00:00",
      expires_at: "2026-11-10T06:50:04+00:00",
      revoked_at: null,
    };
    const operation = (status: string, extra: Record<string, unknown> = {}) => ({
      id: 16044,
      kind: "conn.pairing_create",
      status,
      error_code: null,
      result: null,
      poll_after_seconds: status === "running" ? 2 : null,
      ...extra,
    });
    /** Answers each request with the next scripted reply and records what was asked. */
    const scripted = (replies: ReadonlyArray<readonly [number, unknown]>) => {
      const requests: OrbitGatewayRequest[] = [];
      let next = 0;
      const transport = async (request: OrbitGatewayRequest) => {
        requests.push(request);
        const reply = replies[next++];
        if (!reply) throw new Error(`unexpected ${request.method} ${request.path}`);
        return { status: reply[0], body: JSON.stringify({ data: reply[1] }) };
      };
      return { requests, transport };
    };

    it("follows the Gateway's Operation and reads the link once it succeeded", async () => {
      const { requests, transport } = scripted([
        [202, operation("running")],
        [200, operation("running")],
        [200, operation("succeeded", { result: { backend: "issued", pairing_id: 1851 } })],
        [200, { pairing, pairing_url: "http://10.44.0.7:3801/pair#token=ABC" }],
      ]);
      const waits: number[] = [];
      const client = createOrbitGatewayClient(transport, {
        sleep: async (ms) => {
          waits.push(ms);
        },
      });

      await expect(client.pair("env-spike")).resolves.toEqual({
        environmentId: "env-spike",
        pairingUrl: "http://10.44.0.7:3801/pair#token=ABC",
        expiresAt: "2026-11-10T06:50:04+00:00",
      });
      expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
        "POST /environments/env-spike/pairings",
        "GET /operations/16044",
        "GET /operations/16044",
        "GET /environments/env-spike/pairings/1851",
      ]);
      expect(waits).toEqual([2000, 2000]);
      expect(requests[0]?.timeoutMs).toBe(60_000);
    });

    it("sends renew only for a renewal, and reports a revoked pairing as final", async () => {
      const { requests, transport } = scripted([
        [201, { pairing, pairing_url: "http://10.44.0.7:3801/pair#token=ABC" }],
        [201, { pairing, pairing_url: "http://10.44.0.7:3801/pair#token=ABC" }],
      ]);
      const client = createOrbitGatewayClient(transport);
      await client.pair("env-spike");
      await client.pair("env-spike", { renew: true });
      expect(requests[0]?.body).toBeUndefined();
      expect(requests[1]?.body).toEqual({ renew: true });

      const revoked = createOrbitGatewayClient(async () => ({
        status: 409,
        body: JSON.stringify({
          status: 409,
          error: { code: "conn.pairing_revoked", message: "Revoked.", details: {} },
        }),
      }));
      const failure = await revoked.pair("env-spike", { renew: true }).catch((error) => error);
      expect(isPairingRevokedError(failure)).toBe(true);
      expect(isFinalPairingError(failure)).toBe(true);
    });

    it("still accepts a Gateway that answers with the link at once", async () => {
      const { requests, transport } = scripted([
        [201, { pairing, pairing_url: "http://10.44.0.7:3801/pair#token=ABC" }],
      ]);
      const client = createOrbitGatewayClient(transport);
      await expect(client.pair("env-spike")).resolves.toMatchObject({
        pairingUrl: "http://10.44.0.7:3801/pair#token=ABC",
      });
      expect(requests).toHaveLength(1);
    });

    it("reports a failed Operation with its error code and reads no link", async () => {
      const { requests, transport } = scripted([
        [202, operation("failed", { error_code: "conn.server_unreachable" })],
      ]);
      const client = createOrbitGatewayClient(transport, { sleep: async () => {} });
      await expect(client.pair("env-spike")).rejects.toMatchObject({
        code: "conn.server_unreachable",
        details: { operation_id: 16044 },
      });
      expect(requests).toHaveLength(1);
    });

    it("ends on an interrupted Operation without polling again", async () => {
      const { requests, transport } = scripted([
        [202, operation("running", { poll_after_seconds: null })],
        [200, operation("interrupted")],
      ]);
      const waits: number[] = [];
      const client = createOrbitGatewayClient(transport, {
        sleep: async (ms) => {
          waits.push(ms);
        },
      });
      await expect(client.pair("env-spike")).rejects.toMatchObject({ code: "operation.failed" });
      expect(requests).toHaveLength(2);
      expect(waits).toEqual([500]);
    });

    it("marks only the codes the Gateway calls final", () => {
      const error = (code: string) =>
        new OrbitGatewayError({ code, message: code, status: 0, details: {} });
      expect(isFinalPairingError(error("conn.session_rejected"))).toBe(true);
      expect(isFinalPairingError(error("conn.request_refused"))).toBe(true);
      expect(isFinalPairingError(error("conn.response_invalid"))).toBe(true);
      expect(isFinalPairingError(error("conn.pairing_revoked"))).toBe(true);
      expect(isPairingRevokedError(error("conn.pairing_revoked"))).toBe(true);
      expect(isPairingRevokedError(error("conn.session_rejected"))).toBe(false);
      expect(isFinalPairingError(error("conn.pairing_outcome_unknown"))).toBe(false);
      expect(isFinalPairingError(error("gateway.unreachable"))).toBe(false);
      expect(isFinalPairingError(new Error("conn.session_rejected"))).toBe(false);
    });

    it("gives up on an Operation that does not end in time", async () => {
      let clock = 0;
      const client = createOrbitGatewayClient(
        async () => ({ status: 200, body: JSON.stringify({ data: operation("running") }) }),
        {
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
        },
      );
      await expect(client.pair("env-spike")).rejects.toMatchObject({ code: "operation.timeout" });
      expect(clock).toBeGreaterThanOrEqual(60_000);
    });

    it("rejects a succeeded Operation without a pairing id", async () => {
      const { transport } = scripted([[202, operation("succeeded", { result: {} })]]);
      const client = createOrbitGatewayClient(transport);
      await expect(client.pair("env-spike")).rejects.toMatchObject({
        code: "gateway.response_invalid",
      });
    });
  });

  it("reads a server's Instance and power state, the thread Projects, and an Operation", async () => {
    const requests: OrbitGatewayRequest[] = [];
    const bodies: Record<string, unknown> = {
      "GET /environments": [
        {
          environment_id: "env-clone",
          label: "mealou / fix",
          url: "http://10.44.0.7:3800",
          status: "registered",
          instance_id: 41,
          power_state: "stopped",
          project_id: 3,
          project_name: " Mealou ",
          project_slug: "mealou",
          instance_name: "fix",
          node_name: "beast",
          instance_url: "https://fix.mealou.test",
        },
        { environment_id: "env-beast", label: "beast", url: "http://x", status: "registered" },
        {
          environment_id: "env-odd",
          label: "odd",
          url: "http://y",
          status: "registered",
          instance_id: 42,
          project_id: "3",
          project_name: 5,
          project_slug: "",
          instance_name: null,
          node_name: ["beast"],
          instance_url: false,
        },
      ],
      "GET /projects": [
        { id: 3, slug: "mealou", name: "Mealou", node_id: 7, node_name: "beast" },
        {
          id: 4,
          slug: "hauzer",
          name: "Hauzer",
          node_id: null,
          node_name: null,
          instance_domain_suffix: null,
          cloneable: false,
          cloneable_reason: " No Node access ",
          future_field: { ignored: true },
          checks: [
            { key: "default_instance", label: "Default Instance", status: "pass" },
            {
              key: "node_access",
              status: "fail",
              code: "node_access.required",
              message: "Grant this Node access.",
            },
            { key: "source_access", status: "not_checked", label: 7 },
            { key: "later", status: "unknown" },
            { status: "pass" },
          ],
        },
        {
          id: 5,
          slug: "nckrtl",
          name: "nckrtl",
          node_id: 7,
          node_name: "beast",
          instance_domain_suffix: ".nckrtl.test",
          cloneable: true,
          cloneable_reason: null,
          checks: "not a list",
        },
      ],
      "POST /projects/3/instances": {
        id: 100,
        kind: "instance.create",
        status: "queued",
        target_id: 41,
        error_code: null,
        poll_after_seconds: 2,
      },
      // A failed create as Operation show reports it: steps, the failed step and the error.
      "GET /operations/100": {
        id: 100,
        kind: "instance.create",
        status: "failed",
        target_id: 41,
        error_code: "instance.t3_unready",
        poll_after_seconds: null,
        current_step: null,
        current_step_started_at: null,
        failed_step: "clone-t3",
        error: {
          code: "instance.t3_unready",
          message: " T3 did not answer. ",
          detail: " Argument list too long ",
        },
        result: null,
        steps: [
          {
            name: "clone-container",
            job: "clone",
            status: "succeeded",
            started_at: "2026-11-11T20:37:04.739Z",
            finished_at: "2026-11-11T20:37:11.045Z",
          },
          { name: "clone-t3", group: "t3", job: "clone", status: "failed", started_at: null },
          { name: "clone-next", status: "paused-by-orbit", job: 3 },
          { name: 7, status: "running" },
          "clone-odd",
        ],
      },
      "POST /operations/100/cancel": {
        id: 100,
        kind: "instance.create",
        status: "running",
        target_id: 41,
        poll_after_seconds: 2,
      },
      // A Project process did not stay up: Orbit names its unit; other facts are optional.
      "GET /operations/101": {
        id: 101,
        kind: "instance.create",
        status: "failed",
        target_id: 41,
        error_code: "instance.container_process_inactive",
        result: {
          process_failure: { unit: " conn-web.service ", exit_status: 1 },
          recovery: { state: "retained_for_retry" },
        },
      },
      "GET /operations/102": {
        id: 102,
        kind: "instance.create",
        status: "failed",
        target_id: 41,
        error_code: "instance.container_process_inactive",
        result: { process_failure: { unit: 7 } },
      },
      "GET /operations/103": {
        id: 103,
        kind: "instance.create",
        status: "failed",
        target_id: 41,
        error_code: "instance.container_process_inactive",
        result: {
          process_failure: { unit: "conn-web.service" },
          // The Gateway's shape (InstanceCompleteProjection): `requires` is under `retry`.
          recovery: {
            state: "retained_for_retry",
            retry: {
              command: "instance:complete",
              instance_id: 41,
              new_idempotency_key: true,
              requires: "project_process_definition",
            },
          },
        },
      },
      // The shape Conn used to read: `requires` beside `retry` is not Orbit's.
      "GET /operations/104": {
        id: 104,
        kind: "instance.create",
        status: "failed",
        target_id: 41,
        result: {
          recovery: { state: "retained_for_retry", requires: "project_process_definition" },
        },
      },
      // Release 2030: a create that ends at a usable thread names its completion.
      "GET /operations/105": {
        id: 105,
        kind: "instance.create",
        status: "succeeded",
        target_id: 41,
        input: { route_id: 77 },
        result: { instance_id: 41, completion_operation_id: 106 },
      },
      "GET /operations/106": {
        id: 106,
        kind: "instance.complete",
        status: "failed",
        target_id: 41,
        failed_step: "clone-services",
        error_code: "instance.create_workspace_failed",
        cancel_requested: false,
        result: {
          failed_step: "workspace",
          recovery: {
            state: "retained_for_retry",
            retry: { command: "instance:complete", instance_id: 41, new_idempotency_key: true },
          },
        },
      },
      "POST /instances/41/complete": {
        id: 107,
        kind: "instance.complete",
        status: "queued",
        target_id: 41,
        poll_after_seconds: 2,
      },
    };
    const client = createOrbitGatewayClient(async (request) => {
      requests.push(request);
      return {
        status: 200,
        body: JSON.stringify({ data: bodies[`${request.method} ${request.path}`] }),
      };
    });

    const servers = await client.environments();
    expect(servers.map(({ instanceId, powerState }) => ({ instanceId, powerState }))).toEqual([
      { instanceId: 41, powerState: "stopped" },
      { instanceId: null, powerState: null },
      { instanceId: 42, powerState: null },
    ]);
    const facts = servers.map(
      ({ projectId, projectName, projectSlug, instanceName, nodeName, instanceUrl }) => ({
        projectId,
        projectName,
        projectSlug,
        instanceName,
        nodeName,
        instanceUrl,
      }),
    );
    const none = {
      projectId: null,
      projectName: null,
      projectSlug: null,
      instanceName: null,
      nodeName: null,
      instanceUrl: null,
    };
    // Missing and wrong-typed facts read as null; they never fail the list.
    expect(facts).toEqual([
      {
        projectId: 3,
        projectName: "Mealou",
        projectSlug: "mealou",
        instanceName: "fix",
        nodeName: "beast",
        instanceUrl: "https://fix.mealou.test",
      },
      none,
      none,
    ]);
    const projects = await client.projects();
    const listing = { instanceDomainSuffix: null, cloneable: true, cloneableReason: null };
    expect(projects).toEqual([
      {
        id: 3,
        slug: "mealou",
        name: "Mealou",
        nodeId: 7,
        nodeName: "beast",
        ...listing,
        checks: null,
      },
      {
        id: 4,
        slug: "hauzer",
        name: "Hauzer",
        nodeId: null,
        nodeName: null,
        instanceDomainSuffix: null,
        cloneable: false,
        cloneableReason: "No Node access",
        checks: [
          {
            key: "default_instance",
            label: "Default Instance",
            status: "pass",
            code: null,
            message: null,
          },
          {
            key: "node_access",
            label: null,
            status: "fail",
            code: "node_access.required",
            message: "Grant this Node access.",
          },
          { key: "source_access", label: null, status: "not_checked", code: null, message: null },
        ],
      },
      {
        id: 5,
        slug: "nckrtl",
        name: "nckrtl",
        nodeId: 7,
        nodeName: "beast",
        ...listing,
        instanceDomainSuffix: ".nckrtl.test",
        checks: null,
      },
    ]);
    expect(projects.map(startableOrbitProject)).toEqual([
      {
        id: 3,
        slug: "mealou",
        name: "Mealou",
        nodeId: 7,
        nodeName: "beast",
        instanceDomainSuffix: null,
      },
      null,
      {
        id: 5,
        slug: "nckrtl",
        name: "nckrtl",
        nodeId: 7,
        nodeName: "beast",
        instanceDomainSuffix: ".nckrtl.test",
      },
    ]);
    await expect(client.createThreadInstance(3, "fix-k3j9", "key-1")).resolves.toEqual({
      id: 100,
      kind: "instance.create",
      status: "queued",
      targetId: 41,
      errorCode: null,
      pollAfterSeconds: 2,
    });
    expect(requests.at(-1)).toEqual({
      method: "POST",
      path: "/projects/3/instances",
      body: { name: "fix-k3j9" },
      timeoutMs: 60_000,
      idempotencyKey: "key-1",
    });
    await expect(client.cancelOperation(100)).resolves.toMatchObject({
      id: 100,
      status: "running",
    });
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/operations/100/cancel",
      body: {},
    });
    await expect(client.operation(101)).resolves.toMatchObject({
      errorCode: "instance.container_process_inactive",
      processFailureUnit: "conn-web.service",
      recoveryRequires: null,
    });
    await expect(client.operation(102)).resolves.toMatchObject({ processFailureUnit: null });
    await expect(client.operation(102)).resolves.not.toHaveProperty("recoveryRequires");
    await expect(client.operation(103)).resolves.toMatchObject({
      recoveryRequires: "project_process_definition",
      recoveryRetryable: true,
    });
    await expect(client.operation(104)).resolves.toMatchObject({
      recoveryRequires: null,
      recoveryRetryable: false,
    });
    await expect(client.operation(105)).resolves.toMatchObject({
      completionOperationId: 106,
      routeId: 77,
    });
    // An older Gateway's create names no completion.
    await expect(client.operation(103)).resolves.not.toHaveProperty("completionOperationId");
    await expect(client.operation(106)).resolves.toMatchObject({
      kind: "instance.complete",
      failedStep: "clone-services",
      resultFailedStep: "workspace",
      cancelRequested: false,
      recoveryRequires: null,
      recoveryRetryable: true,
    });
    await expect(client.completeInstance(41, "key-c")).resolves.toMatchObject({
      id: 107,
      kind: "instance.complete",
      status: "queued",
    });
    expect(requests.at(-1)).toEqual({
      method: "POST",
      path: "/instances/41/complete",
      timeoutMs: 60_000,
      idempotencyKey: "key-c",
    });
    // An unknown step status passes through; a step without a name or status is dropped.
    await expect(client.operation(100)).resolves.toEqual({
      id: 100,
      kind: "instance.create",
      status: "failed",
      targetId: 41,
      errorCode: "instance.t3_unready",
      pollAfterSeconds: null,
      currentStep: null,
      currentStepStartedAt: null,
      failedStep: "clone-t3",
      error: {
        code: "instance.t3_unready",
        message: "T3 did not answer.",
        detail: "Argument list too long",
      },
      result: null,
      steps: [
        {
          name: "clone-container",
          job: "clone",
          status: "succeeded",
          startedAt: "2026-11-11T20:37:04.739Z",
          finishedAt: "2026-11-11T20:37:11.045Z",
        },
        {
          name: "clone-t3",
          group: "t3",
          job: "clone",
          status: "failed",
          startedAt: null,
          finishedAt: null,
        },
        {
          name: "clone-next",
          job: null,
          status: "paused-by-orbit",
          startedAt: null,
          finishedAt: null,
        },
      ],
    });
  });
});

describe("orbitInstanceFromEnvironment", () => {
  const clone = {
    instanceId: 41,
    projectId: 3,
    projectSlug: "mealou",
    projectName: "Mealou",
    instanceName: "fix",
    nodeName: "beast",
    instanceUrl: "https://fix.mealou.test",
  };

  it("builds the descriptor only from a record with both ids", () => {
    expect(orbitInstanceFromEnvironment(clone)).toEqual({
      projectId: 3,
      instanceId: 41,
      projectSlug: "mealou",
      projectName: "Mealou",
      instanceName: "fix",
      nodeName: "beast",
      url: "https://fix.mealou.test",
    });
    expect(
      orbitInstanceFromEnvironment({
        ...clone,
        projectSlug: null,
        projectName: null,
        instanceName: null,
        nodeName: null,
        instanceUrl: "javascript:alert(1)",
      }),
    ).toEqual({ projectId: 3, instanceId: 41 });
    expect(orbitInstanceFromEnvironment({ ...clone, projectId: null })).toBeUndefined();
    expect(orbitInstanceFromEnvironment({ ...clone, instanceId: null })).toBeUndefined();
    expect(orbitInstanceFromEnvironment({ ...clone, projectId: 0 })).toBeUndefined();
    expect(orbitInstanceFromEnvironment({ ...clone, instanceId: 4.5 })).toBeUndefined();
  });

  it("prefers the Gateway's facts over the server's", () => {
    const gateway = { projectId: 3, instanceId: 41 };
    const server = { projectId: 3, instanceId: 41, projectName: "From server" };
    expect(preferredOrbitInstance(gateway, server)).toBe(gateway);
    expect(preferredOrbitInstance(undefined, server)).toBe(server);
    expect(preferredOrbitInstance(undefined, undefined)).toBeUndefined();
  });
});

describe("Orbit branches and branch on create", () => {
  const recording = (
    answer: (request: OrbitGatewayRequest) => { status: number; body: unknown },
  ) => {
    const requests: OrbitGatewayRequest[] = [];
    const client = createOrbitGatewayClient(async (request) => {
      requests.push(request);
      const { status, body } = answer(request);
      return { status, body: JSON.stringify(body) };
    });
    return { client, requests };
  };

  it("parses the branch list tolerantly, with the PR flag, and sends the query with a 25 s limit", async () => {
    const { client, requests } = recording(() => ({
      status: 200,
      body: {
        data: [
          { name: "main", default: true, pull_request: null, instance: { id: 9, name: "default" } },
          {
            name: "feature/login",
            default: false,
            pull_request: { number: 482, title: "Login", url: "https://github.com/o/r/pull/482" },
            instance: { id: 42, name: "login" },
          },
          { name: "odd", pull_request: { title: "no number" }, instance: { id: "x" } },
          { default: false },
          "garbage",
        ],
        meta: { pull_requests_unavailable: false },
      },
    }));
    await expect(client.branches(66, " Log ")).resolves.toEqual({
      branches: [
        { name: "main", default: true, pullRequest: null, instance: { id: 9, name: "default" } },
        {
          name: "feature/login",
          default: false,
          pullRequest: { number: 482, title: "Login", url: "https://github.com/o/r/pull/482" },
          instance: { id: 42, name: "login" },
        },
        { name: "odd", default: false, pullRequest: null, instance: null },
      ],
      pullRequestsUnavailable: false,
    });
    expect(requests.at(-1)).toEqual({
      method: "GET",
      path: "/projects/66/branches",
      query: { query: "Log" },
      timeoutMs: 25_000,
    });
    // An empty search sends no query at all.
    await client.branches(66, "  ");
    expect(requests.at(-1)?.query).toBeUndefined();
  });

  it("reads pull_requests_unavailable and fails on a list that is no array", async () => {
    const unavailable = recording(() => ({
      status: 200,
      body: { data: [{ name: "main", default: true }], meta: { pull_requests_unavailable: true } },
    }));
    await expect(unavailable.client.branches(1, "")).resolves.toMatchObject({
      pullRequestsUnavailable: true,
    });
    const broken = recording(() => ({ status: 200, body: { data: { name: "main" } } }));
    await expect(broken.client.branches(1, "")).rejects.toMatchObject({
      code: "gateway.response_invalid",
    });
  });

  it("keeps the Gateway's code for a refused branch read", async () => {
    for (const [status, code] of [
      [409, "instance.default_missing"],
      [502, "source.head_unavailable"],
    ] as const) {
      const { client } = recording(() => ({
        status,
        body: { status, error: { code, message: "no", details: {} } },
      }));
      await expect(client.branches(1, "a..b")).rejects.toMatchObject({ code, status });
    }
  });

  it("sends a branch on create only when one is chosen, with only the mode's keys", async () => {
    const { client, requests } = recording(() => ({
      status: 202,
      body: { data: { id: 1, kind: "instance.create", status: "queued", target_id: 2 } },
    }));
    await client.createThreadInstance(3, "fix", "k");
    await client.createThreadInstance(3, "fix", "k", null);
    await client.createThreadInstance(3, "fix", "k", { mode: "new", from: "develop" });
    await client.createThreadInstance(3, "fix", "k", {
      mode: "existing",
      name: "feature/login",
      // A stray key from a widened object never reaches Orbit, which refuses extra keys.
      ...({ from: "main" } as object),
    });
    expect(requests.map((request) => request.body)).toEqual([
      { name: "fix" },
      { name: "fix" },
      { name: "fix", branch: { mode: "new", from: "develop" } },
      { name: "fix", branch: { mode: "existing", name: "feature/login" } },
    ]);
  });
});
