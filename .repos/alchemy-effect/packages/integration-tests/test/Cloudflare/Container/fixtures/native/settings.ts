import * as Cloudflare from "@alchemy.run/cloudflare";
import { declareDurableObjectApplication } from "@alchemy.run/cloudflare/Containers/DurableObjectApplication";
import * as Effect from "effect/Effect";
import type { NativeAsyncObject } from "./async-worker.ts";

/** Public half of a key generated once for these tests; the private key was discarded. */
export const TEST_SSH_PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHyBNPTu6UntBqHyD4LsYK16cRDTf2k+uD10WnuvHYoe alchemy-container-test";

export type ApplicationSettings = Pick<
  Cloudflare.Containers.DurableObjectContainerProps,
  "ssh" | "authorizedKeys" | "observability"
>;

/**
 * Two Containers backing one Durable Object class. Application-wide settings
 * may be declared on either one; `tools` declares its own to probe conflicts.
 */
export const settingsStack = (
  settings: ApplicationSettings = {},
  tools: ApplicationSettings = {},
) =>
  Effect.gen(function* () {
    const shell = Cloudflare.Container("SettingsShell", {
      schedulingPolicy: "durable_object",
      image: "alpine:3.21",
      ...settings,
    });
    const toolbox = Cloudflare.Container("SettingsTools", {
      schedulingPolicy: "durable_object",
      image: "alpine:3.20",
      ...tools,
    });
    const worker = yield* Cloudflare.Worker("SettingsWorker", {
      main: `${import.meta.dirname}/async-worker.ts`,
      env: {
        SANDBOX: Cloudflare.DurableObject<NativeAsyncObject>("NativeAsyncObject", {
          containers: [shell, toolbox],
        }),
        IMAGE_REVISION: "settings",
      },
    });
    return {
      worker,
      application: yield* declareDurableObjectApplication(worker, "NativeAsyncObject"),
    };
  });

/** A container application declared under one logical id with either scheduling policy. */
export const policyStack = (policy: "default" | "durable_object") =>
  Effect.gen(function* () {
    if (policy === "default") {
      return yield* Cloudflare.Container("PolicySwitch", { image: "alpine:3.21" }).Application;
    }
    return yield* Cloudflare.Container("PolicySwitch", {
      schedulingPolicy: "durable_object",
      image: "alpine:3.21",
    }).Application;
  });
