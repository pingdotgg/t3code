import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import OwnedAccessWorker from "./fixtures/access-owned-worker.ts";
import SecondAccessWorker from "./fixtures/access-worker-b.ts";
import AccessProtectedWorker, { App } from "./fixtures/access-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class NotYetProtected extends Data.TaggedError("NotYetProtected")<{
  status: number;
  location: string | null;
  bodyExcerpt: string;
}> {}

/**
 * Probe `url` without following redirects until Cloudflare Access
 * intercepts it — a 302 to the team's `cloudflareaccess.com` login page.
 * Freshly-deployed workers.dev URLs 404/530 briefly and then serve the
 * open worker until the Access policy propagates, so every non-intercepted
 * response is retried.
 */
const expectAccessLoginRedirect = (url: string) =>
  Effect.gen(function* () {
    const probe = Effect.tryPromise({
      try: async (signal) => {
        const res = await fetch(url, {
          signal,
          redirect: "manual",
          cache: "no-store",
        });
        const location = res.headers.get("location");
        if (
          res.status === 302 &&
          location !== null &&
          location.includes("cloudflareaccess.com")
        ) {
          return location;
        }
        const body = await res.text();
        throw new NotYetProtected({
          status: res.status,
          location,
          bodyExcerpt: body.slice(0, 200),
        });
      },
      catch: (e) =>
        e instanceof NotYetProtected
          ? e
          : new NotYetProtected({
              status: 0,
              location: null,
              bodyExcerpt: e instanceof Error ? e.message : String(e),
            }),
    });
    return yield* probe.pipe(
      Effect.retry({
        while: (e) => e._tag === "NotYetProtected",
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("1 second", 1.5),
            Schedule.spaced("5 seconds"),
          ]),
          Schedule.recurs(24),
        ]),
      }),
    );
  });

/** Structural view of the live application for out-of-band assertions. */
interface LiveApp {
  destinations?: ReadonlyArray<{
    type?: string | null;
    workerId?: string | null;
  }> | null;
  policies?: ReadonlyArray<{
    id?: string | null;
    decision?: string | null;
    reusable?: boolean | null;
  }> | null;
}

test.provider(
  "the access prop enrolls a Worker into an Access application with inline policies",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deployStack = Effect.gen(function* () {
        const worker = yield* AccessProtectedWorker;
        const app = yield* App;
        return { worker, app };
      });

      const { worker, app } = yield* stack.deploy(deployStack);

      // The application carries the inline (application-owned) policy.
      expect(app.applicationId).toBeDefined();
      expect(app.aud.length).toBeGreaterThan(0);
      const live = (yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: app.applicationId,
      })) as unknown as LiveApp;
      expect(live.policies?.length).toBe(1);
      expect(live.policies![0].decision).toBe("allow");
      expect(live.policies![0].reusable).toBe(false);
      const inlinePolicyId = live.policies![0].id;
      expect(inlinePolicyId).toBeDefined();

      // The Worker enrolled itself: worker + preview destinations keyed by
      // its immutable script id, contributed through the application's
      // binding contract.
      expect(worker.workerId).toBeDefined();
      expect(app.destinations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "worker",
            workerId: worker.workerId,
          }),
        ]),
      );
      expect(live.destinations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "worker",
            workerId: worker.workerId,
          }),
          expect.objectContaining({
            type: "preview_worker",
            workerId: worker.workerId,
          }),
        ]),
      );

      // Unauthenticated requests are redirected to the Access login page
      // instead of reaching the worker.
      const location = yield* expectAccessLoginRedirect(worker.url!);
      expect(location).toContain("cloudflareaccess.com");

      // Idempotence: a second deploy must not churn the inline policy (an
      // id-less inline item in an update PUT would mint a fresh policy) or
      // duplicate the destinations.
      yield* stack.deploy(deployStack);
      const liveAfter = (yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: app.applicationId,
      })) as unknown as LiveApp;
      expect(liveAfter.policies?.length).toBe(1);
      expect(liveAfter.policies![0].id).toBe(inlinePolicyId);
      expect(
        (liveAfter.destinations ?? []).filter(
          (d) => d.workerId === worker.workerId,
        ),
      ).toHaveLength(2);

      yield* stack.destroy();

      // The application (and its inline policy with it) is gone.
      const gone = yield* zeroTrust
        .getAccessApplicationForAccount({ accountId, appId: app.applicationId })
        .pipe(
          Effect.map(() => "still-exists" as const),
          Effect.catchTag("AccessApplicationNotFound", () =>
            Effect.succeed("gone" as const),
          ),
        );
      expect(gone).toBe("gone");
    }).pipe(logLevel),
  { timeout: 300_000 },
);

