import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { projectTransferTargets } from "./projectTransferTargets";

const machine = (id: string, phase = "connected", projectTransfer = true) => ({
  environmentId: EnvironmentId.make(id),
  connection: { phase },
  serverConfig: { environment: { capabilities: { projectTransfer } } },
});
const source = machine("source");
const destination = machine("destination");

describe("projectTransferTargets", () => {
  it("offers no destination for a single machine or when every machine has the project", () => {
    expect(projectTransferTargets([source], [source])).toEqual([]);
    expect(projectTransferTargets([source, destination], [source, destination])).toEqual([]);
  });
  it("offers only machines missing the project, even with multiple source checkouts", () => {
    const third = machine("third");
    expect(
      projectTransferTargets([source, destination, third], [source, source, destination]),
    ).toEqual([third]);
  });
  it("excludes offline and older servers", () => {
    expect(
      projectTransferTargets(
        [
          source,
          machine("offline", "disconnected"),
          machine("old", "connected", false),
          destination,
        ],
        [source],
      ),
    ).toEqual([destination]);
  });
  it("removes the destination as soon as its checkout is registered", () => {
    expect(projectTransferTargets([source, destination], [source])).toEqual([destination]);
    expect(projectTransferTargets([source, destination], [source, destination])).toEqual([]);
  });
});
