// @effect-diagnostics nodeBuiltinImport:off -- the received archive is written and removed with plain filesystem calls.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type ProjectId,
  WorkFilesApplied,
  type WorkFilesReceiveInput,
  type WorkFilesReceiveResult,
  type WorkFilesSummary,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PayloadSigner from "../auth/PayloadSigner.ts";
import { base64UrlDecodeUtf8, base64UrlEncode } from "../auth/utils.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PeerLinks from "./PeerLinks.ts";
import {
  applyWorkFiles,
  archiveStream,
  gitHead,
  selectWorkFiles,
  WORK_FILES_MAX_ARCHIVE_BYTES,
  WorkFilesError,
  type WorkFilesSelection,
} from "./WorkFiles.ts";

export const WORK_FILES_RECEIVE_ROUTE_PREFIX = "/api/work-files/receive";
const RECEIVE_TICKET_TTL_MS = 5 * 60_000;

const ReceiveClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("work-files-receive"),
  receiveId: Schema.String,
  expiresAt: Schema.Number,
});
const receiveClaimsJson = Schema.fromJsonString(ReceiveClaims);
const decodeReceiveClaims = Schema.decodeUnknownOption(receiveClaimsJson);
const encodeReceiveClaims = Schema.encodeSync(receiveClaimsJson);
const isWorkFilesError = Schema.is(WorkFilesError);
const appliedJson = Schema.fromJsonString(WorkFilesApplied);
const decodeApplied = Schema.decodeUnknownOption(appliedJson);
const encodeApplied = Schema.encodeSync(appliedJson);

function claimsOf(payload: string) {
  try {
    return Option.getOrNull(decodeReceiveClaims(base64UrlDecodeUtf8(payload)));
  } catch {
    return null;
  }
}

interface PendingReceive {
  readonly root: string;
  readonly head: string | null;
  readonly deletions: ReadonlyArray<string>;
  /** The link session that asked; only it may upload. */
  readonly sessionId: string;
  readonly expiresAt: number;
}

export interface ReceiveResponse {
  readonly status: number;
  readonly body: string;
}

export const summaryOf = (selection: WorkFilesSelection): WorkFilesSummary => ({
  directory: selection.root,
  fileCount: selection.files.length,
  totalBytes: selection.totalBytes,
  deletionCount: selection.deletions.length,
  leftBehindCount: selection.leftBehind.length,
  refusal: selection.refusal,
});

const transferFailure = (message: string) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message });

/**
 * Carries a thread's working files to a project's checkout in a linked
 * environment. The source streams a gzip tar over the link to a one-time
 * upload the target issued; the target checks and applies it, and neither
 * side keeps the archive.
 */
export class WorkFilesTransfer extends Context.Service<
  WorkFilesTransfer,
  {
    /** The files `cwd` would carry, with any limit it breaks. */
    readonly select: (cwd: string) => Effect.Effect<WorkFilesSelection, WorkFilesError>;
    /**
     * Sends the work files at `cwd` to `projectId` in `environmentId`. `receive`
     * asks that environment for the upload, through the caller's own route there.
     * A selection with nothing to carry sends nothing.
     */
    readonly send: (input: {
      readonly cwd: string;
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly receive: (
        request: WorkFilesReceiveInput,
      ) => Effect.Effect<WorkFilesReceiveResult, OrchestratorMcpFailure>;
    }) => Effect.Effect<WorkFilesApplied, OrchestratorMcpFailure>;
    /** Here as the target: a one-time upload into `projectId`'s checkout for link session `sessionId`. */
    readonly issueReceive: (input: {
      readonly request: WorkFilesReceiveInput;
      readonly sessionId: string;
    }) => Effect.Effect<WorkFilesReceiveResult, OrchestratorMcpFailure>;
    /** Here as the target: checks and applies an upload `issueReceive` allowed. */
    readonly receive: (input: {
      readonly token: string;
      readonly sessionId: string;
      readonly body: Stream.Stream<Uint8Array, Error>;
    }) => Effect.Effect<ReceiveResponse>;
  }
>()("t3/peer/WorkFilesTransfer") {}