/** Find a live application by its exact display name, or undefined. */
const findAppByName = (accountId: string, name: string) =>
  zeroTrust.listAccessApplicationsForAccount.pages({ accountId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .flatMap((page) => page.result ?? [])
        .map(
          (raw) => raw as unknown as LiveApp & { id?: string; name?: string },
        )
        .find((app) => app.name === name),
    ),
  );

test.provider(
  "access.policies declares a dedicated application owned by the Worker",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const { worker } = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* OwnedAccessWorker;
          return { worker };
        }),
      );

      // The dedicated application exists with the inline policy and this
      // Worker's destinations — declared entirely from the `access` prop.
      const app = yield* findAppByName(
        accountId,
        "Access for alchemy owned-app test",
      );
      expect(app).toBeDefined();
      expect(app!.policies?.length).toBe(1);
      expect(app!.policies![0].decision).toBe("allow");
      expect(app!.policies![0].reusable).toBe(false);
      // `previews: false` — production destination only.
      expect(app!.destinations).toEqual([
        expect.objectContaining({ type: "worker", workerId: worker.workerId }),
      ]);

      // Unauthenticated requests are intercepted.
      const location = yield* expectAccessLoginRedirect(worker.url!);
      expect(location).toContain("cloudflareaccess.com");

      yield* stack.destroy();

      // The dedicated application is deleted with the Worker's stack.
      const appAfter = yield* findAppByName(
        accountId,
        "Access for alchemy owned-app test",
      );
      expect(appAfter).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 300_000 },
);

test.provider(
  "a shared application merges enrollments from multiple Workers",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Two Workers enroll into the SAME application.
      const both = Effect.gen(function* () {
        const a = yield* AccessProtectedWorker;
        const b = yield* SecondAccessWorker;
        const app = yield* App;
        return { a, b, app };
      });
      const { a, b, app } = yield* stack.deploy(both);

      const live = (yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: app.applicationId,
      })) as unknown as LiveApp;
      const workerDestinations = (live.destinations ?? []).filter(
        (d) => d.workerId === a.workerId || d.workerId === b.workerId,
      );
      expect(workerDestinations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "worker", workerId: a.workerId }),
          expect.objectContaining({
            type: "preview_worker",
            workerId: a.workerId,
          }),
          expect.objectContaining({ type: "worker", workerId: b.workerId }),
          expect.objectContaining({
            type: "preview_worker",
            workerId: b.workerId,
          }),
        ]),
      );
      expect(workerDestinations).toHaveLength(4);

      // Un-enrollment without destroy: remove worker B from the stack —
      // its binding contribution disappears and the application converges
      // to worker A's destinations only.
      const onlyA = Effect.gen(function* () {
        const a = yield* AccessProtectedWorker;
        const app = yield* App;
        return { a, app };
      });
      yield* stack.deploy(onlyA);
      const liveAfter = (yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: app.applicationId,
      })) as unknown as LiveApp;
      const remaining = (liveAfter.destinations ?? []).filter(
        (d) => d.workerId === a.workerId || d.workerId === b.workerId,
      );
      expect(remaining).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "worker", workerId: a.workerId }),
          expect.objectContaining({
            type: "preview_worker",
            workerId: a.workerId,
          }),
        ]),
      );
      expect(remaining).toHaveLength(2);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);
