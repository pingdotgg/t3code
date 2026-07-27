import * as AWS from "@/AWS";
import { Domain } from "@/AWS/CodeArtifact/Domain.ts";
import { Repository } from "@/AWS/CodeArtifact/Repository.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as codeartifact from "@distilled.cloud/aws/codeartifact";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// CodeArtifact domain names must be lowercase; keep them deterministic.
const domainName = "alchemy-test-ca";
const repositoryName = "alchemy-test-repo";

const getRepository = codeartifact
  .describeRepository({ domain: domainName, repository: repositoryName })
  .pipe(
    Effect.map((res) => res.repository),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

const makeStack = (description: string, upstreamDescription: string) =>
  Effect.gen(function* () {
    const domain = yield* Domain("Domain", { domainName });
    const shared = yield* Repository("Shared", {
      domain: domain.domainName,
      repositoryName: `${repositoryName}-shared`,
      description: upstreamDescription,
    });
    const repo = yield* Repository("Repo", {
      domain: domain.domainName,
      repositoryName,
      description,
      upstreams: [shared.repositoryName],
      tags: { env: "test" },
    });
    return { domain, repo };
  });

test.provider(
  "lifecycle: create domain + repository with upstream, update, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const deployed = yield* stack.deploy(makeStack("first", "shared-first"));
      expect(deployed.repo.repositoryName).toBe(repositoryName);
      expect(deployed.repo.repositoryArn).toContain(`:repository/`);
      expect(deployed.domain.domainName).toBe(domainName);
      expect(deployed.domain.domainArn).toContain(`:domain/`);

      // Out-of-band verification via distilled.
      const created = yield* getRepository;
      expect(created?.name).toBe(repositoryName);
      expect(created?.description).toBe("first");
      expect(created?.upstreams?.map((u) => u.repositoryName)).toContain(
        `${repositoryName}-shared`,
      );

      const domainCheck = yield* codeartifact.describeDomain({
        domain: domainName,
      });
      expect(domainCheck.domain?.name).toBe(domainName);
      expect(domainCheck.domain?.repositoryCount).toBeGreaterThanOrEqual(2);

      // Canonical list() coverage for Domain.
      const domainProvider = yield* Provider.findProvider(Domain);
      const domains = yield* domainProvider.list();
      expect(domains.some((d) => d.domainName === domainName)).toBe(true);

      // Update — change the repository description in place (no replacement).
      yield* stack.deploy(makeStack("second", "shared-first"));
      const updated = yield* getRepository;
      expect(updated?.description).toBe("second");

      // Destroy — verify both resources are gone out-of-band.
      yield* stack.destroy();
      const afterRepo = yield* getRepository;
      expect(afterRepo).toBeUndefined();
      const afterDomain = yield* codeartifact
        .describeDomain({ domain: domainName })
        .pipe(
          Effect.map((res) => res.domain),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      expect(afterDomain).toBeUndefined();
    }),
  { timeout: 300_000 },
);
