import { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vite-plus/test";
import type { ExtensionPanelSurface, RightPanelSurface } from "../rightPanelStore";
import { registerWorkspaceExtension, WorkspaceExtensionSurface } from "./workspaceRegistry";
import { useRetainedExtensionSidePanel } from "./useRetainedExtensionSidePanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const a: ExtensionPanelSurface = {
  kind: "extension",
  id: "extension:retention-a",
  viewerGeneration: "generation-a",
  record: {
    version: 1,
    surfaceId: "test.retention/view",
    placement: "side-panel",
    stateVersion: 1,
    restoreState: 0,
    fallback: "Retention unavailable",
    context: {
      client: "web",
      resource: {
        namespace: "test.retention",
        id: "a",
        environmentId: "env",
        projectId: "project",
      },
    },
  },
};
const b: ExtensionPanelSurface = {
  ...a,
  id: "extension:retention-b",
  viewerGeneration: "generation-b",
  record: {
    ...a.record,
    context: { ...a.record.context, resource: { ...a.record.context.resource, id: "b" } },
  },
};
interface Props {
  scope: string;
  open: boolean;
  selected: RightPanelSurface | null;
  surfaces: RightPanelSurface[];
}
function Shell(props: Props) {
  const retained = useRetainedExtensionSidePanel(
    props.scope,
    props.open,
    props.selected,
    props.surfaces,
  );
  return retained ? (
    <section hidden={!props.open} inert={!props.open}>
      <WorkspaceExtensionSurface
        key={JSON.stringify([props.scope, retained.id, retained.viewerGeneration])}
        record={retained.record}
        visible={props.open}
      />
    </section>
  ) : null;
}
function fixture() {
  const created: string[] = [],
    visibility: boolean[] = [];
  let disposed = 0;
  const unregister = registerWorkspaceExtension({
    manifest: {
      id: "test.retention",
      apiVersion: 1,
      version: "1.0.0",
      surfaces: [
        {
          id: a.record.surfaceId,
          title: "Retention",
          clients: ["web"],
          placements: ["side-panel"],
          scope: "project",
          stateVersion: 1,
          capabilities: [],
        },
      ],
    },
    surfaces: [
      {
        id: a.record.surfaceId,
        validateRestore: (value) => typeof value === "number",
        createView(session) {
          created.push(session.context.resource.id);
          session.onVisibility((value) => visibility.push(value));
          return {
            dispose() {
              disposed += 1;
            },
            renderer: function Input() {
              const [value, setValue] = useState("");
              return (
                <input
                  aria-label="Retained input"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
              );
            },
          };
        },
      },
    ],
  });
  return { created, visibility, disposed: () => disposed, unregister };
}
describe("generic side-panel hide retention", () => {
  it("retains the actual registered renderer and unsaved input while SDK visibility changes", async () => {
    const owner = fixture();
    let root!: ReactTestRenderer;
    const props: Props = { scope: "env/thread", open: true, selected: a, surfaces: [a] };
    try {
      await act(async () => {
        root = create(<Shell {...props} />);
      });
      const input = root.root.findByType("input");
      await act(async () => {
        input.props.onChange({ target: { value: "not saved to restoreState" } });
      });
      await act(async () => {
        root.update(<Shell {...props} open={false} />);
      });
      expect(root.root.findByType("input")).toBe(input);
      expect(root.root.findByType("section").props.hidden).toBe(true);
      expect(owner.visibility.at(-1)).toBe(false);
      await act(async () => {
        root.update(<Shell {...props} />);
      });
      expect(root.root.findByType("input")).toBe(input);
      expect(input.props.value).toBe("not saved to restoreState");
      expect(owner.created).toEqual(["a"]);
      expect(owner.disposed()).toBe(0);
      expect(owner.visibility.at(-1)).toBe(true);
    } finally {
      await act(async () => {
        root?.unmount();
        owner.unregister();
      });
    }
  });
  it("never activates a cold hidden restore or the successor of a closed hidden viewer", async () => {
    const owner = fixture();
    let root!: ReactTestRenderer;
    const props: Props = { scope: "env/thread", open: false, selected: a, surfaces: [a, b] };
    try {
      await act(async () => {
        root = create(<Shell {...props} />);
      });
      expect(owner.created).toEqual([]);
      await act(async () => {
        root.update(<Shell {...props} open />);
      });
      await act(async () => {
        root.update(<Shell {...props} />);
      });
      await act(async () => {
        root.update(<Shell {...props} selected={b} surfaces={[b]} />);
      });
      expect(owner.created).toEqual(["a"]);
      expect(owner.disposed()).toBe(1);
      expect(root.root.findAllByType("input")).toHaveLength(0);
      await act(async () => {
        root.update(<Shell {...props} open selected={b} surfaces={[b]} />);
      });
      expect(owner.created).toEqual(["a", "b"]);
    } finally {
      await act(async () => {
        root?.unmount();
        owner.unregister();
      });
    }
  });
  it("returns latest hidden record, but rejects scope and viewer-generation replacements", async () => {
    const observed: Array<ExtensionPanelSurface | null> = [];
    function Probe(props: Props) {
      const retained = useRetainedExtensionSidePanel(
        props.scope,
        props.open,
        props.selected,
        props.surfaces,
      );
      observed.push(retained);
      return null;
    }
    let root!: ReactTestRenderer;
    const props: Props = { scope: "env/thread", open: true, selected: a, surfaces: [a] };
    try {
      await act(async () => {
        root = create(<Probe {...props} />);
      });
      const updated = { ...a, record: { ...a.record, restoreState: 7 } };
      await act(async () => {
        root.update(<Probe {...props} open={false} selected={updated} surfaces={[updated]} />);
      });
      expect(observed.at(-1)).toBe(updated);
      const replaced = { ...updated, viewerGeneration: "replacement" };
      await act(async () => {
        root.update(<Probe {...props} open={false} selected={replaced} surfaces={[replaced]} />);
      });
      expect(observed.at(-1)).toBeNull();
      await act(async () => {
        root.update(<Probe {...props} open={false} scope="env/other-thread" />);
      });
      expect(observed.at(-1)).toBeNull();
    } finally {
      await act(async () => {
        root?.unmount();
      });
    }
  });
});
