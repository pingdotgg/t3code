import { authorize, githubKeys, type WriteIdentity } from './auth.ts';
import { cborResponse } from './cbor.ts';
import { cleanup, getScope, selectBlob } from './database.ts';
import { errorResponse, HttpError, unavailable } from './errors.ts';
import { fetchMetadata } from './fetch.ts';
import { limitsFrom } from './limits.ts';
import { store } from './store.ts';
import { Deadline } from './streams.ts';
import { Admission } from './admission.ts';
import { Observations } from './observations.ts';

const keys = githubKeys();
const admission = new Admission();

export default {
  async fetch(request, env, ctx) {
    const started = Date.now();
    const id = crypto.randomUUID();
    const stats = new Observations();
    let scopeId = 'unknown';
    let operation = 'unknown';
    let outcome = 'error';
    let identity: WriteIdentity | undefined;
    let deadline: Deadline | undefined;
    let release: (() => void) | undefined;
    let response: Response;
    try {
      const limits = limitsFrom(env.LIMITS);
      const url = new URL(request.url);
      deadline = new Deadline(
        url.pathname.endsWith('/store') ? limits.deadlineMs : Math.min(limits.deadlineMs, 15000),
        request.signal,
      );
      const route =
        /^\/projects\/([a-z0-9][a-z0-9-]{0,62})\/(fetch|store|blob\/([0-9a-f-]{36}))$/.exec(
          url.pathname,
        );
      const namespaces: unknown = JSON.parse(env.NAMESPACES);
      if (
        !Array.isArray(namespaces) ||
        namespaces.length > 100 ||
        namespaces.some((value) => typeof value !== 'string')
      )
        throw new Error('Invalid namespaces');
      const known = route && namespaces.includes(route[1]);
      if (known) {
        scopeId = route[1]!;
        operation = route[2]!.startsWith('blob/') ? 'blob' : route[2]!;
      }
      const limiter =
        operation === 'store' || url.pathname.endsWith('/store')
          ? env.STORE_LIMITER
          : env.READ_LIMITER;
      const rateLimit = await deadline.run(
        limiter.limit({ key: known ? `${scopeId}:${operation}` : 'unknown' }),
      );
      if (!rateLimit.success) throw new HttpError(429, 'rate_limit');
      if (!known || url.search || request.method !== (operation === 'blob' ? 'GET' : 'POST'))
        throw new HttpError(404, 'unknown_route');
      release = admission.acquire(operation === 'store');
      const scope = await deadline.run(getScope(env.INDEX, scopeId, stats));
      if (operation === 'store') {
        identity = await deadline.run(authorize(request, scope, keys));
        response = await store(request, env, ctx, scope, identity, limits, deadline, stats);
        outcome = 'stored';
      } else if (operation === 'fetch') {
        const result = await fetchMetadata(request, env, scopeId, limits, deadline, stats);
        response = cborResponse(result);
        outcome = result.kind;
      } else {
        const selected = await deadline.run(selectBlob(env.INDEX, scopeId, route[3]!, stats));
        if (!selected) throw new HttpError(404, 'blob_missing');
        stats.r2_operations++;
        const object = await deadline
          .run(env.ARTIFACTS.get(selected.blob_object))
          .catch(() => unavailable());
        if (!object) throw new HttpError(404, 'blob_missing');
        if (object.size !== selected.blob_size) unavailable();
        response = new Response(object.body, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(object.size),
            'Cache-Control': 'no-store',
          },
        });
        outcome = 'blob';
      }
    } catch (error) {
      response = errorResponse(error);
      if (error instanceof HttpError) outcome = error.code;
    } finally {
      deadline?.dispose();
      release?.();
    }
    response.headers.set('X-Request-Id', id);
    response.headers.set('X-Remote-Cache-Deployment', env.DEPLOYMENT_ID ?? 'local');
    const sample = Math.min(1, Math.max(0, Number(env.LOG_SAMPLE_RATE) || 0));
    // Fixed sampling bounds error volume as well as successful request volume.
    if (Math.random() < sample)
      console.log(
        JSON.stringify({
          request_id: id,
          scope: scopeId,
          operation,
          status: response.status,
          outcome,
          ...(response.status >= 400 ? { error_class: outcome } : {}),
          response_bytes: Number(response.headers.get('Content-Length') ?? 0),
          duration_ms: Date.now() - started,
          ...stats.toJSON(),
          ...(stats.d1_storage_bytes >= 400000000 ? { warning: 'd1_storage_400mb' } : {}),
          ...(identity
            ? {
                repository_id: identity.repository_id,
                workflow_ref: identity.workflow_ref,
                run_id: identity.run_id,
                run_attempt: identity.run_attempt,
                sha: identity.sha,
                event_name: identity.event_name,
                head_ref: identity.head_ref,
              }
            : {}),
        }),
      );
    return response;
  },
  async scheduled(_event, env) {
    await cleanup(env);
  },
} satisfies ExportedHandler<Env>;
