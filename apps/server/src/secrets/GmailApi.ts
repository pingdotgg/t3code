import {
  GMAIL_MAX_MESSAGES,
  GMAIL_SUMMARY_MAX_LENGTH,
  type GmailMessageSummary,
  type GmailReadOperation,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

export interface GmailClientRegistration {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly revision: string;
}

export interface GmailGrant {
  readonly account: string;
  readonly refreshToken: string;
  readonly clientId: string;
}

const messages = {
  authorization:
    "Google did not authorize Gmail. Check this entry’s Web application credentials and redirect URI in Settings, then reconnect.",
  scope:
    "The Gmail connection must have only the Gmail read-only permission. Reconnect it in Settings.",
  profile: "Google did not return a valid Gmail account address.",
  unavailable: "Google could not complete the Gmail request. Try again later.",
  invalid: "Google returned an invalid Gmail response.",
  operation: "Select Inbox or Spam and between 1 and 20 messages.",
  timeout: "The Gmail request timed out. Try again.",
} as const;

export class GmailApiError extends Schema.TaggedError<GmailApiError>()("GmailApiError", {
  code: Schema.Literals(
    Object.keys(messages) as [keyof typeof messages, ...(keyof typeof messages)[]],
  ),
}) {
  override get message() {
    return messages[this.code];
  }
}

const error = (code: keyof typeof messages) => new GmailApiError({ code });
const readScope = "https://www.googleapis.com/auth/gmail.readonly";
const tokenEndpoint = "https://oauth2.googleapis.com/token";
const mailbox = "https://gmail.googleapis.com/gmail/v1/users/me";
const maxListPages = 5;
const deadline = Effect.timeoutOrElse({
  duration: "30 seconds",
  orElse: () => Effect.fail(error("timeout")),
});

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const decodeResponse = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

// The HTTP scope covers both headers and body. Closing it also aborts unread error responses.
// Never propagate raw HTTP or schema errors: they can retain credentials or private response text.
const requestJson = Effect.fnUntraced(
  function* (request: HttpClientRequest.HttpClientRequest, allowMissing = false) {
    const client = HttpClient.withScope(yield* HttpClient.HttpClient);
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(() => error("unavailable")));
    const { status } = response;
    if (allowMissing && status === 404) return null;
    if (status < 200 || status >= 300) {
      return yield* error(
        status === 401 || status === 403 || (request.url === tokenEndpoint && status === 400)
          ? "authorization"
          : "unavailable",
      );
    }
    // The fetch backend buffers response.json without a byte limit. Enforce the cap on the
    // decoded wire stream before collecting text, even for compressed or chunked responses.
    let bytes = 0;
    return yield* response.stream.pipe(
      Stream.mapEffect((chunk) => {
        bytes += chunk.byteLength;
        return bytes > 96 * 1024 ? Effect.fail(error("invalid")) : Effect.succeed(chunk);
      }),
      Stream.decodeText(),
      Stream.mkString,
      Effect.flatMap(decodeResponse),
      Effect.mapError(() => error("invalid")),
    );
  },
  Effect.scoped,
  Effect.provideService(FetchHttpClient.RequestInit, {
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
  }),
  Effect.withTracerEnabled(false),
);

function tokens(form: URLSearchParams, refreshing: boolean) {
  return requestJson(
    HttpClientRequest.bodyUrlParams(HttpClientRequest.post(tokenEndpoint), form),
  ).pipe(
    Effect.flatMap((json) => {
      if (
        !json ||
        typeof json.access_token !== "string" ||
        !/^[\x21-\x7e]{1,8192}$/u.test(json.access_token) ||
        typeof json.token_type !== "string" ||
        json.token_type.toLowerCase() !== "bearer"
      ) {
        return Effect.fail(error("authorization"));
      }
      // RFC 6749 §§5.1, 6: omitting scope on an unscoped refresh means it is unchanged.
      // Only grants with an explicitly verified *exact* initial scope can enter the vault.
      if (!(refreshing && json.scope === undefined) && json.scope !== readScope) {
        return Effect.fail(error("scope"));
      }
      return Effect.succeed({ access: json.access_token, refresh: json.refresh_token });
    }),
  );
}

const readJson = (url: string | URL, access: string, allowMissing = false) =>
  requestJson(HttpClientRequest.bearerToken(HttpClientRequest.get(url), access), allowMissing);

export const exchangeGmailCode = Effect.fnUntraced(
  function* (
    input: { readonly code: string; readonly verifier: string },
    client: GmailClientRegistration,
  ) {
    const token = yield* tokens(
      new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        code_verifier: input.verifier,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: client.redirectUri,
      }),
      false,
    );
    if (typeof token.refresh !== "string" || !/^[\x21-\x7e]{1,8192}$/u.test(token.refresh))
      return yield* error("authorization");
    const profile = yield* readJson(`${mailbox}/profile?fields=emailAddress`, token.access);
    const account = profile?.emailAddress;
    if (
      typeof account !== "string" ||
      account.length > 254 ||
      !/^[^\s@<>(),;:\p{C}]+@(?:[\w-]+\.)+[\w-]+$/u.test(account)
    ) {
      return yield* error("profile");
    }
    return { account, clientId: client.clientId, refreshToken: token.refresh } satisfies GmailGrant;
  },
  Effect.provide(FetchHttpClient.layer),
  deadline,
);

