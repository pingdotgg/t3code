import * as Hetzner from "@/Hetzner";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { Services } from "@distilled.cloud/hetzner";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Hetzner.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasHetznerCreds = !!process.env.HCLOUD_TOKEN;

const waitUntilGone = (id: number) =>
  Services.servers.getServer({ id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test(
  "composes user data with the alchemy bootstrap",
  Effect.gen(function* () {
    // No user data: the bootstrap script is sent as-is.
    const bootstrap = Hetzner.composeUserData(undefined);
    expect(bootstrap.startsWith("#!/bin/bash")).toBe(true);
    expect(bootstrap).toContain("setup_26.x");

    // A cloud-config document becomes the second part of a multipart
    // cloud-init document, behind the bootstrap script.
    const composed = Hetzner.composeUserData(
      ["#cloud-config", "packages:", "  - nginx"].join("\n"),
    );
    expect(
      composed.startsWith('Content-Type: multipart/mixed; boundary="'),
    ).toBe(true);
    expect(composed).toContain("Content-Type: text/x-shellscript");
    expect(composed).toContain("Content-Type: text/cloud-config");
    expect(composed).toContain("  - nginx");
    expect(composed.indexOf("setup_26.x")).toBeLessThan(
      composed.indexOf("#cloud-config"),
    );

    // A shell script keeps its shebang; a bare snippet gets one.
    expect(Hetzner.composeUserData("#!/bin/sh\nid")).toContain("#!/bin/sh\nid");
    expect(Hetzner.composeUserData("apt-get install -y nginx")).toContain(
      "#!/bin/bash\napt-get install -y nginx",
    );

    // A caller-supplied MIME document owns the whole payload.
    const raw = 'Content-Type: multipart/mixed; boundary="x"\n\n--x--\n';
    expect(Hetzner.composeUserData(raw)).toEqual(raw);
  }),
);

test.provider.skipIf(!hasHetznerCreds)(
  "create, update, and delete a server",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Server("Web", {
            serverType: "cpx12",
            image: "ubuntu-24.04",
            location: "nbg1",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.id).toEqual(expect.any(Number));
      expect(created.serverId).toEqual(created.id);
      expect(created.name).toEqual(expect.any(String));
      expect(created.serverType).toEqual("cpx12");
      expect(created.image).toEqual("ubuntu-24.04");
      expect(created.location).toEqual("nbg1");
      expect(created.locationId).toEqual(expect.any(Number));
      expect(created.ipv4).toEqual(expect.any(String));
      expect(created.ipv6).toEqual(expect.any(String));
      expect(created.deleteProtection).toEqual(false);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* Services.servers.getServer({
        id: created.id,
      });
      expect(fetched.server?.id).toEqual(created.id);
      expect(fetched.server?.server_type.name).toEqual("cpx12");
      expect(fetched.server?.image?.name).toEqual("ubuntu-24.04");
      expect(fetched.server?.location.name).toEqual("nbg1");
      expect(fetched.server?.public_net.ipv4?.ip).toEqual(created.ipv4);
      expect(fetched.server?.public_net.ipv6?.ip).toEqual(created.ipv6);
      expect(fetched.server?.labels.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Server("Web", {
            serverType: "cpx12",
            image: "ubuntu-24.04",
            location: "nbg1",
            labels: { env: "prod", role: "web" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.serverId).toEqual(created.serverId);
      expect(updated.ipv4).toEqual(created.ipv4);
      expect(updated.ipv6).toEqual(created.ipv6);
      expect(updated.labels).toMatchObject({ env: "prod", role: "web" });

      const refetched = yield* Services.servers.getServer({
        id: updated.id,
      });
      expect(refetched.server?.id).toEqual(created.id);
      expect(refetched.server?.labels.env).toEqual("prod");
      expect(refetched.server?.labels.role).toEqual("web");
      expect(refetched.server?.public_net.ipv4?.ip).toEqual(created.ipv4);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000, exclusive: true },
);

test.provider.skipIf(!hasHetznerCreds)(
  "replace when image changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Server("ReplaceWeb", {
            serverType: "cpx12",
            image: "ubuntu-24.04",
            location: "nbg1",
          });
        }),
      );

      expect(created.image).toEqual("ubuntu-24.04");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Server("ReplaceWeb", {
            serverType: "cpx12",
            image: "debian-12",
            location: "nbg1",
          });
        }),
      );

      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.image).toEqual("debian-12");
      expect(replaced.location).toEqual("nbg1");
      expect(replaced.serverType).toEqual("cpx12");

      const fetched = yield* Services.servers.getServer({
        id: replaced.id,
      });
      expect(fetched.server?.image?.name).toEqual("debian-12");

      const oldGone = yield* waitUntilGone(created.id);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000, exclusive: true },
);

test.provider.skipIf(!hasHetznerCreds)(
  "list enumerates the deployed server",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Server("ListWeb", {
            serverType: "cpx12",
            image: "ubuntu-24.04",
            location: "nbg1",
          });
        }),
      );

      const provider = yield* Provider.findProvider(Hetzner.Server);
      const all = yield* provider.list();
      const found = all.find((server) => server.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.serverType).toEqual("cpx12");
      expect(found?.image).toEqual("ubuntu-24.04");
      expect(found?.location).toEqual("nbg1");
      expect(found?.ipv4).toEqual(deployed.ipv4);
      expect(found?.ipv6).toEqual(deployed.ipv6);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000, exclusive: true },
);

test.provider.skipIf(!hasHetznerCreds)(
  "runs a custom init script alongside the alchemy bootstrap",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const server = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Server("InitWeb", {
            serverType: "cpx12",
            image: "ubuntu-24.04",
            location: "nbg1",
            userData: [
              "#!/bin/bash",
              "echo alchemy-init-ok > /etc/alchemy-init-marker",
            ].join("\n"),
          });
        }),
      );

      expect(server.ipv4).toEqual(expect.any(String));
      expect(server.privateKey).toBeDefined();
      const host = server.ipv4 ?? "";
      const privateKey =
        server.privateKey === undefined
          ? ""
          : Redacted.value(server.privateKey);

      // Both cloud-init parts must have run: the user script (marker file)
      // and Alchemy's bootstrap (Node 26). Probed as one command — the box is
      // still booting when the create action completes.
      const probe = yield* Effect.gen(function* () {
        const ssh = yield* Hetzner.openSshClient({ host, privateKey });
        const { stdout } = yield* ssh.exec(
          "cat /etc/alchemy-init-marker && command -v node && echo node-ok",
        );
        return stdout;
      }).pipe(
        Effect.scoped,
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 30 }),
      );

      expect(probe).toContain("alchemy-init-ok");
      expect(probe).toContain("node-ok");

      // Cloud-init only runs on first boot, so a changed script replaces.
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.Server("InitWeb", {
            serverType: "cpx12",
            image: "ubuntu-24.04",
            location: "nbg1",
            userData: [
              "#!/bin/bash",
              "echo alchemy-init-v2 > /etc/alchemy-init-marker",
            ].join("\n"),
          });
        }),
      );

      expect(replaced.id).not.toEqual(server.id);

      const oldGone = yield* waitUntilGone(server.id);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 300_000, exclusive: true },
);
