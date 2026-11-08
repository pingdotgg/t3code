import * as NodeBuffer from "node:buffer";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as L from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as Q from "./linearOperations.ts";

type Read<S extends Schema.Top, I = typeof L.LinearIdInput.Type> = (
  input: I,
) => Effect.Effect<S["Type"], L.LinearError>;
export class LinearService extends Context.Service<
  LinearService,
  {
    readonly connection: () => Effect.Effect<typeof L.LinearConnection.Type, L.LinearError>;
    readonly upload: Read<typeof L.LinearUploadResult, typeof L.LinearUploadInput.Type>;
    readonly configure: Read<typeof L.LinearConnection, typeof L.LinearConfigureInput.Type>;
    readonly workspace: () => Effect.Effect<typeof L.LinearWorkspace.Type, L.LinearError>;
    readonly teamContext: Read<typeof L.LinearTeamContext>;
    readonly issues: Read<typeof L.LinearIssuePage, typeof L.LinearIssuesInput.Type>;
    readonly issue: Read<typeof L.LinearIssueDetail>;
    readonly comments: Read<typeof L.LinearCommentsPage, typeof L.LinearCommentsInput.Type>;
    readonly projects: Read<typeof L.LinearProjectPage, typeof L.LinearProjectsInput.Type>;
    readonly project: Read<typeof L.LinearProjectDetail>;
    readonly documents: Read<typeof L.LinearDocumentPage, typeof L.LinearDocumentsInput.Type>;
    readonly document: Read<typeof L.LinearDocument>;
    readonly inbox: Read<typeof L.LinearInboxPage, typeof L.LinearInboxInput.Type>;
    readonly mutate: Read<typeof L.LinearMutationResult, L.LinearMutationInput>;
  }
>()("t3/linear/LinearService") {}

