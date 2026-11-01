// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * S3-compatible API for local R2 buckets, adapted from Miniflare's local S3
 * endpoint (`workers-sdk/packages/miniflare/src/workers/r2/s3/*.worker.ts`
 * and `workers/r2/serve.worker.ts`), collapsed into a single worker. Hono is
 * replaced by a small router + CORS handler.
 *
 * Runs as a fetch middleware in the entry chain: requests under
 * `/cdn-cgi/local/r2/s3` are served here, everything else is forwarded to
 * the next middleware (`UPSTREAM`). It sits after `plugin:entry`, which
 * restores the client-facing URL and `Host` from the proxy headers — SigV4
 * signs the host, so verification must see what the client signed.
 *
 * Each exposed bucket is a regular `r2Bucket` binding onto the shared `r2`
 * service, so objects written here are the same objects Worker bindings
 * read. Requests are authenticated with AWS Signature Version 4, either via
 * the `Authorization` header (S3 SDKs) or presigned URL query parameters.
 *
 * Status codes, headers, XML bodies and header screening mimic R2's S3
 * endpoint (captured upstream from a real bucket, 2026-06-11).
 *
 * ## Gaps vs real R2 (no local equivalent in the R2 binding)
 *
 * - SSE-C writes answer NotImplemented rather than storing plaintext; reads
 *   with SSE-C headers get R2's error for unencrypted objects.
 * - Non-default `x-amz-storage-class` values answer NotImplemented.
 * - Flexible checksums (`x-amz-checksum-*`) are ignored; `Content-MD5` IS
 *   verified. `aws-chunked` bodies are not decoded.
 * - ListParts, ListMultipartUploads, `?partNumber` reads and the bucket
 *   configuration surfaces answer R2's templated "<name> not implemented".
 * - CreateBucket / DeleteBucket are not implemented: a local bucket exists
 *   by being bound.
 * - Credentials are per bucket. Unknown buckets return NoSuchBucket before
 *   the signature is checked.
 * - CORS is always permissive, so browser uploads from a dev frontend work.
 *
 * workerd never answers `100 Continue`. Through the dev proxy
 * (`proxy/WorkerProxy.ts`) clients sending `Expect: 100-continue` (the AWS
 * SDK v3 in Node, for bodies of 2 MB or more) get one from the proxy;
 * connecting to workerd's own port directly, they wait out their timeout.
 */
import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";
import {
  assert,
  hexEncode,
  type Awaitable,
} from "../../internal/shared.worker.ts";
import {
  BINDING_R2_S3_BUCKETS,
  BINDING_R2_S3_UPSTREAM,
  PATH_R2_S3,
  type R2S3Bucket,
  type S3Credentials,
} from "./R2BucketOptions.shared.ts";

interface Env {
  /** JSON map of bucket id to its binding name + credentials. */
  [BINDING_R2_S3_BUCKETS]: Record<string, R2S3Bucket>;
  [BINDING_R2_S3_UPSTREAM]: Fetcher;
  [binding: string]: unknown;
}

// -----------------------------------------------------------------------------
// Request context (replaces Hono's `Context`)
// -----------------------------------------------------------------------------

interface S3Context {
  readonly env: Env;
  readonly req: {
    readonly method: string;
    readonly url: string;
    readonly raw: Request;
    header(name: string): string | undefined;
  };
}

const makeContext = (request: Request, env: Env): S3Context => ({
  env,
  req: {
    method: request.method,
    url: request.url,
    raw: request,
    header: (name) => request.headers.get(name) ?? undefined,
  },
});

const bucketBinding = (
  env: Env,
  bucketId: string,
): { bucket: R2Bucket; credentials: S3Credentials } | undefined => {
  const entry = env[BINDING_R2_S3_BUCKETS][bucketId];
  if (entry === undefined) return undefined;
  const bucket = env[entry.binding] as R2Bucket | undefined;
  assert(bucket !== undefined, `Missing R2 binding for bucket ${bucketId}`);
  return { bucket, credentials: entry.credentials };
};

// -----------------------------------------------------------------------------
// Entry: routing + CORS (`s3/index.worker.ts`)
// -----------------------------------------------------------------------------

const CORS_ALLOW_METHODS = "GET,HEAD,PUT,POST,DELETE";

function withCors(request: Request, response: Response): Response {
  // Responses from `fetch()`-like sources can have immutable headers
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Expose-Headers", "*");
  if (request.headers.get("Origin") !== null) {
    headers.append("Vary", "Origin");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function preflight(request: Request): Response {
  const headers = new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
  });
  const requested = request.headers.get("Access-Control-Request-Headers");
  if (requested !== null) {
    headers.set("Access-Control-Allow-Headers", requested);
    headers.append("Vary", "Access-Control-Request-Headers");
  }
  return new Response(null, { status: 204, headers });
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      url.pathname !== PATH_R2_S3 &&
      !url.pathname.startsWith(`${PATH_R2_S3}/`)
    ) {
      return env[BINDING_R2_S3_UPSTREAM].fetch(request);
    }
    if (request.method === "OPTIONS") {
      return preflight(request);
    }
    const c = makeContext(request, env);
    const rest = url.pathname.slice(PATH_R2_S3.length).replace(/^\//, "");
    let response: Response;
    if (rest === "") {
      response = await listBuckets(c);
    } else {
      const separator = rest.indexOf("/");
      const bucketId = safeDecode(
        separator === -1 ? rest : rest.slice(0, separator),
      );
      const rawKey = separator === -1 ? "" : rest.slice(separator + 1);
      response = await dispatch(
        c,
        bucketId,
        rawKey === "" ? undefined : safeDecode(rawKey),
      );
    }
    return withCors(request, response);
  },
} satisfies ExportedHandler<Env>;

// -----------------------------------------------------------------------------
// XML + shared helpers (`s3/common.worker.ts`, `s3/errors.worker.ts`)
// -----------------------------------------------------------------------------

/** HEAD responses must not include a body */
function stripBodyForHead(c: S3Context, response: Response): Response {
  return c.req.method === "HEAD" && response.body !== null
    ? new Response(null, response)
    : response;
}

const XMLNS = "http://s3.amazonaws.com/doc/2006-03-01/";
const MAX_LIST_KEYS = 1000;
const MAX_DELETE_KEYS = 1000;

const xmlBuilder = new XMLBuilder({ ignoreAttributes: false });
const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
});

function xmlResponse(
  root: string,
  content: Record<string, unknown>,
  status = 200,
): Response {
  const body = `<?xml version="1.0" encoding="UTF-8"?>${xmlBuilder.build({
    [root]: { "@_xmlns": XMLNS, ...content },
  })}`;
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/xml" },
  });
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return hexEncode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

function coerceArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * https://docs.aws.amazon.com/AmazonS3/latest/API/ErrorResponses.html
 * Unlike success documents, R2's <Error> documents carry no xmlns.
 * `extraFields` are appended after <Message> in entry order (e.g.
 * SignatureDoesNotMatch's debug fields). Hand-built because R2 escapes `'`
 * as `&apos;`, which fast-xml-parser does not reproduce.
 */
function errorResponse(
  status: number,
  code: string,
  message: string,
  extraFields: Record<string, string> = {},
): Response {
  const extra = Object.entries(extraFields)
    .map(([name, value]) => `<${name}>${xmlEscape(value)}</${name}>`)
    .join("");
  const body = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message>${extra}</Error>`;
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/xml" },
  });
}

const noSuchBucket = () =>
  errorResponse(404, "NoSuchBucket", "The specified bucket does not exist.");

const notImplemented = (message: string) =>
  errorResponse(501, "NotImplemented", message);

const routeNotFound = () =>
  errorResponse(404, "RouteNotFound", "No route matches this url.");

// -----------------------------------------------------------------------------
// SigV4 verification (`s3/auth.worker.ts`)
//
// Implements both authentication methods: the `Authorization` header and
// presigned URL query parameters. The S3 canonical URI is the request path
// used verbatim (single-encoded). Error codes, messages and check order mimic
// R2 (`InvalidArgument`/`InvalidRequest` for malformed auth, 401 for unknown
// access keys, 403 `SignatureDoesNotMatch` with debug fields, 403
// `ExpiredRequest` for expired presigned URLs).
// -----------------------------------------------------------------------------

const ALGORITHM = "AWS4-HMAC-SHA256";
const MAX_EXPIRES_SECONDS = 604_800;
const MAX_SKEW_MILLIS = 15 * 60 * 1000;

const encoder = new TextEncoder();

async function sha256Hex(data: BufferSource): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", data));
}

