import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import SmokeJob from "./job.ts";
import {
  Jobs,
  Store,
  Uploads,
  type JobMessage,
} from "./serverless-resources.ts";

const notFound = () =>
  HttpServerResponse.json({ error: "not found" }, { status: 404 });

/**
 * Public API Function. One route per behavior of the serverless story:
 *
 * - `GET    /config`             → resource identifiers (readiness + cross-checks)
 * - `GET    /ready`              → touches Firestore and Storage (IAM propagation)
 * - `PUT    /todos/:id`          → Firestore `set`
 * - `GET    /todos/:id`          → Firestore `get`
 * - `GET    /todos`              → Firestore `list`
 * - `DELETE /todos/:id`          → Firestore `delete`
 * - `PUT    /files/:name`        → Storage `put`
 * - `GET    /files/:name`        → Storage `get` (regular read)
 * - `GET    /files/:name/signed` → V4 signed download URL
 * - `POST   /jobs`               → Pub/Sub publish to the worker
 * - `POST   /run-job`            → Cloud Run Job execution
 */
export default class SmokeApi extends GCP.Function<SmokeApi>()(
  "SmokeApi",
  {
    main: import.meta.url,
    location: "us-central1",
    invokerIamDisabled: true,
  },
  Effect.gen(function* () {
    const store = yield* Store;
    const uploads = yield* Uploads;
    const jobs = yield* Jobs;
    const job = yield* SmokeJob;

    const db = yield* GCP.Firestore.ReadWriteDatabase(store);
    const files = yield* GCP.Storage.ReadWriteBucket(uploads);
    const signGetObjectUrl = yield* GCP.Storage.SignGetObjectUrl(uploads);
    const publisher = yield* GCP.PubSub.WriteTopic(jobs);
    const runJob = yield* GCP.Run.RunJob(job);

    const DatabaseName = yield* store.name;
    const BucketName = yield* uploads.bucketName;
    const TopicName = yield* jobs.name;
    const JobName = yield* job.name;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl, "http://api");
        const [head, id, tail, ...rest] = url.pathname
          .split("/")
          .filter(Boolean)
          .map(decodeURIComponent);
        if (rest.length > 0) return yield* notFound();

        if (request.method === "GET" && head === "config") {
          return yield* HttpServerResponse.json({
            databaseName: yield* DatabaseName,
            bucketName: yield* BucketName,
            topicName: yield* TopicName,
            jobName: yield* JobName,
          });
        }

        if (request.method === "GET" && head === "ready") {
          yield* db.get("todos/ready-probe");
          yield* files.head("ready-probe");
          return HttpServerResponse.text("ready");
        }

        if (head === "todos" && id === undefined && request.method === "GET") {
          const { documents } = yield* db.list("todos", { pageSize: 100 });
          return yield* HttpServerResponse.json({
            todos: documents.map((document) => document.fields),
          });
        }

        if (head === "todos" && id !== undefined && tail === undefined) {
          const path = `todos/${id}`;
          if (request.method === "PUT") {
            const body = (yield* request.json) as { text?: unknown };
            if (typeof body.text !== "string") {
              return yield* HttpServerResponse.json(
                { error: "text must be a string" },
                { status: 400 },
              );
            }
            yield* db.set(path, { id, text: body.text });
            return yield* HttpServerResponse.json({ ok: true, id });
          }
          if (request.method === "GET") {
            const document = yield* db.get(path);
            return document === undefined
              ? yield* notFound()
              : yield* HttpServerResponse.json({ item: document.fields });
          }
          if (request.method === "DELETE") {
            yield* db.delete(path);
            return HttpServerResponse.empty({ status: 204 });
          }
        }

        if (head === "files" && id !== undefined) {
          if (request.method === "PUT" && tail === undefined) {
            const body = new Uint8Array(yield* request.arrayBuffer);
            const object = yield* files.put(id, body, {
              contentType: request.headers["content-type"] ?? "text/plain",
            });
            return yield* HttpServerResponse.json({
              name: object.name,
              generation: object.generation,
            });
          }
          if (request.method === "GET" && tail === undefined) {
            const object = yield* files.get(id);
            return object === undefined
              ? yield* notFound()
              : HttpServerResponse.uint8Array(object.body, {
                  contentType: object.contentType ?? "application/octet-stream",
                });
          }
          if (request.method === "GET" && tail === "signed") {
            const signedUrl = yield* signGetObjectUrl({
              object: id,
              expiresIn: 300,
            });
            return yield* HttpServerResponse.json({ url: signedUrl });
          }
        }

        if (request.method === "POST" && head === "jobs") {
          const body = (yield* request.json) as { payload?: unknown };
          if (typeof body.payload !== "string") {
            return yield* HttpServerResponse.json(
              { error: "payload must be a string" },
              { status: 400 },
            );
          }
          const message: JobMessage = {
            id: crypto.randomUUID(),
            payload: body.payload,
          };
          const messageId = yield* publisher.publish({
            data: JSON.stringify(message),
          });
          return yield* HttpServerResponse.json({ id: message.id, messageId });
        }

        if (request.method === "POST" && head === "run-job") {
          const operation = yield* runJob();
          return yield* HttpServerResponse.json({
            operation: operation.name,
            execution: (operation.metadata as { name?: string } | undefined)
              ?.name,
          });
        }

        return yield* notFound();
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide([
      GCP.Firestore.ReadWriteDatabaseHttp,
      GCP.Storage.ReadWriteBucketHttp,
      GCP.Storage.SignGetObjectUrlHttp,
      GCP.PubSub.WriteTopicHttp,
      GCP.Run.RunJobHttp,
    ]),
  ),
) {}
