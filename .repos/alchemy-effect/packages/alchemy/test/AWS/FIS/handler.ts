import * as FIS from "@/AWS/FIS";
import { Role } from "@/AWS/IAM/Role.ts";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class FisTestFunction extends Lambda.Function<Lambda.Function>()(
  "FisTestFunction",
) {}

export default FisTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The experiment template the template-scoped bindings are bound to. A
    // single target-less aws:fis:wait action, so starting an experiment
    // disrupts nothing — it just idles until it completes or is stopped.
    const role = yield* Role("FisBindingsRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "fis.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
    });
    const template = yield* FIS.ExperimentTemplate("BindingsWaitTemplate", {
      description: "alchemy fis bindings fixture template",
      roleArn: role.roleArn,
      actions: {
        Wait: {
          actionId: "aws:fis:wait",
          parameters: { duration: "PT3M" },
        },
      },
    });

    // Event source: subscribe the host to experiment state changes. The
    // deploy proves the EventBridge rule + invoke permission wiring.
    yield* FIS.consumeExperimentEvents({}, (events) =>
      Stream.runForEach(events, (event) =>
        Effect.log(
          `fis experiment ${event.detail["experiment-id"]} -> ` +
            `${event.detail["new-state"]?.status}`,
        ),
      ),
    );

    const startExperiment = yield* FIS.StartExperiment(template);
    const getExperimentTemplate = yield* FIS.GetExperimentTemplate(template);
    const getExperiment = yield* FIS.GetExperiment();
    const stopExperiment = yield* FIS.StopExperiment();
    const listExperiments = yield* FIS.ListExperiments();
    const listExperimentResolvedTargets =
      yield* FIS.ListExperimentResolvedTargets();
    const listExperimentTemplates = yield* FIS.ListExperimentTemplates();
    const getAction = yield* FIS.GetAction();
    const listActions = yield* FIS.ListActions();
    const getTargetResourceType = yield* FIS.GetTargetResourceType();
    const listTargetResourceTypes = yield* FIS.ListTargetResourceTypes();
    const getSafetyLever = yield* FIS.GetSafetyLever();
    const updateSafetyLeverState = yield* FIS.UpdateSafetyLeverState();
    const getExperimentTargetAccountConfiguration =
      yield* FIS.GetExperimentTargetAccountConfiguration();
    const listExperimentTargetAccountConfigurations =
      yield* FIS.ListExperimentTargetAccountConfigurations();

    const bound = {
      startExperiment,
      getExperimentTemplate,
      getExperiment,
      stopExperiment,
      listExperiments,
      listExperimentResolvedTargets,
      listExperimentTemplates,
      getAction,
      listActions,
      getTargetResourceType,
      listTargetResourceTypes,
      getSafetyLever,
      // Engaging the lever halts every experiment in the account, so the
      // suite only proves registration/IAM wiring and never calls it.
      updateSafetyLeverState,
      // Multi-account reads; registration-only on a single-account fixture.
      getExperimentTargetAccountConfiguration,
      listExperimentTargetAccountConfigurations,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const id = url.searchParams.get("id") ?? "";

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        // Template-scoped read: the template id is injected by the binding.
        if (request.method === "GET" && pathname === "/template") {
          const { experimentTemplate } = yield* getExperimentTemplate();
          return yield* HttpServerResponse.json({
            id: experimentTemplate?.id,
            actions: Object.keys(experimentTemplate?.actions ?? {}),
          });
        }

        if (request.method === "GET" && pathname === "/templates") {
          const { experimentTemplates } = yield* listExperimentTemplates();
          return yield* HttpServerResponse.json({
            ids: (experimentTemplates ?? []).map((t) => t.id),
          });
        }

        // Start a (harmless, wait-only) experiment from the bound template.
        if (request.method === "POST" && pathname === "/experiments") {
          const { experiment } = yield* startExperiment({
            tags: { "alchemy-test": "fis-bindings" },
          });
          return yield* HttpServerResponse.json({
            id: experiment?.id,
            status: experiment?.state?.status,
          });
        }

        if (request.method === "GET" && pathname === "/experiment") {
          const { experiment } = yield* getExperiment({ id });
          return yield* HttpServerResponse.json({
            id: experiment?.id,
            templateId: experiment?.experimentTemplateId,
            status: experiment?.state?.status,
          });
        }

        if (request.method === "GET" && pathname === "/experiments") {
          const templateId = url.searchParams.get("templateId") ?? undefined;
          const { experiments } = yield* listExperiments({
            experimentTemplateId: templateId,
          });
          return yield* HttpServerResponse.json({
            ids: (experiments ?? []).map((e) => e.id),
          });
        }

        if (request.method === "POST" && pathname === "/stop") {
          const { experiment } = yield* stopExperiment({ id });
          return yield* HttpServerResponse.json({
            status: experiment?.state?.status,
          });
        }

        if (request.method === "GET" && pathname === "/resolved-targets") {
          const { resolvedTargets } = yield* listExperimentResolvedTargets({
            experimentId: id,
          });
          return yield* HttpServerResponse.json({
            count: (resolvedTargets ?? []).length,
          });
        }

        // Catalog reads.
        if (request.method === "GET" && pathname === "/action") {
          const { action } = yield* getAction({ id });
          return yield* HttpServerResponse.json({ id: action?.id });
        }

        if (request.method === "GET" && pathname === "/actions") {
          const { actions } = yield* listActions();
          return yield* HttpServerResponse.json({
            ids: (actions ?? []).map((a) => a.id),
          });
        }

        if (request.method === "GET" && pathname === "/target-resource-type") {
          const { targetResourceType } = yield* getTargetResourceType({
            resourceType: url.searchParams.get("type") ?? "",
          });
          return yield* HttpServerResponse.json({
            resourceType: targetResourceType?.resourceType,
          });
        }

        if (request.method === "GET" && pathname === "/target-resource-types") {
          const { targetResourceTypes } = yield* listTargetResourceTypes();
          return yield* HttpServerResponse.json({
            resourceTypes: (targetResourceTypes ?? []).map(
              (t) => t.resourceType,
            ),
          });
        }

        // The account's safety lever has the well-known id `default`.
        if (request.method === "GET" && pathname === "/safety-lever") {
          const { safetyLever } = yield* getSafetyLever({ id: "default" });
          return yield* HttpServerResponse.json({
            id: safetyLever?.id,
            status: safetyLever?.state?.status,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        FIS.StartExperimentHttp,
        FIS.GetExperimentTemplateHttp,
        FIS.GetExperimentHttp,
        FIS.StopExperimentHttp,
        FIS.ListExperimentsHttp,
        FIS.ListExperimentResolvedTargetsHttp,
        FIS.ListExperimentTemplatesHttp,
        FIS.GetActionHttp,
        FIS.ListActionsHttp,
        FIS.GetTargetResourceTypeHttp,
        FIS.ListTargetResourceTypesHttp,
        FIS.GetSafetyLeverHttp,
        FIS.UpdateSafetyLeverStateHttp,
        FIS.GetExperimentTargetAccountConfigurationHttp,
        FIS.ListExperimentTargetAccountConfigurationsHttp,
      ),
    ),
  ),
);
