import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { Effect } from "effect";
import { Traces } from "./Datasets.ts";

/**
 * `${stage} alchemy CLI overview` — a single dashboard answering the
 * four questions we actually care about, laid out on a 12-column grid:
 *
 *   1. **How many active users are working on a project?**
 *      Distinct `alchemy.user.id` per `alchemy.git.origin_hash`.
 *   2. **How many distinct projects are there?**
 *      Distinct `alchemy.git.origin_hash`.
 *   3. **How many projects use CI/CD?**
 *      Distinct `alchemy.git.origin_hash` where `alchemy.ci=true`.
 *   4. **What state stores are people using?**
 *      Sourced from `state_store.init` spans tagged with
 *      `alchemy.state_store.id` (the open-ended `StateService.id`
 *      slug; built-ins are `local` / `inmemory` / `http` /
 *      `cloudflare-http`, third-party stores get tracked automatically
 *      by setting their own slug). Emitted once per process via
 *      `recordStateStoreInit` at every `Layer.effect(State, …)` site.
 *
 * Project identity uses `alchemy.git.origin_hash` rather than
 * `alchemy.user.id`: ephemeral CI runners regenerate `~/.alchemy/id`
 * every job, which dramatically inflates the user count. The git
 * origin hash is stable across runs of the same repo and is the
 * closest proxy we have for "a project".
 *
 * All queries target `${stage}-traces` — Axiom's metrics datasets
 * cannot be queried via APL, but every metric we emit has an
 * equivalent span (`cli.<command>`, `provider.<op>`,
 * `state_store.deploy`, `state_store.init`).
 *
 * Each chart's APL query is built with `Output.interpolate` against
 * `traces.name` so Alchemy sequences the dashboard after the dataset
 * exists. Otherwise Axiom would reject creation with
 * `BadRequest: failed to validate ... entity not found`.
 */
