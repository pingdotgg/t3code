import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as androidmanagement from "@distilled.cloud/gcp/androidmanagement_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { enterpriseName, logLevel, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  androidmanagement.getEnterprisesWebApps({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(runLifecycle)(
  "getEnterprisesWebApps without the Android Management scope fails with InsufficientScopes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidmanagement.getEnterprisesWebApps({
          name: "enterprises/alchemy-missing-enterprise/webApps/com.alchemy.missing",
        }),
      );
      expect(error._tag).toEqual("InsufficientScopes");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androidmanagement", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "createEnterprisesWebApps without Android Management access fails with a typed entitlement error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidmanagement.createEnterprisesWebApps({
          parent: "enterprises/alchemy-missing-enterprise",
          body: {
            title: "Alchemy Probe",
            startUrl: "https://example.com/",
            displayMode: "STANDALONE",
          },
        }),
      );
      expect(error._tag).toEqual("InsufficientScopes");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androidmanagement", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a web app",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const enterprise = enterpriseName
            ? { name: enterpriseName }
            : yield* GCP.AndroidManagement.Enterprise("WebHost", {
                enterpriseDisplayName: "Web Host",
              });
          const app = yield* GCP.AndroidManagement.EnterprisesWebApp("Docs", {
            parent: enterprise.name,
            startUrl: "https://example.com/alchemy-docs",
            title: "Docs",
          });
          return { enterprise, app };
        }),
      );

      expect(created.app.name).toContain("/webApps/");
      expect(created.app.parent).toEqual(created.enterprise.name);
      expect(created.app.title).toEqual("Docs");
      expect(created.app.startUrl).toEqual("https://example.com/alchemy-docs");

      const fetched = yield* androidmanagement.getEnterprisesWebApps({
        name: created.app.name,
      });
      expect(fetched.name).toEqual(created.app.name);
      expect(fetched.title).toEqual("Docs");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const enterprise = enterpriseName
            ? { name: enterpriseName }
            : yield* GCP.AndroidManagement.Enterprise("WebHost", {
                enterpriseDisplayName: "Web Host",
              });
          return yield* GCP.AndroidManagement.EnterprisesWebApp("Docs", {
            parent: enterprise.name,
            startUrl: "https://example.com/alchemy-docs",
            title: "Internal docs",
            displayMode: "MINIMAL_UI",
          });
        }),
      );

      expect(updated.name).toEqual(created.app.name);
      expect(updated.title).toEqual("Internal docs");
      expect(updated.displayMode).toEqual("MINIMAL_UI");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.app.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androidmanagement", "live"],
    timeout: 90_000,
  },
);
