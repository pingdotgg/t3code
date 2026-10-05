import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as monitoring from "@distilled.cloud/gcp/monitoring_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  monitoring.getProjectsNotificationChannels({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, replace, and delete a notification channel",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Monitoring.NotificationChannel("Alerts", {
            type: "email",
            description: "oncall",
            labels: { email_address: "alchemy-test@example.com" },
            userLabels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/notificationChannels/");
      expect(created.notificationChannelId).toEqual(expect.any(String));
      expect(created.type).toEqual("email");
      expect(created.description).toEqual("oncall");
      expect(created.labels.email_address).toEqual("alchemy-test@example.com");
      expect(created.userLabels).toMatchObject({ env: "test" });
      expect(created.enabled).toEqual(true);

      const fetched = yield* monitoring.getProjectsNotificationChannels({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.type).toEqual("email");
      expect(fetched.labels?.email_address).toEqual("alchemy-test@example.com");
      expect(fetched.userLabels?.env).toEqual("test");
      expect(
        Object.keys(fetched.userLabels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Monitoring.NotificationChannel("Alerts", {
            type: "email",
            displayName: created.displayName,
            description: "oncall v2",
            labels: { email_address: "alchemy-alerts@example.com" },
            userLabels: { env: "prod", role: "alerts" },
            enabled: false,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("oncall v2");
      expect(updated.labels.email_address).toEqual(
        "alchemy-alerts@example.com",
      );
      expect(updated.userLabels).toMatchObject({
        env: "prod",
        role: "alerts",
      });
      expect(updated.enabled).toEqual(false);

      const fetchedUpdate = yield* monitoring.getProjectsNotificationChannels({
        name: updated.name,
      });
      expect(fetchedUpdate.description).toEqual("oncall v2");
      expect(fetchedUpdate.enabled).toEqual(false);
      expect(fetchedUpdate.labels?.email_address).toEqual(
        "alchemy-alerts@example.com",
      );

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Monitoring.NotificationChannel("Alerts", {
            type: "webhook_tokenauth",
            displayName: created.displayName,
            labels: { url: "https://example.com/hooks/alerts" },
            userLabels: { env: "prod" },
          });
        }),
      );

      expect(replaced.type).toEqual("webhook_tokenauth");
      expect(replaced.labels.url).toEqual("https://example.com/hooks/alerts");
      expect(replaced.name).not.toEqual(created.name);

      const oldGone = yield* waitUntilGone(created.name);
      expect(oldGone).toEqual("gone");

      const fetchedReplace = yield* monitoring.getProjectsNotificationChannels({
        name: replaced.name,
      });
      expect(fetchedReplace.type).toEqual("webhook_tokenauth");
      expect(fetchedReplace.labels?.url).toEqual(
        "https://example.com/hooks/alerts",
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:monitoring", "live"],
    timeout: 90_000,
  },
);
