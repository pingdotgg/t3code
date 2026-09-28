import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { checkCursorCloudStatus } from "./CursorCloudProvider.ts";

const withApi = (respond: (path: string) => Response) =>
  Effect.provideService(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, respond(new URL(request.url).pathname))),
    ),
  );

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

it.effect("asks for an API key before contacting Cursor", () =>
  Effect.gen(function* () {
    const cloud = yield* checkCursorCloudStatus({}).pipe(
      withApi(() => {
        throw new Error("no request without a key");
      }),
    );
    expect(cloud.available).toBe(false);
    expect(cloud.message).toMatch(/CURSOR_API_KEY/);
  }),
);

it.effect("reports a rejected key as unavailable", () =>
  Effect.gen(function* () {
    const cloud = yield* checkCursorCloudStatus({ CURSOR_API_KEY: "bad" }).pipe(
      withApi(() => json({ code: "unauthorized", message: "Invalid API key" }, 401)),
    );
    expect(cloud.available).toBe(false);
    expect(cloud.message).toMatch(/rejected/);
  }),
);

it.effect("offers the account default and each model's parameters with their defaults", () =>
  Effect.gen(function* () {
    const cloud = yield* checkCursorCloudStatus({ CURSOR_API_KEY: "key" }).pipe(
      withApi((path) =>
        path === "/v1/me"
          ? json({ apiKeyName: "Laptop" })
          : json({
              items: [
                {
                  id: "composer-2",
                  displayName: "Composer 2",
                  parameters: [
                    { id: "fast", values: [{ value: "false" }, { value: "true" }] },
                    {
                      id: "effort",
                      displayName: "Effort",
                      values: [{ value: "low" }, { value: "high", displayName: "High" }],
                    },
                  ],
                  variants: [
                    {
                      params: [
                        { id: "fast", value: "true" },
                        { id: "effort", value: "high" },
                      ],
                      isDefault: true,
                    },
                  ],
                },
              ],
            }),
      ),
    );

    expect(cloud.available).toBe(true);
    expect(cloud.models.map((model) => model.slug)).toEqual(["default", "composer-2"]);
    expect(cloud.models[1]?.capabilities?.optionDescriptors).toEqual([
      { id: "fast", label: "fast", type: "boolean", currentValue: true },
      {
        id: "effort",
        label: "Effort",
        type: "select",
        options: [
          { id: "low", label: "low" },
          { id: "high", label: "High", isDefault: true },
        ],
        currentValue: "high",
      },
    ]);
  }),
);
