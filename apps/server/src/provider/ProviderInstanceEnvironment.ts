import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  platform: NodeJS.Platform,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const normalizeName = (name: PropertyKey): PropertyKey =>
    platform === "win32" && typeof name === "string" ? name.toUpperCase() : name;
  const resolveBaseName = (name: PropertyKey): PropertyKey => {
    if (Object.hasOwn(baseEnv, name) || platform !== "win32" || typeof name !== "string") {
      return name;
    }
    const normalizedName = normalizeName(name);
    return (
      Reflect.ownKeys(baseEnv).find((candidate) => normalizeName(candidate) === normalizedName) ??
      name
    );
  };

  // Drivers retain this object for their full lifetime. Keep inherited values live so
  // host PATH hydration reaches existing instances, while instance overrides stay fixed.
  const overrides: NodeJS.ProcessEnv = {};
  for (const variable of environment) {
    overrides[normalizeName(variable.name) as string] = variable.value;
  }

  return new Proxy(overrides, {
    get: (target, property, receiver) => {
      const overrideName = normalizeName(property);
      return Object.hasOwn(target, overrideName)
        ? Reflect.get(target, overrideName, receiver)
        : Reflect.get(baseEnv, resolveBaseName(property), baseEnv);
    },
    set: (target, property, value, receiver) =>
      Reflect.set(target, normalizeName(property), value, receiver),
    has: (target, property) =>
      Object.hasOwn(target, normalizeName(property)) ||
      Reflect.has(baseEnv, resolveBaseName(property)),
    ownKeys: (target) => {
      const overrideNames = new Set(Reflect.ownKeys(target).map(normalizeName));
      return [
        ...Reflect.ownKeys(target),
        ...Reflect.ownKeys(baseEnv).filter(
          (baseName) => !overrideNames.has(normalizeName(baseName)),
        ),
      ];
    },
    getOwnPropertyDescriptor: (target, property) => {
      const overrideDescriptor = Reflect.getOwnPropertyDescriptor(target, normalizeName(property));
      if (overrideDescriptor !== undefined) {
        return overrideDescriptor;
      }
      const baseName = resolveBaseName(property);
      if (!Object.hasOwn(baseEnv, baseName)) {
        return undefined;
      }
      return {
        configurable: true,
        enumerable: true,
        writable: true,
        value: Reflect.get(baseEnv, baseName, baseEnv),
      };
    },
  });
}
