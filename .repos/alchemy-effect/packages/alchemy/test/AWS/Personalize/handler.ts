import * as Lambda from "@/AWS/Lambda";
import * as Personalize from "@/AWS/Personalize";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class PersonalizeTestFunction extends Lambda.Function<Lambda.Function>()(
  "PersonalizeTestFunction",
) {}

const INTERACTIONS_SCHEMA = JSON.stringify({
  type: "record",
  name: "Interactions",
  namespace: "com.amazonaws.personalize.schema",
  fields: [
    { name: "USER_ID", type: "string" },
    { name: "ITEM_ID", type: "string" },
    { name: "TIMESTAMP", type: "long" },
  ],
  version: "1.0",
});

const ITEMS_SCHEMA = JSON.stringify({
  type: "record",
  name: "Items",
  namespace: "com.amazonaws.personalize.schema",
  fields: [
    { name: "ITEM_ID", type: "string" },
    { name: "CATEGORY", type: "string", categorical: true },
  ],
  version: "1.0",
});

const USERS_SCHEMA = JSON.stringify({
  type: "record",
  name: "Users",
  namespace: "com.amazonaws.personalize.schema",
  fields: [
    { name: "USER_ID", type: "string" },
    { name: "MEMBERSHIP", type: "string", categorical: true },
  ],
  version: "1.0",
});

/**
 * Personalize bindings fixture: deploys the cheap definition resources (three
 * schemas, a dataset group, Interactions/Items/Users datasets, and an event
 * tracker) plus a Lambda bound to all nineteen Personalize bindings.
 *
 * The event-ingestion routes (`/put-events`, `/put-items`, `/put-users`)
 * exercise the data plane for real against the deployed datasets/tracker.
 * The campaign/solution routes are probes: training a solution takes ~an hour
 * of paid compute, so they drive well-formed-but-nonexistent ARNs (passed by
 * the test as a query parameter) and return the typed error tag — proving the
 * deploy-time IAM bind, the runtime call plumbing, and the typed error decode.
 */