export const CliOverviewDashboard = Axiom.Dashboard(
  "CliOverview",
  Effect.gen(function* () {
    const stack = yield* Alchemy.Stack;
    const traces = yield* Traces;
    const t = traces.name;
    const isProd = stack.stage === "prod";

    const prodTracesName: Input<string> = isProd
      ? t
      : (yield* Axiom.Dataset.ref("Traces", { stage: "prod" })).name;
    // Global filter bar — a `SmartFilter` chart drives every other
    // chart's APL via `declare query_parameters` parameters:
    //
    // - `alchemy_version` (every stage) narrows every chart to a
    //   single alchemy version. An explicit "All" row with an empty
    //   value short-circuits the filter via
    //   `isempty(alchemy_version)`. APL-sourced filters don't get
    //   the auto-"All" that `list` filters do, so the source query
    //   unions one in.
    //
    // - `dataset_filter` (non-prod stages only) lets us preview
    //   dashboard changes against `prod-traces` while defaulting to
    //   the current stage's own dataset. Charts reference the
    //   dataset via `table(dataset_filter)` instead of a literal
    //   `['<name>']` so the parameter binding takes effect. On prod
    //   we skip the filter entirely and hardcode `['prod-traces']`.
    //
    // Fresh stages have no spans yet, so `service.version` may not
    // exist as a column. `column_ifexists` lets the queries parse
    // against an empty dataset (otherwise APL rejects them with
    // `invalid field: "service.version"`).
    // `bin_size` drives every TimeSeries chart's bucket width so a
    // single filter flips the whole dashboard between hourly / daily /
    // weekly aggregation. Queries reference it as
    // `bin(_time, totimespan(bin_size))`.
    const declarations: Input<string> = isProd
      ? `declare query_parameters (alchemy_version:string = "", bin_size:string = "1h");`
      : Output.interpolate`declare query_parameters (dataset_filter:string = "${t}", alchemy_version:string = "", bin_size:string = "1h");`;
    const datasetExpr: Input<string> = isProd
      ? Output.interpolate`['${t}']`
      : "table(dataset_filter)";
    const versionFilterWhere = `\n              | where isempty(alchemy_version) or tostring(column_ifexists("service.version", "")) == alchemy_version`;
    const charts: Input<Axiom.Chart>[] = [
      {
        id: "filter-bar",
        type: "SmartFilter",
        name: "Filters",
        filters: [
          ...(isProd
            ? []
            : [
                {
                  id: "dataset_filter",
                  type: "select" as const,
                  name: "dataset",
                  active: true,
                  selectType: "list" as const,
                  options: [
                    {
                      id: "stage",
                      key: `${stack.stage} (this stage)`,
                      value: t,
                      default: true,
                    },
                    {
                      id: "prod",
                      key: "prod (production data)",
                      value: prodTracesName,
                    },
                  ],
                },
              ]),
          {
            id: "bin_size",
            type: "select",
            name: "aggregation period",
            active: true,
            selectType: "list",
            options: [
              { id: "1h", key: "1 hour", value: "1h", default: true },
              { id: "6h", key: "6 hours", value: "6h" },
              { id: "1d", key: "1 day", value: "1d" },
              { id: "7d", key: "7 days", value: "7d" },
            ],
          },
          {
            id: "alchemy_version",
            type: "select",
            name: "alchemy version",
            active: true,
            selectType: "apl",
            options: [],
            apl: {
              apl: Output.interpolate`
                  ${declarations}
                  let opts = ${datasetExpr}
                    | extend sv = tostring(column_ifexists("service.version", ""))
                    | where sv != ""
                    | distinct sv
                    | sort by sv desc
                    | project key=sv, value=sv;
                  let all = print key="All", value="";
                  union all, opts
                `,
            },
          },
        ],
      },
      // Row 1 — top-line counts answering Qs 1, 2, 3.
      {
        id: "distinct-projects",
        name: "Distinct projects (7d)",
        type: "Statistic",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | extend project=tostring(['resource.custom']['alchemy.git.origin_hash'])
              | where project != ""
              | summarize projects=dcount(project)
            `,
        },
      },
      {
        id: "projects-using-ci",
        name: "Projects using CI/CD (7d)",
        type: "Statistic",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | extend project=tostring(['resource.custom']['alchemy.git.origin_hash']),
                       ci=tostring(['resource.custom']['alchemy.ci'])
              | where project != "" and ci == "true"
              | summarize projects=dcount(project)
            `,
        },
      },
      {
        id: "active-users-7d",
        name: "Active users — non-CI (7d)",
        type: "Statistic",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | extend uid=tostring(['resource.custom']['alchemy.user.id']),
                       ci=tostring(['resource.custom']['alchemy.ci'])
              | where ci != "true"
              | summarize users=dcount(uid)
            `,
        },
      },

      // Row 2 — Q1 broken out per-project, plus solo-vs-team split.
      {
        id: "users-per-project",
        name: "Active users per project (7d)",
        type: "Table",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | extend project=tostring(['resource.custom']['alchemy.git.origin_hash']),
                       uid=tostring(['resource.custom']['alchemy.user.id']),
                       ci=tostring(['resource.custom']['alchemy.ci'])
              | where project != ""
              | summarize users_total=dcount(uid),
                          users_local=dcountif(uid, ci != "true"),
                          users_ci=dcountif(uid, ci == "true"),
                          events=count()
                  by project
              | order by users_total desc
              | take 100
            `,
        },
      },
      {
        id: "project-team-size-distribution",
        name: "Project team-size distribution (local users / project)",
        type: "Table",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | extend project=tostring(['resource.custom']['alchemy.git.origin_hash']),
                       uid=tostring(['resource.custom']['alchemy.user.id']),
                       ci=tostring(['resource.custom']['alchemy.ci'])
              | where project != "" and ci != "true"
              | summarize users=dcount(uid) by project
              | extend bucket = case(
                  users == 1, "1 (solo)",
                  users <= 3, "2-3",
                  users <= 10, "4-10",
                  "11+")
              | summarize projects=count() by bucket
              | order by bucket asc
            `,
        },
      },

      // Row 3 — Q4: state-store breakdown.
      {
        id: "state-store-projects-by-id",
        name: "Projects by state store (7d)",
        type: "Table",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | where name == "state_store.init"
              | extend store=tostring(['attributes.custom']['alchemy.state_store.id']),
                       project=tostring(['resource.custom']['alchemy.git.origin_hash']),
                       uid=tostring(['resource.custom']['alchemy.user.id'])
              | summarize projects=dcountif(project, project != ""),
                          users=dcount(uid),
                          inits=count()
                  by store
              | order by projects desc
            `,
        },
      },
      {
        id: "state-store-by-id-over-time",
        name: "State store init by store / hour",
        type: "TimeSeries",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | where name == "state_store.init"
              | extend store=tostring(['attributes.custom']['alchemy.state_store.id'])
              | summarize count=count() by store, bin(_time, totimespan(bin_size))
              | order by _time asc
            `,
        },
      },

      // Row 4 — adoption shape: project growth + CI-vs-local split.
      {
        id: "projects-over-time",
        name: "Distinct projects per day",
        type: "TimeSeries",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | extend project=tostring(['resource.custom']['alchemy.git.origin_hash'])
              | where project != ""
              | summarize projects=dcount(project) by bin(_time, totimespan(bin_size))
              | order by _time asc
            `,
        },
      },
      {
        id: "active-users-over-time-hourly",
        name: "Active users (non-CI)",
        type: "TimeSeries",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | extend uid=tostring(['resource.custom']['alchemy.user.id']),
                       ci=tostring(['resource.custom']['alchemy.ci'])
              | where ci != "true" and uid != ""
              | summarize users=dcount(uid) by bin(_time, totimespan(bin_size))
              | order by _time asc
            `,
        },
      },
      {
        id: "active-users-over-time-daily",
        name: "Active users (CI vs local)",
        type: "TimeSeries",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | extend uid=tostring(['resource.custom']['alchemy.user.id']),
                       ci=tostring(['resource.custom']['alchemy.ci'])
              | where uid != ""
              | extend bucket=iff(ci == "true", "ci", "local")
              | summarize users=dcount(uid) by bucket, bin(_time, totimespan(bin_size))
              | order by _time asc
            `,
        },
      },
      {
        id: "ci-vs-local-projects",
        name: "Projects: CI vs local per day",
        type: "TimeSeries",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | extend project=tostring(['resource.custom']['alchemy.git.origin_hash']),
                       ci=tostring(['resource.custom']['alchemy.ci'])
              | where project != ""
              | extend bucket=iff(ci == "true", "ci", "local")
              | summarize projects=dcount(project) by bucket, bin(_time, totimespan(bin_size))
              | order by _time asc
            `,
        },
      },

      // Row 5 — keep the state-store deploy health signals for the
      // Cloudflare-hosted store (not just init, but actual deploys).
      {
        id: "state-store-deploys",
        name: "Cloudflare state store deploys (success vs error)",
        type: "TimeSeries",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | where name == "state_store.deploy"
              | extend status=iff(tobool(['error']), "error", "success")
              | summarize count=count() by status, bin(_time, totimespan(bin_size))
              | order by _time asc
            `,
        },
      },
      {
        id: "active-users-by-version",
        name: "Active users by alchemy version (7d)",
        type: "Table",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | extend uid=tostring(['resource.custom']['alchemy.user.id']),
                       version=tostring(['resource.custom']['alchemy.version']),
                       ci=tostring(['resource.custom']['alchemy.ci'])
              | summarize users_total=dcount(uid),
                          users_local=dcountif(uid, ci != "true"),
                          users_ci=dcountif(uid, ci == "true")
                  by version
              | order by users_total desc
            `,
        },
      },

      // ─── Cloudflare State Store ────────────────────────────────
      //
      // Two span sources feed this section:
      //
      //   - **CLI spans** (`state_store.init`, `state_store.bootstrap`,
      //     `state_store.deploy`, ...) — emitted from the user's
      //     terminal/CI. Carry `alchemy.cloudflare.account_hash` (a
      //     SHA-256 of the CF accountId) so we can count distinct
      //     deployments without leaking raw account IDs.
      //
      //   - **Worker handler spans** (`state_store.{getVersion,
      //     listStacks,listStages,listResources,getState,setState,
      //     deleteState,getReplacedResources,deleteStack}`) — emitted
      //     from inside the deployed `alchemy-state-store` worker.
      //     Distinguished by the `alchemy.state_store.script_name`
      //     **resource** attribute (set on the worker's OTLP tracer
      //     resource); CLI spans do not carry that resource attr.
      //
      // Worker handler spans carry `alchemy.state_store.{op,stack,
      // stage,fqn}` as span attributes plus a `duration` field —
      // that's what powers the latency / op-rate / stack-count
      // charts. Account-hash sits on CLI spans only (worker-side
      // injection would need a separate deploy-time env-var pass).
      {
        id: "state-store-distinct-cloudflare-stores",
        name: "Distinct Cloudflare state-store deployments (7d)",
        type: "Statistic",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | where name == "state_store.init"
              | extend hash=tostring(['attributes.custom']['alchemy.cloudflare.account_hash'])
              | where hash != ""
              | summarize stores=dcount(hash)
            `,
        },
      },
      {
        id: "state-store-distinct-stacks",
        name: "Distinct stacks tracked (7d)",
        type: "Statistic",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | where ['resource.custom']['alchemy.state_store.script_name'] != ""
              | extend stack=tostring(['attributes.custom']['alchemy.state_store.stack'])
              | where stack != ""
              | summarize stacks=dcount(stack)
            `,
        },
      },
      {
        id: "state-store-total-ops",
        name: "Cloudflare state store ops (7d)",
        type: "Statistic",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | where ['resource.custom']['alchemy.state_store.script_name'] != ""
              | extend op=tostring(['attributes.custom']['alchemy.state_store.op'])
              | where op != ""
              | summarize ops=count()
            `,
        },
      },
      {
        id: "state-store-op-latency",
        name: "State store op latency (p50 / p95 / p99, 7d)",
        type: "Table",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | where ['resource.custom']['alchemy.state_store.script_name'] != ""
              | extend op=tostring(['attributes.custom']['alchemy.state_store.op'])
              | where op != ""
              | summarize p50=percentile(duration, 50),
                          p95=percentile(duration, 95),
                          p99=percentile(duration, 99),
                          calls=count()
                  by op
              | order by calls desc
            `,
        },
      },
      {
        id: "state-store-ops-over-time",
        name: "State store ops over time (by op)",
        type: "TimeSeries",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | where ['resource.custom']['alchemy.state_store.script_name'] != ""
              | extend op=tostring(['attributes.custom']['alchemy.state_store.op'])
              | where op != ""
              | summarize count=count() by op, bin(_time, totimespan(bin_size))
              | order by _time asc
            `,
        },
      },
      {
        id: "state-store-error-rate",
        name: "State store error rate by op (7d)",
        type: "Table",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | where ['resource.custom']['alchemy.state_store.script_name'] != ""
              | extend op=tostring(['attributes.custom']['alchemy.state_store.op']),
                       err=tobool(['error'])
              | where op != ""
              | summarize errors=countif(err == true),
                          total=count()
                  by op
              | extend error_rate=todouble(errors) / todouble(total)
              | order by total desc
            `,
        },
      },
      {
        id: "state-store-top-stacks",
        name: "Top stacks by activity (7d)",
        type: "Table",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | where ['resource.custom']['alchemy.state_store.script_name'] != ""
              | extend stack=tostring(['attributes.custom']['alchemy.state_store.stack'])
              | where stack != ""
              | summarize ops=count() by stack
              | order by ops desc
              | take 25
            `,
        },
      },
      {
        id: "state-store-deployments-over-time",
        name: "Distinct Cloudflare state-store deployments per day",
        type: "TimeSeries",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | where name == "state_store.init"
              | extend hash=tostring(['attributes.custom']['alchemy.cloudflare.account_hash'])
              | where hash != ""
              | summarize stores=dcount(hash) by bin(_time, totimespan(bin_size))
              | order by _time asc
            `,
        },
      },

      // ─── Resource usage & reliability ──────────────────────────
      //
      // Every provider lifecycle invocation is wrapped in a
      // `provider.<op>` span (see `instrumentLifecycle` in Apply.ts)
      // carrying `alchemy.resource.type` and `alchemy.resource.op`
      // (precreate/create/update/delete/read). `error` is set when
      // the lifecycle effect fails.
      {
        id: "resource-usage-ranked",
        name: "Resource usage — ranked by lifecycle ops (7d)",
        type: "Table",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | where name startswith "provider."
              | extend resource_type=tostring(['attributes.custom']['alchemy.resource.type']),
                       project=tostring(['resource.custom']['alchemy.git.origin_hash'])
              | where resource_type != ""
              | summarize ops=count(),
                          projects=dcountif(project, project != ""),
                          errors=countif(tobool(['error']) == true)
                  by resource_type
              | order by ops desc
              | take 200
            `,
        },
      },
      {
        id: "resource-error-rate-by-type",
        name: "Resource error rate by resource type (7d)",
        type: "Table",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | where name startswith "provider."
              | extend resource_type=tostring(['attributes.custom']['alchemy.resource.type']),
                       err=tobool(['error'])
              | where resource_type != ""
              | summarize errors=countif(err == true),
                          total=count()
                  by resource_type
              | extend error_rate=todouble(errors) / todouble(total)
              | order by error_rate desc, total desc
              | take 200
            `,
        },
      },
      {
        id: "resource-error-rate-by-op",
        name: "Resource error rate by lifecycle method (7d)",
        type: "Table",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | where name startswith "provider."
              | extend op=tostring(['attributes.custom']['alchemy.resource.op']),
                       err=tobool(['error'])
              | where op != ""
              | summarize errors=countif(err == true),
                          total=count()
                  by op
              | extend error_rate=todouble(errors) / todouble(total)
              | order by total desc
            `,
        },
      },
    ];

    const layout: Axiom.LayoutCell[] = [
      // Row 0 — filter bar (full width, narrow)
      { i: "filter-bar", x: 0, y: 0, w: 12, h: 2 },
      // Row 1
      { i: "distinct-projects", x: 0, y: 2, w: 4, h: 4 },
      { i: "projects-using-ci", x: 4, y: 2, w: 4, h: 4 },
      { i: "active-users-7d", x: 8, y: 2, w: 4, h: 4 },
      // Row 2 — active users over time
      { i: "active-users-over-time-hourly", x: 0, y: 6, w: 6, h: 6 },
      { i: "active-users-over-time-daily", x: 6, y: 6, w: 6, h: 6 },
      // Row 3
      { i: "users-per-project", x: 0, y: 12, w: 8, h: 8 },
      { i: "project-team-size-distribution", x: 8, y: 12, w: 4, h: 8 },
      // Row 4
      { i: "state-store-projects-by-id", x: 0, y: 20, w: 6, h: 6 },
      { i: "state-store-by-id-over-time", x: 6, y: 20, w: 6, h: 6 },
      // Row 5
      { i: "projects-over-time", x: 0, y: 26, w: 6, h: 6 },
      { i: "ci-vs-local-projects", x: 6, y: 26, w: 6, h: 6 },
      // Row 6
      { i: "state-store-deploys", x: 0, y: 32, w: 6, h: 6 },
      { i: "active-users-by-version", x: 6, y: 32, w: 6, h: 6 },
      // Row 7 — Cloudflare State Store: top-line stats
      {
        i: "state-store-distinct-cloudflare-stores",
        x: 0,
        y: 38,
        w: 4,
        h: 4,
      },
      { i: "state-store-distinct-stacks", x: 4, y: 38, w: 4, h: 4 },
      { i: "state-store-total-ops", x: 8, y: 38, w: 4, h: 4 },
      // Row 8 — performance: latency table (full width)
      { i: "state-store-op-latency", x: 0, y: 42, w: 12, h: 8 },
      // Row 9 — ops over time + error rate
      { i: "state-store-ops-over-time", x: 0, y: 50, w: 8, h: 6 },
      { i: "state-store-error-rate", x: 8, y: 50, w: 4, h: 6 },
      // Row 10 — distribution + adoption shape
      { i: "state-store-top-stacks", x: 0, y: 56, w: 6, h: 8 },
      { i: "state-store-deployments-over-time", x: 6, y: 56, w: 6, h: 8 },
      // Row 11 — Resource usage ranking (full width)
      { i: "resource-usage-ranked", x: 0, y: 64, w: 12, h: 10 },
      // Row 12 — Error rate broken down by resource type and lifecycle method
      { i: "resource-error-rate-by-type", x: 0, y: 74, w: 8, h: 10 },
      { i: "resource-error-rate-by-op", x: 8, y: 74, w: 4, h: 10 },
    ];

    return {
      dashboard: {
        name: `${stack.stage} alchemy CLI overview`,
        // Empty owner = X-AXIOM-EVERYONE (org-shared). API tokens
        // can't create per-user "private" dashboards.
        owner: "",
        description:
          "Adoption telemetry: distinct projects, active users per project, " +
          "CI vs local usage, and state-store backend breakdown. Plus " +
          "Cloudflare State Store ops: distinct deployments, stack count, " +
          "per-op latency / error rate. " +
          "Resource usage: ranked list of resource types by lifecycle ops, " +
          "with error rates broken down by resource type and by lifecycle method. " +
          "Project identity = alchemy.git.origin_hash (stable across CI runs); " +
          "user identity = alchemy.user.id (ephemeral in CI); " +
          "Cloudflare deployment identity = alchemy.cloudflare.account_hash " +
          "(SHA-256 of accountId, set on CLI state_store.* spans).",
        refreshTime: 60 as const,
        schemaVersion: 2 as const,
        // Axiom requires the `qr-now-{duration}` form for relative times.
        timeWindowStart: "qr-now-7d",
        timeWindowEnd: "qr-now",
        charts,
        layout,
      },
    };
  }),
);