async function hmac(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

/**
 * AWS `UriEncode`: percent-encode everything except RFC 3986 unreserved
 * characters, with uppercase hex.
 */
function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const invalidArgument = (message: string) =>
  errorResponse(400, "InvalidArgument", message);

const unauthorized = () => errorResponse(401, "Unauthorized", "Unauthorized");

function byteDump(value: string): string {
  return Array.from(encoder.encode(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join(" ");
}

interface ComputedSignature {
  signature: string;
  canonicalRequest: string;
  stringToSign: string;
}

function signatureDoesNotMatch(
  computed: ComputedSignature,
  provided: string,
): Response {
  return errorResponse(
    403,
    "SignatureDoesNotMatch",
    "The request signature we calculated does not match the signature you provided. Check your secret access key and signing method.",
    {
      StringToSign: computed.stringToSign,
      StringToSignBytes: byteDump(computed.stringToSign),
      CanonicalRequest: computed.canonicalRequest,
      CanonicalRequestBytes: byteDump(computed.canonicalRequest),
      SignatureProvided: provided,
    },
  );
}

const unsupportedAlgorithm = () =>
  errorResponse(400, "InvalidRequest", `Please use ${ALGORITHM}`);

interface ParsedCredential {
  accessKeyId: string;
  date: string;
  region: string;
  service: string;
}

/**
 * Parses `<access-key-id>/<yyyymmdd>/<region>/<service>/aws4_request`,
 * validating in R2's order: part count, service, termination string.
 */
function parseCredential(
  credential: string,
): ParsedCredential | { error: Response } {
  const parts = credential.split("/");
  if (parts.length < 5) {
    return {
      error: invalidArgument(
        `Credential sigv4 header should have at least 5 slash-separated parts, not ${parts.length}`,
      ),
    };
  }
  // R2 treats everything before the last four parts as the access key
  const accessKeyId = parts.slice(0, -4).join("/");
  const [date, region, service, terminator] = parts.slice(-4);
  if (service !== "s3") {
    return {
      error: invalidArgument(`Credential service should be s3, not ${service}`),
    };
  }
  if (terminator !== "aws4_request") {
    return {
      error: invalidArgument(
        `Credential termination string should be aws4_request, not ${terminator}`,
      ),
    };
  }
  if (date === undefined || region === undefined) {
    return { error: unauthorized() };
  }
  return { accessKeyId, date, region, service };
}

/** Dates must strictly be basic ISO 8601 format */
function parseAmzDate(value: string): Date | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ),
  );
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Canonical query string: each name and value `UriEncode`d, sorted by
 * encoded name (then value). Presigned requests exclude `X-Amz-Signature`.
 */
function canonicalQueryString(url: URL, excludeSignature: boolean): string {
  const params: Array<[string, string]> = [];
  for (const [name, value] of url.searchParams) {
    if (excludeSignature && name === "X-Amz-Signature") continue;
    params.push([awsUriEncode(name), awsUriEncode(value)]);
  }
  params.sort(([name1, value1], [name2, value2]) => {
    if (name1 !== name2) return name1 < name2 ? -1 : 1;
    return value1 < value2 ? -1 : value1 > value2 ? 1 : 0;
  });
  return params.map(([name, value]) => `${name}=${value}`).join("&");
}

/**
 * Canonical headers: lowercase name, `:`, trimmed value with sequential
 * spaces collapsed. Repeated headers can't be recovered from `Headers`, so
 * signing one produces a mismatch (same as upstream).
 */
function canonicalHeaders(
  request: Request,
  url: URL,
  signedHeaders: Array<string>,
): string {
  let result = "";
  for (const name of signedHeaders) {
    const value =
      request.headers.get(name) ?? (name === "host" ? url.host : "");
    result += `${name}:${value.trim().replace(/ +/g, " ")}\n`;
  }
  return result;
}

/**
 * Candidate canonical URIs. AWS SDKs percent-encode every reserved character
 * in the request path, so the path IS the canonical URI (upstream's
 * behavior). Other signers (aws4fetch, `@distilled.cloud/aws`) canonicalize
 * the decoded path per segment while sending some reserved characters raw
 * (e.g. the `:` in a `dev:` bucket id), so the segment-normalized path is
 * accepted too.
 */
function canonicalUris(url: URL): Array<string> {
  const normalized = url.pathname
    .split("/")
    .map((segment) => awsUriEncode(safeDecode(segment)))
    .join("/");
  return normalized === url.pathname
    ? [url.pathname]
    : [url.pathname, normalized];
}

async function computeSignature(
  request: Request,
  url: URL,
  canonicalUri: string,
  secretAccessKey: string,
  credential: ParsedCredential,
  amzDate: string,
  signedHeaders: Array<string>,
  payloadHash: string,
  presigned: boolean,
): Promise<ComputedSignature> {
  const canonicalRequest = [
    request.method,
    canonicalUri,
    canonicalQueryString(url, presigned),
    canonicalHeaders(request, url, signedHeaders),
    signedHeaders.join(";"),
    payloadHash,
  ].join("\n");

  const scope = `${credential.date}/${credential.region}/${credential.service}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    await sha256Hex(encoder.encode(canonicalRequest)),
  ].join("\n");

  let key = await hmac(
    encoder.encode(`AWS4${secretAccessKey}`),
    credential.date,
  );
  key = await hmac(key, credential.region);
  key = await hmac(key, credential.service);
  key = await hmac(key, "aws4_request");

  return {
    signature: hex(await hmac(key, stringToSign)),
    canonicalRequest,
    stringToSign,
  };
}

function timingSafeStringsEqual(expected: string, actual: string): boolean {
  const expectedBytes = encoder.encode(expected);
  const actualBytes = encoder.encode(actual);
  return actualBytes.byteLength === expectedBytes.byteLength
    ? crypto.subtle.timingSafeEqual(expectedBytes, actualBytes)
    : !crypto.subtle.timingSafeEqual(expectedBytes, expectedBytes);
}

/**
 * Shared scope checks: parse the credential, match its date against the
 * request date, then match the access key.
 */
function checkCredentialScope(
  credentialField: string,
  amzDate: string,
  credentials: S3Credentials,
): ParsedCredential | { error: Response } {
  const credential = parseCredential(credentialField);
  if ("error" in credential) return credential;
  if (!amzDate.startsWith(credential.date)) {
    return {
      error: invalidArgument(
        `Credential signed date ${credential.date} does not match ${amzDate.slice(0, 8)} from 'x-amz-date' header`,
      ),
    };
  }
  if (credential.accessKeyId !== credentials.accessKeyId) {
    return { error: unauthorized() };
  }
  return credential;
}

function parseSignedHeaders(
  field: string,
): Array<string> | { error: Response } {
  const signedHeaders = field.split(";").map((name) => name.toLowerCase());
  if (!signedHeaders.includes("host")) {
    return { error: unauthorized() };
  }
  return signedHeaders;
}

async function checkSignature(
  request: Request,
  url: URL,
  credentials: S3Credentials,
  credential: ParsedCredential,
  amzDate: string,
  signedHeaders: Array<string>,
  payloadHash: string,
  presigned: boolean,
  provided: string,
): Promise<Response | undefined> {
  let first: ComputedSignature | undefined;
  for (const canonicalUri of canonicalUris(url)) {
    const computed = await computeSignature(
      request,
      url,
      canonicalUri,
      credentials.secretAccessKey,
      credential,
      amzDate,
      signedHeaders,
      payloadHash,
      presigned,
    );
    if (timingSafeStringsEqual(computed.signature, provided)) return undefined;
    first ??= computed;
  }
  assert(first !== undefined);
  return signatureDoesNotMatch(first, provided);
}

async function verifyAuthorizationHeader(
  request: Request,
  url: URL,
  credentials: S3Credentials,
  authorization: string,
): Promise<Response | undefined> {
  const payloadHash = request.headers.get("x-amz-content-sha256");
  if (payloadHash === null) {
    return errorResponse(400, "InvalidRequest", "Missing x-amz-content-sha256");
  }

  let amzDate = request.headers.get("x-amz-date");
  let dateSource = "'x-amz-date' header";
  if (amzDate === null) {
    amzDate = request.headers.get("date");
    dateSource = "'date' header";
  }
  if (amzDate === null) {
    return invalidArgument("No date provided in x-amz-date nor date header");
  }
  const date = parseAmzDate(amzDate);
  if (date === undefined) {
    return invalidArgument(
      `Date provided in ${dateSource} (${amzDate}) didn't parse successfully`,
    );
  }
  if (Math.abs(Date.now() - date.getTime()) > MAX_SKEW_MILLIS) {
    return errorResponse(
      403,
      "RequestTimeTooSkewed",
      "The difference between the request time and the server's time is too large.",
    );
  }

  // `AWS4-HMAC-SHA256 Credential=<scope>, SignedHeaders=<h1;h2>, Signature=<hex>`
  const fields = new Map<string, string>();
  if (authorization.startsWith(`${ALGORITHM} `)) {
    for (const component of authorization.slice(ALGORITHM.length).split(",")) {
      const separator = component.indexOf("=");
      if (separator === -1) continue;
      fields.set(
        component.slice(0, separator).trim(),
        component.slice(separator + 1).trim(),
      );
    }
  }
  const credentialField = fields.get("Credential");
  const signedHeadersField = fields.get("SignedHeaders");
  const signatureField = fields.get("Signature");
  if (
    credentialField === undefined ||
    signedHeadersField === undefined ||
    signatureField === undefined
  ) {
    return unsupportedAlgorithm();
  }

  const credential = checkCredentialScope(
    credentialField,
    amzDate,
    credentials,
  );
  if ("error" in credential) return credential.error;

  const signedHeaders = parseSignedHeaders(signedHeadersField);
  if ("error" in signedHeaders) return signedHeaders.error;

  const mismatch = await checkSignature(
    request,
    url,
    credentials,
    credential,
    amzDate,
    signedHeaders,
    payloadHash,
    false,
    signatureField,
  );
  if (mismatch !== undefined) return mismatch;

  // A literal payload hash (rather than UNSIGNED-PAYLOAD or a streaming
  // sentinel) must match the body
  if (/^[0-9a-f]{64}$/.test(payloadHash)) {
    const body = await request.clone().arrayBuffer();
    if ((await sha256Hex(body)) !== payloadHash) {
      return errorResponse(
        400,
        "XAmzContentSHA256Mismatch",
        "The provided 'x-amz-content-sha256' header does not match what was computed.",
      );
    }
  }
  return undefined;
}

