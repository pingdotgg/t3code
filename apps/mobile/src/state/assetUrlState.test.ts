import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { resolveAssetUrlState } from "./assetUrlState";

const RELATIVE_URL = "/api/assets/signed-token/preview.png";

describe("resolveAssetUrlState", () => {
  it("treats an unrequested asset as loading", () => {
    expect(
      resolveAssetUrlState({
        httpBaseUrl: null,
        requested: false,
        result: AsyncResult.initial(false),
      }),
    ).toEqual({ _tag: "Loading" });
  });

  it("keeps a spinner while the query is pending on a connected environment", () => {
    expect(
      resolveAssetUrlState({
        httpBaseUrl: "https://environment.example/",
        requested: true,
        result: AsyncResult.initial(true),
      }),
    ).toEqual({ _tag: "Loading" });
  });

  it("treats a missing connection as disconnected, even while the query is waiting", () => {
    expect(
      resolveAssetUrlState({
        httpBaseUrl: null,
        requested: true,
        result: AsyncResult.initial(true),
      }),
    ).toEqual({ _tag: "Disconnected" });
  });

  it("surfaces query failures instead of loading", () => {
    expect(
      resolveAssetUrlState({
        httpBaseUrl: "https://environment.example/",
        requested: true,
        result: AsyncResult.failure(Cause.fail(new Error("createUrl failed"))),
      }),
    ).toEqual({ _tag: "Failure" });
  });

  it("shows loading again while a failed query is retrying", () => {
    expect(
      resolveAssetUrlState({
        httpBaseUrl: "https://environment.example/",
        requested: true,
        result: AsyncResult.failure(Cause.fail(new Error("createUrl failed")), {
          waiting: true,
        }),
      }),
    ).toEqual({ _tag: "Loading" });
  });

  it("keeps disconnected copy if the environment drops during a retry", () => {
    expect(
      resolveAssetUrlState({
        httpBaseUrl: null,
        requested: true,
        result: AsyncResult.failure(Cause.fail(new Error("createUrl failed")), {
          waiting: true,
        }),
      }),
    ).toEqual({ _tag: "Disconnected" });
  });

  it("resolves a ready asset URL", () => {
    expect(
      resolveAssetUrlState({
        httpBaseUrl: "https://environment.example/base/",
        requested: true,
        result: AsyncResult.success({ relativeUrl: RELATIVE_URL }),
      }),
    ).toEqual({
      _tag: "Success",
      url: "https://environment.example/api/assets/signed-token/preview.png",
    });
  });

  it("treats an unresolvable URL as failure", () => {
    expect(
      resolveAssetUrlState({
        httpBaseUrl: "not a URL",
        requested: true,
        result: AsyncResult.success({ relativeUrl: RELATIVE_URL }),
      }),
    ).toEqual({ _tag: "Failure" });
  });
});
