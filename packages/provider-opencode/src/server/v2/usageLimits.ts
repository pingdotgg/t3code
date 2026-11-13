import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

const Instant = Schema.Finite.check(
  Schema.isBetween({ minimum: -8640000000000000, maximum: 8640000000000000 }),
);
const Meter = Schema.Struct({
  percent: Schema.Finite,
  limited: Schema.Boolean,
  resetsAt: Instant,
});
const BudgetModel = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  name: Schema.String,
  spent: Schema.optionalKey(Schema.Finite),
});
// Decode only fields needed by T3, independently of the pinned 2.0 client.
const ResponseBody = Schema.Struct({
  location: Schema.Struct({ directory: Schema.String }),
  data: Schema.NullOr(
    Schema.Struct({
      workspace: Schema.Struct({
        id: Schema.String,
        name: Schema.optionalKey(Schema.String),
        usageURL: Schema.String,
      }),
      go: Schema.optionalKey(Schema.Struct({ rolling: Meter, weekly: Meter, monthly: Meter })),
      budgets: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          limit: Schema.Finite,
          spent: Schema.Finite,
          scope: Schema.Literals(["each", "combined"]),
          per: Schema.Literals(["set", "model"]),
          coverage: Schema.Literals(["all", "models"]),
          models: Schema.Array(BudgetModel),
          shared: Schema.Boolean,
          resetsAt: Instant,
        }),
      ),
    }),
  ),
});

const Providers = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      integrationID: Schema.optionalKey(Schema.String),
    }),
  ),
});

const resetTime = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const budgetPercent = (spent: number, limit: number) =>
  limit <= 0 ? 100 : clampPercent((spent / limit) * 100);

/** Undefined alone permits the legacy credential reader; null data is authoritative. */
export const readServerUsageLimits = Effect.fn("OpenCode2Client.usageLimits")(function* (
  directory: string,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.gen(function* () {
    const response = yield* HttpClient.get("/api/experimental/usage/limits", {
      urlParams: { "location[directory]": directory },
    });
    if (
      response.status === 404 ||
      response.status === 405 ||
      (response.status === 200 &&
        response.headers["content-type"]?.split(";")[0]?.trim() === "text/html")
    )
      return undefined;
    const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ResponseBody)),
    );
    if (body.data === null)
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "No OpenCode Console workspace is signed in.",
      });
    const { go, budgets, workspace } = body.data;
    const consoleProviders = budgets.some(
      (budget) => budget.coverage === "all" && budget.per === "set",
    )
      ? yield* HttpClient.get("/api/provider", {
          urlParams: { "location[directory]": directory },
        }).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Providers)),
          Effect.map((page) =>
            page.data
              .filter(
                (provider) =>
                  provider.integrationID === "opencode" && provider.id !== "opencode-go",
              )
              .map((provider) => provider.id),
          ),
          Effect.orElseSucceed(() => []),
        )
      : [];
    const windows: ServerProviderUsageWindow[] = [];
    if (go) {
      for (const [key, kind, label, duration] of [
        ["rolling", "session", "Session", 300],
        ["weekly", "weekly", "Weekly", 10080],
        ["monthly", "monthly", "Monthly", undefined],
      ] as const) {
        const meter = go[key];
        windows.push({
          id: `go_${key}`,
          kind,
          label: `Go · ${label}`,
          usedPercent: meter.limited ? 100 : clampPercent(meter.percent),
          resetsAt: resetTime(meter.resetsAt),
          ...(duration === undefined ? {} : { windowDurationMins: duration }),
        });
      }
    }
    for (const budget of budgets) {
      const scope = budget.shared || budget.scope === "combined" ? "Shared" : "Individual";
      const covered =
        budget.coverage === "all"
          ? "All spend"
          : budget.models.map((model) => model.name).join(", ") || "Models";
      if (
        budget.per === "model" &&
        budget.coverage === "models" &&
        budget.models.length > 0 &&
        budget.models.every((model) => model.spent !== undefined)
      ) {
        for (const model of budget.models) {
          windows.push({
            id: `budget_${budget.id}_${model.providerID}_${model.modelID}`,
            kind: "other",
            label: `Console · ${scope} · ${model.name}`,
            modelIds: [`${model.providerID}/${model.modelID}`],
            usedPercent: budgetPercent(model.spent ?? budget.spent, budget.limit),
            resetsAt: resetTime(budget.resetsAt),
          });
        }
      } else {
        windows.push({
          id: `budget_${budget.id}`,
          kind: "other",
          label: `Console · ${scope} · ${covered}${budget.per === "model" ? " · Most used model" : ""}`,
          // Aggregate per-model spend cannot identify the exhausted model.
          ...(budget.per === "model"
            ? { modelIds: [] }
            : budget.coverage === "models"
              ? {
                  modelIds: budget.models.map((model) => `${model.providerID}/${model.modelID}`),
                }
              : { providerIds: consoleProviders }),
          usedPercent: budgetPercent(budget.spent, budget.limit),
          resetsAt: resetTime(budget.resetsAt),
        });
      }
    }
    const usageURL = URL.parse(workspace.usageURL);
    return {
      ...makeUsageLimits({ checkedAt, windows }),
      ...(usageURL?.protocol === "http:" || usageURL?.protocol === "https:"
        ? { externalUsage: { label: workspace.name?.trim() || workspace.id, url: usageURL.href } }
        : {}),
    };
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "OpenCode could not read workspace usage.",
      }),
    ),
  );
});