async function verifyPresigned(
  request: Request,
  url: URL,
  credentials: S3Credentials,
): Promise<Response | undefined> {
  const params = url.searchParams;

  const missing = [
    "X-Amz-Algorithm",
    "X-Amz-Signature",
    "X-Amz-Date",
    "X-Amz-SignedHeaders",
    "X-Amz-Expires",
  ].filter((name) => !params.has(name));
  if (missing.length === 1) {
    return invalidArgument(`Required search parameter ${missing[0]} missing`);
  }
  if (missing.length > 1) {
    return invalidArgument(
      `Required search parameters ${missing.join(",  ")} missing`,
    );
  }

  if (params.get("X-Amz-Algorithm") !== ALGORITHM) {
    return unsupportedAlgorithm();
  }

  const amzDate = params.get("X-Amz-Date");
  const expiresParam = params.get("X-Amz-Expires");
  const signedHeadersParam = params.get("X-Amz-SignedHeaders");
  const provided = params.get("X-Amz-Signature");
  assert(
    amzDate !== null &&
      expiresParam !== null &&
      signedHeadersParam !== null &&
      provided !== null,
  );

  const date = parseAmzDate(amzDate);
  if (date === undefined) {
    return invalidArgument(
      `Date provided in X-Amz-Date (${amzDate}) didn't parse successfully`,
    );
  }

  const credentialParam = params.get("X-Amz-Credential");
  assert(credentialParam !== null);
  const credential = checkCredentialScope(
    credentialParam,
    amzDate,
    credentials,
  );
  if ("error" in credential) return credential.error;

  // `Number("")` is 0, but an empty X-Amz-Expires must be rejected
  const expires =
    expiresParam.trim() === "" ? Number.NaN : Number(expiresParam);
  if (Number.isNaN(expires)) {
    return invalidArgument("X-Amz-Expires should be a number");
  }
  if (expires > MAX_EXPIRES_SECONDS) {
    return invalidArgument(
      `X-Amz-Expires must be less than a week (in seconds); that is, the given X-Amz-Expires must be less than ${MAX_EXPIRES_SECONDS} seconds`,
    );
  }
  if (expires < 1 || Date.now() > date.getTime() + expires * 1000) {
    return errorResponse(403, "ExpiredRequest", "Request has expired");
  }

  const signedHeaders = parseSignedHeaders(signedHeadersParam);
  if ("error" in signedHeaders) return signedHeaders.error;

  // The body is unknown at signing time
  return checkSignature(
    request,
    url,
    credentials,
    credential,
    amzDate,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
    true,
    provided,
  );
}

/** Timing-safe comparison of credential pairs */
function credentialsEqual(
  expected: S3Credentials,
  provided: S3Credentials,
): boolean {
  return (
    timingSafeStringsEqual(expected.accessKeyId, provided.accessKeyId) &&
    timingSafeStringsEqual(expected.secretAccessKey, provided.secretAccessKey)
  );
}

/** Whether the request carries either SigV4 authentication method */
function hasAuthentication(request: Request, params: URLSearchParams): boolean {
  return (
    request.headers.get("Authorization") !== null ||
    params.has("X-Amz-Credential")
  );
}

/**
 * Verifies a request against SigV4, returning an R2-style XML error
 * `Response` on failure, or `undefined` on success. The `Authorization`
 * header takes precedence over presigned query parameters.
 */
async function verifyRequest(
  request: Request,
  credentials: S3Credentials,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const authorization = request.headers.get("Authorization");
  if (authorization !== null) {
    return verifyAuthorizationHeader(request, url, credentials, authorization);
  }
  if (url.searchParams.has("X-Amz-Credential")) {
    return verifyPresigned(request, url, credentials);
  }
  return invalidArgument("Authorization");
}

// -----------------------------------------------------------------------------
// ListBuckets (`s3/account.worker.ts`)
// -----------------------------------------------------------------------------

/**
 * Verifies the request against every configured credential set, returning
 * the matching credentials or the most specific auth error.
 */
async function verifyAgainstSome(
  c: S3Context,
): Promise<{ matched: S3Credentials } | { error: Response }> {
  let error: Response | undefined;
  const seenPairs = new Set<string>();
  for (const { credentials } of Object.values(c.env[BINDING_R2_S3_BUCKETS])) {
    const pair = `${credentials.accessKeyId}\0${credentials.secretAccessKey}`;
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);

    const result = await verifyRequest(c.req.raw, credentials);
    if (result === undefined) return { matched: credentials };
    // A 401 only means this set's access key didn't match; errors from a
    // set whose key did match are the precise ones
    if (error === undefined || error.status === 401) error = result;
  }
  return { error: error ?? unauthorized() };
}

/**
 * ListBuckets is account-level: lists the buckets sharing the presented
 * credential pair.
 */
async function listBuckets(c: S3Context): Promise<Response> {
  return stripBodyForHead(c, await listBucketsInner(c));
}

async function listBucketsInner(c: S3Context): Promise<Response> {
  if (c.req.method !== "GET") return routeNotFound();

  const verified = await verifyAgainstSome(c);
  if ("error" in verified) return verified.error;
  const matched = verified.matched;

  for (const name of new URL(c.req.url).searchParams.keys()) {
    if (!isScreenedParam(name)) {
      return notImplemented(
        `ListBuckets search parameter ${name} not implemented`,
      );
    }
  }

  const buckets = Object.entries(c.env[BINDING_R2_S3_BUCKETS])
    .filter(([, { credentials }]) => credentialsEqual(credentials, matched))
    .map(([id]) => ({ Name: id }));
  return xmlResponse("ListAllMyBucketsResult", {
    Buckets: buckets.length > 0 ? { Bucket: buckets } : {},
  });
}

// -----------------------------------------------------------------------------
// Per-bucket pipeline (`s3/dispatch.worker.ts`)
// -----------------------------------------------------------------------------

async function dispatch(
  c: S3Context,
  bucketId: string,
  key: string | undefined,
): Promise<Response> {
  return stripBodyForHead(c, await dispatchInner(c, bucketId, key));
}

async function dispatchInner(
  c: S3Context,
  bucketId: string,
  key: string | undefined,
): Promise<Response> {
  const resolved = bucketBinding(c.env, bucketId);
  // Local credentials are per bucket, so an unknown bucket has nothing to
  // verify against and existence is reported first
  if (resolved === undefined) return noSuchBucket();
  const { bucket, credentials } = resolved;

  const params = new URL(c.req.url).searchParams;

  // R2 interprets an unauthenticated bucket-level POST as a browser form
  // upload (POST Object), which it recognizes but does not implement. The
  // doubled "not implemented" is R2's, verbatim.
  if (
    key === undefined &&
    c.req.method === "POST" &&
    !params.has("delete") &&
    !hasAuthentication(c.req.raw, params)
  ) {
    return notImplemented(
      "Presigned post requests are not yet implemented not implemented",
    );
  }

  const authError = await verifyRequest(c.req.raw, credentials);
  if (authError !== undefined) return authError;

  const detected = detectOperation(c, bucket, bucketId, key, params);
  if (detected instanceof Response) return detected;

  const screenError = screenHeaders(c, detected.operation, detected.rules);
  if (screenError !== undefined) return screenError;

  return detected.run();
}

interface BoundOperation {
  operation: S3Operation;
  rules: ScreeningRules;
  run(): Awaitable<Response>;
}

function detectOperation(
  c: S3Context,
  bucket: R2Bucket,
  bucketId: string,
  key: string | undefined,
  params: URLSearchParams,
): BoundOperation | Response {
  if (key === undefined) {
    const detected = detectBucketOperation(c.req.method, params);
    if (detected instanceof Response) return detected;
    return bind(detected, BUCKET_OPERATIONS, { c, bucket, bucketId, params });
  }

  const detected = detectObjectOperation(c, params);
  if (detected instanceof Response) return detected;

  const context = { c, bucket, bucketId, key, params };
  // Multipart operations, uniquely, are detected as an object
  if (typeof detected === "object") {
    return bind(detected.operation, MULTIPART_OPERATIONS, {
      ...context,
      uploadId: detected.uploadId,
    });
  }
  return bind(detected, OBJECT_OPERATIONS, context);
}

function bind<Operation extends S3Operation, Context>(
  operation: Operation,
  table: Record<Operation, OperationDefinition<Context> & ScreeningRules>,
  context: Context,
): BoundOperation {
  const definition = table[operation];
  return {
    operation,
    rules: definition,
    run: () => definition.handle(context),
  };
}

// -----------------------------------------------------------------------------
// Operation detection (`s3/detect.worker.ts`)
// -----------------------------------------------------------------------------

const notImplementedOperation = (name: string) =>
  notImplemented(`${name} not implemented`);

