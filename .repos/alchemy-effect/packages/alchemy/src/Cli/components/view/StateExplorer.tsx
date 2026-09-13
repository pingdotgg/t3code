/** @jsxImportSource react */
import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type JSX,
} from "react";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type {
  InvalidStatePath,
  StateStoreError,
} from "../../../State/index.ts";
import {
  Box,
  KeyBar,
  Spinner,
  Text,
  TextField,
  Viewport,
  useBorderStyle,
  useCliEnvironment,
  useKeyGlyphs,
  useTerminalInput,
  useTerminalSize,
} from "../ui/index.ts";
import { Screen, theme, type ScreenController } from "../../CliKit/index.ts";
import { formatYamlLines, matchYamlKey } from "../../PropertyDiff.ts";

export type StateFileRef =
  | {
      readonly kind: "resource";
      readonly stack: string;
      readonly stage: string;
      readonly fqn: string;
    }
  | {
      readonly kind: "output";
      readonly stack: string;
      readonly stage: string;
    };

export type StateExplorerError = InvalidStatePath | StateStoreError;

export interface StateExplorerSource {
  readonly backend: string;
  readonly listStacks: Effect.Effect<ReadonlyArray<string>, StateExplorerError>;
  readonly listStages: (
    stack: string,
  ) => Effect.Effect<ReadonlyArray<string>, StateExplorerError>;
  readonly listResources: (
    stack: string,
    stage: string,
  ) => Effect.Effect<ReadonlyArray<string>, StateExplorerError>;
  readonly readFile: (
    file: StateFileRef,
  ) => Effect.Effect<unknown, StateExplorerError>;
  readonly deleteNodes: (
    nodes: ReadonlyArray<StateBrowserNode>,
  ) => Effect.Effect<void, StateExplorerError>;
}

export type StateBrowserNode =
  | {
      readonly kind: "stack";
      readonly id: string;
      readonly name: string;
      readonly path: string;
      readonly stack: string;
    }
  | {
      readonly kind: "stage";
      readonly id: string;
      readonly name: string;
      readonly path: string;
      readonly stack: string;
      readonly stage: string;
    }
  | {
      readonly kind: "namespace";
      readonly id: string;
      readonly name: string;
      readonly path: string;
      readonly stack: string;
      readonly stage: string;
      readonly children: ReadonlyArray<StateBrowserNode>;
    }
  | {
      readonly kind: "resource";
      readonly id: string;
      readonly name: string;
      readonly path: string;
      readonly file: StateFileRef & { readonly kind: "resource" };
    }
  | {
      readonly kind: "output";
      readonly id: string;
      readonly name: string;
      readonly path: string;
      readonly file: StateFileRef & { readonly kind: "output" };
    };

type LoadState<Value> =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: Value }
  | { readonly status: "error"; readonly message: string };

interface ExplorerSnapshot {
  readonly root: LoadState<ReadonlyArray<StateBrowserNode>>;
  readonly children: ReadonlyMap<
    string,
    LoadState<ReadonlyArray<StateBrowserNode>>
  >;
  readonly files: ReadonlyMap<string, LoadState<unknown>>;
}

const errorMessage = (error: StateExplorerError) =>
  error._tag === "InvalidStatePath"
    ? `${error.path}: ${error.reason}`
    : error.message;

const causeMessage = (cause: Cause.Cause<StateExplorerError>) =>
  Option.match(Cause.findErrorOption(cause), {
    onSome: errorMessage,
    onNone: () => {
      const defect = Cause.squash(cause);
      return defect instanceof Error ? defect.message : String(defect);
    },
  });

/** Mutable async cache: every state-store read is initiated by a selection. */
export class StateExplorerStore {
  private state: ExplorerSnapshot = {
    root: { status: "idle" },
    children: new Map(),
    files: new Map(),
  };
  private readonly listeners = new Set<() => void>();
  private readonly fibers = new Set<Fiber.Fiber<unknown, unknown>>();

