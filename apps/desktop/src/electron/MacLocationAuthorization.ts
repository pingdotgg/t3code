import * as Effect from "effect/Effect";

const AUTHORIZATION_NOT_DETERMINED = 0;
const AUTHORIZATION_AUTHORIZED_ALWAYS = 3;
const AUTHORIZATION_AUTHORIZED_WHEN_IN_USE = 4;
const AUTHORIZATION_TIMEOUT_MS = 120_000;

const isAuthorized = (status: number) =>
  status === AUTHORIZATION_AUTHORIZED_ALWAYS || status === AUTHORIZATION_AUTHORIZED_WHEN_IN_USE;

const createAuthorizationApi = async () => {
  const { DataType, load, open } = await import("ffi-rs");
  const library = "t3-location-objc";
  open({
    library: "t3-core-location",
    path: "/System/Library/Frameworks/CoreLocation.framework/CoreLocation",
  });
  open({ library, path: "/usr/lib/libobjc.A.dylib" });

  const selector = (name: string) =>
    load({
      library,
      funcName: "sel_registerName",
      retType: DataType.BigInt,
      paramsType: [DataType.String],
      paramsValue: [name],
    }) as bigint;
  const sendPointer = (receiver: bigint, name: string) =>
    load({
      library,
      funcName: "objc_msgSend",
      retType: DataType.BigInt,
      paramsType: [DataType.BigInt, DataType.BigInt],
      paramsValue: [receiver, selector(name)],
    }) as bigint;
  const managerClass = load({
    library,
    funcName: "objc_getClass",
    retType: DataType.BigInt,
    paramsType: [DataType.String],
    paramsValue: ["CLLocationManager"],
  }) as bigint;
  const manager = sendPointer(sendPointer(managerClass, "alloc"), "init");
  if (manager === 0n) throw new Error("macOS location authorization is unavailable.");
  const statusSelector = selector("authorizationStatus");
  const requestSelector = selector("requestWhenInUseAuthorization");

  const getStatus = () =>
    load({
      library,
      funcName: "objc_msgSend",
      retType: DataType.I32,
      paramsType: [DataType.BigInt, DataType.BigInt],
      paramsValue: [manager, statusSelector],
    });
  let pendingAuthorization: Promise<boolean> | undefined;

  // CLLocationManager must stay alive and run on Electron's main thread while
  // the system consent dialog is pending. ffi-rs calls are synchronous here.
  return {
    isAuthorized: () => {
      try {
        return isAuthorized(getStatus());
      } catch {
        return false;
      }
    },
    request: (): Promise<boolean> => {
      pendingAuthorization ??= Effect.runPromise(
        Effect.gen(function* () {
          let status = getStatus();
          if (status !== AUTHORIZATION_NOT_DETERMINED) return isAuthorized(status);
          load({
            library,
            funcName: "objc_msgSend",
            retType: DataType.Void,
            paramsType: [DataType.BigInt, DataType.BigInt],
            paramsValue: [manager, requestSelector],
          });
          do {
            yield* Effect.sleep(250);
            status = getStatus();
          } while (status === AUTHORIZATION_NOT_DETERMINED);
          return isAuthorized(status);
        }).pipe(
          Effect.timeoutOrElse({
            duration: AUTHORIZATION_TIMEOUT_MS,
            orElse: () => Effect.succeed(false),
          }),
        ),
      ).finally(() => {
        pendingAuthorization = undefined;
      });
      return pendingAuthorization;
    },
  };
};

let authorizationApi: ReturnType<typeof createAuthorizationApi> | undefined;

/** Loads the native status reader without prompting for access. */
export const loadMacLocationAuthorization = () => (authorizationApi ??= createAuthorizationApi());
