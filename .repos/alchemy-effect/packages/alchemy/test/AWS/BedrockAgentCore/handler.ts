import * as AgentCore from "@/AWS/BedrockAgentCore";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class AgentCoreTestFunction extends Lambda.Function<Lambda.Function>()(
  "AgentCoreTestFunction",
) {}

export default AgentCoreTestFunction.make(
  {
    main,
    url: true,
    // code interpreter / browser session start + execution can take >3s
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    const memory = yield* AgentCore.Memory("TestMemory", {
      eventExpiryDuration: "7 days",
      memoryStrategies: [
        {
          semanticMemoryStrategy: {
            name: "facts",
            namespaces: ["facts/{actorId}"],
          },
        },
      ],
    });
    const codeInterpreter = yield* AgentCore.CodeInterpreter(
      "TestInterpreter",
      {},
    );
    const browser = yield* AgentCore.BrowserCustom("TestBrowser", {});

    // memory: events
    const createEvent = yield* AgentCore.CreateEvent(memory);
    const getEvent = yield* AgentCore.GetEvent(memory);
    const deleteEvent = yield* AgentCore.DeleteEvent(memory);
    const listEvents = yield* AgentCore.ListEvents(memory);
    const listSessions = yield* AgentCore.ListSessions(memory);
    const listActors = yield* AgentCore.ListActors(memory);
    // memory: long-term records
    const listMemoryRecords = yield* AgentCore.ListMemoryRecords(memory);
    const retrieveMemoryRecords =
      yield* AgentCore.RetrieveMemoryRecords(memory);
    const getMemoryRecord = yield* AgentCore.GetMemoryRecord(memory);
    const deleteMemoryRecord = yield* AgentCore.DeleteMemoryRecord(memory);
    const batchCreateMemoryRecords =
      yield* AgentCore.BatchCreateMemoryRecords(memory);
    const batchUpdateMemoryRecords =
      yield* AgentCore.BatchUpdateMemoryRecords(memory);
    const batchDeleteMemoryRecords =
      yield* AgentCore.BatchDeleteMemoryRecords(memory);
    // memory: extraction jobs
    const startMemoryExtractionJob =
      yield* AgentCore.StartMemoryExtractionJob(memory);
    const listMemoryExtractionJobs =
      yield* AgentCore.ListMemoryExtractionJobs(memory);
    // code interpreter sessions
    const startSession =
      yield* AgentCore.StartCodeInterpreterSession(codeInterpreter);
    const invokeCodeInterpreter =
      yield* AgentCore.InvokeCodeInterpreter(codeInterpreter);
    const getCodeInterpreterSession =
      yield* AgentCore.GetCodeInterpreterSession(codeInterpreter);
    const listCodeInterpreterSessions =
      yield* AgentCore.ListCodeInterpreterSessions(codeInterpreter);
    const stopSession =
      yield* AgentCore.StopCodeInterpreterSession(codeInterpreter);
    // browser sessions
    const startBrowserSession = yield* AgentCore.StartBrowserSession(browser);
    const getBrowserSession = yield* AgentCore.GetBrowserSession(browser);
    const listBrowserSessions = yield* AgentCore.ListBrowserSessions(browser);
    const invokeBrowser = yield* AgentCore.InvokeBrowser(browser);
    const updateBrowserStream = yield* AgentCore.UpdateBrowserStream(browser);
    const saveBrowserSessionProfile =
      yield* AgentCore.SaveBrowserSessionProfile(browser);
    const stopBrowserSession = yield* AgentCore.StopBrowserSession(browser);

    // batchCreate -> get -> batchUpdate -> delete + batchDelete records.
    const recordsRoundtrip = Effect.gen(function* () {
      const namespace = "facts/batch-actor";
      const created = yield* batchCreateMemoryRecords({
        records: [
          {
            requestIdentifier: "rec-1",
            namespaces: [namespace],
            content: { text: "The user's favorite color is teal." },
            timestamp: new Date(),
          },
          {
            requestIdentifier: "rec-2",
            namespaces: [namespace],
            content: { text: "The user prefers window seats." },
            timestamp: new Date(),
          },
        ],
      });
      const [first, second] = created.successfulRecords;
      const fetched = yield* getMemoryRecord({
        memoryRecordId: first.memoryRecordId,
      });
      const updated = yield* batchUpdateMemoryRecords({
        records: [
          {
            memoryRecordId: first.memoryRecordId,
            timestamp: new Date(),
            content: { text: "The user's favorite color is green." },
            namespaces: [namespace],
          },
        ],
      });
      yield* deleteMemoryRecord({
        memoryRecordId: first.memoryRecordId,
      });
      const batchDeleted = yield* batchDeleteMemoryRecords({
        records: [{ memoryRecordId: second.memoryRecordId }],
      });
      return yield* HttpServerResponse.json({
        created: created.successfulRecords.length,
        fetchedRecordId: fetched.memoryRecord.memoryRecordId,
        updated: updated.successfulRecords.length,
        batchDeleted: batchDeleted.successfulRecords.length,
      });
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/events") {
          const body = (yield* request.json) as unknown as {
            actorId: string;
            sessionId: string;
            text: string;
          };
          const result = yield* createEvent({
            actorId: body.actorId,
            sessionId: body.sessionId,
            eventTimestamp: new Date(),
            payload: [
              {
                conversational: {
                  role: "USER",
                  content: { text: body.text },
                },
              },
            ],
          });
          return yield* HttpServerResponse.json({
            eventId: result.event.eventId,
            sessionId: result.event.sessionId,
          });
        }

        if (request.method === "GET" && pathname === "/events") {
          const result = yield* listEvents({
            actorId: url.searchParams.get("actorId")!,
            sessionId: url.searchParams.get("sessionId")!,
          });
          return yield* HttpServerResponse.json({
            count: result.events.length,
          });
        }

        // create -> get -> delete a single event, end to end.
        if (request.method === "POST" && pathname === "/events/roundtrip") {
          const actorId = "roundtrip-actor";
          const sessionId = "roundtrip-session";
          const created = yield* createEvent({
            actorId,
            sessionId,
            eventTimestamp: new Date(),
            payload: [
              {
                conversational: {
                  role: "USER",
                  content: { text: "roundtrip event" },
                },
              },
            ],
          });
          const eventId = created.event.eventId;
          const fetched = yield* getEvent({ actorId, sessionId, eventId });
          yield* deleteEvent({ actorId, sessionId, eventId });
          return yield* HttpServerResponse.json({
            eventId,
            fetchedEventId: fetched.event.eventId,
            deleted: true,
          });
        }

        if (request.method === "GET" && pathname === "/sessions") {
          const result = yield* listSessions({
            actorId: url.searchParams.get("actorId")!,
          });
          return yield* HttpServerResponse.json({
            count: result.sessionSummaries.length,
          });
        }

        if (request.method === "GET" && pathname === "/actors") {
          const result = yield* listActors({});
          return yield* HttpServerResponse.json({
            count: result.actorSummaries.length,
          });
        }

        if (request.method === "GET" && pathname === "/records") {
          const result = yield* listMemoryRecords({
            namespace: `facts/${url.searchParams.get("actorId")}`,
          });
          return yield* HttpServerResponse.json({
            count: result.memoryRecordSummaries.length,
          });
        }

        if (request.method === "GET" && pathname === "/retrieve") {
          const result = yield* retrieveMemoryRecords({
            namespace: `facts/${url.searchParams.get("actorId")}`,
            searchCriteria: {
              searchQuery: url.searchParams.get("query") ?? "anything",
              topK: 3,
            },
          });
          return yield* HttpServerResponse.json({
            count: result.memoryRecordSummaries.length,
          });
        }

        // Failures surface as a 500 with the typed tag/message in the body
        // so the suite's transient-retry logging shows the real cause.
        if (request.method === "POST" && pathname === "/records/roundtrip") {
          return yield* recordsRoundtrip.pipe(
            Effect.catch((error) =>
              HttpServerResponse.json(
                {
                  error: error._tag,
                  message: String(
                    (error as { message?: unknown }).message ?? error,
                  ),
                },
                { status: 500 },
              ),
            ),
          );
        }

        if (request.method === "GET" && pathname === "/extraction/jobs") {
          const result = yield* listMemoryExtractionJobs({});
          return yield* HttpServerResponse.json({
            count: result.jobs.length,
          });
        }

        // Not driven by tests (re-runs an extraction job by id); exists so
        // the binding's runtime callable is wired end-to-end.
        if (request.method === "POST" && pathname === "/extraction/start") {
          const result = yield* startMemoryExtractionJob({
            extractionJob: { jobId: url.searchParams.get("jobId")! },
          });
          return yield* HttpServerResponse.json({ jobId: result.jobId });
        }

        if (request.method === "POST" && pathname === "/code/run") {
          const session = yield* startSession({
            sessionTimeout: "5 minutes",
          });
          const result = yield* invokeCodeInterpreter({
            sessionId: session.sessionId,
            name: "executeCode",
            arguments: { language: "python", code: "print(21 * 2)" },
          });
          const chunks = yield* Stream.runCollect(result.stream);
          const observed = yield* getCodeInterpreterSession({
            sessionId: session.sessionId,
          });
          const sessions = yield* listCodeInterpreterSessions({});
          yield* stopSession({ sessionId: session.sessionId });
          return yield* HttpServerResponse.json({
            sessionId: session.sessionId,
            sessionStatus: observed.status,
            sessionCount: sessions.items?.length ?? 0,
            chunks: Array.from(chunks),
          });
        }

        // start -> get -> list -> screenshot -> stop a browser session.
        if (request.method === "POST" && pathname === "/browser/run") {
          const session = yield* startBrowserSession({
            sessionTimeout: "5 minutes",
          });
          const observed = yield* getBrowserSession({
            sessionId: session.sessionId,
          });
          const sessions = yield* listBrowserSessions({});
          const screenshot = yield* invokeBrowser({
            sessionId: session.sessionId,
            action: { screenshot: {} },
          });
          yield* stopBrowserSession({ sessionId: session.sessionId });
          return yield* HttpServerResponse.json({
            sessionId: session.sessionId,
            sessionStatus: observed.status,
            sessionCount: sessions.items?.length ?? 0,
            screenshotTaken: screenshot.result !== undefined,
          });
        }

        // Not driven by tests (needs a live automation stream / a browser
        // profile); exist so the bindings' runtime callables are wired.
        if (request.method === "POST" && pathname === "/browser/stream") {
          yield* updateBrowserStream({
            sessionId: url.searchParams.get("sessionId")!,
            streamUpdate: {
              automationStreamUpdate: { streamStatus: "ENABLED" },
            },
          });
          return yield* HttpServerResponse.json({ updated: true });
        }
        if (request.method === "POST" && pathname === "/browser/profile") {
          yield* saveBrowserSessionProfile({
            sessionId: url.searchParams.get("sessionId")!,
            profileIdentifier: url.searchParams.get("profileIdentifier")!,
          });
          return yield* HttpServerResponse.json({ saved: true });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found" },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AgentCore.CreateEventHttp,
        AgentCore.GetEventHttp,
        AgentCore.DeleteEventHttp,
        AgentCore.ListEventsHttp,
        AgentCore.ListSessionsHttp,
        AgentCore.ListActorsHttp,
        AgentCore.ListMemoryRecordsHttp,
        AgentCore.RetrieveMemoryRecordsHttp,
        AgentCore.GetMemoryRecordHttp,
        AgentCore.DeleteMemoryRecordHttp,
        AgentCore.BatchCreateMemoryRecordsHttp,
        AgentCore.BatchUpdateMemoryRecordsHttp,
        AgentCore.BatchDeleteMemoryRecordsHttp,
        AgentCore.StartMemoryExtractionJobHttp,
        AgentCore.ListMemoryExtractionJobsHttp,
        AgentCore.StartCodeInterpreterSessionHttp,
        AgentCore.InvokeCodeInterpreterHttp,
        AgentCore.GetCodeInterpreterSessionHttp,
        AgentCore.ListCodeInterpreterSessionsHttp,
        AgentCore.StopCodeInterpreterSessionHttp,
        AgentCore.StartBrowserSessionHttp,
        AgentCore.GetBrowserSessionHttp,
        AgentCore.ListBrowserSessionsHttp,
        AgentCore.InvokeBrowserHttp,
        AgentCore.UpdateBrowserStreamHttp,
        AgentCore.SaveBrowserSessionProfileHttp,
        AgentCore.StopBrowserSessionHttp,
      ),
    ),
  ),
);
