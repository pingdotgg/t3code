import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Output from "alchemy/Output";
import { Effect } from "effect";
import { Traces } from "./Datasets.ts";

/**
 * Saved Axiom views (APL queries) for the alchemy CLI's OTEL signals.
 *
 * All views target `${stage}-traces`. Axiom's metrics datasets cannot be
 * queried via APL ("Please use the builder to query metrics datasets"),
 * but every metric we emit has an equivalent span — `cli.<command>` for
 * invocations, `provider.<op>` for resource lifecycle ops with
 * `duration` for latency and `error` for status — so we derive
 * everything from traces.
 *
 * Each view's `datasets` entry references `traces.name` (an Output) rather
 * than a literal `${stage}-traces` string so Alchemy sequences view creation
 * after the dataset exists. Without this, Axiom rejects the view with
 * `BadRequest: failed to validate view: entity not found`.
 *
 * Attribute paths:
 * - Resource attributes (per-process, set on `OtlpTracer.resource`):
 *   `['resource.custom']['alchemy.user.id']`,
 *   `['resource.custom']['alchemy.version']`, …
 * - Span attributes (per-span, set on `Effect.withSpan(... { attributes })`):
 *   `['attributes.custom']['alchemy.resource.type']`,
 *   `['attributes.custom']['alchemy.resource.op']`, …
 *
 * `error` (bool) and `status.code` are first-class span fields.
 */

const viewProps = <A>(
  fn: (ctx: { stage: string; traces: Output.Output<string> }) => A,
) =>
  Effect.all([Alchemy.Stack, Traces]).pipe(
    Effect.map(([stack, traces]) =>
      fn({ stage: stack.stage, traces: traces.name }),
    ),
  );

export const ActiveUsersHourly = Axiom.View(
  "ActiveUsersHourly",
  viewProps(({ stage, traces }) => ({
    name: `${stage}-active-users-hourly`,
    description: "Distinct alchemy.user.id per hour, last 7d",
    datasets: [traces],
    aplQuery: `
      ['${stage}-traces']
      | where _time > ago(7d)
      | extend uid=tostring(['resource.custom']['alchemy.user.id'])
      | summarize users=dcount(uid) by bin(_time, 1h)
      | order by _time asc
    `,
  })),
);

export const ActiveUsersByVersion = Axiom.View(
  "ActiveUsersByVersion",
  viewProps(({ stage, traces }) => ({
    name: `${stage}-active-users-by-version`,
    description: "Distinct users grouped by alchemy.version (last 7d)",
    datasets: [traces],
    aplQuery: `
      ['${stage}-traces']
      | where _time > ago(7d)
      | extend uid=tostring(['resource.custom']['alchemy.user.id']),
               version=tostring(['resource.custom']['alchemy.version'])
      | summarize users=dcount(uid) by version
      | order by users desc
    `,
  })),
);

export const ActiveUsersByCi = Axiom.View(
  "ActiveUsersByCi",
  viewProps(({ stage, traces }) => ({
    name: `${stage}-active-users-by-ci`,
    description: "CI vs local users (last 7d)",
    datasets: [traces],
    aplQuery: `
      ['${stage}-traces']
      | where _time > ago(7d)
      | extend uid=tostring(['resource.custom']['alchemy.user.id']),
               ci=tostring(['resource.custom']['alchemy.ci'])
      | summarize users=dcount(uid) by ci
    `,
  })),
);

export const ResourcesUsed = Axiom.View(
  "ResourcesUsed",
  viewProps(({ stage, traces }) => ({
    name: `${stage}-resources-used`,
    description: "Top resource types by lifecycle op count (last 7d)",
    datasets: [traces],
    aplQuery: `
      ['${stage}-traces']
      | where _time > ago(7d)
      | where name startswith "provider."
      | extend rt=tostring(['attributes.custom']['alchemy.resource.type']),
               op=tostring(['attributes.custom']['alchemy.resource.op'])
      | summarize ops=count() by rt, op
      | order by ops desc
    `,
  })),
);

export const DeployDestroyLatency = Axiom.View(
  "DeployDestroyLatency",
  viewProps(({ stage, traces }) => ({
    name: `${stage}-deploy-destroy-latency`,
    description: "p50/p95/p99 of cli.deploy and cli.destroy spans",
    datasets: [traces],
    aplQuery: `
      ['${stage}-traces']
      | where _time > ago(7d)
      | where name in ("cli.deploy", "cli.destroy")
      | summarize p50=percentile(duration, 50),
                  p95=percentile(duration, 95),
                  p99=percentile(duration, 99)
          by name, bin(_time, 1h)
      | order by _time asc
    `,
  })),
);

export const ResourceLatency = Axiom.View(
  "ResourceLatency",
  viewProps(({ stage, traces }) => ({
    name: `${stage}-resource-latency`,
    description:
      "p50/p95 of provider.<op> spans by resource_type and op (last 7d)",
    datasets: [traces],
    aplQuery: `
      ['${stage}-traces']
      | where _time > ago(7d)
      | where name startswith "provider."
      | extend rt=tostring(['attributes.custom']['alchemy.resource.type']),
               op=tostring(['attributes.custom']['alchemy.resource.op'])
      | summarize p50=percentile(duration, 50),
                  p95=percentile(duration, 95),
                  count=count()
          by rt, op
      | order by p95 desc
    `,
  })),
);

export const CliInvocations = Axiom.View(
  "CliInvocations",
  viewProps(({ stage, traces }) => ({
    name: `${stage}-cli-invocations`,
    description:
      "cli.<command> span counts grouped by command and success/error",
    datasets: [traces],
    aplQuery: `
      ['${stage}-traces']
      | where _time > ago(7d)
      | where name startswith "cli."
      | extend command=extract("cli\\\\.(.+)", 1, name),
               status=iff(tobool(['error']), "error", "success")
      | summarize count=count() by command, status, bin(_time, 1h)
      | order by _time asc
    `,
  })),
);

export const ResourceErrorRate = Axiom.View(
  "ResourceErrorRate",
  viewProps(({ stage, traces }) => ({
    name: `${stage}-resource-error-rate`,
    description:
      "provider.<op> spans split by status (success vs error) per hour",
    datasets: [traces],
    aplQuery: `
      ['${stage}-traces']
      | where _time > ago(7d)
      | where name startswith "provider."
      | extend rt=tostring(['attributes.custom']['alchemy.resource.type']),
               status=iff(tobool(['error']), "error", "success")
      | summarize total=count() by rt, status, bin(_time, 1h)
      | order by _time asc
    `,
  })),
);
