import * as Lambda from "@/AWS/Lambda";
import * as MailManager from "@/AWS/MailManager";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class MailManagerTestFunction extends Lambda.Function<Lambda.Function>()(
  "MailManagerTestFunction",
) {}

export default MailManagerTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The address list the member-scoped bindings are bound to.
    const blockList = yield* MailManager.AddressList("BindingList", {
      tags: { fixture: "mailmanager-bindings" },
    });
    // The archive the search-scoped bindings are bound to. Nothing routes
    // mail into it, so searches complete with zero rows.
    const archive = yield* MailManager.Archive("BindingArchive", {
      retentionPeriod: "THREE_MONTHS",
      tags: { fixture: "mailmanager-bindings" },
    });

    const registerMember =
      yield* MailManager.RegisterMemberToAddressList(blockList);
    const deregisterMember =
      yield* MailManager.DeregisterMemberFromAddressList(blockList);
    const getMember = yield* MailManager.GetMemberOfAddressList(blockList);
    const listMembers = yield* MailManager.ListMembersOfAddressList(blockList);
    const listImportJobs =
      yield* MailManager.ListAddressListImportJobs(blockList);
    const startSearch = yield* MailManager.StartArchiveSearch(archive);
    const getSearch = yield* MailManager.GetArchiveSearch(archive);
    const getSearchResults =
      yield* MailManager.GetArchiveSearchResults(archive);
    const listSearches = yield* MailManager.ListArchiveSearches(archive);
    const listExports = yield* MailManager.ListArchiveExports(archive);

    const bound = {
      registerMember,
      deregisterMember,
      getMember,
      listMembers,
      listImportJobs,
      startSearch,
      getSearch,
      getSearchResults,
      listSearches,
      listExports,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        // Full member roundtrip: register -> get -> list -> deregister ->
        // get (typed not-found). Addresses are Sensitive/Redacted end-to-end
        // so the route reports booleans and counts, never the values.
        if (request.method === "POST" && pathname === "/members/roundtrip") {
          const address = "blocked@example.com";
          yield* registerMember({ Address: address });
          const member = yield* getMember({ Address: address });
          const { Addresses } = yield* listMembers({});
          yield* deregisterMember({ Address: address });
          const goneAfterDeregister = yield* getMember({
            Address: address,
          }).pipe(
            Effect.map(() => false),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(true),
            ),
          );
          return yield* HttpServerResponse.json({
            registered: member.CreatedTimestamp !== undefined,
            memberCount: Addresses.length,
            goneAfterDeregister,
          });
        }

        // Kick off an archive search over the last hour (the archive is
        // empty; the search completes with zero rows).
        if (request.method === "POST" && pathname === "/search/start") {
          const { SearchId } = yield* startSearch({
            FromTimestamp: new Date(Date.now() - 3_600_000),
            ToTimestamp: new Date(),
            MaxResults: 5,
          });
          return yield* HttpServerResponse.json({ searchId: SearchId });
        }

        if (request.method === "GET" && pathname === "/search/status") {
          const searchId = url.searchParams.get("searchId") ?? "";
          const search = yield* getSearch({ SearchId: searchId });
          return yield* HttpServerResponse.json({
            state: search.Status?.State,
            errorMessage: search.Status?.ErrorMessage,
          });
        }

        if (request.method === "GET" && pathname === "/search/results") {
          const searchId = url.searchParams.get("searchId") ?? "";
          const { Rows } = yield* getSearchResults({ SearchId: searchId });
          return yield* HttpServerResponse.json({
            rowCount: (Rows ?? []).length,
          });
        }

        // Cheap enumeration reads proving the remaining grants.
        if (request.method === "GET" && pathname === "/tasks") {
          const { Searches } = yield* listSearches({});
          const { Exports } = yield* listExports({});
          const { ImportJobs } = yield* listImportJobs({});
          return yield* HttpServerResponse.json({
            searchCount: (Searches ?? []).length,
            exportCount: (Exports ?? []).length,
            importJobCount: ImportJobs.length,
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
        MailManager.RegisterMemberToAddressListHttp,
        MailManager.DeregisterMemberFromAddressListHttp,
        MailManager.GetMemberOfAddressListHttp,
        MailManager.ListMembersOfAddressListHttp,
        MailManager.ListAddressListImportJobsHttp,
        MailManager.StartArchiveSearchHttp,
        MailManager.GetArchiveSearchHttp,
        MailManager.GetArchiveSearchResultsHttp,
        MailManager.ListArchiveSearchesHttp,
        MailManager.ListArchiveExportsHttp,
      ),
    ),
  ),
);
