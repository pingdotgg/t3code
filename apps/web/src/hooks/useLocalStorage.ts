import * as Schema from "effect/Schema";
import * as Record from "effect/Record";
import { useCallback, useMemo, useSyncExternalStore } from "react";

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

const decode = <T, E>(schema: Schema.Codec<T, E>, value: string) => {
  const decodeJson = Schema.decodeSync(Schema.fromJsonString(schema));
  return decodeJson(value);
};

const encode = <T, E>(schema: Schema.Codec<T, E>, value: T) => {
  const encodeJson = Schema.encodeSync(Schema.fromJsonString(schema));
  return encodeJson(value);
};

export const getLocalStorageItem = <T, E>(key: string, schema: Schema.Codec<T, E>): T | null => {
  const item = isomorphicLocalStorage.getItem(key);
  return item ? decode(schema, item) : null;
};

export const setLocalStorageItem = <T, E>(key: string, value: T, schema: Schema.Codec<T, E>) => {
  const valueToSet = encode(schema, value);
  isomorphicLocalStorage.setItem(key, valueToSet);
};

export const removeLocalStorageItem = (key: string) => {
  isomorphicLocalStorage.removeItem(key);
};

const LOCAL_STORAGE_CHANGE_EVENT = "t3code:local_storage_change";

interface LocalStorageChangeDetail {
  key: string;
}

function dispatchLocalStorageChange(key: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<LocalStorageChangeDetail>(LOCAL_STORAGE_CHANGE_EVENT, {
      detail: { key },
    }),
  );
}

export function useLocalStorage<T, E>(
  key: string,
  initialValue: T,
  schema: Schema.Codec<T, E>,
): [T, (value: T | ((val: T) => T)) => void] {
  const getSnapshot = useCallback(() => {
    try {
      return isomorphicLocalStorage.getItem(key);
    } catch (error) {
      console.error("[LOCALSTORAGE] Error:", error);
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
      return decode(schema, serializedValue);
    } catch (error) {
      console.error("[LOCALSTORAGE] Error:", error);
      return initialValue;
    }
  }, [initialValue, schema, serializedValue]);

  const setValue = useCallback(
    (value: T | ((val: T) => T)) => {
      try {
        const currentValue = getLocalStorageItem(key, schema) ?? initialValue;
        const valueToStore =
          typeof value === "function" ? (value as (val: T) => T)(currentValue) : value;
        if (valueToStore === null) {
          removeLocalStorageItem(key);
        } else {
          setLocalStorageItem(key, valueToStore, schema);
        }
        dispatchLocalStorageChange(key);
      } catch (error) {
        console.error("[LOCALSTORAGE] Error:", error);
      }
    },
    [initialValue, key, schema],
  );

  return [storedValue, setValue];
}