  constructor(
    readonly source: StateExplorerSource,
    private readonly services: Context.Context<never> = Context.empty(),
  ) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly snapshot = () => this.state;
  private commit(next: ExplorerSnapshot) {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  /**
   * Fork the effect in the CLI's ambient services and hand its exit to the
   * caller. A fiber the store no longer tracks — dropped by `refresh` or
   * `dispose` — is stale, and its result is discarded even if it managed to
   * complete before the interrupt landed.
   */
  private run<A>(
    effect: Effect.Effect<A, StateExplorerError>,
    handlers: {
      readonly onSuccess: (value: A) => void;
      readonly onFailure: (message: string) => void;
    },
  ) {
    const fiber = Effect.runForkWith(this.services)(effect);
    this.fibers.add(fiber);
    fiber.addObserver((exit) => {
      if (!this.fibers.delete(fiber)) return;
      if (Exit.isSuccess(exit)) handlers.onSuccess(exit.value);
      else if (!Cause.hasInterrupts(exit.cause))
        handlers.onFailure(causeMessage(exit.cause));
    });
  }

  private interruptAll() {
    for (const fiber of this.fibers) fiber.interruptUnsafe();
    this.fibers.clear();
  }

  readonly loadRoot = () => {
    if (this.state.root.status !== "idle") return;
    this.commit({ ...this.state, root: { status: "loading" } });
    this.run(this.source.listStacks, {
      onSuccess: (stacks) => {
        this.commit({
          ...this.state,
          root: {
            status: "ready",
            value: [...stacks].sort().map((stack) => ({
              kind: "stack",
              id: `stack:${stack}`,
              name: stack,
              path: stack,
              stack,
            })),
          },
        });
      },
      onFailure: (message) => {
        this.commit({ ...this.state, root: { status: "error", message } });
      },
    });
  };

  readonly refresh = () => {
    this.interruptAll();
    this.commit({
      root: { status: "idle" },
      children: new Map(),
      files: new Map(),
    });
    this.loadRoot();
  };

  /**
   * Re-list only what a deletion could have changed — the parent listing of
   * each target — and drop cached files under it. Every other cached column
   * survives, so the explorer keeps its position instead of collapsing to
   * the stack list the way `refresh` does.
   */
  readonly invalidate = (targets: ReadonlyArray<StateBrowserNode>) => {
    const children = new Map(this.state.children);
    const files = new Map(this.state.files);
    const parents = new Map<string, StateBrowserNode | undefined>();
    for (const target of targets) {
      for (const id of files.keys()) {
        if (id.slice(id.indexOf(":") + 1).startsWith(`${target.path}/`))
          files.delete(id);
      }
      if (target.kind === "stack") {
        for (const id of children.keys()) {
          if (
            id === `stack:${target.stack}` ||
            id.startsWith(`stage:${target.stack}/`)
          )
            children.delete(id);
        }
        parents.set("root", undefined);
      } else if (target.kind === "stage") {
        children.delete(target.id);
        parents.set(`stack:${target.stack}`, {
          kind: "stack",
          id: `stack:${target.stack}`,
          name: target.stack,
          path: target.stack,
          stack: target.stack,
        });
      } else if (target.kind !== "output") {
        const { stack, stage } =
          target.kind === "resource" ? target.file : target;
        parents.set(`stage:${stack}/${stage}`, {
          kind: "stage",
          id: `stage:${stack}/${stage}`,
          name: stage,
          path: `${stack}/${stage}`,
          stack,
          stage,
        });
      }
    }
    for (const id of parents.keys()) {
      if (id !== "root") children.delete(id);
    }
    this.commit({
      ...this.state,
      root: parents.has("root") ? { status: "idle" } : this.state.root,
      children,
      files,
    });
    for (const parent of parents.values()) {
      if (parent === undefined) this.loadRoot();
      else this.loadChildren(parent);
    }
  };

  readonly loadChildren = (node: StateBrowserNode) => {
    if (
      node.kind === "namespace" ||
      node.kind === "resource" ||
      node.kind === "output"
    ) {
      return;
    }
    if ((this.state.children.get(node.id)?.status ?? "idle") !== "idle") return;
    const children = new Map(this.state.children);
    children.set(node.id, { status: "loading" });
    this.commit({ ...this.state, children });

    const request =
      node.kind === "stack"
        ? Effect.map(this.source.listStages(node.stack), (stages) =>
            [...stages].sort().map((stage): StateBrowserNode => ({
              kind: "stage",
              id: `stage:${node.stack}/${stage}`,
              name: stage,
              path: `${node.stack}/${stage}`,
              stack: node.stack,
              stage,
            })),
          )
        : Effect.map(
            this.source.listResources(node.stack, node.stage!),
            (fqns) => buildStageNodes(node.stack, node.stage!, fqns),
          );
    this.run(request, {
      onSuccess: (value) => {
        const next = new Map(this.state.children);
        next.set(node.id, { status: "ready", value });
        this.commit({ ...this.state, children: next });
      },
      onFailure: (message) => {
        const next = new Map(this.state.children);
        next.set(node.id, { status: "error", message });
        this.commit({ ...this.state, children: next });
      },
    });
  };

  readonly loadFile = (node: StateBrowserNode) => {
    if (node.kind !== "resource" && node.kind !== "output") return;
    if ((this.state.files.get(node.id)?.status ?? "idle") !== "idle") return;
    const files = new Map(this.state.files);
    files.set(node.id, { status: "loading" });
    this.commit({ ...this.state, files });
    this.run(this.source.readFile(node.file), {
      onSuccess: (value) => {
        const next = new Map(this.state.files);
        next.set(node.id, { status: "ready", value });
        this.commit({ ...this.state, files: next });
      },
      onFailure: (message) => {
        const next = new Map(this.state.files);
        next.set(node.id, { status: "error", message });
        this.commit({ ...this.state, files: next });
      },
    });
  };

  readonly deleteNodes = (
    targets: ReadonlyArray<StateBrowserNode>,
    handlers: {
      readonly onSuccess: () => void;
      readonly onFailure: (message: string) => void;
    },
  ) => this.run(this.source.deleteNodes(targets), handlers);

  readonly dispose = () => {
    this.interruptAll();
    this.listeners.clear();
  };
}

interface MutableNamespace {
  readonly name: string;
  readonly path: string;
  readonly children: Map<string, MutableNamespace>;
  readonly files: StateBrowserNode[];
}

/** Convert listed FQNs to namespace columns without reading any state values. */
export const buildStageNodes = (
  stack: string,
  stage: string,
  fqns: ReadonlyArray<string>,
): ReadonlyArray<StateBrowserNode> => {
  const root: MutableNamespace = {
    name: "",
    path: `${stack}/${stage}`,
    children: new Map(),
    files: [],
  };
  for (const fqn of [...fqns].sort()) {
    const parts = fqn.split("/").filter(Boolean);
    let current = root;
    for (const part of parts.slice(0, -1)) {
      let child = current.children.get(part);
      if (child === undefined) {
        child = {
          name: part,
          path: `${current.path}/${part}`,
          children: new Map(),
          files: [],
        };
        current.children.set(part, child);
      }
      current = child;
    }
    const name = parts.at(-1) ?? fqn;
    current.files.push({
      kind: "resource",
      id: `resource:${stack}/${stage}/${fqn}`,
      name,
      path: `${stack}/${stage}/${fqn}`,
      file: { kind: "resource", stack, stage, fqn },
    });
  }

  const freeze = (namespace: MutableNamespace): StateBrowserNode[] => [
    ...[...namespace.children.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((child): StateBrowserNode => ({
        kind: "namespace",
        id: `namespace:${child.path}`,
        name: child.name,
        path: child.path,
        stack,
        stage,
        children: freeze(child),
      })),
    ...namespace.files,
  ];
  return [
    ...freeze(root),
    {
      kind: "output",
      id: `output:${stack}/${stage}`,
      name: "output",
      path: `${stack}/${stage}/output`,
      file: { kind: "output", stack, stage },
    },
  ];
};

const nodeStyle: Record<
  StateBrowserNode["kind"],
  { readonly color: string; readonly icon: string; readonly asciiIcon: string }
> = {
  stack: { color: theme.color.brand, icon: "◆", asciiIcon: "#" },
  stage: { color: theme.color.warning, icon: "●", asciiIcon: "@" },
  namespace: { color: theme.color.accent, icon: "▸", asciiIcon: ">" },
  resource: { color: theme.color.info, icon: "▪", asciiIcon: "-" },
  output: { color: theme.color.success, icon: "◇", asciiIcon: "=" },
};

const childrenFor = (
  node: StateBrowserNode,
  state: ExplorerSnapshot,
): LoadState<ReadonlyArray<StateBrowserNode>> | undefined =>
  node.kind === "namespace"
    ? { status: "ready", value: node.children }
    : node.kind === "stack" || node.kind === "stage"
      ? (state.children.get(node.id) ?? { status: "idle" })
      : undefined;

interface BrowserColumn {
  readonly id: string;
  readonly title: string;
  readonly state: LoadState<ReadonlyArray<StateBrowserNode>>;
}

const buildColumns = (
  state: ExplorerSnapshot,
  selection: ReadonlyArray<string>,
): BrowserColumn[] => {
  const columns: BrowserColumn[] = [
    { id: "root", title: "Stacks", state: state.root },
  ];
  let current = state.root;
  for (let depth = 0; depth < selection.length; depth++) {
    if (current.status !== "ready") break;
    const selected = current.value.find((node) => node.id === selection[depth]);
    if (selected === undefined) break;
    const children = childrenFor(selected, state);
    if (children === undefined) break;
    columns.push({
      id: selected.id,
      title:
        selected.kind === "stack"
          ? "Stages"
          : selected.kind === "stage"
            ? "State"
            : selected.name,
      state: children,
    });
    current = children;
  }
  return columns;
};

type ColumnProps = {
  readonly column: BrowserColumn;
  readonly selected: string | undefined;
  readonly focused: boolean;
  readonly height: number;
  readonly query: string;
  readonly marked: ReadonlySet<string>;
};

function Column({
  column,
  selected,
  focused,
  height,
  query,
  marked,
}: ColumnProps) {
  const { unicode } = useCliEnvironment();
  const borderStyle = useBorderStyle();
  if (column.state.status === "idle" || column.state.status === "loading") {
    return <Spinner label="Loading" />;
  }
  if (column.state.status === "error") {
    return <Text tone="danger">{column.state.message}</Text>;
  }
  const needle = query.trim().toLowerCase();
  const items =
    needle === ""
      ? column.state.value
      : column.state.value.filter((node) =>
          node.path.toLowerCase().includes(needle),
        );
  const selectedIndex = Math.max(
    0,
    items.findIndex((node) => node.id === selected),
  );
  return (
    <Viewport
      items={items}
      cursor={selectedIndex}
      height={height}
      getKey={(node) => node.id}
      empty={<Text tone="muted">No matches.</Text>}
      renderItem={(node) => {
        const active = node.id === selected;
        const style = nodeStyle[node.kind];
        return (
          <Box
            width="100%"
            paddingLeft={active ? 0 : 1}
            borderStyle={borderStyle}
            borderLeft={active}
            borderRight={false}
            borderTop={false}
            borderBottom={false}
            borderColor={focused ? theme.color.accent : theme.color.muted}
          >
            <Box width={2} flexShrink={0}>
              <Text color={style.color}>
                {marked.has(node.id)
                  ? unicode
                    ? "● "
                    : "* "
                  : `${unicode ? style.icon : style.asciiIcon} `}
              </Text>
            </Box>
            <Text
              bold={active}
              color={
                active
                  ? focused
                    ? theme.color.accentBright
                    : theme.color.emphasis
                  : undefined
              }
              wrap="truncate-end"
            >
              {node.name}
            </Text>
            {(node.kind === "stack" ||
              node.kind === "stage" ||
              node.kind === "namespace") && (
              <Box flexGrow={1} justifyContent="flex-end">
                <Text tone="muted">{unicode ? "›" : ">"}</Text>
              </Box>
            )}
          </Box>
        );
      }}
    />
  );
}

type YamlLineProps = { readonly line: string };

function YamlLine({ line }: YamlLineProps) {
  const key = matchYamlKey(line);
  if (key !== undefined) {
    return (
      <Text wrap="truncate-end">
        {key.indent}
        <Text color={theme.color.info}>{key.key}</Text>
        <YamlValue value={key.value} />
      </Text>
    );
  }
  return (
    <Text wrap="truncate-end">
      <YamlValue value={line} />
    </Text>
  );
}

type YamlValueProps = { readonly value: string };

function YamlValue({ value }: YamlValueProps) {
  const trimmed = value.trimStart();
  const color = /^(["'])/.test(trimmed)
    ? theme.color.success
    : /^(true|false)/.test(trimmed)
      ? theme.color.accent
      : /^-?\d/.test(trimmed)
        ? theme.color.warning
        : trimmed.startsWith("null")
          ? theme.color.danger
          : undefined;
  return <Text color={color}>{value}</Text>;
}

type PreviewProps = {
  readonly node: StateBrowserNode | undefined;
  readonly state: LoadState<unknown> | undefined;
  readonly lines: ReadonlyArray<string> | undefined;
  readonly offset: number;
  readonly height: number;
};

function Preview({ node, state, lines = [], offset, height }: PreviewProps) {
  if (
    node === undefined ||
    (node.kind !== "resource" && node.kind !== "output")
  ) {
    return <Text tone="muted">Select a state file to preview it.</Text>;
  }
  if (
    state === undefined ||
    state.status === "idle" ||
    state.status === "loading"
  ) {
    return <Spinner label="Reading state" detail={node.name} />;
  }
  if (state.status === "error")
    return <Text tone="danger">{state.message}</Text>;
  if (state.value === undefined) {
    return <Text tone="muted">No stored value.</Text>;
  }
  const bodyHeight = Math.max(1, height - 2);
  const start = Math.max(
    0,
    Math.min(offset, Math.max(0, lines.length - bodyHeight)),
  );
  return (
    <Box flexDirection="column" height={height}>
      <Text bold color={nodeStyle[node.kind].color} wrap="truncate-middle">
        {node.path}
      </Text>
      <Box flexDirection="column">
        {lines.slice(start, start + bodyHeight).map((line, index) => (
          <YamlLine key={`${start + index}:${line}`} line={line} />
        ))}
      </Box>
    </Box>
  );
}

function StateExplorer({
  store,
  controller,
}: {
  readonly store: StateExplorerStore;
  readonly controller: ScreenController<void>;
}): JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const [selection, setSelection] = useState<ReadonlyArray<string>>([]);
  const [columnIndex, setColumnIndex] = useState(0);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [previewOffset, setPreviewOffset] = useState(0);
  const [previewFocused, setPreviewFocused] = useState(false);
  const [marked, setMarked] = useState<ReadonlyMap<string, StateBrowserNode>>(
    new Map(),
  );
  const [deletion, setDeletion] = useState<
    | {
        readonly status: "confirm" | "deleting";
        readonly targets: ReadonlyArray<StateBrowserNode>;
      }
    | {
        readonly status: "error";
        readonly message: string;
        readonly targets: ReadonlyArray<StateBrowserNode>;
      }
  >();
  const [notice, setNotice] = useState<string>();
  const { columns: terminalColumns, rows: terminalRows } = useTerminalSize();
  const borderStyle = useBorderStyle();
  const keys = useKeyGlyphs();

  useEffect(() => {
    store.loadRoot();
    return store.dispose;
  }, [store]);
  const columns = useMemo(
    () => buildColumns(state, selection),
    [selection, state],
  );
  const markedIds = useMemo(() => new Set(marked.keys()), [marked]);
  const activeColumn = Math.min(columnIndex, columns.length - 1);
  const column = columns[activeColumn]!;
  const filteredItems =
    column.state.status !== "ready"
      ? []
      : query.trim() === ""
        ? column.state.value
        : column.state.value.filter((node) =>
            node.path.toLowerCase().includes(query.trim().toLowerCase()),
          );
  const selectedId = selection[activeColumn];
  const selectedIndex = filteredItems.findIndex(
    (node) => node.id === selectedId,
  );
  const selected = filteredItems[selectedIndex];
  const lastSelected = (() => {
    for (let index = columns.length - 1; index >= 0; index--) {
      const candidate = columns[index];
      if (candidate?.state.status !== "ready") continue;
      const node = candidate.state.value.find(
        (item) => item.id === selection[index],
      );
      if (node !== undefined) return node;
    }
    return undefined;
  })();
  const file =
    lastSelected?.kind === "resource" || lastSelected?.kind === "output"
      ? lastSelected
      : undefined;
  const fileState = file === undefined ? undefined : state.files.get(file.id);
  // The delete prompt replaces the key bar (a margin row + the keys) with a
  // bordered panel: border, header line, one line per target (capped, with
  // a "+N more" line), and its own key bar. KeyBar is a full-width block,
  // so it gets its own row rather than sharing one with the header.
  const promptTargets =
    deletion === undefined ? [] : deletion.targets.slice(0, MAX_PROMPT_TARGETS);
  const promptOverflow =
    deletion === undefined ? 0 : deletion.targets.length - promptTargets.length;
  const footerHeight =
    deletion === undefined
      ? 2
      : 3 + promptTargets.length + (promptOverflow > 0 ? 1 : 0);
  const contentHeight = Math.max(6, terminalRows - 8 - footerHeight);
  const previewLines = useMemo(
    () =>
      fileState?.status === "ready" && fileState.value !== undefined
        ? formatYamlLines(fileState.value)
        : undefined,
    [fileState],
  );
  const maxPreviewOffset =
    previewLines === undefined
      ? 0
      : Math.max(0, previewLines.length - Math.max(1, contentHeight - 2));

  const choose = (index: number, node: StateBrowserNode) => {
    setSelection((current) => [...current.slice(0, index), node.id]);
    setPreviewOffset(0);
    if (node.kind === "resource" || node.kind === "output")
      store.loadFile(node);
    else store.loadChildren(node);
  };
  const move = (delta: number) => {
    if (filteredItems.length === 0) return;
    const next =
      selectedIndex < 0
        ? delta < 0
          ? filteredItems.length - 1
          : 0
        : Math.max(
            0,
            Math.min(filteredItems.length - 1, selectedIndex + delta),
          );
    choose(activeColumn, filteredItems[next]!);
  };

  const beginDelete = () => {
    const targets =
      marked.size > 0 ? [...marked.values()] : selected ? [selected] : [];
    if (targets.length === 0) return;
    if (targets.some((node) => node.kind === "output")) {
      setDeletion({
        status: "error",
        message: "output cannot be deleted independently",
        targets,
      });
      return;
    }
    setDeletion({ status: "confirm", targets });
  };

  const confirmDelete = () => {
    if (deletion === undefined || deletion.status === "deleting") return;
    const targets = deletion.targets;
    const deletes = (node: StateBrowserNode) =>
      targets.some(
        (target) =>
          node.id === target.id || node.path.startsWith(`${target.path}/`),
      );
    // The shallowest column whose selected node is going away: the cursor
    // moves there, onto the next surviving sibling (or the previous one).
    // Deeper selection is dropped; everything above it is untouched.
    const landing = (() => {
      for (let index = 0; index < columns.length; index++) {
        const column = columns[index]!;
        if (column.state.status !== "ready") return undefined;
        const items = column.state.value;
        const position = items.findIndex(
          (node) => node.id === selection[index],
        );
        if (position < 0 || !deletes(items[position]!)) continue;
        const fallback =
          items.slice(position + 1).find((node) => !deletes(node)) ??
          items.slice(0, position).findLast((node) => !deletes(node));
        return { index, fallback };
      }
      return undefined;
    })();
    setDeletion({ status: "deleting", targets });
    store.deleteNodes(targets, {
      onSuccess: () => {
        setDeletion(undefined);
        setMarked(new Map());
        if (landing !== undefined) {
          setSelection((current) =>
            landing.fallback === undefined
              ? current.slice(0, landing.index)
              : [...current.slice(0, landing.index), landing.fallback.id],
          );
          setColumnIndex(landing.index);
          setPreviewOffset(0);
          setPreviewFocused(false);
        }
        setNotice(
          `Deleted state at ${targets.map((target) => `${target.path}${target.kind === "resource" ? "" : "/"}`).join(", ")}`,
        );
        store.invalidate(targets);
      },
      onFailure: (message) =>
        setDeletion({ status: "error", message, targets }),
    });
  };

  useTerminalInput(
    (input, key) => {
      if (deletion !== undefined) {
        if (deletion.status === "deleting") return;
        if (key.escape || input === "n" || input === "q")
          setDeletion(undefined);
        else if (deletion.status === "confirm" && input === "y")
          confirmDelete();
        return;
      }
      if (input === "q") return controller.submit(undefined);
      if (key.escape) {
        if (query !== "") setQuery("");
        else controller.submit(undefined);
        return;
      }
      if (!key.ctrl && !key.meta && input === "/") {
        setSearching(true);
        setPreviewFocused(false);
        return;
      }
      if (!key.ctrl && !key.meta && input === "r") {
        setSelection([]);
        setColumnIndex(0);
        setPreviewFocused(false);
        setNotice(undefined);
        store.refresh();
        return;
      }
      if (input === " " && selected !== undefined) {
        setMarked((current) => {
          const next = new Map(current);
          if (next.has(selected.id)) next.delete(selected.id);
          else next.set(selected.id, selected);
          return next;
        });
        return;
      }
      if (input === "d") {
        beginDelete();
        return;
      }
      if (key.tab) {
        if (file !== undefined) setPreviewFocused((current) => !current);
        return;
      }
      if (previewFocused) {
        if (key.left) setPreviewFocused(false);
        else if (key.up) setPreviewOffset((value) => Math.max(0, value - 1));
        else if (key.down)
          setPreviewOffset((value) => Math.min(maxPreviewOffset, value + 1));
        else if (key.pageUp)
          setPreviewOffset((value) => Math.max(0, value - contentHeight));
        else if (key.pageDown)
          setPreviewOffset((value) =>
            Math.min(maxPreviewOffset, value + contentHeight),
          );
        else if (key.home) setPreviewOffset(0);
        else if (key.end) setPreviewOffset(maxPreviewOffset);
        return;
      }
      if (key.up || input === "k") move(-1);
      else if (key.down || input === "j") move(1);
      else if (key.home && filteredItems[0])
        choose(activeColumn, filteredItems[0]);
      else if (key.end && filteredItems.at(-1))
        choose(activeColumn, filteredItems.at(-1)!);
      else if (key.left && activeColumn > 0) setColumnIndex(activeColumn - 1);
      else if (key.right || key.enter) {
        if (selected === undefined) return;
        choose(activeColumn, selected);
        if (selected.kind === "resource" || selected.kind === "output") {
          setPreviewFocused(true);
        } else {
          setColumnIndex(activeColumn + 1);
        }
      }
    },
    { active: !searching },
  );

  const previewWidth =
    file === undefined ? 0 : Math.max(34, Math.floor(terminalColumns * 0.42));
  const columnWidth = Math.max(
    20,
    Math.min(28, Math.floor((terminalColumns - previewWidth) / 2)),
  );
  const availableForColumns = Math.max(
    columnWidth,
    terminalColumns - previewWidth - 2,
  );
  const visibleColumnCount = Math.max(
    1,
    Math.floor(availableForColumns / (columnWidth + 1)),
  );
  const visibleStart = Math.max(0, columns.length - visibleColumnCount);
  const visibleColumns = columns.slice(visibleStart);
  const currentPath = selected?.path ?? "/";
  const displayPath =
    selected === undefined ||
    selected.kind === "resource" ||
    selected.kind === "output"
      ? currentPath
      : `${currentPath}/`;

  return (
    // Pinned to the terminal width: without it the root sizes to its content,
    // and the layout visibly narrows whenever the full-width key bar is
    // swapped out for the delete panel.
    <Box
      flexDirection="column"
      width={terminalColumns}
      height={Math.max(12, terminalRows - 2)}
    >
      <Box
        justifyContent="space-between"
        flexShrink={0}
        paddingX={1}
        marginBottom={1}
        borderStyle={borderStyle}
        borderBottom
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        borderColor={theme.color.muted}
        borderDimColor
      >
        <Box gap={1}>
          <Text color={theme.color.brand}>●</Text>
          <Text bold>state</Text>
          <Text color={theme.color.accent} wrap="truncate-middle">
            · {displayPath}
          </Text>
        </Box>
        <Text bold color={theme.color.brand}>
          {store.source.backend}
        </Text>
      </Box>
      {notice === undefined ? null : (
        <Box paddingX={1} flexShrink={0}>
          <Text color={theme.color.success}>✓ {notice}</Text>
        </Box>
      )}
      {searching ? (
        <Box gap={1} paddingX={1} flexShrink={0}>
          <Text color={theme.color.brand}>/</Text>
          <TextField
            value={query}
            placeholder="filter this column"
            active
            onChange={setQuery}
            onSubmit={() => setSearching(false)}
            onCancel={() => setSearching(false)}
          />
        </Box>
      ) : query === "" ? null : (
        <Box paddingX={1}>
          <Text tone="muted">filter · {query}</Text>
        </Box>
      )}
      <Box flexGrow={1}>
        {visibleColumns.map((item, offset) => {
          const index = visibleStart + offset;
          return (
            <Box
              key={item.id}
              width={columnWidth}
              flexDirection="column"
              paddingX={1}
              borderStyle={borderStyle}
              borderLeft={offset > 0}
              borderRight={false}
              borderTop={false}
              borderBottom={false}
              borderColor={
                !previewFocused && index === activeColumn
                  ? theme.color.accent
                  : theme.color.muted
              }
            >
              <Text
                bold
                color={
                  !previewFocused && index === activeColumn
                    ? theme.color.accent
                    : theme.color.muted
                }
              >
                {item.title.toUpperCase()}
              </Text>
              <Box height={contentHeight} flexDirection="column">
                <Column
                  column={item}
                  selected={selection[index]}
                  focused={!previewFocused && index === activeColumn}
                  height={contentHeight}
                  query={index === activeColumn ? query : ""}
                  marked={markedIds}
                />
              </Box>
            </Box>
          );
        })}
        {file === undefined ? null : (
          <Box
            flexGrow={1}
            flexDirection="column"
            paddingLeft={1}
            borderStyle={borderStyle}
            borderLeft
            borderRight={false}
            borderTop={false}
            borderBottom={false}
            borderColor={
              previewFocused ? theme.color.accent : theme.color.muted
            }
          >
            <Text
              bold
              color={previewFocused ? theme.color.accent : theme.color.muted}
            >
              PREVIEW
            </Text>
            <Preview
              node={file}
              state={fileState}
              lines={previewLines}
              offset={previewOffset}
              height={contentHeight}
            />
          </Box>
        )}
      </Box>
      {deletion === undefined ? (
        <Box paddingX={1} flexShrink={0}>
          <KeyBar
            keys={[
              [keys.upDown, previewFocused ? "scroll" : "select"],
              [keys.leftRight, "columns"],
              ["/", "search"],
              ["r", "refresh"],
              [keys.space, "select"],
              ["d", "delete"],
              ...(file === undefined ? [] : ([[keys.tab, "preview"]] as const)),
              ["q", "quit"],
            ]}
          />
        </Box>
      ) : (
        <Box
          flexDirection="column"
          paddingX={1}
          flexShrink={0}
          height={footerHeight}
          borderStyle={borderStyle}
          borderTop
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
          borderColor={theme.color.danger}
        >
          <Box height={1}>
            {deletion.status === "deleting" ? (
              <Spinner label="Deleting state" />
            ) : deletion.status === "error" ? (
              <Text tone="danger" wrap="truncate-end">
                {deletion.message}
              </Text>
            ) : (
              <Text wrap="truncate-end">
                <Text bold color={theme.color.danger}>
                  Delete state records?
                </Text>
                <Text tone="muted">
                  {" "}
                  · Cloud resources will not be deleted.
                </Text>
              </Text>
            )}
          </Box>
          <Box flexDirection="column">
            {promptTargets.map((target) => (
              <Text key={target.id} wrap="truncate-middle">
                {"  "}
                {target.path}
                {target.kind === "resource" ? "" : "/"}
              </Text>
            ))}
            {promptOverflow > 0 ? (
              <Text tone="muted">{`  +${promptOverflow} more`}</Text>
            ) : null}
          </Box>
          <DeletionAction status={deletion.status} />
        </Box>
      )}
    </Box>
  );
}

const MAX_PROMPT_TARGETS = 4;

type DeletionActionProps = {
  status: "confirm" | "deleting" | "error";
};

function DeletionAction({ status }: DeletionActionProps) {
  if (status === "deleting") return null;
  if (status === "error")
    return <KeyBar marginTop={0} keys={[["esc", "dismiss"]]} />;
  return (
    <KeyBar
      marginTop={0}
      keys={[
        ["y", "delete"],
        ["n/esc", "cancel"],
      ]}
    />
  );
}

export const stateExplorerScreen = (
  source: StateExplorerSource,
  services?: Context.Context<never>,
) => {
  const store = new StateExplorerStore(source, services);
  return Screen.make<void>("state explorer", (controller) => (
    <StateExplorer store={store} controller={controller} />
  ));
};
