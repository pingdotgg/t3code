import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Drizzle from "@alchemy.run/drizzle/LibSQL";
import * as Turso from "@alchemy.run/turso";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Template, Tenants } from "./Db.ts";
import { Notes } from "./schema.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const tenants = yield* Turso.ManageDatabases(Tenants);
    const template = yield* Template;
    const templateName = yield* template.name;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        // /tenants/:tenant/notes
        const [, root, tenant, resource] = new URL(request.url, "http://api").pathname.split("/");
        if (root !== "tenants") {
          return yield* HttpServerResponse.json({ error: "Not found" }, { status: 404 });
        }

        if (tenant === undefined || tenant === "") {
          const databases = yield* tenants.list();
          const template = yield* templateName;
          return yield* HttpServerResponse.json({
            tenants: databases.map((d) => d.name).filter((name) => name !== template),
          });
        }

        if (resource === undefined) {
          switch (request.method) {
            case "POST": {
              const database = yield* tenants.create(tenant, {
                seed: { type: "database", name: yield* templateName },
              });
              return yield* HttpServerResponse.json({ tenant: database });
            }
            case "DELETE": {
              yield* tenants.delete(tenant);
              return yield* HttpServerResponse.json({ deleted: tenant });
            }
          }
        }

        if (resource === "notes") {
          const db = yield* Drizzle.LibSQL(tenants.connect(tenant));
          switch (request.method) {
            case "GET": {
              const notes = yield* db.select().from(Notes);
              return yield* HttpServerResponse.json({ notes });
            }
            case "POST": {
              const { body } = (yield* request.json) as { body: string };
              const [note] = yield* db.insert(Notes).values({ body }).returning();
              return yield* HttpServerResponse.json({ note });
            }
          }
        }

        return yield* HttpServerResponse.json({ error: "Method not allowed" }, { status: 405 });
      }).pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: String(cause) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(Effect.provide(Turso.ManageDatabasesHttp)),
) {}
