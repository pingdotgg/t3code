import { describe, expect, it } from "@effect/vitest";
import * as Layer from "effect/Layer";

// The rest of the suite imports services and handlers directly, so nothing ever
// loads the module that wires the whole object graph together. That gap let an
// import cycle between server.ts and serverParts2.ts pass typechecking and keep
// every test green while the binary died on startup with
// `Cannot access 'layerPullRequestService' before initialization`.
//
// Importing the composition roots here makes module-initialisation order part of
// the test suite: a cycle or a temporal-dead-zone read throws during collection
// rather than in production.
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as Server from "./server.ts";

describe("module composition", () => {
  it("initialises the server composition roots without a temporal-dead-zone crash", () => {
    expect(Server.layerPullRequestService).toBeDefined();
    expect(Server.layerCommandReadiness).toBeDefined();
    expect(Server.runServer).toBeDefined();
    expect(Layer.isLayer(Server.layerPullRequestService)).toBe(true);
  });

  it("initialises the orchestrator service layer", () => {
    expect(Orchestrator.OrchestratorV2).toBeDefined();
    expect(Layer.isLayer(Orchestrator.layer)).toBe(true);
  });
});
