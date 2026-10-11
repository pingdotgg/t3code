import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type { ConnectionsGitRepositoryLink } from "./ConnectionsGitRepositoryLink.ts";
import { bindGcpHost } from "../Host.ts";
import { type BindingIam, grantFor } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for Developer Connect git repository link
 * bindings. NOT exported from index.ts.
 *
 * Distilled ops are `OperationMethod`s: yield them once at Layer
 * construction (after providing Credentials + HttpClient) so the inner
 * runtime Effect is `Effect<A, E>` and does not leak `GcpOpContext`.
 */
export const makeGitRepositoryLinkHttpBinding = <
  I extends { gitRepositoryLink: string },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: Effect.Effect<
    (input: I) => Effect.Effect<A, E>,
    never,
    Credentials | HttpClient.HttpClient
  >;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* <T extends ConnectionsGitRepositoryLink>(
      link: T,
    ) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: link,
        iam: [grantFor(options.iam, link.name)],
      });
      const name = yield* link.name;
      return Effect.fn(`${options.tag}(${link.LogicalId})`)(function* (
        request?: Omit<I, "gitRepositoryLink">,
      ) {
        const gitRepositoryLink = yield* name;
        return yield* run({
          ...(request ?? {}),
          gitRepositoryLink,
        } as I);
      });
    });
  });
