import * as Workflows from "alchemy/Workflows";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { WorkflowEngine } from "effect/workflow";
import { Journal } from "./journal.ts";
import {
  Approval,
  Approve,
  Checkout,
  Crash,
  Fanout,
  Flaky,
  Greet,
  Guarded,
  Hold,
  Nap,
  Naps,
  Parent,
  ParentOfFailing,
  ParentOfWaiting,
  Race,
  Recover,
  Retry,
  Suspends,
  WakeInStep,
} from "./workflows.ts";

/**
 * The routes the conformance cases drive, whichever engine runs the workflows:
 *
 * - `POST /start/<workflow>/<id>?…` starts a run and answers its execution id
 * - `GET /status/<workflow>/<id>?executionId=…` reads its status
 * - `POST /approve/<workflow>/<id>?executionId=…&by=…` signals its approval
 * - `POST /interrupt/<workflow>/<id>?executionId=…` interrupts it
 * - `POST /resume/Suspends/<id>?executionId=…` resumes a run suspended on failure
 * - `GET /journal/<id>` lists what its activities recorded
 */
export const app = Effect.gen(function* () {
  const journal = yield* Journal;
  const engine = yield* WorkflowEngine.WorkflowEngine;
  const workflows = {
    Greet: yield* Workflows.RunWorkflow(Greet),
    Nap: yield* Workflows.RunWorkflow(Nap),
    Naps: yield* Workflows.RunWorkflow(Naps),
    Approve: yield* Workflows.RunWorkflow(Approve),
    Hold: yield* Workflows.RunWorkflow(Hold),
    Checkout: yield* Workflows.RunWorkflow(Checkout),
    Parent: yield* Workflows.RunWorkflow(Parent),
    Flaky: yield* Workflows.RunWorkflow(Flaky),
    Crash: yield* Workflows.RunWorkflow(Crash),
    Retry: yield* Workflows.RunWorkflow(Retry),
    WakeInStep: yield* Workflows.RunWorkflow(WakeInStep),
    Guarded: yield* Workflows.RunWorkflow(Guarded),
    Race: yield* Workflows.RunWorkflow(Race),
    ParentOfWaiting: yield* Workflows.RunWorkflow(ParentOfWaiting),
    Suspends: yield* Workflows.RunWorkflow(Suspends),
    Recover: yield* Workflows.RunWorkflow(Recover),
    Fanout: yield* Workflows.RunWorkflow(Fanout),
    ParentOfFailing: yield* Workflows.RunWorkflow(ParentOfFailing),
  };
  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const url = new URL(request.originalUrl, "http://conformance");
      const [, operation, name, id] = url.pathname.split("/");
      if (operation === "ready") return HttpServerResponse.text("ready");
      if (operation === "journal" && name) {
        return yield* HttpServerResponse.json(yield* journal.list(name));
      }
      const workflow = workflows[name as keyof typeof workflows] as typeof workflows.Checkout;
      if (!workflow || !id) return HttpServerResponse.text("Not Found", { status: 404 });
      // Every workflow's payload fields; each workflow reads the ones it declares.
      const payload = {
        id,
        name: url.searchParams.get("name") ?? "world",
        seconds: Number(url.searchParams.get("seconds") ?? "2"),
        count: Number(url.searchParams.get("count") ?? "1"),
        decline: url.searchParams.get("decline") === "true",
        abandon: url.searchParams.get("abandon") === "true",
      };
      const run = workflow.get(url.searchParams.get("executionId") ?? "");
      switch (operation) {
        case "start": {
          const started = yield* workflow.start(payload);
          return yield* HttpServerResponse.json({ executionId: started.executionId });
        }
        case "status": {
          const status = yield* run.status;
          // A defect is often an Error, whose message JSON leaves out.
          return yield* HttpServerResponse.json(
            status._tag === "Died" ? { _tag: "Died", defect: messageOf(status.defect) } : status,
          );
        }
        case "resume": {
          yield* engine.resume(Suspends, url.searchParams.get("executionId") ?? "");
          return HttpServerResponse.text("ok");
        }
        case "approve": {
          yield* run.signal(Approval, url.searchParams.get("by") ?? "nobody");
          return HttpServerResponse.text("ok");
        }
        case "interrupt": {
          yield* run.interrupt;
          return HttpServerResponse.text("ok");
        }
        default:
          return HttpServerResponse.text("Not Found", { status: 404 });
      }
    }).pipe(
      // Report why a request failed, so a failing case shows it.
      Effect.catchCause((cause) =>
        Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
      ),
    ),
  };
});

const messageOf = (defect: unknown) =>
  typeof defect === "object" && defect !== null && "message" in defect
    ? String(defect.message)
    : String(defect);
