import { type AccountId, mainAccountId } from "@bank/domain/Account/Account.id";
import { CustomerId } from "@bank/domain/Customer/Customer.id";
import { Username } from "@bank/domain/Customer/Username";
import type { CustomerApi } from "@bank/domain/CustomerApi.api";
import { TransferId } from "@bank/domain/Transfer/Transfer.id";
import { TransferStatus } from "@bank/domain/Transfer/TransferStatus.view";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

/** A CustomerApi client, signed in as one customer. */
export type CustomerClient = Effect.Success<typeof CustomerApi.client>;

/** The demo MFA code `MfaChallenge` accepts. */
export const mfa = { headers: { "x-mfa-code": "000000" } };

/**
 * Register, then watch the customer's dashboard until `UsernameReservation`
 * and `MainAccountProvisioning` have opened the main account. The username
 * defaults to the customer id.
 */
export const register = Effect.fn(function* (
  client: CustomerClient,
  customerId: string,
  name: string,
  username: string = customerId,
) {
  const id = CustomerId.make(customerId);
  yield* client.RegisterCustomer(id, { name, username: Username.make(username) });
  const accountId = mainAccountId(id);
  yield* client.CustomerDashboard.watch(id).pipe(
    Stream.map(({ state }) => state),
    Stream.filter((dashboard) => dashboard !== null && accountId in dashboard.balances),
    Stream.runHead,
    Effect.timeout("20 seconds"),
  );
  return accountId;
});

/**
 * Request a transfer under an id the client chooses (so a retry is
 * idempotent), then watch its status until `TransferExecution` has completed
 * or failed it.
 */
export const transfer = Effect.fn(function* (
  client: CustomerClient,
  request: {
    readonly transferId: string;
    readonly from: AccountId;
    readonly to: AccountId;
    readonly amount: number;
  },
) {
  const transferId = TransferId.make(request.transferId);
  yield* client.RequestTransfer(
    transferId,
    { from: request.from, to: request.to, amount: request.amount },
    mfa,
  );
  const settled = yield* client.TransferStatus.watch(transferId).pipe(
    Stream.map(({ state }) => state),
    Stream.filter(
      (status) => status !== null && (status.completedAt !== null || status.failedReason !== null),
    ),
    Stream.runHead,
    Effect.timeout("20 seconds"),
  );
  const status = Option.getOrThrow(settled)!;
  return {
    transferId,
    status: TransferStatus.computed.status(status),
    reason: status.failedReason,
  };
});