type BucketOperation =
  | "HeadBucket"
  | "GetBucketLocation"
  | "GetBucketEncryption"
  | "GetBucketVersioning"
  | "GetBucketTagging"
  | "GetObjectLockConfiguration"
  | "GetBucketReplication"
  | "ListObjects"
  | "ListObjectsV2"
  | "DeleteObjects";

type ObjectOperation =
  | "GetObject"
  | "HeadObject"
  | "PutObject"
  | "CopyObject"
  | "DeleteObject"
  | "CreateMultipartUpload";

/** Operations on an in-progress multipart upload, addressed by ?uploadId */
type MultipartOperation =
  | "UploadPart"
  | "UploadPartCopy"
  | "CompleteMultipartUpload"
  | "AbortMultipartUpload";

type S3Operation = BucketOperation | ObjectOperation | MultipartOperation;

interface MultipartDetection {
  operation: MultipartOperation;
  uploadId: string;
}

/**
 * Object-level subresources R2 recognizes but does not implement.
 * Subresources without an entry for the method are ignored.
 */
const OBJECT_SUBRESOURCES: Record<string, Partial<Record<string, string>>> = {
  tagging: { GET: "GetObjectTagging", PUT: "PutObjectTagging" },
  acl: { GET: "GetObjectAcl", PUT: "PutObjectAcl" },
  attributes: { GET: "GetObjectAttributes" },
  torrent: { GET: "GetObjectTorrent" },
  retention: { GET: "GetObjectRetention", PUT: "PutObjectRetention" },
  "legal-hold": { GET: "GetObjectLegalHold", PUT: "PutObjectLegalHold" },
};

/**
 * Bucket-level GET subresources answered with R2's templated error.
 * acl/cors/lifecycle are implemented by real R2 but expose per-bucket state
 * the R2 binding does not.
 */
const BUCKET_GET_NOT_IMPLEMENTED: Partial<Record<string, string>> = {
  versions: "ListObjectVersions",
  policy: "GetBucketPolicy",
  website: "GetBucketWebsite",
  notification: "GetBucketNotificationConfiguration",
  requestPayment: "GetBucketRequestPayment",
  logging: "GetBucketLogging",
  accelerate: "GetBucketAccelerateConfiguration",
  publicAccessBlock: "GetPublicAccessBlock",
  ownershipControls: "GetBucketOwnershipControls",
  "intelligent-tiering": "GetBucketIntelligentTieringConfiguration",
  inventory: "GetBucketInventoryConfiguration",
  metrics: "GetBucketMetricsConfiguration",
  analytics: "GetBucketAnalyticsConfiguration",
  // R2's typo, reproduced verbatim
  policyStatus: "GetGetBucketPolicyStatus",
  acl: "GetBucketAcl",
  cors: "GetBucketCors",
  lifecycle: "GetBucketLifecycleConfiguration",
};

/** Bucket-level PUT subresources, all answered with a templated error. */
const BUCKET_PUT_NOT_IMPLEMENTED: Partial<Record<string, string>> = {
  accelerate: "PutBucketAccelerateConfiguration",
  acl: "PutBucketAcl",
  analytics: "PutBucketAnalyticsConfiguration",
  "intelligent-tiering": "PutBucketIntelligentTieringConfiguration",
  inventory: "PutBucketInventoryConfiguration",
  logging: "PutBucketLogging",
  metrics: "PutBucketMetricsConfiguration",
  notification: "PutBucketNotificationConfiguration",
  "object-lock": "PutObjectLockConfiguration",
  ownershipControls: "PutBucketOwnershipControls",
  policy: "PutBucketPolicy",
  publicAccessBlock: "PutPublicAccessBlock",
  replication: "PutBucketReplication",
  requestPayment: "PutBucketRequestPayment",
  tagging: "PutBucketTagging",
  website: "PutBucketWebsite",
  cors: "PutBucketCors",
  encryption: "PutBucketEncryption",
  lifecycle: "PutBucketLifecycleConfiguration",
  versioning: "PutBucketVersioning",
};

/** Bucket-level DELETE subresources. */
const BUCKET_DELETE_NOT_IMPLEMENTED: Partial<Record<string, string>> = {
  analytics: "DeleteBucketAnalyticsConfiguration",
  "intelligent-tiering": "DeleteBucketIntelligentTieringConfiguration",
  inventory: "DeleteBucketInventoryConfiguration",
  metrics: "DeleteBucketMetricsConfiguration",
  ownershipControls: "DeleteBucketOwnershipControls",
  policy: "DeleteBucketPolicy",
  replication: "DeleteBucketReplication",
  tagging: "DeleteBucketTagging",
  website: "DeleteBucketWebsite",
  cors: "DeleteBucketCors",
  encryption: "DeleteBucketEncryption",
  lifecycle: "DeleteBucketLifecycle",
};

/** Bucket-configuration reads with static responses on R2 */
const BUCKET_GET_STATIC: Partial<Record<string, BucketOperation>> = {
  encryption: "GetBucketEncryption",
  versioning: "GetBucketVersioning",
  tagging: "GetBucketTagging",
  "object-lock": "GetObjectLockConfiguration",
  replication: "GetBucketReplication",
};

const LIST_OBJECTS_PARAMS = new Set([
  "prefix",
  "delimiter",
  "marker",
  "max-keys",
  "encoding-type",
]);
const LIST_OBJECTS_V2_PARAMS = new Set([
  "list-type",
  "prefix",
  "delimiter",
  "continuation-token",
  "start-after",
  "max-keys",
  "encoding-type",
  "fetch-owner",
]);

function isScreenedParam(name: string): boolean {
  return name.startsWith("X-Amz-") || name === "x-id";
}

function detectListOperation(
  params: URLSearchParams,
): BucketOperation | Response {
  const listType = params.get("list-type");
  if (listType !== null && listType !== "2") {
    return notImplementedOperation(`ListObjectsV${listType}`);
  }
  const v2 = listType === "2";
  if (!v2 && params.has("continuation-token")) {
    return errorResponse(
      400,
      "InvalidArgument",
      "continuation-token not supported in ListObjects",
    );
  }
  const allowed = v2 ? LIST_OBJECTS_V2_PARAMS : LIST_OBJECTS_PARAMS;
  for (const name of params.keys()) {
    if (!allowed.has(name) && !isScreenedParam(name)) {
      return notImplemented(
        `ListObjectsV${v2 ? "2" : "1"} search parameter ${name} not implemented`,
      );
    }
  }
  return v2 ? "ListObjectsV2" : "ListObjects";
}

/**
 * Bucket-level PUT/DELETE: a recognized subresource wins with its named
 * error; otherwise every non-presign param is rejected together. A bare
 * PUT/DELETE reaches CreateBucket/DeleteBucket, which local buckets don't
 * implement.
 */
function detectBucketMutation(
  method: string,
  params: URLSearchParams,
  subresources: Partial<Record<string, string>>,
  bareOperation: string,
): Response {
  for (const name of params.keys()) {
    const operation = subresources[name];
    if (operation !== undefined) return notImplementedOperation(operation);
  }
  const unsupported = [...new Set(params.keys())].filter(
    (name) => !isScreenedParam(name),
  );
  if (unsupported.length > 0) {
    return errorResponse(
      400,
      "InvalidArgument",
      `Unsupported search param(s) ${unsupported
        .map((name) => `"${name}"`)
        .join(", ")} on a ${method} bucket route`,
    );
  }
  return notImplementedOperation(bareOperation);
}

function detectBucketOperation(
  method: string,
  params: URLSearchParams,
): BucketOperation | Response {
  switch (method) {
    case "HEAD":
      return "HeadBucket";
    case "PUT":
      return detectBucketMutation(
        "PUT",
        params,
        BUCKET_PUT_NOT_IMPLEMENTED,
        "CreateBucket",
      );
    case "DELETE":
      return detectBucketMutation(
        "DELETE",
        params,
        BUCKET_DELETE_NOT_IMPLEMENTED,
        "DeleteBucket",
      );
    case "POST":
      // ?delete is DeleteObjects; any other bucket-level POST gets an
      // empty 200
      return params.has("delete")
        ? "DeleteObjects"
        : new Response(null, { status: 200 });
    case "GET": {
      if (params.has("uploads")) {
        return notImplementedOperation("ListMultipartUploads");
      }
      if (params.has("location")) {
        for (const name of params.keys()) {
          if (name !== "location" && !isScreenedParam(name)) {
            return errorResponse(
              400,
              "InvalidArgument",
              `Search param ${name} is unsupported for bucket location`,
            );
          }
        }
        return "GetBucketLocation";
      }
      for (const name of params.keys()) {
        const staticOperation = BUCKET_GET_STATIC[name];
        if (staticOperation !== undefined) return staticOperation;
        const notImplementedName = BUCKET_GET_NOT_IMPLEMENTED[name];
        if (notImplementedName !== undefined) {
          return notImplementedOperation(notImplementedName);
        }
      }
      return detectListOperation(params);
    }
    default:
      return routeNotFound();
  }
}

function objectSubresourceError(
  params: URLSearchParams,
  method: string,
): Response | undefined {
  for (const name of params.keys()) {
    const subresource = OBJECT_SUBRESOURCES[name]?.[method];
    if (subresource !== undefined) return notImplementedOperation(subresource);
  }
  return undefined;
}

