import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  CARD_DEFAULT_HEIGHT,
  CARD_MAX_HEIGHT,
  CARD_MIN_HEIGHT,
  selectCardHeight,
  useBoardCardStore,
} from "./boardCardStore.ts";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

beforeEach(() => {
  useBoardCardStore.setState({ byThreadKey: {} });
});

describe("boardCardStore", () => {
  it("setHeight clamps to the min/max card height", () => {
    useBoardCardStore.getState().setHeight(refA, CARD_MIN_HEIGHT - 100);
    expect(selectCardHeight(useBoardCardStore.getState().byThreadKey, refA)).toBe(CARD_MIN_HEIGHT);

    useBoardCardStore.getState().setHeight(refA, CARD_MAX_HEIGHT + 100);
    expect(selectCardHeight(useBoardCardStore.getState().byThreadKey, refA)).toBe(CARD_MAX_HEIGHT);
  });

  it("does not let a resized card become shorter than the full default", () => {
    useBoardCardStore.getState().setHeight(refA, CARD_DEFAULT_HEIGHT - 200);
    expect(selectCardHeight(useBoardCardStore.getState().byThreadKey, refA)).toBe(
      CARD_DEFAULT_HEIGHT,
    );
  });

  it("selectCardHeight defaults to the full card height for an unknown thread", () => {
    expect(selectCardHeight(useBoardCardStore.getState().byThreadKey, refB)).toBe(
      CARD_DEFAULT_HEIGHT,
    );
  });

  it("removeThread clears persisted state", () => {
    useBoardCardStore.getState().setHeight(refA, CARD_MIN_HEIGHT);
    useBoardCardStore.getState().removeThread(refA);
    expect(selectCardHeight(useBoardCardStore.getState().byThreadKey, refA)).toBe(
      CARD_DEFAULT_HEIGHT,
    );
    expect(useBoardCardStore.getState().byThreadKey).toEqual({});
  });

  it("removeThread on an untouched thread is a no-op", () => {
    useBoardCardStore.getState().removeThread(refA);
    expect(useBoardCardStore.getState().byThreadKey).toEqual({});
  });

  it("clamps out-of-range persisted heights on rehydrate", () => {
    const persistApi = useBoardCardStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useBoardCardStore.getState>,
        ) => ReturnType<typeof useBoardCardStore.getState>;
      };
    };
    const mergedState = persistApi.getOptions().merge(
      {
        byThreadKey: {
          "env-1:thread-A": { heightPx: CARD_MAX_HEIGHT + 1000 },
          "env-1:thread-B": { heightPx: CARD_MIN_HEIGHT - 1000 },
        },
      },
      useBoardCardStore.getInitialState(),
    );

    expect(mergedState.byThreadKey).toEqual({
      "env-1:thread-A": { heightPx: CARD_MAX_HEIGHT },
      "env-1:thread-B": { heightPx: CARD_MIN_HEIGHT },
    });
  });

  it("drops malformed persisted entries on rehydrate", () => {
    const persistApi = useBoardCardStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useBoardCardStore.getState>,
        ) => ReturnType<typeof useBoardCardStore.getState>;
      };
    };

    expect(
      persistApi.getOptions().merge(null, useBoardCardStore.getInitialState()).byThreadKey,
    ).toEqual({});
    expect(
      persistApi
        .getOptions()
        .merge(
          { byThreadKey: { "env-1:thread-A": { heightPx: "tall" } } },
          useBoardCardStore.getInitialState(),
        ).byThreadKey,
    ).toEqual({});
  });

  it("migrates short legacy heights while preserving taller custom heights", () => {
    const persistApi = useBoardCardStore.persist as unknown as {
      getOptions: () => {
        migrate: (persistedState: unknown, version: number) => unknown;
      };
    };

    expect(
      persistApi.getOptions().migrate(
        {
          byThreadKey: {
            "env-1:thread-A": { heightPx: 260 },
            "env-1:thread-B": { heightPx: 640 },
          },
        },
        1,
      ),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": { heightPx: CARD_DEFAULT_HEIGHT },
        "env-1:thread-B": { heightPx: 640 },
      },
    });
  });
});