const CredentialFile = Schema.Struct({ apiKey: Schema.NullOr(Schema.String) });
const Envelope = Schema.Struct({
  data: Schema.optional(Schema.Unknown),
  errors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        extensions: Schema.optional(Schema.Struct({ code: Schema.optional(Schema.String) })),
      }),
    ),
  ),
});
const decodeEnvelope = Schema.decodeUnknownEffect(Envelope);
const decodeCredential = Schema.decodeEffect(Schema.fromJsonString(CredentialFile));
const encodeCredential = Schema.encodeEffect(Schema.fromJsonString(CredentialFile));
const decodeResult = Schema.decodeUnknownEffect(Schema.Struct({ result: Schema.Unknown }));
const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const env = yield* HostProcess.Environment;
  const credentialPath = path.join(config.secretsDir, "linear.json");
  const credentialLock = yield* Semaphore.make(1);
  const readCredential = Effect.fn("LinearService.readCredential")(
    function* () {
      if (yield* fs.exists(credentialPath)) {
        const saved = yield* fs
          .readFileString(credentialPath)
          .pipe(Effect.flatMap(decodeCredential));
        return {
          source: saved.apiKey ? ("saved" as const) : ("disconnected" as const),
          key: saved.apiKey ? Redacted.make(saved.apiKey) : null,
        };
      }
      const key = env.LINEAR_API_KEY?.trim();
      return {
        source: key ? ("environment" as const) : ("disconnected" as const),
        key: key ? Redacted.make(key) : null,
      };
    },
    Effect.mapError(() => new L.LinearError({ reason: "storage" })),
  );
  const connection = Effect.fn("LinearService.connection")(function* () {
    const credential = yield* readCredential();
    return { source: credential.source, connected: credential.key !== null };
  });
  const request = Effect.fn("LinearService.request")(function* <A>(
    query: string,
    variables: object,
    schema: Schema.Codec<A>,
    override?: Redacted.Redacted<string>,
  ) {
    const key = override ?? (yield* readCredential()).key;
    if (key === null) return yield* new L.LinearError({ reason: "disconnected" });
    const body = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post("https://api.linear.app/graphql"),
      { query, variables },
    ).pipe(Effect.mapError(() => new L.LinearError({ reason: "invalid-response" })));
    const response = yield* http
      .execute(
        body.pipe(
          HttpClientRequest.setHeader("Authorization", Redacted.value(key)),
          HttpClientRequest.setHeader("public-file-urls-expire-in", "3600"),
        ),
      )
      .pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError(() => new L.LinearError({ reason: "network" })),
      );
    if (response.status === 401 || response.status === 403)
      return yield* new L.LinearError({ reason: "unauthorized" });
    if (response.status === 429) return yield* new L.LinearError({ reason: "rate-limit" });
    const raw = yield* response.json.pipe(
      Effect.mapError(() => new L.LinearError({ reason: "invalid-response" })),
    );
    const envelope = yield* decodeEnvelope(raw).pipe(
      Effect.mapError(() => new L.LinearError({ reason: "invalid-response" })),
    );
    if (envelope.errors?.length) {
      const codes = envelope.errors.map((error) => error.extensions?.code);
      return yield* new L.LinearError({
        reason: codes.includes("RATELIMITED")
          ? "rate-limit"
          : codes.includes("AUTHENTICATION_ERROR") || codes.includes("FORBIDDEN")
            ? "unauthorized"
            : "api",
      });
    }
    if (response.status < 200 || response.status >= 300)
      return yield* new L.LinearError({ reason: "api" });
    const decoded = yield* decodeResult(envelope.data).pipe(
      Effect.mapError(() => new L.LinearError({ reason: "invalid-response" })),
    );
    // The response codec is selected by the operation, so it cannot be compiled at module scope.
    return yield* Schema.decodeUnknownEffect(schema)(decoded.result).pipe(
      Effect.mapError(() => new L.LinearError({ reason: "invalid-response" })),
    );
  }, Effect.scoped);
  const configure = Effect.fn("LinearService.configure")(function* (
    input: typeof L.LinearConfigureInput.Type,
  ) {
    if (input.kind === "environment") {
      yield* fs
        .remove(credentialPath, { force: true })
        .pipe(Effect.mapError(() => new L.LinearError({ reason: "storage" })));
    } else {
      if (input.kind === "save")
        yield* request(
          `{ result:viewer { ${Q.personFields} } }`,
          {},
          L.LinearPerson,
          Redacted.make(input.apiKey),
        );
      yield* fs
        .makeDirectory(config.secretsDir, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError(() => new L.LinearError({ reason: "storage" })));
      const temp = `${credentialPath}.tmp`;
      const encoded = yield* encodeCredential({
        apiKey: input.kind === "save" ? input.apiKey : null,
      }).pipe(Effect.mapError(() => new L.LinearError({ reason: "storage" })));
      yield* fs
        .writeFileString(temp, encoded, { mode: 0o600 })
        .pipe(Effect.mapError(() => new L.LinearError({ reason: "storage" })));
      yield* fs
        .rename(temp, credentialPath)
        .pipe(Effect.mapError(() => new L.LinearError({ reason: "storage" })));
    }
    return yield* connection();
  }, credentialLock.withPermit);
  const all = Effect.fn("LinearService.all")(function* <A>(
    field: string,
    fields: string,
    schema: Schema.Codec<A>,
    teamId?: string,
  ) {
    const result: Array<A> = [];
    let after: string | null = null;
    do {
      const selection = `${field}(first:100,after:$after) { nodes { ${fields} } ${Q.pageFields} }`;
      const query = `query LinearDirectory($after:String${teamId ? ",$id:String!" : ""}) { ${teamId ? `result:team(id:$id) { items:${selection} }` : `result:${selection}`} }`;
      const pageSchema = Schema.Struct({ nodes: Schema.Array(schema), pageInfo: L.LinearPageInfo });
      const page: {
        readonly nodes: ReadonlyArray<A>;
        readonly pageInfo: typeof L.LinearPageInfo.Type;
      } = teamId
        ? (yield* request(query, { after, id: teamId }, Schema.Struct({ items: pageSchema }))).items
        : yield* request(query, { after }, pageSchema);
      result.push(...page.nodes);
      if (!page.pageInfo.hasNextPage) break;
      if (!page.pageInfo.endCursor || page.pageInfo.endCursor === after)
        return yield* new L.LinearError({ reason: "invalid-response" });
      after = page.pageInfo.endCursor;
    } while (true);
    return result;
  });
  const workspace = Effect.fn("LinearService.workspace")(function* () {
    const base = yield* request(
      `{ result:organization { id name urlKey } }`,
      {},
      L.LinearWorkspace.fields.organization,
    );
    const viewer = yield* request(`{ result:viewer { ${Q.personFields} } }`, {}, L.LinearPerson);
    const teams = yield* all("teams", Q.teamFields, L.LinearTeam);
    const users = yield* all("users", Q.personFields, L.LinearPerson);
    const projectStatuses = yield* all("projectStatuses", Q.stateFields, L.LinearState);
    return { organization: base, viewer, teams, users, projectStatuses };
  });
  const teamContext = Effect.fn("LinearService.teamContext")(function* ({
    id,
  }: typeof L.LinearIdInput.Type) {
    const states = yield* all("states", Q.stateFields, L.LinearState, id);
    const labels = yield* all("labels", "id name color", L.LinearLabel, id);
    const cycles = yield* all("cycles", Q.cycleFields, L.LinearCycle, id);
    const projects = yield* all("projects", Q.projectFields, L.LinearProjectSummary, id);
    return { states, labels, cycles, projects };
  });
  const issues = Effect.fn("LinearService.issues")(function* (
    input: typeof L.LinearIssuesInput.Type,
  ) {
    const viewer =
      input.view === "mine" || input.view === "created" || input.view === "subscribed"
        ? yield* request("{ result:viewer { id } }", {}, Schema.Struct({ id: Schema.String }))
        : null;
    const searching = Boolean(input.query?.trim());
    const query = `query LinearIssues($filter:IssueFilter,$after:String,$archived:Boolean${searching ? ",$term:String!" : ""}) { result:${searching ? "searchIssues(term:$term," : "issues("}first:50,after:$after,filter:$filter,includeArchived:$archived${searching ? "" : ",orderBy:updatedAt"}) { nodes { ${Q.issueFields} } ${Q.pageFields} } }`;
    return yield* request(
      query,
      {
        filter: Q.linearIssueFilter(input, viewer?.id ?? ""),
        after: input.after,
        archived: input.includeArchived ?? false,
        ...(searching ? { term: input.query?.trim() } : {}),
      },
      L.LinearIssuePage,
    );
  });
  const issue = Effect.fn("LinearService.issue")((input: typeof L.LinearIdInput.Type) =>
    request(
      `query LinearIssue($id:String!) { result:issue(id:$id) { ${Q.issueDetailFields} } }`,
      input,
      L.LinearIssueDetail,
    ),
  );
  const comments = Effect.fn("LinearService.comments")(function* (
    input: typeof L.LinearCommentsInput.Type,
  ) {
    const answer = yield* request(
      `query LinearComments($id:String!,$after:String) { result:issue(id:$id) { comments(first:50,after:$after) { nodes { ${Q.commentFields} } ${Q.pageFields} } } }`,
      input,
      Schema.Struct({ comments: L.LinearCommentsPage }),
    );
    return answer.comments;
  });
  const projects = Effect.fn("LinearService.projects")((input: typeof L.LinearProjectsInput.Type) =>
    request(
      `query LinearProjects($filter:ProjectFilter,$after:String) { result:projects(first:50,after:$after,filter:$filter,orderBy:updatedAt) { nodes { ${Q.projectFields} } ${Q.pageFields} } }`,
      {
        filter: input.teamId ? { accessibleTeams: { id: { eq: input.teamId } } } : {},
        after: input.after,
      },
      L.LinearProjectPage,
    ),
  );
  const project = Effect.fn("LinearService.project")((input: typeof L.LinearIdInput.Type) =>
    request(
      `query LinearProject($id:String!) { result:project(id:$id) { ${Q.projectFields} content documents(first:100) { nodes { ${Q.documentSummaryFields} } ${Q.pageFields} } projectMilestones(first:100) { nodes { id name description targetDate } } } }`,
      input,
      L.LinearProjectDetail,
    ),
  );
  const documents = Effect.fn("LinearService.documents")(
    (input: typeof L.LinearDocumentsInput.Type) =>
      request(
        `query LinearDocuments($filter:DocumentFilter,$after:String) { result:documents(first:50,after:$after,filter:$filter,orderBy:updatedAt) { nodes { ${Q.documentSummaryFields} } ${Q.pageFields} } }`,
        {
          after: input.after,
          filter: {
            ...(input.teamId ? { team: { id: { eq: input.teamId } } } : {}),
            ...(input.projectId ? { project: { id: { eq: input.projectId } } } : {}),
          },
        },
        L.LinearDocumentPage,
      ),
  );
  const document = Effect.fn("LinearService.document")((input: typeof L.LinearIdInput.Type) =>
    request(
      `query LinearDocument($id:String!) { result:document(id:$id) { ${Q.documentFields} } }`,
      input,
      L.LinearDocument,
    ),
  );
  const inbox = Effect.fn("LinearService.inbox")(function* (input: typeof L.LinearInboxInput.Type) {
    const now = yield* Clock.currentTimeMillis;
    return yield* request(
      `query LinearInbox($after:String,$includeArchived:Boolean) { result:notifications(first:50,after:$after,includeArchived:$includeArchived,orderBy:createdAt) { nodes { id type title subtitle url createdAt readAt archivedAt snoozedUntilAt ... on ProjectNotification { project { id } } ... on DocumentNotification { documentId } ... on IssueNotification { issue { id identifier title } } } ${Q.pageFields} } }`,
      { after: input.after, includeArchived: input.archived ?? false },
      L.LinearInboxPage,
    ).pipe(
      Effect.map((page) => ({
        ...page,
        nodes: page.nodes.filter(
          (notification) =>
            (input.archived
              ? notification.archivedAt !== null
              : notification.archivedAt === null) &&
            (input.snoozed
              ? notification.snoozedUntilAt !== null &&
                Date.parse(notification.snoozedUntilAt) > now
              : notification.snoozedUntilAt === null ||
                Date.parse(notification.snoozedUntilAt) <= now) &&
            (!input.unreadOnly || notification.readAt === null),
        ),
      })),
    );
  });
  const upload = Effect.fn("LinearService.upload")(function* (
    input: typeof L.LinearUploadInput.Type,
  ) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64))
      return yield* new L.LinearError({ reason: "invalid-response" });
    const bytes = NodeBuffer.Buffer.from(input.base64, "base64");
    if (bytes.length > 8 * 1024 * 1024)
      return yield* new L.LinearError({ reason: "invalid-response" });
    const ticket = yield* request(
      `mutation LinearUpload($filename:String!,$contentType:String!,$size:Int!) { result:fileUpload(filename:$filename,contentType:$contentType,size:$size,makePublic:false) { success uploadFile { uploadUrl assetUrl headers { key value } } } }`,
      { filename: input.filename, contentType: input.contentType, size: bytes.length },
      Schema.Struct({
        success: Schema.Boolean,
        uploadFile: Schema.NullOr(
          Schema.Struct({
            uploadUrl: Schema.String,
            assetUrl: Schema.String,
            headers: Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })),
          }),
        ),
      }),
    );
    if (!ticket.success || !ticket.uploadFile) return yield* new L.LinearError({ reason: "api" });
    const file = ticket.uploadFile;
    const response = yield* http
      .execute(
        HttpClientRequest.put(file.uploadUrl).pipe(
          HttpClientRequest.setHeaders(
            Object.fromEntries(file.headers.map((header) => [header.key, header.value])),
          ),
          HttpClientRequest.bodyUint8Array(bytes, input.contentType),
        ),
      )
      .pipe(
        Effect.timeout("60 seconds"),
        Effect.mapError(() => new L.LinearError({ reason: "network" })),
      );
    if (response.status < 200 || response.status >= 300)
      return yield* new L.LinearError({ reason: "api" });
    return { assetUrl: file.assetUrl };
  }, Effect.scoped);
  const mutate = Effect.fn("LinearService.mutate")(function* (input: L.LinearMutationInput) {
    const resolveIssueId = (id: string) =>
      request(
        "query LinearResolve($id:String!) { result:issue(id:$id) { id } }",
        { id },
        Schema.Struct({ id: Schema.String }),
      ).pipe(Effect.map((issue) => issue.id));
    if (input.kind === "issueRelationCreate")
      input = {
        ...input,
        input: {
          ...input.input,
          relatedIssueId: yield* resolveIssueId(input.input.relatedIssueId),
        },
      };
    if ((input.kind === "issueCreate" || input.kind === "issueUpdate") && input.input.parentId) {
      const original = input;
      const parentId = yield* resolveIssueId(input.input.parentId);
      input =
        original.kind === "issueCreate"
          ? { ...original, input: { ...original.input, parentId } }
          : { ...original, input: { ...original.input, parentId } };
    }
    const operation = Q.linearMutation(input);
    const result = yield* request(operation.query, operation.variables, Q.MutationAnswer);
    if (!result.success) return yield* new L.LinearError({ reason: "api" });
    return { success: true, id: result.entity?.id ?? null };
  });
  return LinearService.of({
    connection,
    configure,
    upload,
    workspace,
    teamContext,
    issues,
    issue,
    comments,
    projects,
    project,
    document,
    documents,
    inbox,
    mutate,
  });
});
export const layer = Layer.effect(LinearService, make);