function detectObjectOperation(
  c: S3Context,
  params: URLSearchParams,
): ObjectOperation | MultipartDetection | Response {
  const method = c.req.method;

  const uploadId = params.get("uploadId");
  if (uploadId !== null) {
    // R2's part routes only match integer-shaped partNumbers
    const partNumber = params.get("partNumber");
    if (partNumber !== null && !/^ *-?\d*$/.test(partNumber)) {
      return routeNotFound();
    }
    switch (method) {
      case "GET":
        // The R2 binding cannot list parts
        return notImplementedOperation("ListParts");
      case "PUT":
        // Without partNumber, `uploadId` is ignored (plain Put/Copy)
        if (partNumber === null) break;
        return {
          operation:
            c.req.header("x-amz-copy-source") !== undefined
              ? "UploadPartCopy"
              : "UploadPart",
          uploadId,
        };
      case "POST":
        return { operation: "CompleteMultipartUpload", uploadId };
      case "DELETE":
        return { operation: "AbortMultipartUpload", uploadId };
      case "HEAD":
        return "HeadObject";
      default:
        return routeNotFound();
    }
  }
  if (params.has("uploads")) {
    if (method === "POST") return "CreateMultipartUpload";
    if (method === "GET") {
      return notImplementedOperation("ListMultipartUploads");
    }
  }
  switch (method) {
    case "GET":
    case "HEAD":
      // Real R2 serves individual parts; `bucket.get()` cannot
      if (params.has("partNumber")) {
        return notImplementedOperation("partNumber");
      }
      // Real R2 HEAD ignores subresource parameters
      if (method === "HEAD") return "HeadObject";
      return objectSubresourceError(params, method) ?? "GetObject";
    case "PUT": {
      const subresource = objectSubresourceError(params, method);
      if (subresource !== undefined) return subresource;
      return c.req.header("x-amz-copy-source") !== undefined
        ? "CopyObject"
        : "PutObject";
    }
    case "POST":
      // R2 treats POST on an object key as PutObject, ignoring subresources
      // and x-amz-copy-source
      return "PutObject";
    case "DELETE":
      return "DeleteObject";
    default:
      return routeNotFound();
  }
}

// -----------------------------------------------------------------------------
// Object serving (`r2/serve.worker.ts`)
// -----------------------------------------------------------------------------

// A single range with start <= end; anything else is a 400
const RANGE_HEADER = /^bytes=(?:(\d+)-(\d+)?|-(\d+))$/;

type ParsedRangeHeader =
  | { error: "malformed" | "inverted" | "unsatisfiable" }
  // `start` is undefined for suffix ranges (`bytes=-N`)
  | { start?: number };

function parseRangeHeader(header: string): ParsedRangeHeader {
  const match = RANGE_HEADER.exec(header);
  if (match === null) return { error: "malformed" };
  const [, start, end, suffix] = match;
  if (start === undefined) {
    // A zero suffix (`bytes=-0`) is unsatisfiable for any object
    return Number(suffix) === 0 ? { error: "unsatisfiable" } : {};
  }
  if (end !== undefined && Number(start) > Number(end)) {
    return { error: "inverted" };
  }
  return { start: Number(start) };
}

function objectHeaders(object: R2Object): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/octet-stream");
  }
  headers.set("ETag", object.httpEtag);
  headers.set("Last-Modified", object.uploaded.toUTCString());
  headers.set("Accept-Ranges", "bytes");
  return headers;
}

interface ServeHandlers {
  notFound(): Response | Promise<Response>;
  preconditionFailed(): Response;
  /** A range starting at or beyond the object size returns this error */
  invalidRange?(): Response;
  /** Adds endpoint-specific headers to successful (2xx/304) responses */
  decorateHeaders?(object: R2Object, headers: Headers): void;
}

async function serveR2Object(
  request: Request,
  bucket: R2Bucket,
  key: string,
  handlers: ServeHandlers,
  parsedRange?: ParsedRangeHeader,
): Promise<Response> {
  // R2 honors Range on HEAD too (206 + Content-Range, no body)
  const rangeHeader = request.headers.get("Range");
  const hasRange = rangeHeader !== null;

  // `bucket.head()` can't evaluate conditional headers, so HEAD also uses
  // `bucket.get()` and discards the body
  const object = await bucket.get(key, {
    onlyIf: request.headers,
    range: hasRange ? request.headers : undefined,
  });
  if (object === null) return handlers.notFound();

  const headers = objectHeaders(object);
  handlers.decorateHeaders?.(object, headers);

  if (!("body" in object)) {
    // Some conditional failed without naming the header. Per RFC 7232 §6,
    // precondition headers (412) are checked before cache validators (304).
    let preconditions: Headers | undefined;
    for (const name of ["If-Match", "If-Unmodified-Since"]) {
      const value = request.headers.get(name);
      if (value !== null) {
        preconditions ??= new Headers();
        preconditions.set(name, value);
      }
    }
    if (preconditions !== undefined) {
      const recheck = await bucket.get(key, { onlyIf: preconditions });
      if (recheck === null) return handlers.notFound();
      if (!("body" in recheck)) return handlers.preconditionFailed();
      void recheck.body.cancel();
    }
    return new Response(null, { status: 304, headers });
  }

  const body = request.method === "HEAD" ? null : object.body;
  if (body === null) void object.body.cancel();

  const range = object.range;
  if (hasRange && range !== undefined) {
    // The simulator clamps out-of-bounds ranges and serves zero-length
    // ranges for empty objects; R2 rejects both with 416
    if (handlers.invalidRange !== undefined) {
      const parsed = parsedRange ?? parseRangeHeader(rangeHeader);
      if (
        !("error" in parsed) &&
        (object.size === 0 ||
          (parsed.start !== undefined && parsed.start >= object.size))
      ) {
        if (body !== null) void body.cancel();
        return handlers.invalidRange();
      }
    }
    const normalized: { offset?: number; length?: number; suffix?: number } = {
      ...range,
    };
    let offset: number;
    let length: number;
    if (normalized.suffix !== undefined) {
      length = Math.min(normalized.suffix, object.size);
      offset = object.size - length;
    } else {
      offset = normalized.offset ?? 0;
      length = normalized.length ?? object.size - offset;
    }
    headers.set(
      "Content-Range",
      `bytes ${offset}-${offset + length - 1}/${object.size}`,
    );
    headers.set("Content-Length", `${length}`);
    return new Response(body, { status: 206, headers });
  }

  headers.set("Content-Length", `${object.size}`);
  return new Response(body, { headers });
}

// -----------------------------------------------------------------------------
// Operations (`s3/operations.worker.ts`)
// -----------------------------------------------------------------------------

interface S3Error {
  status: number;
  code: string;
  message: string;
}

const NO_SUCH_KEY: S3Error = {
  status: 404,
  code: "NoSuchKey",
  message: "The specified key does not exist.",
};
const PRECONDITION_FAILED: S3Error = {
  status: 412,
  code: "PreconditionFailed",
  message: "At least one of the pre-conditions you specified did not hold.",
};
const NO_SUCH_UPLOAD: S3Error = {
  status: 404,
  code: "NoSuchUpload",
  message: "The specified multipart upload does not exist.",
};

const s3Error = (error: S3Error) =>
  errorResponse(error.status, error.code, error.message);

const noSuchKey = () => s3Error(NO_SUCH_KEY);
const preconditionFailed = () => s3Error(PRECONDITION_FAILED);

const malformedXml = () =>
  errorResponse(
    400,
    "MalformedXML",
    "The XML you provided was not well formed or did not validate against our published schema.",
  );

const notImplementedHeader = (name: string, value: string) =>
  errorResponse(
    501,
    "NotImplemented",
    `Header '${name}' with value '${value}' not implemented`,
  );

/**
 * R2 binding errors carry a stable v4 code at the end of their message
 * (e.g. "... does not exist. (10024)"); map those onto R2's S3 errors.
 */
const BINDING_ERRORS: Partial<Record<number, S3Error>> = {
  10007: NO_SUCH_KEY,
  10011: {
    status: 400,
    code: "EntityTooSmall",
    message:
      "Your proposed upload is smaller than the minimum allowed object size.",
  },
  10024: NO_SUCH_UPLOAD,
  10025: {
    status: 400,
    code: "InvalidPart",
    message: "One or more of the specified parts could not be found.",
  },
  10031: PRECONDITION_FAILED,
  10039: {
    status: 416,
    code: "InvalidRange",
    message: "The requested range is not satisfiable",
  },
};

function bindingError(e: unknown): Response {
  const message = e instanceof Error ? e.message : String(e);
  const v4Code = /\((\d+)\)$/.exec(message);
  const known = v4Code === null ? undefined : BINDING_ERRORS[Number(v4Code[1])];
  if (known !== undefined) return s3Error(known);
  return errorResponse(500, "InternalError", message);
}

