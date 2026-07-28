import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Input } from "../../Input.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { AddressList } from "./AddressList.ts";
import type { Archive } from "./Archive.ts";

/**
 * Shared scaffolding for SES Mail Manager HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below. Everything except the operation, the injected identifier, and the
 * IAM action list is boilerplate.
 */

const registerHostPolicy = Effect.fn(function* (
  tag: string,
  resource: AddressList | Archive,
  arn: Input<string>,
  actions: readonly string[],
) {
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    const host = yield* Binding.Host;
    if (isBindingHost(host)) {
      yield* host.bind`Allow(${host}, ${tag}(${resource}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: [...actions],
            Resource: [arn],
          },
        ],
      });
    }
  }
});

/**
 * Build the impl Effect for a Mail Manager operation scoped to an
 * {@link AddressList} whose request carries `AddressListId`: the deploy-time
 * half grants `actions` on the bound list's ARN, and the runtime half
 * injects the list's id into every request.
 */
export const makeAddressListHttpBinding = <
  I extends { AddressListId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.MailManager.GetMemberOfAddressList`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the address list ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (list: AddressList) {
      const AddressListId = yield* list.addressListId;
      yield* registerHostPolicy(
        options.tag,
        list,
        list.addressListArn,
        options.actions,
      );
      return Effect.fn(`${options.tag}(${list.LogicalId})`)(function* (
        request: Omit<I, "AddressListId">,
      ) {
        const addressListId = yield* AddressListId;
        return yield* op({ ...request, AddressListId: addressListId } as I);
      });
    });
  });

/**
 * Build the impl Effect for a Mail Manager import-job operation scoped to an
 * {@link AddressList} but keyed by `JobId` (the id of a job created against
 * that list): the deploy-time half grants `actions` on the bound list's ARN;
 * the runtime half passes the caller's request through unchanged.
 */
export const makeAddressListJobHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.MailManager.StartAddressListImportJob`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the address list ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (list: AddressList) {
      yield* registerHostPolicy(
        options.tag,
        list,
        list.addressListArn,
        options.actions,
      );
      return Effect.fn(`${options.tag}(${list.LogicalId})`)(function* (
        request: I,
      ) {
        return yield* op(request);
      });
    });
  });

/**
 * Build the impl Effect for a Mail Manager operation scoped to an
 * {@link Archive} whose request carries `ArchiveId`: the deploy-time half
 * grants `actions` on the bound archive's ARN, and the runtime half injects
 * the archive's id into every request.
 */
export const makeArchiveHttpBinding = <
  I extends { ArchiveId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.MailManager.StartArchiveSearch`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the archive ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (archive: Archive) {
      const ArchiveId = yield* archive.archiveId;
      yield* registerHostPolicy(
        options.tag,
        archive,
        archive.archiveArn,
        options.actions,
      );
      return Effect.fn(`${options.tag}(${archive.LogicalId})`)(function* (
        request: Omit<I, "ArchiveId">,
      ) {
        const archiveId = yield* ArchiveId;
        return yield* op({ ...request, ArchiveId: archiveId } as I);
      });
    });
  });

/**
 * Build the impl Effect for a Mail Manager operation scoped to an
 * {@link Archive} but keyed by a task id (`SearchId`, `ExportId`,
 * `ArchivedMessageId`): the deploy-time half grants `actions` on the bound
 * archive's ARN; the runtime half passes the caller's request through
 * unchanged.
 */
export const makeArchiveTaskHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.MailManager.GetArchiveSearchResults`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the archive ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (archive: Archive) {
      yield* registerHostPolicy(
        options.tag,
        archive,
        archive.archiveArn,
        options.actions,
      );
      return Effect.fn(`${options.tag}(${archive.LogicalId})`)(function* (
        request: I,
      ) {
        return yield* op(request);
      });
    });
  });
