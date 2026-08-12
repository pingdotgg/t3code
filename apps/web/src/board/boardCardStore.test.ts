import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  CARD_COMPACT_HEIGHT,
  CARD_MAX_HEIGHT,
  CARD_MIN_HEIGHT,
  CARD_TALL_HEIGHT,
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

  it("setSize applies the preset compact/tall heights", () => {
    useBoardCardStore.getState().setSize(refA, "tall");
    expect(selectCardHeight(useBoardCardStore.getState().byThreadKey, refA)).toBe(CARD_TALL_HEIGHT);

    useBoardCardStore.getState().setSize(refA, "compact");
    expect(selectCardHeight(useBoardCardStore.getState().byThreadKey, refA)).toBe(
      CARD_COMPACT_HEIGHT,
    );
  });

  it("selectCardHeight defaults to compact for an unknown thread", () => {
    expect(selectCardHeight(useBoardCardStore.getState().byThreadKey, refB)).toBe(
      CARD_COMPACT_HEIGHT,
    );
  });

  it("removeThread clears persisted state", () => {
    useBoardCardStore.getState().setSize(refA, "tall");
    useBoardCardStore.getState().removeThread(refA);
    expect(selectCardHeight(useBoardCardStore.getState().byThreadKey, refA)).toBe(
      CARD_COMPACT_HEIGHT,
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
});