const BUCKET_OWNER = ["x-amz-expected-bucket-owner"];
const SOURCE_BUCKET_OWNER = ["x-amz-source-expected-bucket-owner"];
const MFA_AND_LOCK_BYPASS = ["x-amz-mfa", "x-amz-bypass-governance-retention"];
const COPY_SOURCE_CONDITIONALS = [
  "x-amz-copy-source-if-match",
  "x-amz-copy-source-if-none-match",
  "x-amz-copy-source-if-modified-since",
  "x-amz-copy-source-if-unmodified-since",
];
/** Headers R2 recognizes but rejects on every write operation */
const WRITE_UNSUPPORTED = [
  ...BUCKET_OWNER,
  "x-amz-tagging",
  "x-amz-grant-full-control",
  "x-amz-grant-read",
  "x-amz-grant-read-acp",
  "x-amz-grant-write",
  "x-amz-grant-write-acp",
  "x-amz-website-redirect-location",
  "x-amz-object-lock-mode",
  "x-amz-object-lock-retain-until-date",
  "x-amz-object-lock-legal-hold",
  "x-amz-server-side-encryption-aws-kms-key-id",
  "x-amz-server-side-encryption-context",
  "x-amz-server-side-encryption-bucket-key-enabled",
];

interface BucketOperationContext {
  c: S3Context;
  bucket: R2Bucket;
  bucketId: string;
  params: URLSearchParams;
}

interface ObjectOperationContext extends BucketOperationContext {
  key: string;
}

interface MultipartOperationContext extends ObjectOperationContext {
  uploadId: string;
}

interface ScreeningRules {
  /** Headers rejected with the templated NotImplemented error */
  unsupportedHeaders: Array<string>;
  /** Validate x-amz-server-side-encryption / x-amz-acl values */
  validatesWriteHeaders?: true;
  /**
   * SSE-C: "read" returns R2's error for SSE-C on an unencrypted object;
   * "write" reports the header as NotImplemented.
   */
  ssec?: "read" | "write";
}

interface OperationDefinition<Context> {
  handle(operation: Context): Awaitable<Response>;
}

/** Canned ACLs are accepted as no-ops (R2 has no object ACLs) */
const CANNED_ACLS = new Set([
  "private",
  "public-read",
  "public-read-write",
  "authenticated-read",
  "aws-exec-read",
  "bucket-owner-read",
  "bucket-owner-full-control",
]);

function screenHeaders(
  c: S3Context,
  operation: S3Operation,
  rules: ScreeningRules,
): Response | undefined {
  if (c.req.header("x-amz-security-token") !== undefined) {
    return errorResponse(400, "InvalidArgument", "X-Amz-Security-Token");
  }
  for (const name of rules.unsupportedHeaders) {
    const value = c.req.header(name);
    if (value !== undefined) return notImplementedHeader(name, value);
  }
  if (rules.validatesWriteHeaders === true) {
    // R2 encrypts at rest with AES256 anyway, so that value is a no-op
    const sse = c.req.header("x-amz-server-side-encryption");
    if (sse !== undefined && sse !== "AES256") {
      return notImplementedHeader("x-amz-server-side-encryption", sse);
    }
    const acl = c.req.header("x-amz-acl");
    if (acl !== undefined && !CANNED_ACLS.has(acl)) {
      return notImplementedHeader("x-amz-acl", acl);
    }
  }
  if (rules.ssec !== undefined) {
    return screenSSECHeaders(c, operation, rules.ssec);
  }
  return undefined;
}

function screenSSECHeaders(
  c: S3Context,
  operation: S3Operation,
  mode: "read" | "write",
): Response | undefined {
  const prefixes =
    operation === "CopyObject" || operation === "UploadPartCopy"
      ? ["x-amz-", "x-amz-copy-source-"]
      : ["x-amz-"];
  for (const prefix of prefixes) {
    const algorithmName = `${prefix}server-side-encryption-customer-algorithm`;
    const algorithm = c.req.header(algorithmName);
    const key = c.req.header(`${prefix}server-side-encryption-customer-key`);
    const keyMd5 = c.req.header(
      `${prefix}server-side-encryption-customer-key-MD5`,
    );
    if (algorithm === undefined && key === undefined && keyMd5 === undefined) {
      continue;
    }
    // R2 requires the full header triple, checked in this order
    if (key === undefined) {
      return errorResponse(
        400,
        "InvalidArgument",
        "Requests specifying Server Side Encryption with Customer provided keys must provide an appropriate secret key.",
      );
    }
    if (keyMd5 === undefined) {
      return errorResponse(
        400,
        "InvalidArgument",
        "Requests specifying Server Side Encryption with Customer provided keys must provide the client calculated MD5 of the secret key.",
      );
    }
    if (algorithm === undefined) {
      return errorResponse(
        400,
        "InvalidArgument",
        "Requests specifying Server Side Encryption with Customer provided keys must provide a valid encryption algorithm.",
      );
    }
    if (algorithm !== "AES256") {
      return errorResponse(
        400,
        "InvalidEncryptionAlgorithmError",
        "The encryption request that you specified is not valid. The valid value is AES256.",
      );
    }
    return mode === "read"
      ? errorResponse(
          400,
          "InvalidRequest",
          "The encryption parameters are not applicable to this object.",
        )
      : notImplementedHeader(algorithmName, algorithm);
  }
  return undefined;
}

const CONDITIONAL_HEADERS = [
  "If-Match",
  "If-None-Match",
  "If-Modified-Since",
  "If-Unmodified-Since",
];

/** The request body, buffered only when Content-MD5 must be verified */
async function verifiedRequestBody(
  c: S3Context,
): Promise<ReadableStream | ArrayBuffer | string | Response> {
  if (c.req.header("Content-MD5") === undefined) {
    return c.req.raw.body ?? "";
  }
  const buffered = await c.req.raw.arrayBuffer();
  const digestError = await verifyContentMD5(c, buffered);
  return digestError ?? buffered;
}

async function verifyContentMD5(
  c: S3Context,
  body: ArrayBuffer,
): Promise<Response | undefined> {
  const contentMd5 = c.req.header("Content-MD5");
  if (contentMd5 === undefined) return undefined;
  let provided: Uint8Array;
  try {
    provided = Uint8Array.from(atob(contentMd5), (char) => char.charCodeAt(0));
    if (provided.length !== 16) throw new Error("bad length");
  } catch {
    return errorResponse(
      400,
      "InvalidDigest",
      "The checksum or Content-MD5 you specified is not valid.",
    );
  }
  const computed = hex(await crypto.subtle.digest("MD5", body));
  if (hex(provided) !== computed) {
    return errorResponse(
      400,
      "BadDigest",
      `The MD5 checksum you specified did not match what we received.\nYou provided a MD5 checksum with value: ${hex(provided)}\nActual MD5 was: ${computed}`,
    );
  }
  return undefined;
}

/** The R2 storage class for x-amz-storage-class, or an error */
function parseStorageClass(c: S3Context): string | undefined | Response {
  const header = c.req.header("x-amz-storage-class");
  switch (header) {
    case undefined:
      return undefined;
    case "STANDARD":
      return "Standard";
    case "STANDARD_IA":
      // The simulator can't persist storage classes
      return notImplementedHeader("x-amz-storage-class", header);
    default:
      return errorResponse(
        400,
        "InvalidStorageClass",
        "The storage class specified is not valid.",
      );
  }
}

function collectCustomMetadata(c: S3Context): Record<string, string> {
  const customMetadata: Record<string, string> = {};
  for (const [name, value] of c.req.raw.headers) {
    if (name.startsWith("x-amz-meta-")) {
      customMetadata[name.slice("x-amz-meta-".length)] = value;
    }
  }
  return customMetadata;
}

/** Parses `x-amz-copy-source` (`/bucket/key` or `bucket/key`). */
function parseCopySource(
  c: S3Context,
  bucketId: string,
): { bucket: R2Bucket; key: string } | Response {
  const header = c.req.header("x-amz-copy-source");
  assert(header !== undefined);
  const raw = safeDecode(header);
  const source = raw.startsWith("/") ? raw.slice(1) : raw;
  const separator = source.indexOf("/");
  if (separator === -1 || separator === source.length - 1) {
    return errorResponse(400, "InvalidArgument", "copy source bucket name");
  }

  const sourceBucketId = source.slice(0, separator);
  const sourceBucket = bucketBinding(c.env, sourceBucketId);
  if (sourceBucket === undefined) return noSuchBucket();

  // Credentials are per bucket: the pair the request authenticated with
  // must also grant access to the source bucket
  const target = bucketBinding(c.env, bucketId);
  assert(target !== undefined);
  if (!credentialsEqual(sourceBucket.credentials, target.credentials)) {
    return errorResponse(401, "Unauthorized", "Unauthorized");
  }

  return { bucket: sourceBucket.bucket, key: source.slice(separator + 1) };
}

/** Maps x-amz-copy-source-if-* headers onto standard conditional headers */
function copySourceConditionals(c: S3Context): Headers | undefined {
  let headers: Headers | undefined;
  for (const standard of CONDITIONAL_HEADERS) {
    const value = c.req.header(`x-amz-copy-source-${standard.toLowerCase()}`);
    if (value !== undefined) {
      headers ??= new Headers();
      headers.set(standard, value);
    }
  }
  return headers;
}

