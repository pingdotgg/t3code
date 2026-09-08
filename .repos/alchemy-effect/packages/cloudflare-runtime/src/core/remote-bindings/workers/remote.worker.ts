import { newWorkersRpcResponse } from "capnweb";
import { EmailMessage } from "cloudflare:email";
import { ConfigError, SystemError } from "../../RuntimeError.shared.ts";
import { makeErrorResponse } from "../../internal/response.shared.ts";

interface Env extends Record<string, unknown> {}

class BindingNotFoundError extends Error {
  readonly bindingName?: string;
  constructor(name?: string) {
    super(
      name
        ? `Binding "${name}" not found in remote worker bindings.`
        : "Missing binding name in remote-binding request.",
    );
    this.bindingName = name;
  }
}

/**
 * For most bindings, we expose them as
 *  - RPC stubs directly to capnweb, or
 *  - HTTP based fetchers
 * Failures are encoded with the shared {@link makeErrorResponse} helper so
 * the upstream proxy can rehydrate a structured tagged error.
 *
 * However, there are some special cases:
 *  - SendEmail bindings need to take EmailMessage as their first parameter,
 *    which is not serialisable. As such, we reconstruct it before sending it
 *    on to the binding. See packages/miniflare/src/workers/email/email.worker.ts
 *  - Dispatch Namespace bindings have a synchronous .get() method. Since we
 *    can't emulate that over an async boundary, we mock it locally and _actually_
 *    perform the .get() remotely at the first appropriate async point. See
 *    packages/miniflare/src/workers/dispatch-namespace/dispatch-namespace.worker.ts
 *
 * getExposedJSRPCBinding() and getExposedFetcher() perform the logic for figuring out
 * which binding is being accessed, dependending on the request. Note: Both have logic
 * for dispatch namespaces, because dispatch namespaces can use both fetch or RPC depending
 * on context.
 */

function getExposedJSRPCBinding(request: Request, env: Env) {
  const url = new URL(request.url);
  const bindingName = url.searchParams.get("MF-Binding");
  if (!bindingName) {
    throw new BindingNotFoundError();
  }

  const targetBinding = env[bindingName];
  if (!targetBinding) {
    throw new BindingNotFoundError(bindingName);
  }

  if (targetBinding.constructor.name === "SendEmail") {
    return {
      async send(e: any) {
        // Check if this is an EmailMessage (has EmailMessage::raw property) or MessageBuilder
        if ("EmailMessage::raw" in e) {
          // EmailMessage API - reconstruct the EmailMessage object
          const message = new EmailMessage(
            e.from,
            e.to,
            e["EmailMessage::raw"],
          );
          return (targetBinding as SendEmail).send(message);
        } else {
          // MessageBuilder API - pass through directly as a plain object
          return (targetBinding as SendEmail).send(e);
        }
      },
    };
  }

  if (url.searchParams.has("MF-Dispatch-Namespace-Options")) {
    const { name, args, options } = JSON.parse(
      url.searchParams.get("MF-Dispatch-Namespace-Options")!,
    );
    return (targetBinding as DispatchNamespace).get(name, args, options);
  }

  return targetBinding;
}

function getExposedFetcher(request: Request, env: Env) {
  const bindingName = request.headers.get("MF-Binding");
  if (!bindingName) {
    throw new BindingNotFoundError();
  }

  const targetBinding = env[bindingName];
  if (!targetBinding) {
    throw new BindingNotFoundError(bindingName);
  }

  // Special case the Dispatch Namespace binding because it has a top-level synchronous .get() call
  const dispatchNamespaceOptions = request.headers.get(
    "MF-Dispatch-Namespace-Options",
  );
  if (dispatchNamespaceOptions) {
    const { name, args, options } = JSON.parse(dispatchNamespaceOptions);
    return (targetBinding as DispatchNamespace).get(name, args, options);
  }
  return targetBinding as Fetcher;
}

/**
 * This Worker can proxy two types of remote binding:
 *  1. "raw" bindings, where this Worker has been configured to pass through the raw
 *     fetch from a local workerd instance to the relevant binding
 *  2. JSRPC bindings, where this Worker uses capnweb to proxy RPC
 *     communication in userland. This is always over a WebSocket connection
 */
function isJSRPCBinding(request: Request): boolean {
  const url = new URL(request.url);
  return request.headers.has("Upgrade") && url.searchParams.has("MF-Binding");
}

export default {
  async fetch(request, env) {
    try {
      if (isJSRPCBinding(request)) {
        return await newWorkersRpcResponse(
          request,
          getExposedJSRPCBinding(request, env),
        );
      } else {
        const fetcher = getExposedFetcher(request, env);
        const originalHeaders = new Headers();
        for (const [name, value] of request.headers) {
          if (name.startsWith("mf-header-")) {
            originalHeaders.set(name.slice("mf-header-".length), value);
          } else if (name === "upgrade") {
            // The `Upgrade` header needs to be special-cased to prevent:
            //   TypeError: Worker tried to return a WebSocket in a response to a request which did not contain the header "Upgrade: websocket"
            originalHeaders.set(name, value);
          }
        }

        return await fetcher.fetch(
          request.headers.get("MF-URL") ?? "http://example.com",
          new Request(request, {
            redirect: "manual",
            headers: originalHeaders,
          }),
        );
      }
    } catch (e) {
      if (e instanceof BindingNotFoundError) {
        return makeErrorResponse(
          new ConfigError({
            subtag: "BindingNotFound",
            message: e.message,
            hint: e.bindingName
              ? `Add "${e.bindingName}" to the worker's bindings or remove the reference to it.`
              : undefined,
            detail: { bindingName: e.bindingName },
          }),
          { status: 400 },
        );
      }
      const message = e instanceof Error ? e.message : String(e);
      return makeErrorResponse(
        new SystemError({
          subtag: "RemoteBindingProxy",
          message: `Remote binding handler threw an error: ${message}`,
          cause: e,
        }),
      );
    }
  },
} satisfies ExportedHandler<Env>;
