import * as AWS from "@/AWS";
import type { ProviderService } from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

/**
 * Dual-mode AWS providers whose LOCAL variant is a process on this machine
 * (a dev server), not the floci emulator. They have no emulator API for a
 * binding client to route to, so `resolveLocalDataPlane` deliberately falls
 * back to the real cloud for them (see Provider.ts). Every other AWS dual
 * runs on floci and must say so.
 */
const PROCESS_HOSTED = new Set([
  "Command.Dev",
  "AWS.Website.Server",
  "Website.Server",
]);

/**
 * Every floci-backed dual provider must declare the emulator as its
 * {@link ProviderService.localDataPlane}. A dual that doesn't is a silent
 * hole in `alchemy dev`: a deploy-time binding client bound to it (an
 * Action body, a plan-time `execute`) is left unrouted — a single-resource
 * binding such as `InvokeFunction(fn)` then targets the real cloud, and a
 * binding spanning a declaring sibling (`RunTask(cluster, task)`) dies with
 * "Binding client spans mixed data planes" (the reported bug; its e2e is
 * test/AWS/Local/Actions.local.test.ts).
 *
 * `flociDual` declares it for you; the hand-written floci providers
 * (`ProviderLayer.dual` with a `Floci*Provider` local) have to say so
 * explicitly — this walks the registry and pins that they all do.
 */
test.provider(
  "every floci-backed dual AWS provider declares its local data plane",
  () =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const missing: string[] = [];
      let duals = 0;
      for (const [key, value] of context.mapUnsafe) {
        const entry = value as Partial<ProviderService> & {
          kind?: string;
          providers?: Record<string, ProviderService>;
        };
        // Providers live in context either as individual `Provider` tags or
        // inside a `ProviderCollection` keyed by resource type.
        const candidates: [string, Partial<ProviderService>][] =
          entry.kind === "ProviderCollection" && entry.providers
            ? Object.entries(entry.providers)
            : typeof entry.reconcile === "function"
              ? [[String(key), entry]]
              : [];
        for (const [type, service] of candidates) {
          if (service.modes === undefined || PROCESS_HOSTED.has(type)) continue;
          duals += 1;
          if (service.localDataPlane === undefined) missing.push(type);
        }
      }
      // Sanity: the registry was actually walked (hundreds of duals).
      expect(duals).toBeGreaterThan(100);
      expect(missing).toEqual([]);
    }),
);
