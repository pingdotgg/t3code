import * as Alchemy from "alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import { retain } from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as NodeURL from "node:url";

const protocol = new URL("../vendor/vite-plus-remote-cache-cloudflare/", import.meta.url);

export const cacheName = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  return stage === "prod" ? "t3-task-cache" : `t3-task-cache-${stage}`;
});

export const Index = cacheName.pipe(
  Effect.flatMap((name) =>
    Cloudflare.D1.Database("Index", {
      name,
      migrations: NodeURL.fileURLToPath(new URL("migrations", protocol)),
    }).pipe(adopt(true), retain()),
  ),
);

export const Artifacts = cacheName.pipe(
  Effect.flatMap((name) =>
    Cloudflare.R2.Bucket("Artifacts", {
      name,
      lifecycleRules: [
        {
          id: "remote-cache-generations",
          deleteObjectsTransition: { condition: { type: "Age", maxAge: 9 * 86400 } },
          abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 86400 } },
        },
      ],
    }).pipe(adopt(true), retain()),
  ),
);

// Fingerprint-keyed simulator/emulator dev clients; separate from the 9-day task-cache generations.
export const NativeClients = cacheName.pipe(
  Effect.flatMap((name) =>
    Cloudflare.R2.Bucket("NativeClients", {
      name: `${name}-native-clients`,
      lifecycleRules: [
        {
          id: "native-client-retention",
          deleteObjectsTransition: { condition: { type: "Age", maxAge: 30 * 86400 } },
          abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 86400 } },
        },
      ],
    }).pipe(retain()),
  ),
);

export const Savings = cacheName.pipe(
  Effect.flatMap((name) =>
    Cloudflare.D1.Database("Savings", {
      name: `${name}-savings`,
      migrations: NodeURL.fileURLToPath(new URL("../migrations/savings", import.meta.url)),
    }).pipe(retain()),
  ),
);
