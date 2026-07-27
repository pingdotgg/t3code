import * as Deadline from "@/AWS/Deadline";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/**
 * Minimal valid Open Job Description template. With no fleet associated to
 * the queue the job simply sits READY — nothing ever runs (or costs money).
 */
const JOB_TEMPLATE = JSON.stringify({
  specificationVersion: "jobtemplate-2023-09",
  name: "AlchemyDeadlineBindingsJob",
  steps: [
    {
      name: "Echo",
      script: {
        actions: { onRun: { command: "/bin/echo", args: ["hello"] } },
      },
    },
  ],
});

export class DeadlineTestFunction extends Lambda.Function<Lambda.Function>()(
  "DeadlineTestFunction",
) {}

export default DeadlineTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The farm + queue the bindings are bound to. No fleet is associated,
    // so submitted jobs stay READY and never provision workers.
    const farm = yield* Deadline.Farm("BindingsFarm", {
      description: "alchemy deadline bindings fixture farm",
    });
    const queue = yield* Deadline.Queue("BindingsQueue", {
      farmId: farm.farmId,
      description: "alchemy deadline bindings fixture queue",
      jobRunAsUser: { runAs: "WORKER_AGENT_USER" },
    });
    const QueueId = yield* queue.queueId;

    // Event source: subscribe the host to Deadline job status changes. The
    // deploy proves the EventBridge rule + invoke permission wiring.
    yield* Deadline.consumeFarmEvents(
      { kinds: ["job-run", "job-lifecycle"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `deadline job event: ${event.detail.jobId} -> ${event.detail.status}`,
          ),
        ),
    );

    const createJob = yield* Deadline.CreateJob(queue);
    const getJob = yield* Deadline.GetJob(queue);
    const updateJob = yield* Deadline.UpdateJob(queue);
    const listJobs = yield* Deadline.ListJobs(queue);
    const listJobParameterDefinitions =
      yield* Deadline.ListJobParameterDefinitions(queue);
    const searchJobs = yield* Deadline.SearchJobs(queue);
    const searchSteps = yield* Deadline.SearchSteps(queue);
    const searchTasks = yield* Deadline.SearchTasks(queue);
    const getSession = yield* Deadline.GetSession(queue);
    const listSessions = yield* Deadline.ListSessions(queue);
    const getSessionAction = yield* Deadline.GetSessionAction(queue);
    const listSessionActions = yield* Deadline.ListSessionActions(queue);
    const getStep = yield* Deadline.GetStep(queue);
    const listSteps = yield* Deadline.ListSteps(queue);
    const updateStep = yield* Deadline.UpdateStep(queue);
    const getTask = yield* Deadline.GetTask(queue);
    const listTasks = yield* Deadline.ListTasks(queue);
    const updateTask = yield* Deadline.UpdateTask(queue);
    const startAggregation =
      yield* Deadline.StartSessionsStatisticsAggregation(farm);
    const getAggregation =
      yield* Deadline.GetSessionsStatisticsAggregation(farm);

    const bound = {
      createJob,
      getJob,
      updateJob,
      listJobs,
      listJobParameterDefinitions,
      searchJobs,
      searchSteps,
      searchTasks,
      getSession,
      listSessions,
      getSessionAction,
      listSessionActions,
      getStep,
      listSteps,
      updateStep,
      getTask,
      listTasks,
      updateTask,
      startAggregation,
      getAggregation,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const param = (name: string) => url.searchParams.get(name) ?? "";

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/queue") {
          return yield* HttpServerResponse.json({ queueId: yield* QueueId });
        }

        // Submit a render job from the fixture template (farm/queue ids are
        // injected by the binding).
        if (request.method === "POST" && pathname === "/jobs") {
          const { jobId } = yield* createJob({
            // The outer HTTP fixture retries transient 5xx responses. Keep
            // CreateJob idempotent if AWS accepted the first request but the
            // Lambda response was lost.
            clientToken: "alchemy-deadline-bindings-job",
            template: JOB_TEMPLATE,
            templateType: "JSON",
            priority: 50,
          });
          return yield* HttpServerResponse.json({ jobId });
        }

        if (request.method === "GET" && pathname === "/job") {
          const job = yield* getJob({ jobId: param("jobId") });
          return yield* HttpServerResponse.json({
            jobId: job.jobId,
            name: job.name,
            lifecycleStatus: job.lifecycleStatus,
            priority: job.priority,
          });
        }

        if (request.method === "POST" && pathname === "/priority") {
          yield* updateJob({
            jobId: param("jobId"),
            priority: Number(param("priority")),
          });
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/jobs") {
          const { jobs } = yield* listJobs();
          return yield* HttpServerResponse.json({
            ids: (jobs ?? []).map((job) => job.jobId),
          });
        }

        // Search the queue's jobs; summaries include the queueId, which the
        // test feeds back into the statistics aggregation route.
        if (request.method === "POST" && pathname === "/search") {
          const { jobs } = yield* searchJobs({ itemOffset: 0 });
          return yield* HttpServerResponse.json({
            ids: (jobs ?? []).map((job) => job.jobId),
            queueIds: (jobs ?? []).map((job) => job.queueId),
          });
        }

        if (request.method === "POST" && pathname === "/search/steps") {
          const { steps } = yield* searchSteps({
            itemOffset: 0,
            jobId: param("jobId"),
          });
          return yield* HttpServerResponse.json({
            ids: (steps ?? []).map((step) => step.stepId),
          });
        }

        if (request.method === "POST" && pathname === "/search/tasks") {
          const { tasks } = yield* searchTasks({
            itemOffset: 0,
            jobId: param("jobId"),
          });
          return yield* HttpServerResponse.json({
            ids: (tasks ?? []).map((task) => task.taskId),
          });
        }

        if (request.method === "GET" && pathname === "/params") {
          const { jobParameterDefinitions } =
            yield* listJobParameterDefinitions({ jobId: param("jobId") });
          return yield* HttpServerResponse.json({
            count: (jobParameterDefinitions ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/steps") {
          const { steps } = yield* listSteps({ jobId: param("jobId") });
          return yield* HttpServerResponse.json({
            ids: (steps ?? []).map((step) => step.stepId),
            names: (steps ?? []).map((step) => step.name),
          });
        }

        if (request.method === "GET" && pathname === "/step") {
          const step = yield* getStep({
            jobId: param("jobId"),
            stepId: param("stepId"),
          });
          return yield* HttpServerResponse.json({
            stepId: step.stepId,
            name: step.name,
            lifecycleStatus: step.lifecycleStatus,
          });
        }

        if (request.method === "GET" && pathname === "/tasks") {
          const { tasks } = yield* listTasks({
            jobId: param("jobId"),
            stepId: param("stepId"),
          });
          return yield* HttpServerResponse.json({
            ids: (tasks ?? []).map((task) => task.taskId),
          });
        }

        if (request.method === "GET" && pathname === "/task") {
          const task = yield* getTask({
            jobId: param("jobId"),
            stepId: param("stepId"),
            taskId: param("taskId"),
          });
          return yield* HttpServerResponse.json({
            taskId: task.taskId,
            runStatus: task.runStatus,
          });
        }

        // Cancel a single READY task (nothing runs — no fleet).
        if (request.method === "POST" && pathname === "/task/cancel") {
          yield* updateTask({
            jobId: param("jobId"),
            stepId: param("stepId"),
            taskId: param("taskId"),
            targetRunStatus: "CANCELED",
          });
          return yield* HttpServerResponse.json({ ok: true });
        }

        // Requeue the whole step's tasks back to READY.
        if (request.method === "POST" && pathname === "/step/requeue") {
          yield* updateStep({
            jobId: param("jobId"),
            stepId: param("stepId"),
            targetTaskRunStatus: "READY",
          });
          return yield* HttpServerResponse.json({ ok: true });
        }

        // With no fleet there are never sessions — proves the op + IAM wire
        // up and returns an empty page.
        if (request.method === "GET" && pathname === "/sessions") {
          const { sessions } = yield* listSessions({ jobId: param("jobId") });
          return yield* HttpServerResponse.json({
            ids: (sessions ?? []).map((session) => session.sessionId),
          });
        }

        if (request.method === "GET" && pathname === "/session") {
          const session = yield* getSession({
            jobId: param("jobId"),
            sessionId: param("sessionId"),
          });
          return yield* HttpServerResponse.json({
            sessionId: session.sessionId,
          });
        }

        // No workers means no sessions and therefore no session actions —
        // proves the op + IAM wire up and returns an empty page. The API
        // requires a sessionId or taskId to scope the query.
        if (request.method === "GET" && pathname === "/session-actions") {
          const { sessionActions } = yield* listSessionActions({
            jobId: param("jobId"),
            taskId: param("taskId"),
          });
          return yield* HttpServerResponse.json({
            ids: (sessionActions ?? []).map((action) => action.sessionActionId),
          });
        }

        if (request.method === "GET" && pathname === "/session-action") {
          const action = yield* getSessionAction({
            jobId: param("jobId"),
            sessionActionId: param("sessionActionId"),
          });
          return yield* HttpServerResponse.json({
            sessionActionId: action.sessionActionId,
            status: action.status,
          });
        }

        if (request.method === "POST" && pathname === "/stats") {
          // The API rejects timestamps whose minutes/seconds are not zero —
          // align the window to whole hours.
          const hourMs = 3600 * 1000;
          const endTime = new Date(Math.floor(Date.now() / hourMs) * hourMs);
          const startTime = new Date(endTime.getTime() - 24 * hourMs);
          const { aggregationId } = yield* startAggregation({
            resourceIds: { queueIds: [param("queueId")] },
            startTime,
            endTime,
            groupBy: ["QUEUE_ID"],
            statistics: ["SUM"],
          });
          return yield* HttpServerResponse.json({ aggregationId });
        }

        if (request.method === "GET" && pathname === "/stats") {
          const result = yield* getAggregation({
            aggregationId: param("aggregationId"),
          });
          return yield* HttpServerResponse.json({
            status: result.status,
            count: (result.statistics ?? []).length,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(
        // Surface typed operation errors as a JSON 500 so the test log
        // shows the real cause instead of an opaque crash.
        Effect.catch((error) =>
          HttpServerResponse.json({ error: String(error) }, { status: 500 }),
        ),
        Effect.orDie,
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        Deadline.CreateJobHttp,
        Deadline.GetJobHttp,
        Deadline.UpdateJobHttp,
        Deadline.ListJobsHttp,
        Deadline.ListJobParameterDefinitionsHttp,
        Deadline.SearchJobsHttp,
        Deadline.SearchStepsHttp,
        Deadline.SearchTasksHttp,
        Deadline.GetSessionHttp,
        Deadline.ListSessionsHttp,
        Deadline.GetSessionActionHttp,
        Deadline.ListSessionActionsHttp,
        Deadline.GetStepHttp,
        Deadline.ListStepsHttp,
        Deadline.UpdateStepHttp,
        Deadline.GetTaskHttp,
        Deadline.ListTasksHttp,
        Deadline.UpdateTaskHttp,
        Deadline.StartSessionsStatisticsAggregationHttp,
        Deadline.GetSessionsStatisticsAggregationHttp,
      ),
    ),
  ),
);
