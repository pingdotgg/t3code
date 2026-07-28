import {
  type DesktopBackendMode as DesktopBackendModeValue,
  type DesktopBackendModeState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

const BACKEND_MODE_FLAG = "--backend-mode";

export class DesktopBackendModeArgumentError extends Schema.TaggedErrorClass<DesktopBackendModeArgumentError>()(
  "DesktopBackendModeArgumentError",
  {
    value: Schema.NullOr(Schema.String),
    reason: Schema.Literals(["missing-value", "invalid-value", "repeated"]),
  },
) {
  override get message(): string {
    if (this.reason === "missing-value") {
      return `${BACKEND_MODE_FLAG} requires either "managed" or "client-only".`;
    }
    if (this.reason === "repeated") {
      return `${BACKEND_MODE_FLAG} may only be specified once.`;
    }
    return `Invalid ${BACKEND_MODE_FLAG} value ${JSON.stringify(this.value)}. Expected "managed" or "client-only".`;
  }
}

export const isDesktopBackendModeArgumentError = Schema.is(DesktopBackendModeArgumentError);

function parseBackendMode(value: string | undefined): DesktopBackendModeValue {
  if (value === undefined || value.length === 0) {
    throw new DesktopBackendModeArgumentError({
      value: value ?? null,
      reason: "missing-value",
    });
  }
  if (value === "managed" || value === "client-only") {
    return value;
  }
  throw new DesktopBackendModeArgumentError({
    value,
    reason: "invalid-value",
  });
}

export function parseDesktopBackendModeOverride(
  argv: readonly string[],
): DesktopBackendModeValue | null {
  let override: DesktopBackendModeValue | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;

    let value: string | undefined;
    if (argument === BACKEND_MODE_FLAG) {
      value = argv[index + 1];
      index += 1;
    } else if (argument.startsWith(`${BACKEND_MODE_FLAG}=`)) {
      value = argument.slice(BACKEND_MODE_FLAG.length + 1);
    } else {
      continue;
    }

    if (override !== null) {
      throw new DesktopBackendModeArgumentError({
        value: value ?? null,
        reason: "repeated",
      });
    }
    override = parseBackendMode(value);
  }

  return override;
}

export function resolveDesktopBackendModeState(
  argv: readonly string[],
  configuredMode: DesktopBackendModeValue,
): DesktopBackendModeState {
  const cliOverride = parseDesktopBackendModeOverride(argv);
  return {
    effectiveMode: cliOverride ?? configuredMode,
    configuredMode,
    cliOverride,
  };
}

export class DesktopBackendMode extends Context.Service<
  DesktopBackendMode,
  {
    readonly latch: (
      configuredMode: DesktopBackendModeValue,
    ) => Effect.Effect<DesktopBackendModeState, DesktopBackendModeArgumentError>;
    readonly get: Effect.Effect<DesktopBackendModeState>;
  }
>()("@t3tools/desktop/app/DesktopBackendMode") {}

export const make = Effect.fn("desktop.backendMode.make")(function* (argv: readonly string[]) {
  const stateRef = yield* Ref.make<DesktopBackendModeState>({
    effectiveMode: "managed",
    configuredMode: "managed",
    cliOverride: null,
  });

  return DesktopBackendMode.of({
    latch: (configuredMode) =>
      Effect.try({
        try: () => resolveDesktopBackendModeState(argv, configuredMode),
        catch: (cause) =>
          isDesktopBackendModeArgumentError(cause)
            ? cause
            : new DesktopBackendModeArgumentError({
                value: null,
                reason: "invalid-value",
              }),
      }).pipe(Effect.tap((state) => Ref.set(stateRef, state))),
    get: Ref.get(stateRef),
  });
});

export const layer = Layer.effect(DesktopBackendMode, make(process.argv));

export const layerTest = (argv: readonly string[] = []) =>
  Layer.effect(DesktopBackendMode, make(argv));
