import { NodeHttpServer } from "@effect/platform-node";
import { type ExecutionEnvironmentDescriptor, OrchestratorMcpFailure } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { Tool, Toolkit } from "effect/ai";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as PeerLinks from "./PeerLinks.ts";
import {
  descriptorOf,
  layerLinkingEnvironment,
  servePeer,
  type ServedPeer,
} from "./PeerLinks.testkit.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

/** What B's probe saw: the calling client and the modes it may start work with. */
const Probe = Schema.Struct({ caller: Schema.String, modes: Schema.String });

const ProbeToolkit = Toolkit.make(
  Tool.make("probe", {
    description: "Reports the calling client and the modes it may start work with.",
    success: Probe,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
  Tool.make("refuse", {
    description: "Always refuses.",
    success: Probe,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
  }),
);

const probeHandlers = McpToolAccess.toLayer(ProbeToolkit, {
  probe: McpToolAccess.reads(() =>
    McpInvocationContext.McpInvocationContext.pipe(
      Effect.map((scope) => {
        const modes = McpInvocationContext.clientModeCeiling(scope.client);
        return {
          caller: scope.client?.label ?? "none",
          modes: `${modes.runtimeMode}/${modes.interactionMode}`,
        };
      }),
    ),
  ),
  refuse: McpToolAccess.reads(() =>
    Effect.fail(
      new OrchestratorMcpFailure({ code: "thread_not_found", message: "No such thread." }),
    ),
  ),
});

const serveB = (descriptor: ExecutionEnvironmentDescriptor) =>
  servePeer(descriptor, McpHttpServer.toolkitRegistration(ProbeToolkit, probeHandlers));

/** Environment A, which links to B. */
const makeA = (descriptor: ExecutionEnvironmentDescriptor) =>
  layerLinkingEnvironment(descriptor).pipe(
    Layer.build,
    Effect.map((context) => ({
      links: Context.get(context, PeerLinks.PeerLinks),
      peer: Context.get(context, PeerMcpClient.PeerMcpClient),
    })),
  );

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box");
const probe = (
  a: Effect.Success<ReturnType<typeof makeA>>,
  limits: PeerMcpClient.PeerCallLimits = { runtimeMode: "full-access", interactionMode: "default" },
  tool = "probe",
) =>
  a.peer.call({
    environmentId: box.environmentId,
    tool,
    arguments: {},
    limits,
    success: Probe,
  });

const linkedSessions = (b: ServedPeer) => b.linkedSessions;

it.effect("links with a pairing code, and the peer holds its agents to the limits they carry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeA(laptop);

      const refused = yield* a.links
        .link({ url: b.url, pairingCode: "not-a-code", access: "auto" })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("pairing_rejected");
      expect(yield* linkedSessions(b)).toEqual([]);

      const pairing = yield* b.auth.issuePairingCredential();
      const linked = yield* a.links.link({
        url: b.url,
        pairingCode: pairing.credential,
        access: "auto",
      });
      expect(linked).toMatchObject({
        environmentId: box.environmentId,
        label: "Box",
        urls: [b.url],
        access: "auto",
      });
      // B lists the link under A's name, where it can be revoked.
      expect((yield* linkedSessions(b)).map((session) => session.client.label)).toEqual([
        "T3 Code · Laptop",
      ]);
      expect(
        (yield* a.links.list).map(({ environmentId, status }) => [environmentId, status]),
      ).toEqual([[box.environmentId, "reachable"]]);

      // The caller's limits narrow the link's access; they never widen it.
      expect(
        yield* probe(a, { runtimeMode: "approval-required", interactionMode: "plan" }),
      ).toEqual({ caller: "T3 Code · Laptop", modes: "approval-required/plan" });
      expect(yield* probe(a)).toEqual({ caller: "T3 Code · Laptop", modes: "auto/default" });

      // A refusal keeps the peer's reason.
      const notFound = yield* probe(a, undefined, "refuse").pipe(Effect.flip);
      expect(notFound).toMatchObject({ code: "thread_not_found", message: "No such thread." });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("two links racing to one peer leave the stored access matching the token", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeA(laptop);
      const [first, second] = yield* Effect.all(
        [b.auth.issuePairingCredential(), b.auth.issuePairingCredential()],
        { concurrency: 2 },
      );
      yield* Effect.all(
        [
          a.links.link({ url: b.url, pairingCode: first.credential, access: "read-only" }),
          a.links.link({ url: b.url, pairingCode: second.credential, access: "full-access" }),
        ],
        { concurrency: 2 },
      );
      const [stored] = yield* a.links.list;
      // The token sent is the one issued with the access the row records.
      const { modes } = yield* probe(a);
      expect(modes).toBe(
        stored!.access === "read-only" ? "approval-required/default" : "full-access/default",
      );
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("never sends a link's token to an address that stops answering as that peer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeA(laptop);
      const pairing = yield* b.auth.issuePairingCredential();
      yield* a.links.link({ url: b.url, pairingCode: pairing.credential, access: "auto" });
      yield* probe(a);
      expect((yield* Ref.get(b.bearers)).length).toBeGreaterThan(0);

      // The address now answers as another environment, as a reused LAN address would.
      yield* Ref.set(b.descriptor, descriptorOf("environment-impostor", "Impostor"));
      yield* Ref.set(b.bearers, []);
      const failed = yield* probe(a).pipe(Effect.flip);
      expect(failed.message).toContain("Box did not answer");
      expect(yield* Ref.get(b.bearers)).toEqual([]);
      expect((yield* a.links.list).map((link) => link.status)).toEqual(["unreachable"]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("reads one stored link without asking the peer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeA(laptop);
      const pairing = yield* b.auth.issuePairingCredential();
      yield* a.links.link({ url: b.url, pairingCode: pairing.credential, access: "auto" });
      yield* Ref.set(b.probes, 0);

      const stored = yield* a.links.get(box.environmentId);
      expect(Option.map(stored, (link) => link.label)).toEqual(Option.some("Box"));
      expect(Option.isNone(yield* a.links.get(laptop.environmentId))).toBe(true);
      expect(yield* Ref.get(b.probes)).toBe(0);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("tells the agent to link again once the peer revokes the link or it expires", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeA(laptop);
      const pairing = yield* b.auth.issuePairingCredential();
      yield* a.links.link({ url: b.url, pairingCode: pairing.credential, access: "auto" });
      yield* probe(a);

      const [session] = yield* linkedSessions(b);
      yield* b.auth.revokeSession(session!.sessionId);
      const revoked = yield* probe(a).pipe(Effect.flip);
      expect(revoked.code).toBe("capability_denied");
      expect(revoked.message).toContain("revoked there");

      yield* TestClock.adjust(Duration.days(31));
      expect((yield* a.links.list).map((link) => link.status)).toEqual(["expired"]);
      yield* Ref.set(b.bearers, []);
      const expired = yield* probe(a).pipe(Effect.flip);
      expect(expired.code).toBe("capability_denied");
      expect(expired.message).toContain("expired");
      expect(yield* Ref.get(b.bearers)).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "refuses to link itself, plain http off this machine and the tailnet, or a peer that cannot hold a linked agent to its limits",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* serveB(
          descriptorOf("environment-box", "Box", { mcpModeLimitHeader: false }),
        );
        const a = yield* makeA(laptop);
        const pairing = yield* b.auth.issuePairingCredential();
        const older = yield* a.links
          .link({ url: b.url, pairingCode: pairing.credential, access: "auto" })
          .pipe(Effect.flip);
        expect(older.reason).toBe("incompatible");

        // Plain http to a LAN address would carry the code and token in clear.
        const lan = yield* a.links
          .link({
            url: "http://192.168.1.20:3773",
            pairingCode: pairing.credential,
            access: "auto",
          })
          .pipe(Effect.flip);
        expect(lan.message).toContain("plain http");
        const lanAlternate = yield* a.links
          .link({
            url: b.url,
            alternateUrls: ["http://192.168.1.20:3773"],
            pairingCode: pairing.credential,
            access: "auto",
          })
          .pipe(Effect.flip);
        expect(lanAlternate.message).toContain("plain http");

        yield* Ref.set(b.descriptor, laptop);
        const self = yield* a.links
          .link({ url: b.url, pairingCode: pairing.credential, access: "auto" })
          .pipe(Effect.flip);
        expect(self.reason).toBe("self");
        // Neither attempt spent the pairing code on a session.
        expect(yield* linkedSessions(b)).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