function serveObject(
  c: S3Context,
  bucket: R2Bucket,
  key: string,
): Awaitable<Response> {
  const rangeHeader = c.req.header("Range");
  const range = rangeHeader === undefined ? {} : parseRangeHeader(rangeHeader);
  if ("error" in range) {
    switch (range.error) {
      case "malformed":
        // R2's message really ends with `.'`
        return errorResponse(
          400,
          "InvalidArgument",
          "range must be in format 'bytes=start-end', 'bytes=start-' or 'bytes=-suffix'.'",
        );
      case "inverted":
        return errorResponse(400, "InvalidArgument", "range must be positive.");
      case "unsatisfiable":
        return errorResponse(
          416,
          "InvalidRange",
          "The requested range is not satisfiable",
        );
    }
  }

  // Presigned GETs may override response headers (`response-content-type`
  // etc.), like S3/R2
  const overrides = responseHeaderOverrides(c);
  return serveR2Object(
    c.req.raw,
    bucket,
    key,
    {
      notFound: noSuchKey,
      preconditionFailed,
      invalidRange: () =>
        errorResponse(
          416,
          "InvalidRange",
          "The requested range is not satisfiable",
        ),
      decorateHeaders(object, headers) {
        for (const [name, value] of Object.entries(
          object.customMetadata ?? {},
        )) {
          headers.set(`x-amz-meta-${name}`, value);
        }
        for (const [name, value] of overrides) headers.set(name, value);
      },
    },
    range,
  );
}

const RESPONSE_HEADER_OVERRIDES: Record<string, string> = {
  "response-content-type": "Content-Type",
  "response-content-language": "Content-Language",
  "response-expires": "Expires",
  "response-cache-control": "Cache-Control",
  "response-content-disposition": "Content-Disposition",
  "response-content-encoding": "Content-Encoding",
};

function responseHeaderOverrides(c: S3Context): Array<[string, string]> {
  const params = new URL(c.req.url).searchParams;
  const overrides: Array<[string, string]> = [];
  for (const [param, header] of Object.entries(RESPONSE_HEADER_OVERRIDES)) {
    const value = params.get(param);
    if (value !== null) overrides.push([header, value]);
  }
  return overrides;
}

async function listObjects(
  params: URLSearchParams,
  bucket: R2Bucket,
  bucketId: string,
  v2: boolean,
): Promise<Response> {
  const encodingType = params.get("encoding-type");
  if (encodingType !== null && encodingType !== "url") {
    return notImplemented(
      `Unrecognized encoding-type "${encodingType}" not implemented`,
    );
  }
  const encode = (value: string) =>
    encodingType === "url" ? awsUriEncode(value) : value;

  // R2 floors fractional values and allows 0 and values above the limit
  // (clamping the page size but echoing the requested MaxKeys)
  let maxKeys = MAX_LIST_KEYS;
  const maxKeysParam = params.get("max-keys");
  if (maxKeysParam !== null) {
    const value =
      maxKeysParam.trim() === "" ? Number.NaN : Number(maxKeysParam);
    if (!Number.isFinite(value) || value < 0) {
      return errorResponse(
        400,
        "InvalidMaxKeys",
        "MaxKeys params must be positive integer <= 1000.",
      );
    }
    maxKeys = Math.floor(value);
  }
  const limit = Math.min(maxKeys, MAX_LIST_KEYS);

  const prefix = params.get("prefix") ?? "";
  const delimiter = params.get("delimiter") ?? undefined;
  const marker = v2 ? undefined : (params.get("marker") ?? undefined);
  const startAfter = v2 ? (params.get("start-after") ?? undefined) : marker;
  const continuationToken = v2
    ? (params.get("continuation-token") ?? undefined)
    : undefined;

  let objects: Array<R2Object> = [];
  let delimitedPrefixes: Array<string> = [];
  let truncated = false;
  let cursor: string | undefined;
  let result: R2Objects;
  try {
    result = await bucket.list({
      prefix,
      delimiter,
      // For max-keys=0, list one key anyway: IsTruncated reports whether
      // any matching keys exist
      limit: Math.max(limit, 1),
      startAfter,
      cursor: continuationToken,
    });
  } catch (e) {
    return bindingError(e);
  }

  if (limit === 0) {
    truncated =
      result.objects.length > 0 || result.delimitedPrefixes.length > 0;
  } else {
    objects = result.objects;
    delimitedPrefixes = result.delimitedPrefixes;
    truncated = result.truncated;
    cursor = result.truncated ? result.cursor : undefined;
  }

  const contents = objects.map((object) => ({
    Key: encode(object.key),
    Size: object.size,
    LastModified: object.uploaded.toISOString(),
    ETag: object.httpEtag,
    // The simulator does not store storage classes
    StorageClass: "STANDARD",
  }));
  const commonPrefixes = delimitedPrefixes.map((value) => ({
    Prefix: encode(value),
  }));
  // NextMarker is the lexicographically last returned item, which can be a
  // CommonPrefix
  const lastObjectKey = objects[objects.length - 1]?.key;
  const lastPrefix = delimitedPrefixes[delimitedPrefixes.length - 1];
  const lastKey =
    lastPrefix !== undefined &&
    (lastObjectKey === undefined || lastPrefix > lastObjectKey)
      ? lastPrefix
      : lastObjectKey;

  return xmlResponse("ListBucketResult", {
    Name: bucketId,
    ...(contents.length > 0 ? { Contents: contents } : {}),
    IsTruncated: truncated,
    ...(commonPrefixes.length > 0 ? { CommonPrefixes: commonPrefixes } : {}),
    Prefix: encode(prefix),
    ...(delimiter !== undefined ? { Delimiter: encode(delimiter) } : {}),
    ...(v2
      ? {
          ...(startAfter !== undefined
            ? { StartAfter: encode(startAfter) }
            : {}),
          ...(continuationToken !== undefined
            ? { ContinuationToken: continuationToken }
            : {}),
          ...(cursor !== undefined ? { NextContinuationToken: cursor } : {}),
        }
      : {
          Marker: encode(marker ?? ""),
          ...(truncated && lastKey !== undefined
            ? { NextMarker: encode(lastKey) }
            : {}),
        }),
    MaxKeys: maxKeys,
    ...(v2 ? { KeyCount: contents.length + commonPrefixes.length } : {}),
    ...(encodingType !== null ? { EncodingType: encodingType } : {}),
  });
}

function parsePartNumber(params: URLSearchParams): number | Response {
  const raw = params.get("partNumber");
  assert(raw !== null);
  const partNumber = raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return errorResponse(
      400,
      "InvalidArgument",
      "Part number must be an integer between 1 and 10000, inclusive.",
    );
  }
  return partNumber;
}

const OBJECT_OPERATIONS: Record<
  ObjectOperation,
  OperationDefinition<ObjectOperationContext> & ScreeningRules
> = {
  GetObject: {
    unsupportedHeaders: BUCKET_OWNER,
    ssec: "read",
    handle: ({ c, bucket, key }) => serveObject(c, bucket, key),
  },
  HeadObject: {
    unsupportedHeaders: BUCKET_OWNER,
    ssec: "read",
    handle: ({ c, bucket, key }) => serveObject(c, bucket, key),
  },
  PutObject: {
    unsupportedHeaders: WRITE_UNSUPPORTED,
    validatesWriteHeaders: true,
    ssec: "write",
    async handle({ c, bucket, key }) {
      const storageClass = parseStorageClass(c);
      if (storageClass instanceof Response) return storageClass;
      const body = await verifiedRequestBody(c);
      if (body instanceof Response) return body;
      const hasConditional = CONDITIONAL_HEADERS.some(
        (name) => c.req.header(name) !== undefined,
      );
      const object = await bucket.put(key, body, {
        httpMetadata: c.req.raw.headers,
        customMetadata: collectCustomMetadata(c),
        onlyIf: hasConditional ? c.req.raw.headers : undefined,
        storageClass,
      });
      if (object === null) return preconditionFailed();
      return new Response(null, { headers: { ETag: object.httpEtag } });
    },
  },
  CopyObject: {
    unsupportedHeaders: [
      ...WRITE_UNSUPPORTED,
      ...SOURCE_BUCKET_OWNER,
      "x-amz-tagging-directive",
      "x-amz-checksum-algorithm",
    ],
    validatesWriteHeaders: true,
    ssec: "write",
    async handle({ c, bucket, bucketId, key }) {
      const directive = c.req.header("x-amz-metadata-directive") ?? "COPY";
      if (directive !== "COPY" && directive !== "REPLACE") {
        return errorResponse(
          400,
          "InvalidArgument",
          `metadata directive ${directive}.`,
        );
      }
      const storageClass = parseStorageClass(c);
      if (storageClass instanceof Response) return storageClass;
      const source = parseCopySource(c, bucketId);
      if (source instanceof Response) return source;

      const sourceObject = await source.bucket.get(source.key, {
        onlyIf: copySourceConditionals(c),
      });
      if (sourceObject === null) return noSuchKey();
      if (!("body" in sourceObject)) return preconditionFailed();

      const object = await bucket.put(key, sourceObject.body, {
        httpMetadata:
          directive === "COPY" ? sourceObject.httpMetadata : c.req.raw.headers,
        customMetadata:
          directive === "COPY"
            ? sourceObject.customMetadata
            : collectCustomMetadata(c),
        storageClass,
      });
      if (object === null) return preconditionFailed();
      return xmlResponse("CopyObjectResult", {
        ETag: object.httpEtag,
        LastModified: object.uploaded.toISOString(),
      });
    },
  },
  DeleteObject: {
    unsupportedHeaders: [...BUCKET_OWNER, ...MFA_AND_LOCK_BYPASS],
    async handle({ bucket, key }) {
      await bucket.delete(key);
      return new Response(null, { status: 204 });
    },
  },
  CreateMultipartUpload: {
    unsupportedHeaders: WRITE_UNSUPPORTED,
    validatesWriteHeaders: true,
    ssec: "write",
    async handle({ c, bucket, bucketId, key }) {
      const storageClass = parseStorageClass(c);
      if (storageClass instanceof Response) return storageClass;
      const upload = await bucket.createMultipartUpload(key, {
        httpMetadata: c.req.raw.headers,
        customMetadata: collectCustomMetadata(c),
        storageClass,
      });
      return xmlResponse("InitiateMultipartUploadResult", {
        UploadId: upload.uploadId,
        Bucket: bucketId,
        Key: key,
      });
    },
  },
};

