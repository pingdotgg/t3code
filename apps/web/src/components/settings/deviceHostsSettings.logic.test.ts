import { describe, expect, it } from "vite-plus/test";
import { updateDeviceHosts } from "./deviceHostsSettings.logic";

describe("device host changes across environments", () => {
  const shared = { id: "shared", label: "Mac mini", target: "julius@macmini" };
  const local = { id: "other", label: "Android", target: "julius@android" };

  it("adds to differing host lists without losing environment-specific hosts, including on retry", () => {
    const environments = [[], [local], [shared, local]];
    const saved = environments.map((hosts) => updateDeviceHosts(hosts, shared, false));
    expect(saved).toEqual([[shared], [local, shared], [shared, local]]);
    expect(saved.map((hosts) => updateDeviceHosts(hosts, shared, false))).toEqual(saved);
  });

  it("edits and removes the shared host while preserving unrelated hosts", () => {
    const edited = { ...shared, target: "julius@new-address" };
    const saved = [[shared], [local, shared]].map((hosts) =>
      updateDeviceHosts(hosts, edited, false),
    );
    expect(saved).toEqual([[edited], [local, edited]]);
    expect(saved.map((hosts) => updateDeviceHosts(hosts, edited, true))).toEqual([[], [local]]);
  });

  it("recognizes a host added separately on another environment and preserves its local ID", () => {
    const remote = { ...shared, id: "remote-id" };
    const edited = { ...shared, target: "julius@new-address" };
    expect(updateDeviceHosts([remote, local], shared, false)).toEqual([remote, local]);
    const saved = updateDeviceHosts([remote, local], edited, false, shared);
    expect(saved).toEqual([{ ...edited, id: remote.id }, local]);
    expect(updateDeviceHosts(saved, edited, false, shared)).toEqual(saved);
    expect(updateDeviceHosts([remote, local], shared, true)).toEqual([local]);
  });

  it("keeps distinct SSH connections to the same target separate", () => {
    const anotherPort = { ...shared, id: "another-port", port: 2222 };
    const anotherIdentity = { ...shared, id: "another-key", identityFile: "~/.ssh/another" };
    expect(updateDeviceHosts([anotherPort, anotherIdentity], shared, false)).toEqual([
      anotherPort,
      anotherIdentity,
      shared,
    ]);
  });

  it("prefers the selected ID over a sibling with the same destination", () => {
    const sibling = { ...shared, id: "sibling", label: "Another entry" };
    const edited = { ...shared, label: "Renamed" };
    expect(updateDeviceHosts([sibling, shared], edited, false, shared)).toEqual([sibling, edited]);
    expect(updateDeviceHosts([sibling, shared], shared, true)).toEqual([sibling]);
  });

  it("refuses an ambiguous destination on another environment instead of changing a sibling", () => {
    const remote = { ...shared, id: "remote" };
    const sibling = { ...shared, id: "sibling" };
    expect(() => updateDeviceHosts([remote, sibling], shared, true)).toThrow("Multiple hosts");
    expect(() => updateDeviceHosts([remote, sibling], shared, false)).toThrow("Multiple hosts");
  });
});
