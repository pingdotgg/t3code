import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { createRuleFixture } from "../lint-fixture.mjs";

const lint = createRuleFixture("project/no-unbounded-promise-fan-out");

const reported = [
  [
    "the Slack example: one query per URL",
    `async function load(input, service, results) {
      await Promise.all(
        input.urls.map(async (url) => {
          try {
            results[url] = await service.getPrimarySubCategoryForUrl(input.scoringRunId, url);
          } catch {
            results[url] = "Miscellaneous";
          }
        }),
      );
    }`,
  ],
  [
    "an expression-bodied mapper",
    "const rows = await Promise.all(ids.map((id) => prisma.brand.findUnique({ where: { id } })));",
  ],
  ["Promise.allSettled", "await Promise.allSettled(urls.map((url) => this.repository.load(url)));"],
  ["a flatMap", "await Promise.all(groups.flatMap((group) => group.ids.map((id) => load(id))));"],
  ["Array.from with a mapper", "await Promise.all(Array.from(ids, (id) => load(id)));"],
  [
    "mapped promises held in a const",
    "const pending = urls.map((url) => load(url));\nawait Promise.all(pending);",
  ],
  [
    "a parenthesised, asserted argument",
    "await Promise.all((urls.map((url) => load(url)) as Promise<Row>[]));",
  ],
  [
    "a member receiver of request data",
    "await Promise.all(input.profiles.map((profile) => this.load(profile.id)));",
  ],
  [
    "a spread of data into an array literal",
    "await Promise.all([...new Set(ids)].map((id) => load(id)));",
  ],
  [
    "a ternary with one unbounded branch",
    "await Promise.all((all ? ids : ids.slice(0, 3)).map((id) => load(id)));",
  ],
  [
    "a mapper that only names a limiter in its body",
    "await Promise.all(ids.map(async (id) => { await load(id); return limit; }));",
  ],
];

for (const [name, source] of reported) {
  NodeTest.test(`Given ${name}, When the rule lints it, Then it reports one finding`, () =>
    NodeAssert.equal(lint(source).length, 1),
  );
}

const allowed = [
  [
    "a set-based query",
    "const rows = await prisma.brand.findMany({ where: { id: { in: ids } } });",
  ],
  ["a fixed array literal", "const [a, b] = await Promise.all([loadA(), loadB()]);"],
  ["a mapped array literal", 'await Promise.all(["gb", "us"].map((market) => load(market)));'],
  [
    "a constant list",
    "await Promise.all(SOCIAL_PROVIDER_IDS.map((providerId) => resolve(providerId)));",
  ],
  [
    "a constant member list",
    "await Promise.all(Providers.ALL.map((provider) => resolve(provider)));",
  ],
  [
    "an injected collaborator list",
    "await Promise.all(this.assessors.map((assessor) => assessor.assess(brandId)));",
  ],
  [
    "a p-limit wrapper",
    "const limit = pLimit(5);\nawait Promise.all(ids.map((id) => limit(() => load(id))));",
  ],
  [
    "a limiter wrapper in a block body",
    "await Promise.all(ids.map((id) => { return this.limiter(() => load(id)); }));",
  ],
  [
    "a method on a limiter",
    "await Promise.all(bots.map((bot) => globalLimiter.run(() => probe(bot))));",
  ],
  [
    "a scheduler on this",
    "await Promise.all(groups.map((group) => this.scheduler.run(() => summarize(group))));",
  ],
  [
    "a ternary of slices",
    "await Promise.all((all ? ids.slice(0, 3) : ids.slice(1, 4)).map((id) => load(id)));",
  ],
  [
    "a worker pool",
    "const runners = Array.from({ length: Math.min(CONCURRENCY, pages.length) }, async () => {\n  while (queue.length > 0) await load(queue.pop());\n});\nawait Promise.all(runners);",
  ],
  [
    "a for-of batch",
    "for (const batch of batches) {\n  await Promise.all(batch.map((id) => load(id)));\n}",
  ],
  [
    "a sliced batch",
    "for (let i = 0; i < ids.length; i += 10) {\n  const batch = ids.slice(i, i + 10);\n  await Promise.all(batch.map((id) => load(id)));\n}",
  ],
  ["a single promise variable", "const pending = load();\nawait Promise.all([pending]);"],
  [
    "a reassigned promise list",
    "let pending = ids.map((id) => load(id));\npending = [];\nawait Promise.all(pending);",
  ],
];

for (const [name, source] of allowed) {
  NodeTest.test(`Given ${name}, When the rule lints it, Then it reports nothing`, () =>
    NodeAssert.equal(lint(source).length, 0),
  );
}
