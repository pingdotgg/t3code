import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

class Marker extends Context.Service<Marker, { value: string }>()(
  "alarm-callback/types/Marker",
) {}
class TransactionFailure extends Data.TaggedError("TransactionFailure")<{
  value: string;
}> {}

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type SuccessOf<T> =
  T extends Effect.Effect<infer A, infer _E, infer _R> ? A : never;
type ErrorOf<T> =
  T extends Effect.Effect<infer _A, infer E, infer _R> ? E : never;
type RequirementsOf<T> =
  T extends Effect.Effect<infer _A, infer _E, infer R> ? R : never;

const registration = Alchemy.makeCallback(
  "archive",
  Effect.fn(function* (payload: { value: string }) {
    yield* Effect.succeed(payload.value.toUpperCase());
  }),
  { retry: { delay: Duration.seconds(1) } },
);

const contextualRegistration = Alchemy.makeCallback(
  "contextual",
  Effect.fn(function* (payload: { value: string }) {
    const marker = yield* Marker;
    yield* Effect.addFinalizer(() => Effect.void);
    return `${marker.value}:${payload.value}`;
  }),
);

const scopedRegistration = Alchemy.makeCallback(
  "scoped",
  Effect.fn(function* (_payload: { value: string }) {
    yield* Effect.addFinalizer(() => Effect.void);
  }),
);

type _PortableRegistration = Assert<
  Equal<RequirementsOf<typeof registration>, Alchemy.RuntimeContext>
>;
type _RegistrationHasNoTypedError = Assert<
  Equal<ErrorOf<typeof registration>, never>
>;
type _PreservesHandlerRequirements = Assert<
  Equal<
    RequirementsOf<typeof contextualRegistration>,
    Alchemy.RuntimeContext | Marker
  >
>;
type _SuppliesHandlerScope = Assert<
  Equal<RequirementsOf<typeof scopedRegistration>, Alchemy.RuntimeContext>
>;

type Handle = SuccessOf<typeof registration>;
type _PortableHandle = Assert<
  Equal<Handle, Alchemy.Callback<{ value: string }>>
>;
type Options = Parameters<Handle["schedule"]>[1];
type _PortableScheduleOptions = Assert<
  Equal<Options, Alchemy.CallbackScheduleOptions<{ value: string }>>
>;
type _PortableRegistrationOptions = Assert<
  Equal<
    Parameters<typeof Alchemy.makeCallback>[2],
    Alchemy.CallbackOptions | undefined
  >
>;
type _InfersPayload = Assert<Equal<Options["payload"], { value: string }>>;
type _RequiresStringId = Assert<
  Equal<Parameters<Handle["schedule"]>[0], string>
>;
type _ScheduleIsRuntimeOnly = Assert<
  Equal<RequirementsOf<ReturnType<Handle["schedule"]>>, Alchemy.RuntimeContext>
>;
type _CancelIsRuntimeOnly = Assert<
  Equal<RequirementsOf<ReturnType<Handle["cancel"]>>, Alchemy.RuntimeContext>
>;
type _ScheduleErrorIsPortable = Assert<
  Equal<ErrorOf<ReturnType<Handle["schedule"]>>, Alchemy.CallbackError>
>;
type _CancelErrorIsPortable = Assert<
  Equal<ErrorOf<ReturnType<Handle["cancel"]>>, Alchemy.CallbackError>
>;

const instance = Effect.gen(function* () {
  yield* registration;
  yield* scopedRegistration;
  return { ping: () => Effect.succeed("pong") };
});

class CallbackObject extends Cloudflare.DurableObject<CallbackObject>()(
  "CallbackTypes",
  Effect.succeed(instance),
) {}

type _InstanceConsumesCallbacks = Assert<
  Equal<RequirementsOf<typeof CallbackObject>, Cloudflare.Worker>
>;

class ModularCallbackObject extends Cloudflare.DurableObject<
  ModularCallbackObject,
  SuccessOf<typeof instance>
>()("ModularCallbackTypes") {}

const instanceLayer = ModularCallbackObject.make(Effect.succeed(instance));
type _InstanceLayerConsumesCallbacks = Assert<
  Equal<Layer.Services<typeof instanceLayer>, Cloudflare.Worker>
>;

export const schedulingTypes = Effect.gen(function* () {
  const onArchive = yield* registration;
  yield* onArchive.schedule("relative-string", {
    after: "1 second",
    payload: { value: "archive" },
  });
  yield* onArchive.schedule("relative-duration", {
    after: Duration.seconds(1),
    payload: { value: "archive" },
  });
  yield* onArchive.schedule("relative-millis", {
    after: 1_000,
    payload: { value: "archive" },
  });
  yield* onArchive.schedule("absolute-date", {
    at: new Date(1_000),
    payload: { value: "archive" },
  });
  yield* onArchive.schedule("absolute-millis", {
    at: 1_000,
    payload: { value: "archive" },
  });
  yield* onArchive.cancel("archive");

  const wrongPayload = { at: 1_000, payload: { value: 123 } };
  // @ts-expect-error The handler's payload type determines the schedule payload.
  onArchive.schedule("wrong-payload", wrongPayload);
  const missingPayload = { at: 1_000 };
  // @ts-expect-error Scheduling requires the handler payload.
  onArchive.schedule("missing-payload", missingPayload);
  const noTime = { payload: { value: "archive" } };
  // @ts-expect-error Scheduling requires either after or at.
  onArchive.schedule("missing-time", noTime);
  const bothTimes = { after: 1_000, at: 1_000, payload: { value: "archive" } };
  // @ts-expect-error Relative and absolute scheduling are mutually exclusive.
  onArchive.schedule("both-times", bothTimes);
  const invalidDate = { at: "tomorrow", payload: { value: "archive" } };
  // @ts-expect-error Absolute scheduling accepts only Date or epoch milliseconds.
  onArchive.schedule("invalid-date", invalidDate);
  // @ts-expect-error The logical ID is the first positional argument.
  onArchive.schedule({
    id: "inline",
    at: 1_000,
    payload: { value: "archive" },
  });
  // @ts-expect-error Cancellation requires a string ID.
  onArchive.cancel(123);
});

const directTransaction = (storage: Cloudflare.DurableObjectStorage) =>
  storage.transaction(
    Effect.gen(function* () {
      const marker = yield* Marker;
      yield* storage.put("value", marker.value);
      return yield* Effect.fail(
        new TransactionFailure({ value: marker.value }),
      );
    }),
  );

const callbackTransaction = (storage: Cloudflare.DurableObjectStorage) =>
  storage.transaction(
    Effect.fn(function* (transaction: Cloudflare.DurableObjectTransaction) {
      const marker = yield* Marker;
      yield* transaction.put("value", marker.value);
      return yield* Effect.fail(
        new TransactionFailure({ value: marker.value }),
      );
    }),
  );

type _DirectPreservesError = Assert<
  Equal<
    ErrorOf<ReturnType<typeof directTransaction>>,
    TransactionFailure | Cloudflare.DurableObjectStorageError
  >
>;
type _CallbackPreservesError = Assert<
  Equal<
    ErrorOf<ReturnType<typeof callbackTransaction>>,
    TransactionFailure | Cloudflare.DurableObjectStorageError
  >
>;
type _DirectPreservesContext = Assert<
  Equal<
    RequirementsOf<ReturnType<typeof directTransaction>>,
    Marker | Alchemy.RuntimeContext
  >
>;
type _CallbackPreservesContext = Assert<
  Equal<
    RequirementsOf<ReturnType<typeof callbackTransaction>>,
    Marker | Alchemy.RuntimeContext
  >
>;