const MULTIPART_OPERATIONS: Record<
  MultipartOperation,
  OperationDefinition<MultipartOperationContext> & ScreeningRules
> = {
  UploadPart: {
    unsupportedHeaders: [...BUCKET_OWNER, "x-amz-server-side-encryption"],
    ssec: "write",
    async handle({ c, bucket, key, uploadId, params }) {
      const partNumber = parsePartNumber(params);
      if (partNumber instanceof Response) return partNumber;
      const body = await verifiedRequestBody(c);
      if (body instanceof Response) return body;
      // `resumeMultipartUpload` never validates; unknown ids fail on use
      const upload = bucket.resumeMultipartUpload(key, uploadId);
      try {
        const part = await upload.uploadPart(partNumber, body);
        return new Response(null, { headers: { ETag: `"${part.etag}"` } });
      } catch (e) {
        return bindingError(e);
      }
    },
  },
  UploadPartCopy: {
    unsupportedHeaders: [
      ...BUCKET_OWNER,
      ...SOURCE_BUCKET_OWNER,
      ...COPY_SOURCE_CONDITIONALS,
    ],
    ssec: "write",
    async handle({ c, bucket, bucketId, key, uploadId, params }) {
      const partNumber = parsePartNumber(params);
      if (partNumber instanceof Response) return partNumber;
      const source = parseCopySource(c, bucketId);
      if (source instanceof Response) return source;
      let range: R2Range | undefined;
      const rangeHeader = c.req.header("x-amz-copy-source-range");
      if (rangeHeader !== undefined) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
        if (match === null) {
          return errorResponse(
            400,
            "InvalidArgument",
            `Invalid x-amz-copy-source-range: ${rangeHeader}`,
          );
        }
        const offset = Number(match[1]);
        const end = Number(match[2]);
        if (end < offset) {
          return errorResponse(
            400,
            "InvalidArgument",
            "x-amz-copy-source-range must be positive.",
          );
        }
        range = { offset, length: end - offset + 1 };
      }

      let sourceObject: R2ObjectBody | null;
      try {
        sourceObject = await source.bucket.get(source.key, { range });
      } catch (e) {
        return bindingError(e);
      }
      if (sourceObject === null) return noSuchKey();

      const upload = bucket.resumeMultipartUpload(key, uploadId);
      try {
        const part = await upload.uploadPart(partNumber, sourceObject.body);
        return xmlResponse("CopyPartResult", {
          ETag: `"${part.etag}"`,
          LastModified: new Date().toISOString(),
        });
      } catch (e) {
        return bindingError(e);
      }
    },
  },
  CompleteMultipartUpload: {
    unsupportedHeaders: BUCKET_OWNER,
    async handle({ c, bucket, bucketId, key, uploadId }) {
      const text = await c.req.raw.text();
      if (XMLValidator.validate(text) !== true) return malformedXml();

      const parsed: unknown = xmlParser.parse(text);
      const request = (
        parsed as { CompleteMultipartUpload?: { Part?: unknown } }
      ).CompleteMultipartUpload;
      if (request === undefined) return malformedXml();

      const parts: Array<R2UploadedPart> = [];
      const seenPartNumbers = new Set<number>();
      for (const part of coerceArray(request.Part)) {
        const { PartNumber, ETag } = part as {
          PartNumber?: unknown;
          ETag?: unknown;
        };
        const partNumber = Number(PartNumber);
        if (!Number.isInteger(partNumber) || typeof ETag !== "string") {
          return malformedXml();
        }
        // Out-of-range part numbers are parts that cannot exist
        if (partNumber < 1 || partNumber > 10000) {
          return errorResponse(
            400,
            "InvalidPart",
            "One or more of the specified parts could not be found.",
          );
        }
        // The simulator reports duplicates as an internal error; screen them
        if (seenPartNumbers.has(partNumber)) {
          return errorResponse(
            400,
            "InvalidPart",
            "There was a problem with the multipart upload.",
          );
        }
        seenPartNumbers.add(partNumber);
        parts.push({ partNumber, etag: ETag.replace(/^"|"$/g, "") });
      }
      if (parts.length === 0) return malformedXml();

      const upload = bucket.resumeMultipartUpload(key, uploadId);
      try {
        const object = await upload.complete(parts);
        const url = new URL(c.req.url);
        return xmlResponse("CompleteMultipartUploadResult", {
          Bucket: bucketId,
          Key: key,
          ETag: object.httpEtag,
          Location: `${url.origin}${PATH_R2_S3}/${awsUriEncode(bucketId)}/${awsUriEncode(key)}`,
        });
      } catch (e) {
        const response = bindingError(e);
        // The simulator reports an unknown upload id as an internal error
        if (response.status === 500) return s3Error(NO_SUCH_UPLOAD);
        return response;
      }
    },
  },
  AbortMultipartUpload: {
    unsupportedHeaders: [],
    async handle({ bucket, key, uploadId }) {
      const upload = bucket.resumeMultipartUpload(key, uploadId);
      try {
        await upload.abort();
      } catch (e) {
        const response = bindingError(e);
        if (response.status === 500) return s3Error(NO_SUCH_UPLOAD);
        return response;
      }
      return new Response(null, { status: 204 });
    },
  },
};

const BUCKET_OPERATIONS: Record<
  BucketOperation,
  OperationDefinition<BucketOperationContext> & ScreeningRules
> = {
  HeadBucket: {
    unsupportedHeaders: BUCKET_OWNER,
    handle: () => new Response(null, { status: 200 }),
  },
  GetBucketLocation: {
    unsupportedHeaders: BUCKET_OWNER,
    // Local buckets have no location hint
    handle: () => xmlResponse("LocationConstraint", { "#text": "auto" }),
  },
  GetBucketEncryption: {
    unsupportedHeaders: BUCKET_OWNER,
    handle: () =>
      xmlResponse("ServerSideEncryptionConfiguration", {
        Rule: {
          ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
          BucketKeyEnabled: true,
        },
      }),
  },
  GetBucketVersioning: {
    unsupportedHeaders: BUCKET_OWNER,
    handle: () => xmlResponse("VersioningConfiguration", {}),
  },
  GetBucketTagging: {
    unsupportedHeaders: BUCKET_OWNER,
    handle: () =>
      errorResponse(404, "NoSuchTagSet", "The TagSet does not exist."),
  },
  GetObjectLockConfiguration: {
    unsupportedHeaders: BUCKET_OWNER,
    handle: () =>
      errorResponse(
        404,
        "ObjectLockConfigurationNotFoundError",
        "Object Lock configuration does not exist for this bucket.",
      ),
  },
  GetBucketReplication: {
    unsupportedHeaders: BUCKET_OWNER,
    handle: () =>
      errorResponse(
        404,
        "ReplicationConfigurationNotFoundError",
        "The replication configuration was not found.",
      ),
  },
  ListObjects: {
    unsupportedHeaders: BUCKET_OWNER,
    handle: ({ params, bucket, bucketId }) =>
      listObjects(params, bucket, bucketId, false),
  },
  ListObjectsV2: {
    unsupportedHeaders: BUCKET_OWNER,
    handle: ({ params, bucket, bucketId }) =>
      listObjects(params, bucket, bucketId, true),
  },
  DeleteObjects: {
    unsupportedHeaders: [...BUCKET_OWNER, ...MFA_AND_LOCK_BYPASS],
    async handle({ c, bucket }) {
      const body = await c.req.raw.arrayBuffer();
      const digestError = await verifyContentMD5(c, body);
      if (digestError !== undefined) return digestError;

      const text = new TextDecoder().decode(body);
      if (XMLValidator.validate(text) !== true) return malformedXml();

      const parsed: unknown = xmlParser.parse(text);
      const request = (
        parsed as { Delete?: { Object?: unknown; Quiet?: unknown } }
      ).Delete;
      if (request === undefined) return malformedXml();

      const keys: Array<string> = [];
      for (const object of coerceArray(request.Object)) {
        const key = (object as { Key?: unknown }).Key;
        if (typeof key !== "string") return malformedXml();
        keys.push(key);
      }
      if (keys.length === 0 || keys.length > MAX_DELETE_KEYS) {
        return malformedXml();
      }
      // R2 validates Quiet strictly but then ignores it
      if (
        request.Quiet !== undefined &&
        request.Quiet !== "true" &&
        request.Quiet !== "false"
      ) {
        return malformedXml();
      }

      await bucket.delete(keys);
      // Deletes are idempotent: missing keys are still reported as Deleted
      return xmlResponse("DeleteResult", {
        Deleted: keys.map((key) => ({ Key: key })),
      });
    },
  },
};
