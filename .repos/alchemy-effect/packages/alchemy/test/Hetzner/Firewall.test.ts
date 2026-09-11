import * as Hetzner from "@/Hetzner";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { Services } from "@distilled.cloud/hetzner";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Hetzner.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasHetznerCreds = !!process.env.HCLOUD_TOKEN;

const sshRule: Hetzner.FirewallRule = {
  direction: "in",
  protocol: "tcp",
  port: "22",
  sourceIps: ["0.0.0.0/0", "::/0"],
  description: "ssh",
};

const httpRule: Hetzner.FirewallRule = {
  direction: "in",
  protocol: "tcp",
  port: "80",
  sourceIps: ["0.0.0.0/0", "::/0"],
  description: "http",
};

const waitUntilGone = (id: number) =>
  Services.firewalls.getFirewall({ id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasHetznerCreds)(
  "create, update rules and labels, and delete a firewall",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Firewall("Web", {
            rules: [sshRule],
            labels: { env: "test" },
          });
        }),
      );

      expect(created.id).toEqual(expect.any(Number));
      expect(created.name).toEqual(expect.any(String));
      expect(created.created).toEqual(expect.any(String));
      expect(created.appliedTo).toEqual([]);
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.rules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            direction: "in",
            protocol: "tcp",
            port: "22",
            description: "ssh",
          }),
        ]),
      );

      const fetched = yield* Services.firewalls.getFirewall({
        id: created.id,
      });
      expect(fetched.firewall.id).toEqual(created.id);
      expect(fetched.firewall.name).toEqual(created.name);
      expect(fetched.firewall.applied_to).toEqual([]);
      expect(fetched.firewall.labels?.env).toEqual("test");
      expect(fetched.firewall.rules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            direction: "in",
            protocol: "tcp",
            port: "22",
            description: "ssh",
          }),
        ]),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Firewall("Web", {
            rules: [sshRule, httpRule],
            labels: { env: "prod", role: "edge" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.name).toEqual(created.name);
      expect(updated.appliedTo).toEqual([]);
      expect(updated.labels).toMatchObject({ env: "prod", role: "edge" });
      expect(updated.rules).toHaveLength(2);
      expect(updated.rules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ port: "22", description: "ssh" }),
          expect.objectContaining({ port: "80", description: "http" }),
        ]),
      );

      const refetched = yield* Services.firewalls.getFirewall({
        id: updated.id,
      });
      expect(refetched.firewall.id).toEqual(created.id);
      expect(refetched.firewall.labels?.env).toEqual("prod");
      expect(refetched.firewall.labels?.role).toEqual("edge");
      expect(refetched.firewall.rules).toHaveLength(2);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasHetznerCreds)(
  "list enumerates the deployed firewall",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Firewall("ListFw", {
            rules: [sshRule],
          });
        }),
      );

      const provider = yield* Provider.findProvider(Hetzner.Firewall);
      const all = yield* provider.list();
      const found = all.find((item) => item.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(deployed.name);
      expect(found?.rules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            direction: "in",
            protocol: "tcp",
            port: "22",
          }),
        ]),
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