/** Streams `body` into `path`; false when it passes `maxBytes`, without reading the rest. */
const writeCapped = (body: Stream.Stream<Uint8Array, Error>, path: string, maxBytes: number) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.createWriteStream(path, { flags: "wx" })),
    (file) =>
      Effect.gen(function* () {
        let received = 0;
        let over = false;
        yield* body.pipe(
          Stream.takeWhile((chunk) => {
            received += chunk.byteLength;
            over = received > maxBytes;
            return !over;
          }),
          Stream.runForEach((chunk) =>
            Effect.callback<void, Error>((resume) => {
              file.write(chunk, (error) => {
                resume(error ? Effect.fail(error) : Effect.void);
              });
            }),
          ),
        );
        return !over;
      }),
    (file) =>
      Effect.callback<void>((resume) => {
        file.end(() => resume(Effect.void));
      }),
  );

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectService.ProjectService;
  const links = yield* PeerLinks.PeerLinks;
  const httpClient = yield* HttpClient.HttpClient;
  const random = yield* SecureRandom.SecureRandom;
  const signer = yield* PayloadSigner.make("work-files-receive-signing-key");
  const processes = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
  const pending = new Map<string, PendingReceive>();
  const receiveDir = NodePath.join(config.stateDir, "work-files");

  const select: WorkFilesTransfer["Service"]["select"] = (cwd) =>
    selectWorkFiles(cwd).pipe(Effect.provideContext(processes));

  const send: WorkFilesTransfer["Service"]["send"] = Effect.fn("WorkFilesTransfer.send")(
    function* (input) {
      const selection = yield* select(input.cwd).pipe(
        Effect.mapError((error) => transferFailure(error.message)),
      );
      if (selection.refusal !== null) return yield* transferFailure(selection.refusal);
      if (selection.files.length === 0 && selection.deletions.length === 0) {
        return { files: 0, deletions: 0 };
      }
      const ticket = yield* input.receive({
        projectId: input.projectId,
        head: selection.head,
        deletions: selection.deletions,
      });
      const resolved = yield* links
        .resolve(input.environmentId)
        .pipe(Effect.mapError((error) => transferFailure(error.message)));
      const body = archiveStream(
        selection.root,
        selection.files.map((file) => file.path),
      ).pipe(Stream.provideContext(processes));
      const response = yield* httpClient
        .execute(
          HttpClientRequest.post(`${resolved.url}${ticket.relativeUrl}`).pipe(
            HttpClientRequest.setHeaders({ authorization: `Bearer ${resolved.token}` }),
            HttpClientRequest.setBody(HttpBody.stream(body, "application/gzip")),
          ),
        )
        .pipe(
          Effect.mapError(() =>
            transferFailure(
              "The work files could not be sent; the linked environment stopped answering.",
            ),
          ),
        );
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      if (response.status !== 200) {
        return yield* transferFailure(
          text.length > 0
            ? `The linked environment refused the work files: ${text}`
            : `The linked environment refused the work files (HTTP ${response.status}).`,
        );
      }
      return yield* Effect.fromOption(decodeApplied(text)).pipe(
        Effect.mapError(() =>
          transferFailure("The linked environment answered in an unexpected shape."),
        ),
      );
    },
  );

  const issueReceive: WorkFilesTransfer["Service"]["issueReceive"] = Effect.fn(
    "WorkFilesTransfer.issueReceive",
  )(function* ({ request, sessionId }) {
    const project = yield* projects.getById(request.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    if (project === undefined || project.deletedAt !== null) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Project ${request.projectId} was not found here.`,
      });
    }
    const root = project.workspaceRoot;
    // Refused before any bytes move; applying checks again.
    if (request.head !== null) {
      const head = yield* gitHead(root).pipe(
        Effect.provideContext(processes),
        Effect.mapError((error) => transferFailure(error.message)),
      );
      if (head !== request.head) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            head === null
              ? "The files come from a git checkout, but the project's checkout here is not a git repository."
              : `The checkout here is at ${head || "no commit"}, but the files apply to ${request.head || "no commit"}. Check out the same commit here first.`,
        });
      }
    }
    const now = yield* Clock.currentTimeMillis;
    for (const [id, entry] of pending) if (entry.expiresAt <= now) pending.delete(id);
    const receiveId = (yield* random.uuidV4()).replaceAll("-", "");
    const expiresAt = now + RECEIVE_TICKET_TTL_MS;
    pending.set(receiveId, {
      root,
      head: request.head,
      deletions: request.deletions,
      sessionId,
      expiresAt,
    });
    const payload = base64UrlEncode(
      encodeReceiveClaims({ version: 1, kind: "work-files-receive", receiveId, expiresAt }),
    );
    const signature = yield* signer
      .sign(payload)
      .pipe(Effect.mapError(() => transferFailure("Could not sign the upload.")));
    return { relativeUrl: `${WORK_FILES_RECEIVE_ROUTE_PREFIX}/${payload}.${signature}`, expiresAt };
  });

  /** The pending upload a token names, taken so it is used once. */
  const takeTicket = Effect.fn("WorkFilesTransfer.takeTicket")(function* (
    token: string,
    sessionId: string,
  ) {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) return undefined;
    const verified = yield* signer
      .verify(payload, signature)
      .pipe(Effect.orElseSucceed(() => false));
    if (!verified) return undefined;
    const claims = claimsOf(payload);
    if (claims === null) return undefined;
    const entry = pending.get(claims.receiveId);
    if (entry === undefined || entry.sessionId !== sessionId) return undefined;
    pending.delete(claims.receiveId);
    if (Math.min(entry.expiresAt, claims.expiresAt) <= (yield* Clock.currentTimeMillis)) {
      return undefined;
    }
    return { receiveId: claims.receiveId, entry };
  });

  const receive: WorkFilesTransfer["Service"]["receive"] = Effect.fn("WorkFilesTransfer.receive")(
    function* ({ token, sessionId, body }) {
      const ticket = yield* takeTicket(token, sessionId);
      if (ticket === undefined)
        return { status: 404, body: "This upload is unknown, used, or expired." };
      const archivePath = NodePath.join(receiveDir, `${ticket.receiveId}.tgz`);
      const stagingDir = NodePath.join(receiveDir, ticket.receiveId);
      const cleanup = Effect.promise(() =>
        Promise.all([
          NodeFSP.rm(archivePath, { force: true }),
          NodeFSP.rm(stagingDir, { recursive: true, force: true }),
        ]).catch(() => undefined),
      );
      return yield* Effect.gen(function* () {
        yield* Effect.promise(() => NodeFSP.mkdir(receiveDir, { recursive: true }));
        const stored = yield* writeCapped(body, archivePath, WORK_FILES_MAX_ARCHIVE_BYTES);
        if (!stored) {
          return {
            status: 413,
            body: `The archive is over the ${WORK_FILES_MAX_ARCHIVE_BYTES} byte limit.`,
          };
        }
        const applied = yield* applyWorkFiles({
          archivePath,
          stagingDir,
          root: ticket.entry.root,
          head: ticket.entry.head,
          deletions: ticket.entry.deletions,
        }).pipe(Effect.provideContext(processes));
        return { status: 200, body: encodeApplied(applied) };
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            isWorkFilesError(error)
              ? { status: error.reason === "failed" ? 500 : 409, body: error.message }
              : { status: 500, body: "The work files could not be received." },
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("work-files.receive-failed", { cause }).pipe(
            Effect.as({ status: 500, body: "The work files could not be received." }),
          ),
        ),
        Effect.ensuring(cleanup),
      );
    },
  );

  return WorkFilesTransfer.of({ select, send, issueReceive, receive });
});

export const layer = Layer.effect(WorkFilesTransfer, make);

/**
 * `POST /api/work-files/receive/<token>`: a linked environment's upload,
 * authorized by its link session with operate access and the one-time token
 * that session was issued.
 */
export const layerReceiveRoute = Layer.unwrap(
  Effect.gen(function* () {
    // Captured here: route handlers only see the server's request-level services.
    const transfer = yield* WorkFilesTransfer;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    return HttpRouter.add(
      "POST",
      `${WORK_FILES_RECEIVE_ROUTE_PREFIX}/*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const client = yield* auth.authenticateMcpClient(request).pipe(Effect.option);
        if (Option.isNone(client)) return HttpServerResponse.text("Unauthorized", { status: 401 });
        if (!client.value.peerLink || client.value.access === "read-only") {
          return HttpServerResponse.text("This link cannot change files here.", { status: 403 });
        }
        const path = request.url.split("?", 1)[0] ?? "";
        const token = path.slice(`${WORK_FILES_RECEIVE_ROUTE_PREFIX}/`.length);
        // Keep the request stream in the route scope until the response is sent.
        const bodyPull = yield* Stream.toPull(request.stream);
        const result = yield* transfer.receive({
          token,
          sessionId: client.value.sessionId,
          body: Stream.fromPull(Effect.succeed(bodyPull)),
        });
        return HttpServerResponse.text(result.body, { status: result.status });
      }),
    );
  }),
);
