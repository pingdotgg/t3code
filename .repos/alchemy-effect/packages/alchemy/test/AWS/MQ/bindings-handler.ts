import * as Lambda from "@/AWS/Lambda";
import * as MQ from "@/AWS/MQ";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "bindings-handler.ts");

export class MQBindingsFunction extends Lambda.Function<Lambda.Function>()(
  "MQBindingsFunction",
) {}

export default MQBindingsFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // A single-instance mq.t3.micro ActiveMQ broker is the cheapest topology
    // and the only engine whose user APIs (CreateUser/UpdateUser/...) are
    // supported. Omitting engineVersion lets AWS pick the current default.
    const broker = yield* MQ.Broker("BindingsBroker", {
      engineType: "ACTIVEMQ",
      hostInstanceType: "mq.t3.micro",
      deploymentMode: "SINGLE_INSTANCE",
      publiclyAccessible: true,
      users: [
        {
          username: "alchemyadmin",
          password: Redacted.make("SuperSecretPassw0rd!"),
        },
      ],
    });

    const describeBroker = yield* MQ.DescribeBroker(broker);
    const rebootBroker = yield* MQ.RebootBroker(broker);
    const promote = yield* MQ.Promote(broker);
    const createUser = yield* MQ.CreateUser(broker);
    const updateUser = yield* MQ.UpdateUser(broker);
    const deleteUser = yield* MQ.DeleteUser(broker);
    const describeUser = yield* MQ.DescribeUser(broker);
    const listUsers = yield* MQ.ListUsers(broker);
    const listBrokers = yield* MQ.ListBrokers();

    const bound = {
      describeBroker,
      rebootBroker,
      promote,
      createUser,
      updateUser,
      deleteUser,
      describeUser,
      listUsers,
      listBrokers,
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

        if (request.method === "GET" && pathname === "/broker") {
          // BrokerId injection scopes the call to the bound broker.
          const response = yield* describeBroker();
          return yield* HttpServerResponse.json({
            brokerName: response.BrokerName,
            brokerState: response.BrokerState,
          });
        }

        if (request.method === "GET" && pathname === "/brokers") {
          const response = yield* listBrokers();
          return yield* HttpServerResponse.json({
            count: (response.BrokerSummaries ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/users") {
          const response = yield* listUsers();
          return yield* HttpServerResponse.json({
            count: (response.Users ?? []).length,
          });
        }

        if (request.method === "POST" && pathname === "/users") {
          // Full staged-user round-trip: create stages a CREATE pending
          // change, describe reads it back, delete stages the removal — the
          // broker never needs a reboot, so the test stays fast and the
          // stack destroys cleanly.
          yield* createUser({
            Username: "alchemytenant",
            Password: Redacted.make("AnotherSecretPassw0rd!"),
          });
          const described = yield* describeUser({
            Username: "alchemytenant",
          });
          yield* deleteUser({ Username: "alchemytenant" });
          return yield* HttpServerResponse.json({
            created: true,
            describedUsername: described.Username,
            pendingChange: described.Pending?.PendingChange,
            deleted: true,
          });
        }

        if (
          request.method === "POST" &&
          pathname === "/users/typed-not-found"
        ) {
          // UpdateUser on a nonexistent user round-trips the typed
          // NotFoundException — an IAM gap would surface AccessDenied (500),
          // so the typed tag proves grant + injection end-to-end.
          const typed = yield* updateUser({
            Username: "alchemynonexistentuser",
            ConsoleAccess: true,
          }).pipe(
            Effect.map(() => false),
            Effect.catchTag("NotFoundException", () => Effect.succeed(true)),
          );
          return yield* HttpServerResponse.json({ typed });
        }

        if (request.method === "POST" && pathname === "/promote") {
          // The bound broker has no CRDR replication, so Promote returns the
          // typed BadRequestException — proving the grant without touching
          // broker state.
          const typed = yield* promote({ Mode: "SWITCHOVER" }).pipe(
            Effect.map(() => false),
            Effect.catchTag("BadRequestException", () => Effect.succeed(true)),
          );
          return yield* HttpServerResponse.json({ typed });
        }

        if (request.method === "POST" && pathname === "/reboot") {
          // A real reboot of the RUNNING broker — call this from the LAST
          // test; the Broker provider's delete waits for the broker to
          // settle before deleting.
          yield* rebootBroker();
          return yield* HttpServerResponse.json({ rebooting: true });
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
        MQ.DescribeBrokerHttp,
        MQ.RebootBrokerHttp,
        MQ.PromoteHttp,
        MQ.CreateUserHttp,
        MQ.UpdateUserHttp,
        MQ.DeleteUserHttp,
        MQ.DescribeUserHttp,
        MQ.ListUsersHttp,
        MQ.ListBrokersHttp,
      ),
    ),
  ),
);