const previewText = (value: unknown, max: number) =>
  typeof value === "string"
    ? value
        .slice(0, max)
        .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
        .trim()
    : "";

const readMessage = Effect.fnUntraced(function* (id: string, label: string, access: string) {
  const url = new URL(`${mailbox}/messages/${id}`);
  url.searchParams.set("format", "metadata");
  url.searchParams.set("fields", "internalDate,labelIds,snippet,payload/headers(name,value)");
  for (const name of ["From", "Subject", "Date"]) url.searchParams.append("metadataHeaders", name);
  const json = yield* readJson(url, access, true);
  // A message may disappear or move between list and get. The card approved just this folder.
  if (!json || !Array.isArray(json.labelIds) || !json.labelIds.includes(label)) return null;
  const received =
    typeof json.internalDate === "string" && /^\d{1,15}$/u.test(json.internalDate)
      ? Number(json.internalDate)
      : NaN;
  if (!Number.isSafeInteger(received)) return yield* error("invalid");
  let snippet = json.snippet;
  if (snippet === undefined) {
    // Gmail can omit the preview for METADATA. Ask for just the snippet and folder membership;
    // even with format=full the partial-response mask excludes bodies, headers and attachments.
    const preview = yield* readJson(
      `${mailbox}/messages/${id}?format=full&fields=labelIds,snippet`,
      access,
      true,
    );
    if (!preview || !Array.isArray(preview.labelIds) || !preview.labelIds.includes(label))
      return null;
    snippet = preview.snippet;
  }
  const headers =
    isObject(json.payload) && Array.isArray(json.payload.headers) ? json.payload.headers : [];
  const header = (name: string, cap: number) => {
    const match: unknown = headers.find(
      (h: unknown) => isObject(h) && typeof h.name === "string" && h.name.toLowerCase() === name,
    );
    return previewText(isObject(match) ? match.value : undefined, cap);
  };
  const message: GmailMessageSummary = {
    from: header("from", GMAIL_SUMMARY_MAX_LENGTH.from),
    subject: header("subject", GMAIL_SUMMARY_MAX_LENGTH.subject),
    date:
      header("date", GMAIL_SUMMARY_MAX_LENGTH.date) ||
      DateTime.formatIso(DateTime.makeUnsafe(received)),
    snippet: previewText(snippet, GMAIL_SUMMARY_MAX_LENGTH.snippet),
  };
  return { received, message };
});

export const listRecentGmail = Effect.fn("GmailApi.listRecentGmail")(
  function* (
    grant: GmailGrant,
    op: GmailReadOperation,
    client: GmailClientRegistration,
  ): Effect.fn.Return<ReadonlyArray<GmailMessageSummary>, GmailApiError> {
    if (
      (op.folder !== "inbox" && op.folder !== "spam") ||
      !Number.isInteger(op.limit) ||
      op.limit < 1 ||
      op.limit > GMAIL_MAX_MESSAGES
    ) {
      return yield* error("operation");
    }
    if (client.clientId !== grant.clientId) return yield* error("authorization");
    const token = yield* tokens(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: grant.refreshToken,
      }),
      true,
    );
    const label = op.folder === "inbox" ? "INBOX" : "SPAM";
    const url = new URL(`${mailbox}/messages`);
    url.searchParams.set("labelIds", label);
    if (label === "SPAM") url.searchParams.set("includeSpamTrash", "true");
    url.searchParams.set("fields", "messages/id,nextPageToken");
    const rows: Array<{ received: number; message: GmailMessageSummary }> = [];
    const seenIds = new Set<string>();
    const continuations = new Set<string>();
    for (;;) {
      const remaining = op.limit - rows.length;
      url.searchParams.set("maxResults", String(remaining));
      const page = yield* readJson(url, token.access);
      const candidates = page?.messages === undefined ? [] : page.messages;
      if (!Array.isArray(candidates) || candidates.length > remaining)
        return yield* error("invalid");
      const ids: string[] = [];
      for (const item of candidates) {
        if (
          !isObject(item) ||
          typeof item.id !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/u.test(item.id)
        )
          return yield* error("invalid");
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          ids.push(item.id);
        }
      }
      const fetched = yield* Effect.forEach(ids, (id) => readMessage(id, label, token.access), {
        concurrency: 4,
      });
      for (const row of fetched) if (row !== null) rows.push(row);
      const next = page?.nextPageToken;
      if (rows.length === op.limit || next === undefined) break;
      if (typeof next !== "string" || !next || next.length > 4096 || continuations.has(next))
        return yield* error("invalid");
      // Mailbox churn is not proof that the folder has fewer messages than requested.
      if (continuations.size + 1 >= maxListPages) return yield* error("unavailable");
      continuations.add(next);
      url.searchParams.set("pageToken", next);
    }
    return rows.sort((a, b) => b.received - a.received).map((row) => row.message);
  },
  Effect.provide(FetchHttpClient.layer),
  deadline,
);
