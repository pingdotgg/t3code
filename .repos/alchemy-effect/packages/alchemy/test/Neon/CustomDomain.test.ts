import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import { Project } from "@/Neon/Project";
import { Function } from "@/Neon/Function";
import { CustomDomain } from "@/Neon/CustomDomain";
import { providers } from "@/Neon/Providers";
import * as AlchemyOutput from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Api from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";

const { test } = Test.make({
  providers: Layer.mergeAll(providers(), Cloudflare.providers()),
});
test.provider(
  "custom domain registers independently and returns DNS before activation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const tls = yield* Config.String("NODE_TLS_REJECT_UNAUTHORIZED").pipe(
        Config.withDefault("1"),
      );
      expect(tls).not.toBe("0");
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zone = yield* findZoneByName({
        accountId,
        name: "alchemy-test-2.us",
      });
      if (!zone) {
        return yield* Effect.fail(new Error("alchemy-test-2.us not found"));
      }
      const zoneId = zone.id;
      const resources = Effect.gen(function* () {
        const project = yield* Project("DomainProject", {
          region: "aws-us-east-2",
        });
        const api = yield* Function("Api", {
          project,
          main: new URL("./fixtures/function-bare.ts", import.meta.url).href,
        });
        return { project, api };
      });
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, api } = yield* resources;
          const domain = yield* CustomDomain("Domain", {
            function: api,
            hostname: api.slug.pipe(
              AlchemyOutput.map((slug) => `${slug}.alchemy-test-2.us`),
            ),
          });
          const record = yield* Cloudflare.DNS.Record("DomainCname", {
            zoneId,
            name: domain.hostname,
            type: "CNAME",
            content: domain.cnameTarget,
            proxied: false,
            ttl: 60,
          });
          return { project, api, domain, record };
        }),
      );
      expect(deployed.domain.cnameTarget.length).toBeGreaterThan(0);
      expect(deployed.domain.url).toBe(`https://${deployed.domain.hostname}`);
      const liveRecord = yield* dns.getRecord({
        zoneId,
        dnsRecordId: deployed.record.recordId,
      });
      expect(liveRecord.name).toBe(deployed.domain.hostname);
      expect(liveRecord.type).toBe("CNAME");
      expect(liveRecord.content).toBe(deployed.domain.cnameTarget);
      expect(liveRecord.proxied).toBe(false);
      expect(liveRecord.ttl).toBe(60);
      const observeDomain = Api.listProjectBranchCustomDomains({
        project_id: deployed.api.projectId,
        branch_id: deployed.api.branchId,
      }).pipe(
        Effect.map(({ custom_domains }) =>
          custom_domains.find(
            (domain) => domain.domain === deployed.domain.hostname,
          ),
        ),
      );
      const registered = yield* observeDomain;
      expect(registered?.entity_type).toBe("function");
      expect(registered?.entity_id).toBe(deployed.api.slug);
      expect(registered?.cname_target).toBe(deployed.domain.cnameTarget);
      const client = yield* HttpClient.HttpClient;
      const activation = yield* Effect.gen(function* () {
        const domain = yield* observeDomain;
        const https = yield* Effect.gen(function* () {
          if (domain?.dns_status !== "ok") {
            return { status: 0, body: "DNS validation pending" };
          }
          const response = yield* client.get(deployed.domain.url);
          const body = yield* response.text;
          return { status: response.status, body };
        }).pipe(
          Effect.timeout("6 seconds"),
          Effect.catch((error) =>
            Effect.logWarning("Custom domain HTTPS probe failed", error).pipe(
              Effect.as({ status: 0, body: String(error) }),
            ),
          ),
        );
        yield* Effect.logInfo("Custom domain activation", { domain, https });
        return { domain, https };
      }).pipe(
        Effect.repeat({
          // Neon's background DNS check lands around 45-50s, so leave headroom.
          schedule: Schedule.spaced("5 seconds"),
          times: 23,
          until: ({ domain, https }) =>
            domain?.status === "active" &&
            domain.dns_status === "ok" &&
            domain.binding_status === "present" &&
            https.status === 200 &&
            https.body === "bare-v2",
        }),
        Effect.timeout("150 seconds"),
      );
      expect(activation.domain?.status).toBe("active");
      expect(activation.domain?.dns_status).toBe("ok");
      expect(activation.domain?.binding_status).toBe("present");
      expect(activation.https.status).toBe(200);
      expect(activation.https.body).toBe("bare-v2");

      const retained = yield* stack.deploy(resources);
      expect(retained.project.projectId).toBe(deployed.project.projectId);
      expect(retained.api.slug).toBe(deployed.api.slug);
      const remainingRecords = yield* dns.listRecords
        .items({
          zoneId,
          name: { exact: deployed.domain.hostname },
          type: "CNAME",
        })
        .pipe(Stream.runCollect);
      expect(remainingRecords.length).toBe(0);
      expect(yield* observeDomain).toBeUndefined();
      const retainedProject = yield* Api.getProject({
        project_id: deployed.project.projectId,
      });
      expect(retainedProject.project.id).toBe(deployed.project.projectId);
      yield* stack.destroy();
      const projectExists = yield* Api.getProject({
        project_id: deployed.project.projectId,
      }).pipe(
        Effect.as(true),
        Effect.catchTag("NotFound", () => Effect.succeed(false)),
      );
      expect(projectExists).toBe(false);
      yield* Effect.logInfo(
        "Custom domain, DNS record, and project independently absent",
      );
    }),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "provider:cloudflare:zone",
      "provider:neon",
      "provider:neon:customdomain",
      "provider:neon:function",
      "provider:neon:project",
      "live",
    ],
    timeout: 240_000,
  },
);