export default PersonalizeTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const interactionsSchema = yield* Personalize.Schema("InteractionsSchema", {
      schema: INTERACTIONS_SCHEMA,
    });
    const itemsSchema = yield* Personalize.Schema("ItemsSchema", {
      schema: ITEMS_SCHEMA,
    });
    const usersSchema = yield* Personalize.Schema("UsersSchema", {
      schema: USERS_SCHEMA,
    });
    const group = yield* Personalize.DatasetGroup("BindingsGroup", {});
    const interactions = yield* Personalize.Dataset("Interactions", {
      schemaArn: interactionsSchema.schemaArn,
      datasetGroupArn: group.datasetGroupArn,
      datasetType: "Interactions",
    });
    const items = yield* Personalize.Dataset("Items", {
      schemaArn: itemsSchema.schemaArn,
      datasetGroupArn: group.datasetGroupArn,
      datasetType: "Items",
    });
    const users = yield* Personalize.Dataset("Users", {
      schemaArn: usersSchema.schemaArn,
      datasetGroupArn: group.datasetGroupArn,
      datasetType: "Users",
    });
    // Depend on the Interactions dataset (events are recorded into it) so the
    // tracker is created after it and deleted before it.
    const tracker = yield* Personalize.EventTracker("Tracker", {
      datasetGroupArn: interactions.datasetGroupArn,
    });

    const putEvents = yield* Personalize.PutEvents(tracker);
    const putActionInteractions =
      yield* Personalize.PutActionInteractions(tracker);
    const putItems = yield* Personalize.PutItems(items);
    const putUsers = yield* Personalize.PutUsers(users);
    // Bound to the Items dataset on purpose: without an Actions dataset the
    // route is a typed-error probe for the PutActions plumbing.
    const putActions = yield* Personalize.PutActions(items);
    const getRecommendations = yield* Personalize.GetRecommendations();
    const getPersonalizedRanking = yield* Personalize.GetPersonalizedRanking();
    const getActionRecommendations =
      yield* Personalize.GetActionRecommendations();
    const createDatasetImportJob = yield* Personalize.CreateDatasetImportJob();
    const describeDatasetImportJob =
      yield* Personalize.DescribeDatasetImportJob();
    const createSolutionVersion = yield* Personalize.CreateSolutionVersion();
    const describeSolutionVersion =
      yield* Personalize.DescribeSolutionVersion();
    const updateCampaign = yield* Personalize.UpdateCampaign();
    const describeCampaign = yield* Personalize.DescribeCampaign();
    const createSolution = yield* Personalize.CreateSolution();
    const createCampaign = yield* Personalize.CreateCampaign();
    const getSolutionMetrics = yield* Personalize.GetSolutionMetrics();
    const createBatchInferenceJob =
      yield* Personalize.CreateBatchInferenceJob();
    const describeBatchInferenceJob =
      yield* Personalize.DescribeBatchInferenceJob();

    const bound = {
      putEvents,
      putActionInteractions,
      putItems,
      putUsers,
      putActions,
      getRecommendations,
      getPersonalizedRanking,
      getActionRecommendations,
      createDatasetImportJob,
      describeDatasetImportJob,
      createSolutionVersion,
      describeSolutionVersion,
      updateCampaign,
      describeCampaign,
      createSolution,
      createCampaign,
      getSolutionMetrics,
      createBatchInferenceJob,
      describeBatchInferenceJob,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const arn = url.searchParams.get("arn") ?? "";
        const roleArn =
          url.searchParams.get("role") ??
          "arn:aws:iam::000000000000:role/alchemy_probe";

        if (pathname === "/bindings") {
          return yield* HttpServerResponse.json({ bound: Object.keys(bound) });
        }

        if (pathname === "/put-events") {
          const tag = yield* putEvents({
            sessionId: "alchemy-session-1",
            userId: "alchemy-user-1",
            eventList: [
              {
                eventType: "click",
                itemId: "alchemy-item-1",
                sentAt: new Date(),
              },
            ],
          }).pipe(
            Effect.map(() => "Recorded"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (pathname === "/put-items") {
          const tag = yield* putItems({
            items: [
              {
                itemId: "alchemy-item-1",
                properties: JSON.stringify({ category: "books" }),
              },
            ],
          }).pipe(
            Effect.map(() => "Recorded"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (pathname === "/put-users") {
          const tag = yield* putUsers({
            users: [
              {
                userId: "alchemy-user-1",
                properties: JSON.stringify({ membership: "gold" }),
              },
            ],
          }).pipe(
            Effect.map(() => "Recorded"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (pathname === "/put-actions-probe") {
          const tag = yield* putActions({
            actions: [{ actionId: "alchemy-action-1" }],
          }).pipe(
            Effect.map(() => "Recorded"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (pathname === "/put-action-interactions-probe") {
          const tag = yield* putActionInteractions({
            actionInteractions: [
              {
                actionId: "alchemy-action-1",
                userId: "alchemy-user-1",
                sessionId: "alchemy-session-1",
                eventType: "Taken",
                timestamp: new Date(),
              },
            ],
          }).pipe(
            Effect.map(() => "Recorded"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (pathname === "/recommendations-probe") {
          const tag = yield* getRecommendations({
            campaignArn: arn,
            userId: "alchemy-user-1",
          }).pipe(
            Effect.map(() => "Recommended"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (pathname === "/ranking-probe") {
          const tag = yield* getPersonalizedRanking({
            campaignArn: arn,
            userId: "alchemy-user-1",
            inputList: ["alchemy-item-1", "alchemy-item-2"],
          }).pipe(
            Effect.map(() => "Ranked"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (pathname === "/action-recommendations-probe") {
          const tag = yield* getActionRecommendations({
            campaignArn: arn,
            userId: "alchemy-user-1",
          }).pipe(
            Effect.map(() => "Recommended"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (pathname === "/import-create-probe") {
          const tag = yield* createDatasetImportJob({
            jobName: "alchemy-import-probe",
            datasetArn: arn,
            dataSource: {
              dataLocation: "s3://alchemy-nonexistent-probe-bucket/data.csv",
            },
            roleArn,
          }).pipe(
            Effect.map(() => "Created"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (pathname === "/import-probe") {
          const tag = yield* describeDatasetImportJob({
            datasetImportJobArn: arn,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (pathname === "/solution-version-create-probe") {
          const tag = yield* createSolutionVersion({
            solutionArn: arn,
          }).pipe(
            Effect.map(() => "Created"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (pathname === "/solution-version-probe") {
          const tag = yield* describeSolutionVersion({
            solutionVersionArn: arn,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (pathname === "/campaign-update-probe") {
          const tag = yield* updateCampaign({ campaignArn: arn }).pipe(
            Effect.map(() => "Updated"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (pathname === "/campaign-probe") {
          const tag = yield* describeCampaign({ campaignArn: arn }).pipe(
            Effect.map(() => "Found"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (pathname === "/solution-create-probe") {
          const tag = yield* createSolution({
            name: "alchemy-solution-probe",
            recipeArn: "arn:aws:personalize:::recipe/aws-user-personalization",
            datasetGroupArn: arn,
          }).pipe(
            Effect.map(() => "Created"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (pathname === "/campaign-create-probe") {
          const tag = yield* createCampaign({
            name: "alchemy-campaign-probe",
            solutionVersionArn: arn,
          }).pipe(
            Effect.map(() => "Created"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (pathname === "/solution-metrics-probe") {
          const tag = yield* getSolutionMetrics({
            solutionVersionArn: arn,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (pathname === "/batch-create-probe") {
          const tag = yield* createBatchInferenceJob({
            jobName: "alchemy-batch-probe",
            solutionVersionArn: arn,
            jobInput: {
              s3DataSource: {
                path: "s3://alchemy-nonexistent-probe-bucket/users.json",
              },
            },
            jobOutput: {
              s3DataDestination: {
                path: "s3://alchemy-nonexistent-probe-bucket/scores/",
              },
            },
            roleArn,
          }).pipe(
            Effect.map(() => "Created"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (pathname === "/batch-probe") {
          const tag = yield* describeBatchInferenceJob({
            batchInferenceJobArn: arn,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Personalize.PutEventsHttp,
        Personalize.PutActionInteractionsHttp,
        Personalize.PutItemsHttp,
        Personalize.PutUsersHttp,
        Personalize.PutActionsHttp,
        Personalize.GetRecommendationsHttp,
        Personalize.GetPersonalizedRankingHttp,
        Personalize.GetActionRecommendationsHttp,
        Personalize.CreateDatasetImportJobHttp,
        Personalize.DescribeDatasetImportJobHttp,
        Personalize.CreateSolutionVersionHttp,
        Personalize.DescribeSolutionVersionHttp,
        Personalize.UpdateCampaignHttp,
        Personalize.DescribeCampaignHttp,
        Personalize.CreateSolutionHttp,
        Personalize.CreateCampaignHttp,
        Personalize.GetSolutionMetricsHttp,
        Personalize.CreateBatchInferenceJobHttp,
        Personalize.DescribeBatchInferenceJobHttp,
      ),
    ),
  ),
);
