import * as Schema from "effect/Schema";
import * as Record from "effect/Record";
import { useCallback, useMemo, useSyncExternalStore } from "react";

export class LocalStorageOperationError extends Schema.TaggedErrorClass<LocalStorageOperationError>()(
  "LocalStorageOperationError",
  {
    operation: Schema.Literals(["read", "decode", "encode", "update", "write", "remove", "notify"]),
    storageKey: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} local storage item ${this.storageKey}.`;
  }
}

const isomorphicLocalStorage: Storage =
  typeof window !== "undefined"
    ? window.localStorage
    : (function () {
        const store = new Map<string, string>();
        return {
          clear: () => store.clear(),
          getItem: (_) => store.get(_) ?? null,
          key: (_) => Record.keys(store).at(_) ?? null,
          get length() {
            return store.size;
          },
          removeItem: (_) => store.delete(_),
          setItem: (_, value) => store.set(_, value),
        };
      })();

const read = (key: string) => {
  try {
    return isomorphicLocalStorage.getItem(key);
  } catch (cause) {
    throw new LocalStorageOperationError({ operation: "read", storageKey: key, cause });
  }
};

const decode = <T, E>(key: string, schema: Schema.Codec<T, E>, value: string) => {
  try {
    return Schema.decodeSync(Schema.fromJsonString(schema))(value);
  } catch (cause) {
    throw new LocalStorageOperationError({ operation: "decode", storageKey: key, cause });
  }
};

const encode = <T, E>(key: string, schema: Schema.Codec<T, E>, value: T) => {
  try {
    return Schema.encodeSync(Schema.fromJsonString(schema))(value);
  } catch (cause) {
    throw new LocalStorageOperationError({ operation: "encode", storageKey: key, cause });
  }
};

export const getLocalStorageItem = <T, E>(key: string, schema: Schema.Codec<T, E>): T | null => {
  const item = read(key);
  return item ? decode(key, schema, item) : null;
};

export const setLocalStorageItem = <T, E>(key: string, value: T, schema: Schema.Codec<T, E>) => {
  const valueToSet = encode(key, schema, value);
  try {
    isomorphicLocalStorage.setItem(key, valueToSet);
  } catch (cause) {
    throw new LocalStorageOperationError({ operation: "write", storageKey: key, cause });
  }
};

export const removeLocalStorageItem = (key: string) => {
  try {
    isomorphicLocalStorage.removeItem(key);
  } catch (cause) {
    throw new LocalStorageOperationError({ operation: "remove", storageKey: key, cause });
  }
};

const LOCAL_STORAGE_CHANGE_EVENT = "t3code:local_storage_change";

interface LocalStorageChangeDetail {
  key: string;
}

function dispatchLocalStorageChange(key: string) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent<LocalStorageChangeDetail>(LOCAL_STORAGE_CHANGE_EVENT, {
        detail: { key },
      }),
    );
  } catch (cause) {
    throw new LocalStorageOperationError({ operation: "notify", storageKey: key, cause });
  }
}

export function useLocalStorage<T, E>(
  key: string,
  initialValue: T,
  schema: Schema.Codec<T, E>,
): [T, (value: T | ((val: T) => T)) => void] {
  const getSnapshot = useCallback(() => {
    try {
      return read(key);
    } catch (error) {
      console.error("[LOCALSTORAGE] Could not read stored value.", error);
      return null;
    }
  }, [key]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const handleStorageChange = (event: StorageEvent) => {
        if (event.key === key) {
          onStoreChange();
        }
      };
      const handleLocalChange = (event: CustomEvent<LocalStorageChangeDetail>) => {
        if (event.detail.key === key) {
          onStoreChange();
        }
      };

      window.addEventListener("storage", handleStorageChange);
      window.addEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocalChange as EventListener);
      return () => {
        window.removeEventListener("storage", handleStorageChange);
        window.removeEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocalChange as EventListener);
      };
    },
    [key],
  );

  const serializedValue = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const storedValue = useMemo(() => {
    if (serializedValue === null) {
      return initialValue;
    }
    try {
      return decode(key, schema, serializedValue);
    } catch (error) {
      console.error("[LOCALSTORAGE] Could not decode stored value.", error);
      return initialValue;
    }
  }, [initialValue, key, schema, serializedValue]);

  const setValue = useCallback(
    (value: T | ((val: T) => T)) => {
      try {
        const currentValue = getLocalStorageItem(key, schema) ?? initialValue;
        let valueToStore: T;
        if (typeof value === "function") {
          try {
            valueToStore = (value as (val: T) => T)(currentValue);
          } catch (cause) {
            throw new LocalStorageOperationError({
              operation: "update",
              storageKey: key,
              cause,
            });
          }
        } else {
          valueToStore = value;
        }
        if (valueToStore === null) {
          removeLocalStorageItem(key);
        } else {
          setLocalStorageItem(key, valueToStore, schema);
        }
        dispatchLocalStorageChange(key);
      } catch (error) {
        console.error("[LOCALSTORAGE] Could not update stored value.", error);
      }
    },
    [initialValue, key, schema],
  );

  return [storedValue, setValue];
}
