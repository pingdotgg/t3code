import {
  canOpenFilesInBrowser,
  composerContextApi,
  describeOpenFileRefusal,
  filePresentationApi,
  messagesEnrichmentApi,
  openWorkspaceFile,
  resourcesLeaseApi,
  textEditsApi,
  uiKeybindingsApi,
  uiEditorApi,
  uiNavigationApi,
  uiNotificationsApi,
  uiPreferencesApi,
  uiThemeApi,
  workspaceChangesApi,
  workspaceResourcesApi,
  workspaceSearchApi,
  workspaceTreeApi,
} from "@t3tools/extension-sdk/catalogue";
import {
  defineExtension,
  requireApi,
  Tooltip,
  useWindowedRows,
} from "@t3tools/extension-sdk/authoring";
import { bindApi, bindStreamApi } from "@t3tools/extension-sdk/capabilities";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";

import {
  COMPOSER_MENTION_DRAG_TYPE,
  dragMentionPayload,
  fileBreadcrumbChildren,
  fileBreadcrumbParent,
  fileBreadcrumbTooltip,
  fileBreadcrumbs,
  isAbsolutePath,
  lineStartOffset,
  resolveCenteredFileLineScrollTop,
  resolveWorkspaceLink,
} from "./fileNavigation.js";
import {
  COMMENT_EXCERPT_MAX_CHARS,
  formatCommentRangeLabel,
  type FileCommentRange,
} from "./fileComments.js";
import {
  useCommentDraft,
  LISTED_ANNOTATIONS_CAP,
  useCommentTransport,
  useEditorSelection,
  usePostedComments,
} from "./commentSession.js";
import { useAddToChat } from "./composerBridge.js";
import { useExternalEditor } from "./editorBridge.js";
import { parseMarkdown, type MarkdownBlock, type MarkdownInline } from "./markdown.js";
import { EditableFileBody, ReadOnlyFileBody } from "./codeView.js";
import { useFileEditor } from "./editorSession.js";
import { useMutationRefresh, useWorkspaceChanges } from "./mutationRefresh.js";
import { useWorkspaceTree } from "./workspaceTree.js";
import { FileTreeRow } from "./treeRow.js";
import { resolveUiKit } from "@t3tools/extension-sdk/ui";
import {
  collectResourceRead,
  contentMatchSegments,
  describeContentSearch,
  describeFileOpen,
  describeMediaLease,
  describeResourcePreview,
  describeSaveState,
  describeSearch,
  documentFrameSandbox,
  editorSavePending,
  fileOpenFailed,
  FILES_VIEW_COMMANDS,
  fileOpenNotification,
  isMarkdownPath,
  opensInPreviewBrowser,
  leasePreviewMode,
  mediaLeaseAssetFailed,
  mediaLeaseExpire,
  mediaLeaseFailed,
  mediaLeaseKindGate,
  mediaLeaseMinted,
  mediaLeaseRenewalDelay,
  mediaLeaseRenewing,
  mediaLeaseUrl,
  selectMediaLease,
  parentPath,
  presentationPath,
  presentedPreviewKind,
  filesViewState,
  isFilesViewState,
  restoredFolders,
  restoredExplorerOpen,
  showsFileExplorer,
  restoredRenderHtml,
  restoredRevealLine,
  restoredRenderMarkdown,
  restoredSelection,
  watchThemeVars,
  toggleFolder,
  openFolders,
  expandedFolders,
  treeDirectories,
  allDirectoriesExpanded,
  visibleRows,
  watchPreferences,
  writeRenderHtml,
  writeFileExplorerOpen,
  writeWordWrap,
  type ContentSearchResults,
  type FileOpenState,
  type MediaLeaseState,
  type PreviewKind,
  type SearchKindFilter,
  type SearchResults,
  type TreeEntry,
} from "./viewModel.js";

const manifestId = "t3.files";
const SEARCH_LIMIT = 100;
const SEARCH_DEBOUNCE_MS = 150;
/** Every tree row's height: the windowed tree places rows by it. */
const TREE_ROW_HEIGHT = 24;

// Every theme-backed value chains a `--t3-files-*` hop (published on the view
// root from `t3.ui/theme` tokens) ahead of the legacy host vars. When the
// contract is unavailable the hop never resolves and the legacy chain renders.
// `font-*` vars are not theme roles and keep their plain host references.

/**
 * Workspace media preview via `t3.resources/lease`. Selecting a
 * previewable media file mints a signed `/api/assets/*` URL, which the host
 * resolves against the environment's HTTP origin; the lease renews
 * `MEDIA_LEASE_RENEWAL_SKEW_MS` before expiry while visible, re-mints on tree
 * refresh, and every named denial maps to an explicit state — a broken
 * element is never the error UI. A load failure lands in the named
 * unavailable state instead of a broken image.
 */
function useMediaLease(
  host: ClientHost,
  session: ViewSession,
  selected: string | null,
  selectedKind: PreviewKind,
  refreshRevision: number,
  visible: boolean,
) {
  const active = selected !== null && selectedKind !== "text" && visible;
  const mode = selected === null ? null : leasePreviewMode(selected);
  const [lease, setLease] = useState<MediaLeaseState>({ status: "idle" });
  const leaseRef = useRef<MediaLeaseState>({ status: "idle" });
  const mintRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const commitLease = (next: MediaLeaseState | ((prev: MediaLeaseState) => MediaLeaseState)) => {
      setLease((prev) => {
        const value = typeof next === "function" ? next(prev) : next;
        leaseRef.current = value;
        return value;
      });
    };
    mintRef.current = null;
    if (!active || selected === null) {
      commitLease({ status: "idle" });
      return;
    }
    const path = selected;
    const threadId = session.context.resource.threadId;
    const initial = selectMediaLease({
      path,
      hasThread: typeof threadId === "string" && threadId.length > 0,
    });
    commitLease(initial);
    if (initial.status !== "minting" || threadId === undefined) return;

    const api = bindApi(resourcesLeaseApi, host, session.context);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    let renewalTimer: ReturnType<typeof setTimeout> | undefined;
    const clearRenewal = () => {
      if (renewalTimer !== undefined) {
        clearTimeout(renewalTimer);
        renewalTimer = undefined;
      }
    };

    const mint = async () => {
      try {
        const capabilities = await api.invoke("getCapabilities", {}, signal);
        if (signal.aborted) return;
        const gate = mediaLeaseKindGate(capabilities.supportedKinds);
        if (gate) {
          commitLease(gate);
          return;
        }
        const minted = await api.invoke(
          "createPresentationUrl",
          { resource: { _tag: "workspace-file", threadId, path } },
          signal,
        );
        if (signal.aborted) return;
        if (leasePreviewMode(path) !== "image") {
          // An iframe does not reliably fire onerror for failed documents —
          // preflight the lease so a 404 lands in the named state. The frame
          // gets the minted URL itself so the page's relative subresources
          // resolve under the lease. The route's private max-age cache
          // dedupes the frame's fetch.
          const response = await fetch(minted.url, { signal });
          if (signal.aborted) return;
          if (!response.ok) {
            commitLease(
              mediaLeaseAssetFailed(
                { status: "ready", url: minted.url, expiresAt: minted.expiresAt },
                Date.now(),
              ),
            );
            return;
          }
          await response.arrayBuffer();
          if (signal.aborted) return;
        }
        commitLease(mediaLeaseMinted(minted));
        clearRenewal();
        renewalTimer = setTimeout(
          () => {
            renewalTimer = undefined;
            commitLease((prev) => mediaLeaseRenewing(prev));
            void mint();
          },
          mediaLeaseRenewalDelay(minted.expiresAt, Date.now()),
        );
      } catch (error) {
        if (signal.aborted) return;
        const next = mediaLeaseFailed(error, leaseRef.current);
        commitLease(next);
        if (next.status === "ready") {
          // Renewal failed but the current lease still serves — re-arm at
          // expiresAt so the state goes expired and re-mints rather than
          // asserting a live lease past its TTL.
          clearRenewal();
          renewalTimer = setTimeout(
            () => {
              renewalTimer = undefined;
              commitLease((prev) => mediaLeaseExpire(prev));
              void mint();
            },
            Math.max(0, next.expiresAt - Date.now()),
          );
        }
      }
    };
    mintRef.current = mint;
    void mint();

    return () => {
      mintRef.current = null;
      clearRenewal();
      controller.abort();
    };
    // selectedKind gates via `active`; refreshRevision is an intentional
    // trigger — a tree refresh re-mints so refreshed bytes stay honest.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [host, session, selected, selectedKind, refreshRevision, active]);

  const notifyAssetFailed = () => {
    const previous = leaseRef.current;
    const next = mediaLeaseAssetFailed(previous, Date.now());
    if (next === previous) return;
    leaseRef.current = next;
    setLease(next);
    if (next.status === "expired") mintRef.current?.();
  };

  return { state: lease, mode, url: mediaLeaseUrl(lease), notifyAssetFailed };
}

/**
 * `t3.ui/theme` consumer. `getTokens` resolves the host's *effective* theme —
 * the provider's projection already folds the stored preference, live session
 * overlays, and external previews into the painted state — and each
 * `subscribeState` frame re-reads the tokens, so the panel tracks exactly
 * what the host paints without interpreting overlay semantics itself. The map
 * lands on the view root as `--t3-files-*` custom properties; a denied
 * read or a dead stream clears it and every style falls back to its legacy
 * `var()` chain — the honest degraded path.
 */
function useThemeVars(
  host: ClientHost,
  session: ViewSession,
  visible: boolean,
): Record<string, string> | null {
  const [vars, setVars] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    void watchThemeVars({
      client: host,
      context: session.context,
      signal: AbortSignal.any([controller.signal, session.signal]),
      apply: setVars,
    });
    return () => controller.abort();
  }, [host, session, visible]);
  return vars;
}

/**
 * `t3.ui/preferences` consumer for the client settings the native file
 * preview honors. `wordWrap.value` is null while the preference is
 * unavailable (ungranted, provider-less host, lost stream): the panel then
 * keeps its pre-contract wrapping and hides the toggle. Toggling writes
 * through `setPreferences`; the displayed value changes only when the stream
 * carries the persisted one, never optimistically. `renderHtml` is the last
 * HTML rendered/source choice the host reported, undefined until it reports
 * one (older hosts never do).
 */
function useFilePreferences(host: ClientHost, session: ViewSession, visible: boolean) {
  const [value, setValue] = useState<boolean | null>(null);
  const [renderHtml, setRenderHtml] = useState<boolean | undefined>(undefined);
  // The explorer choice as the view opened: native reads it once, on mount,
  // so a later change elsewhere does not move an open view's explorer.
  const [fileExplorerOpen, setFileExplorerOpen] = useState<boolean | undefined>(undefined);
  // False until the feed first answers — with a value, or with "none" from a
  // host without the preference. Until then the saved HTML choice is unknown.
  const [answered, setAnswered] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  // Counts the user's own HTML choices. A first answer begun before the
  // latest one is older than it and leaves the HTML choice alone.
  const htmlChoices = useRef(0);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    const begunAt = htmlChoices.current;
    const current = () => htmlChoices.current === begunAt;
    let subscribed = false;
    let streamAnswered = false;
    let explorerRead = false;
    const readExplorer = (open: boolean | undefined) => {
      if (open === undefined || explorerRead) return;
      explorerRead = true;
      setFileExplorerOpen(open);
    };
    void watchPreferences({
      client: host,
      context: session.context,
      signal,
      apply: (preferences) => {
        setValue(preferences?.wordWrap ?? null);
        if (preferences?.renderBrowserFile !== undefined && (streamAnswered || current()))
          setRenderHtml(preferences.renderBrowserFile);
        readExplorer(preferences?.fileExplorerOpen);
        // The clear watchPreferences makes synchronously as it subscribes is
        // not an answer; every later call is.
        if (subscribed) {
          streamAnswered = true;
          setAnswered(true);
        }
      },
    });
    subscribed = true;
    // The stream has no first-frame deadline; this read has the request's. A
    // silent stream still settles the HTML choice: the saved one, or, when
    // the read fails too, the view's own.
    bindApi(uiPreferencesApi, host, session.context)
      .invoke("getPreferences", {}, signal)
      .then(
        (preferences) => {
          if (signal.aborted || streamAnswered) return;
          if (preferences.renderBrowserFile !== undefined && current())
            setRenderHtml(preferences.renderBrowserFile);
          readExplorer(preferences.fileExplorerOpen);
          setAnswered(true);
        },
        () => {
          if (!signal.aborted && !streamAnswered) setAnswered(true);
        },
      );
    return () => controller.abort();
  }, [host, session, visible]);
  const toggle = () => {
    if (value === null) return;
    setWriteError(null);
    void writeWordWrap({
      client: host,
      context: session.context,
      signal: session.signal,
      wordWrap: !value,
    }).then((error) => {
      if (!session.signal.aborted) setWriteError(error);
    });
  };
  const chooseHtml = () => {
    htmlChoices.current++;
  };
  return {
    wordWrap: { value, writeError, toggle },
    renderHtml,
    answered,
    chooseHtml,
    fileExplorerOpen,
  };
}

/**
 * Live views holding each command-set token. The host dedupes identical
 * registrations onto one token, so sibling Files views in the same context
 * share theirs — the token must outlive every view that holds it.
 */
const commandSetUsers = new Map<string, number>();

function acquireCommandSet(commandSetToken: string) {
  commandSetUsers.set(commandSetToken, (commandSetUsers.get(commandSetToken) ?? 0) + 1);
}

/**
 * Drops one view's hold on a command set, unregistering once the last holder
 * is gone. The release runs on its own signal — at view disposal the
 * session's signal is already aborted, and a stranded registration
 * accumulates in the host registry and replays on every reconnect.
 */
function releaseCommandSet(host: ClientHost, session: ViewSession, commandSetToken: string) {
  const remaining = (commandSetUsers.get(commandSetToken) ?? 0) - 1;
  if (remaining > 0) {
    commandSetUsers.set(commandSetToken, remaining);
    return;
  }
  commandSetUsers.delete(commandSetToken);
  void bindApi(uiKeybindingsApi, host, session.context, "^1.1.0")
    .invoke("unregisterCommands", { commandSetToken }, new AbortController().signal)
    .catch(() => {});
}

/**
 * `t3.ui/keybindings` consumer. The panel's actions register as a
 * `surface`-scope command set and bind through `session.bindCommands`, so
 * dispatch runs the host's arbitration — focused-view binding first, with
 * user rules and native defaults outranking the plugin `defaultKey`s.
 * Registration or binding failure (ungranted grant, provider-less host) just
 * leaves the toolbar buttons as the only trigger — commands never gate the
 * panel.
 *
 * Registration and binding are separate effects: `bindCommands` throws
 * "View is inactive" on a hidden view, and a registration that resolves
 * while hidden must not lose the shortcuts for the session's lifetime. A
 * bound set survives hide/show (its unbind rides view disposal), so the
 * binding effect binds once per token on the first visible frame and
 * retries on each subsequent one until it lands.
 */
function useFilesCommands(
  host: ClientHost,
  session: ViewSession,
  visible: boolean,
  actions: {
    readonly refresh: () => void;
    readonly focusSearch: () => void;
    readonly openIn: () => void;
    readonly toggleMarkdown: () => void;
  },
) {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const [commandSet, setCommandSet] = useState<{
    readonly session: ViewSession;
    readonly token: string;
    readonly ids: ReadonlySet<string>;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(uiKeybindingsApi, host, session.context, "^1.1.0")
      .invoke("registerCommands", { commands: FILES_VIEW_COMMANDS }, signal)
      .then((result) => {
        const ids = new Set(
          result.results
            .filter((entry) => entry.status === "registered")
            .map((entry) => entry.commandId),
        );
        // Count the hold before the liveness check: the token may already be
        // shared with a live sibling view, and a release that skipped the
        // count would unregister the set out from under it.
        acquireCommandSet(result.commandSetToken);
        // Registration can land after the view died or the session changed —
        // the token is still real, so release this hold rather than
        // orphaning it. (A registration committed *after* abort rejects
        // before this handler and stays registered until environment
        // teardown — bounded, and the registry dedupes it back into use if
        // the view returns.)
        if (signal.aborted || ids.size === 0) {
          releaseCommandSet(host, session, result.commandSetToken);
          return;
        }
        setCommandSet({ session, token: result.commandSetToken, ids });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [host, session]);
  useEffect(() => {
    if (commandSet === null || commandSet.session !== session) return;
    session.onDispose(() => releaseCommandSet(host, session, commandSet.token));
  }, [host, session, commandSet]);
  const boundTokenRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      !visible ||
      commandSet === null ||
      commandSet.session !== session ||
      boundTokenRef.current === commandSet.token
    )
      return;
    try {
      session.bindCommands(commandSet.token, ({ commandId }) => {
        if (!commandSet.ids.has(commandId)) return;
        actionsRef.current[commandId as keyof typeof actions]?.();
      });
      boundTokenRef.current = commandSet.token;
    } catch {
      // Inactive view or a host without a binding seam — the next visible
      // frame retries; the toolbar buttons carry the actions meanwhile.
    }
  }, [session, visible, commandSet]);
}

const HEADING_SIZE: readonly number[] = [0, 22, 18, 16, 14, 13, 12];

/**
 * What a workspace link in rendered markdown can do. `baseDir` is the
 * directory of the document being rendered; `openPath` selects (and reveals
 * a line in) a workspace file; `revealLine` scrolls the current document.
 */
interface MarkdownLinkActions {
  readonly baseDir: string;
  readonly openPath: (path: string, line?: number) => void;
  readonly revealLine: (line: number) => void;
}

const linkButtonStyle = {
  display: "inline",
  padding: 0,
  border: "none",
  background: "none",
  font: "inherit",
  cursor: "pointer",
  color: "var(--t3-files-message-action, var(--primary, #175cd3))",
  textDecoration: "underline",
} as const;

/** Short content digest — enough for sibling-unique, rerender-stable keys. */
function nodeDigest(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return hash.toString(36);
}

/**
 * Data-derived keys for rendered node lists: content digest plus the
 * occurrence count among identical siblings. Stable across re-parses of the
 * same source and unique without positional index keys.
 */
function keyed<T>(items: readonly T[], keyOf: (item: T) => string) {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = keyOf(item);
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return { item, key: `${base}#${occurrence}` };
  });
}

/** One inline markdown node → a host-React element. */
function MarkdownInlineNode(props: {
  readonly node: MarkdownInline;
  readonly links?: MarkdownLinkActions;
}) {
  const node = props.node;
  const links = props.links;
  switch (node.type) {
    case "text":
      return node.text;
    case "code":
      return (
        <code
          style={{
            fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace)",
            fontSize: "0.92em",
            background: "var(--t3-files-muted, var(--muted, #f2f4f7))",
            borderRadius: 4,
            padding: "0 3px",
          }}
        >
          {node.text}
        </code>
      );
    case "strong":
      return (
        <strong>
          <MarkdownInlines nodes={node.children} links={links} />
        </strong>
      );
    case "em":
      return (
        <em>
          <MarkdownInlines nodes={node.children} links={links} />
        </em>
      );
    case "delete":
      return (
        <del>
          <MarkdownInlines nodes={node.children} links={links} />
        </del>
      );
    case "link": {
      if (node.href.startsWith("#")) {
        // `#L…` anchors reveal a line in this document; other fragments have
        // no heading targets in this view, so they stay inert rather than
        // rewriting the host page's location hash.
        const anchor = links === undefined ? null : resolveWorkspaceLink(node.href, "");
        return links !== undefined && anchor?.kind === "anchor" && anchor.line !== undefined ? (
          <button
            data-t3-files-fallback-control
            type="button"
            style={linkButtonStyle}
            onClick={() => links.revealLine(anchor.line ?? 0)}
          >
            <MarkdownInlines nodes={node.children} links={links} />
          </button>
        ) : (
          <span>
            <MarkdownInlines nodes={node.children} links={links} /> ({node.href})
          </span>
        );
      }
      if (node.safe) {
        return (
          <a href={node.href} target="_blank" rel="noreferrer">
            <MarkdownInlines nodes={node.children} links={links} />
          </a>
        );
      }
      // Relative destinations resolve against the rendered document's
      // directory; only workspace paths become navigable.
      const target = links === undefined ? null : resolveWorkspaceLink(node.href, links.baseDir);
      return links !== undefined && target?.kind === "workspace" ? (
        <button
          data-t3-files-fallback-control
          type="button"
          style={linkButtonStyle}
          onClick={() => links.openPath(target.path, target.line)}
        >
          <MarkdownInlines nodes={node.children} links={links} />
        </button>
      ) : (
        // Unsafe/unresolvable destinations stay visible but never navigable.
        <span>
          <MarkdownInlines nodes={node.children} links={links} /> ({node.href})
        </span>
      );
    }
    case "image":
      return (
        <span
          style={{ color: "var(--t3-files-muted-foreground, var(--muted-foreground, #667085))" }}
        >
          [image: {node.alt || node.src}]
        </span>
      );
    case "break":
      return <br />;
  }
}

/**
 * Inline markdown → host-React elements. Every text node is escaped by React;
 * the only attribute ever emitted is `href` on a safe-scheme anchor, so the
 * markup source has no injection surface at all.
 */
function MarkdownInlines(props: {
  readonly nodes: readonly MarkdownInline[];
  readonly links?: MarkdownLinkActions;
}) {
  return keyed(props.nodes, (node) => `i:${nodeDigest(node)}`).map(({ item, key }) => (
    <MarkdownInlineNode key={key} node={item} links={props.links} />
  ));
}

/** One block → host-React elements; plain elements only, no raw HTML. */
function MarkdownBlockNode(props: {
  readonly block: MarkdownBlock;
  readonly links?: MarkdownLinkActions;
}) {
  const block = props.block;
  switch (block.type) {
    case "heading": {
      const Tag = `h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return (
        <Tag
          style={{
            fontSize: HEADING_SIZE[block.level],
            fontWeight: 600,
            margin: "14px 0 6px",
          }}
        >
          <MarkdownInlines nodes={block.children} links={props.links} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p style={{ margin: "0 0 10px" }}>
          <MarkdownInlines nodes={block.children} links={props.links} />
        </p>
      );
    case "code":
      return (
        <figure style={{ margin: "0 0 10px" }}>
          {block.info !== "" && (
            <figcaption
              style={{
                color: "var(--t3-files-muted-foreground, var(--muted-foreground, #667085))",
                fontSize: 11,
                marginBottom: 2,
              }}
            >
              {block.info}
            </figcaption>
          )}
          <pre
            style={{
              margin: 0,
              padding: 10,
              overflow: "auto",
              background: "var(--t3-files-muted, var(--muted, #f2f4f7))",
              borderRadius: 6,
              fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace)",
              fontSize: 12,
            }}
          >
            <code>{block.text}</code>
          </pre>
        </figure>
      );
    case "quote":
      return (
        <blockquote
          style={{
            margin: "0 0 10px",
            paddingLeft: 12,
            borderLeft: "3px solid var(--t3-files-border, var(--border, #dfe3e8))",
            color: "var(--t3-files-muted-foreground, var(--muted-foreground, #667085))",
          }}
        >
          <MarkdownBlocks blocks={block.children} links={props.links} />
        </blockquote>
      );
    case "list": {
      const ListTag = block.ordered ? "ol" : "ul";
      return (
        <ListTag style={{ margin: "0 0 10px", paddingLeft: 24 }}>
          {keyed(block.items, (item) => `li:${nodeDigest(item)}`).map(({ item, key }) => (
            <li key={key} style={{ marginBottom: 4 }}>
              {item.task !== undefined && (
                <input
                  data-t3-files-fallback-control
                  type="checkbox"
                  checked={item.task.checked}
                  disabled
                  readOnly
                  aria-label={item.task.checked ? "Completed task" : "Incomplete task"}
                  style={{ marginRight: 6 }}
                />
              )}
              <MarkdownBlocks blocks={item.children} links={props.links} />
            </li>
          ))}
        </ListTag>
      );
    }
    case "rule":
      return (
        <hr
          style={{
            border: 0,
            borderTop: "1px solid var(--t3-files-border, var(--border, #dfe3e8))",
            margin: "14px 0",
          }}
        />
      );
  }
}

/**
 * Block tree → host-React elements for the rendered-markdown preview.
 * Plain elements only — no raw HTML, no user-controlled attributes.
 */
function MarkdownBlocks(props: {
  readonly blocks: readonly MarkdownBlock[];
  readonly links?: MarkdownLinkActions;
}) {
  return keyed(props.blocks, (block) => `b:${nodeDigest(block)}`).map(({ item, key }) => (
    <MarkdownBlockNode key={key} block={item} links={props.links} />
  ));
}

/** The rendered-markdown surface: block view plus the named-subset caption. */
function RenderedMarkdown(props: {
  readonly blocks: readonly MarkdownBlock[];
  readonly links?: MarkdownLinkActions;
}) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 12 }}>
      <article
        aria-label="Rendered markdown"
        style={{ lineHeight: 1.55, overflowWrap: "break-word" }}
      >
        <MarkdownBlocks blocks={props.blocks} links={props.links} />
      </article>
      <footer
        style={{
          color: "var(--t3-files-muted-foreground, var(--muted-foreground, #667085))",
          fontSize: 12,
          marginTop: 12,
        }}
      >
        Rendered preview — markdown subset (raw HTML, tables and images are not rendered; task lists
        are read-only)
      </footer>
    </div>
  );
}

/**
 * Breadcrumbs for the selected path. The root crumb is labeled
 * "Workspace" because no public contract reports the project title to a
 * project-scope view — naming it anything else would fabricate. Crumb menus
 * list children from the tree snapshot the panel already holds; drilling into
 * a subdirectory re-targets the menu, bounded back at the crumb's own dir.
 */
const WORKSPACE_ROOT_LABEL = "Workspace";

function FileBreadcrumbBar(props: {
  readonly host: ClientHost;
  readonly selected: string;
  readonly entries: readonly TreeEntry[];
  readonly truncated: boolean;
  readonly onSelect: (path: string) => void;
}) {
  const { host, selected, entries, truncated, onSelect } = props;
  const crumbs = fileBreadcrumbs(WORKSPACE_ROOT_LABEL, selected);
  // Host-absolute paths are outside the workspace — labels only, no menus.
  const hostPath = isAbsolutePath(selected);
  // The open menu is keyed to the path it opened under — a selection change
  // closes it by derivation, no reset effect needed. The anchor is the
  // crumb's viewport rect at click time; the menu re-clamps itself against
  // the viewport on every content change and the bar dismisses it on resize.
  const [openMenu, setOpenMenu] = useState<{
    crumb: string;
    forPath: string;
    left: number;
    top: number;
    bottom: number;
  } | null>(null);
  const openCrumb = openMenu !== null && openMenu.forPath === selected ? openMenu : null;
  const [menuDir, setMenuDir] = useState("");
  const navRef = useRef<HTMLElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    navRef.current
      ?.querySelector("[data-current-file-crumb]")
      ?.scrollIntoView({ block: "nearest", inline: "end" });
    // `selected` is the intentional trigger — the body reads DOM state only.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [selected]);
  // An open menu anchors to click-time viewport coordinates, so anything
  // that moves the bar invalidates it. ResizeObserver catches resizes of
  // the bar itself (panel splitters); window "resize" catches resizes that
  // only translate it — a vertical window drag moves the bar while its own
  // size stays constant, which RO cannot see. ResizeObserver fires once on
  // observation start; skip that initial call.
  const menuOpen = openCrumb !== null;
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!menuOpen || wrap === null) return;
    let initial = true;
    const observer = new ResizeObserver(() => {
      if (initial) {
        initial = false;
        return;
      }
      setOpenMenu(null);
    });
    observer.observe(wrap);
    const dismiss = () => setOpenMenu(null);
    window.addEventListener("resize", dismiss);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", dismiss);
    };
  }, [menuOpen]);
  const muted = "var(--t3-files-muted-foreground, var(--muted-foreground, #667085))";
  return (
    // The menu must live outside the scrolling nav — anything inside an
    // `overflow-x` container is clipped to its box.
    <div
      ref={wrapRef}
      style={{
        position: "relative",
        borderTop: "1px solid var(--t3-files-border, var(--border, #dfe3e8))",
        flexShrink: 0,
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpenMenu(null);
      }}
    >
      <nav
        aria-label="File path"
        ref={navRef}
        onScroll={() => setOpenMenu(null)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: "4px 10px",
          overflowX: "auto",
          whiteSpace: "nowrap",
          fontSize: 12,
          color: "var(--t3-files-text, var(--foreground, #20252d))",
        }}
      >
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          const menuable = !hostPath && !last;
          return (
            <span key={crumb.path || crumb.label} style={{ flexShrink: 0 }}>
              {menuable ? (
                <Tooltip host={host} side="top" label={fileBreadcrumbTooltip(crumb)}>
                  <button
                    data-t3-files-fallback-control
                    type="button"
                    aria-label={`Browse ${crumb.label}`}
                    aria-haspopup="menu"
                    aria-expanded={openCrumb?.crumb === crumb.path}
                    onClick={(event) => {
                      if (openCrumb?.crumb === crumb.path) {
                        setOpenMenu(null);
                        return;
                      }
                      const anchor = event.currentTarget.getBoundingClientRect();
                      setMenuDir(crumb.path);
                      setOpenMenu({
                        crumb: crumb.path,
                        forPath: selected,
                        left: anchor.left,
                        top: anchor.top,
                        bottom: anchor.bottom,
                      });
                    }}
                    style={{
                      border: "none",
                      background:
                        openCrumb?.crumb === crumb.path
                          ? "var(--t3-files-accent-surface, var(--accent, #e8eef7))"
                          : "none",
                      font: "inherit",
                      color: "inherit",
                      padding: "1px 4px",
                      borderRadius: 4,
                      cursor: "pointer",
                    }}
                  >
                    {crumb.label}
                  </button>
                </Tooltip>
              ) : (
                <Tooltip host={host} side="top" label={crumb.path}>
                  <span
                    {...(last ? { "data-current-file-crumb": "" } : {})}
                    aria-current={last ? "page" : undefined}
                    style={{ padding: "1px 4px", fontWeight: last ? 600 : 400 }}
                  >
                    {crumb.label}
                  </span>
                </Tooltip>
              )}
              {!last && (
                <span aria-hidden="true" style={{ color: muted, padding: "0 1px" }}>
                  /
                </span>
              )}
            </span>
          );
        })}
      </nav>
      {openCrumb !== null && (
        <CrumbMenu
          host={host}
          rootPath={openCrumb.crumb}
          menuDir={menuDir}
          anchor={{ left: openCrumb.left, top: openCrumb.top, bottom: openCrumb.bottom }}
          entries={entries}
          selected={selected}
          truncated={truncated}
          onNavigate={setMenuDir}
          onSelect={(path) => {
            onSelect(path);
            setOpenMenu(null);
          }}
          onClose={() => setOpenMenu(null)}
        />
      )}
    </div>
  );
}

/** The open crumb's child-entry menu — files select, directories drill in. */
function CrumbMenu(props: {
  readonly host: ClientHost;
  readonly rootPath: string;
  readonly menuDir: string;
  readonly anchor: { readonly left: number; readonly top: number; readonly bottom: number };
  readonly entries: readonly TreeEntry[];
  readonly selected: string;
  readonly truncated: boolean;
  readonly onNavigate: (dir: string) => void;
  readonly onSelect: (path: string) => void;
  readonly onClose: () => void;
}) {
  const {
    host,
    rootPath,
    menuDir,
    anchor,
    entries,
    selected,
    truncated,
    onNavigate,
    onSelect,
    onClose,
  } = props;
  const children = fileBreadcrumbChildren(entries, menuDir);
  const parent = fileBreadcrumbParent(menuDir);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Fixed-positioned at the anchor, then clamped into the viewport on both
  // axes against the menu's measured size: left shifts left when the right
  // edge would overflow, and the menu flips above the crumb (or shrinks via
  // maxHeight) when there isn't room below. Runs after every render so
  // drill-in content changes re-clamp against the new measured size.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const left = Math.max(4, Math.min(anchor.left, vw - rect.width - 4));
    let top = anchor.bottom + 2;
    if (top + rect.height > vh - 4) top = Math.max(4, anchor.top - rect.height - 2);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.maxWidth = `${Math.max(180, Math.min(320, vw - left - 4))}px`;
    el.style.maxHeight = `${Math.max(80, Math.min(260, vh - top - 4))}px`;
  });
  const muted = "var(--t3-files-muted-foreground, var(--muted-foreground, #667085))";
  const itemStyle = {
    display: "block",
    width: "100%",
    textAlign: "left",
    font: "inherit",
    fontSize: 12,
    padding: "4px 8px",
    border: "none",
    borderRadius: 4,
    cursor: "pointer",
    background: "none",
    color: "var(--t3-files-text, var(--foreground, #20252d))",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as const;
  return (
    <>
      <button
        data-t3-files-fallback-control
        type="button"
        aria-label="Close directory menu"
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 9,
          border: "none",
          background: "transparent",
          cursor: "default",
        }}
      />
      <div
        role="menu"
        ref={menuRef}
        aria-label={`Contents of ${menuDir === "" ? WORKSPACE_ROOT_LABEL : menuDir}`}
        style={{
          position: "fixed",
          top: anchor.bottom + 2,
          left: anchor.left,
          zIndex: 10,
          minWidth: 180,
          maxWidth: 320,
          maxHeight: 260,
          overflow: "auto",
          padding: 4,
          border: "1px solid var(--t3-files-border, var(--border, #dfe3e8))",
          borderRadius: 6,
          background: "var(--t3-files-canvas, var(--background, #fff))",
          boxShadow: "0 4px 16px rgba(0, 0, 0, 0.12)",
        }}
      >
        {menuDir !== rootPath && parent !== null && (
          <button
            data-t3-files-fallback-control
            type="button"
            role="menuitem"
            onClick={() => onNavigate(parent)}
            style={itemStyle}
          >
            ‹ Back to {parent === "" ? WORKSPACE_ROOT_LABEL : (parent.split("/").at(-1) ?? parent)}
          </button>
        )}
        {children.map((child) => (
          <Tooltip key={child.path} host={host} side="right" label={child.path}>
            <button
              data-t3-files-fallback-control
              type="button"
              role="menuitem"
              aria-current={child.path === selected ? "true" : undefined}
              onClick={() =>
                child.kind === "directory" ? onNavigate(child.path) : onSelect(child.path)
              }
              style={{
                ...itemStyle,
                background:
                  child.path === selected
                    ? "var(--t3-files-accent-surface, var(--accent, #e8eef7))"
                    : "none",
              }}
            >
              {child.kind === "directory" ? `${child.label}/` : child.label}
            </button>
          </Tooltip>
        ))}
        {children.length === 0 && (
          <div role="none" style={{ padding: "4px 8px", color: muted, fontSize: 12 }}>
            Empty
          </div>
        )}
        {truncated && (
          <div role="none" style={{ padding: "4px 8px", color: muted, fontSize: 12 }}>
            Index truncated — some entries are not shown
          </div>
        )}
      </div>
    </>
  );
}

/*
 * Native toolbar control idiom (cert files-3): the native Files toolbar uses
 * text-sm ghost controls — no border at rest, transparent background — with
 * the host's focus ring (style block on the panel root) supplying keyboard
 * affordance. The 1px transparent border keeps the control's box metrics
 * identical to the native ghost button.
 */
const toolbarControl = {
  font: "inherit",
  fontSize: 14,
  padding: "4px 8px",
  border: "1px solid transparent",
  borderRadius: 5,
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
} as const;

function FilesView(props: { host: ClientHost; session: ViewSession }) {
  const kit = resolveUiKit(props.host);
  const ActionButton = kit?.Button ?? "button";
  const actionProps = kit
    ? ({ variant: "outline", size: "xs" } as const)
    : { "data-t3-files-fallback-control": "" };
  const { host, session } = props;
  const [visible, setVisible] = useState(session.visible);
  useEffect(() => session.onVisibility(setVisible), [session]);
  const changes = useWorkspaceChanges(host, session, visible);
  const { entries, status, refresh, revision, pending, truncated } = useWorkspaceTree(
    host,
    session,
    visible,
    changes,
  );
  const themeVars = useThemeVars(host, session, visible);
  const preferences = useFilePreferences(host, session, visible);
  const externalEditor = useExternalEditor(host, session);
  const [editorMenuOpen, setEditorMenuOpen] = useState(false);
  const wordWrap = preferences.wordWrap;
  // Native parity (FileBrowserPanel): one control opens every folder, or
  // closes them all once they are open. While expand-all stands, folders
  // that later appear open too, and folders closed by hand stay closed.
  const [folders, setFolders] = useState(() => restoredFolders(session.restoreState));
  const directories = useMemo(() => treeDirectories(entries), [entries]);
  const expanded = useMemo(() => expandedFolders(folders, directories), [folders, directories]);
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"names" | "contents">("names");
  const [kindFilter, setKindFilter] = useState<SearchKindFilter>("all");
  const [search, setSearch] = useState<{
    key: string;
    outcome:
      | { mode: "names"; results: SearchResults | null; error: string | null }
      | { mode: "contents"; results: ContentSearchResults | null; error: string | null };
  } | null>(null);
  const [selected, setSelected] = useState<string | null>(() =>
    restoredSelection(session.restoreState),
  );
  const [read, setRead] = useState<{
    relativePath: string;
    revision: number;
    contents: string;
    status: string;
    truncated: boolean;
  } | null>(null);
  // The latest centered line reveal request — set by search hits and
  // link targets, tracked as handled once the content surface scrolls.
  // `id` tells repeated requests for the same line apart for the host view.
  // A file link's line arrives with the view (`t3.file/presentation.open`)
  // as request 1; later requests count on from there.
  const revealSequence = useRef(1);
  const [revealRequest, setRevealRequest] = useState<{
    path: string;
    line: number;
    id: number;
  } | null>(() => {
    const path = restoredSelection(session.restoreState);
    const line = restoredRevealLine(session.restoreState);
    return path !== null && line !== null ? { path, line, id: 1 } : null;
  });
  const handledRevealRef = useRef<{ path: string; line: number; id: number } | null>(null);
  const readOnlyRef = useRef<HTMLPreElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  // HTML renders by default; a pending line reveal shows the source it
  // scrolls. The choice is the client's shared preference — the native
  // panel's own — so it carries across files, presentations and reloads; the
  // view record keeps it too for hosts that predate the preference.
  const [renderHtml, setRenderHtml] = useState(() => restoredRenderHtml(session.restoreState));
  // The user's own toggle settles the choice without waiting for the preference.
  const [htmlChosen, setHtmlChosen] = useState(false);
  const htmlUnsettled = !preferences.answered && !htmlChosen;
  const [reportedRenderHtml, setReportedRenderHtml] = useState(preferences.renderHtml);
  if (preferences.renderHtml !== reportedRenderHtml) {
    setReportedRenderHtml(preferences.renderHtml);
    if (preferences.renderHtml !== undefined) setRenderHtml(preferences.renderHtml);
  }
  const selectedKind: PreviewKind = selected
    ? presentedPreviewKind(selected, {
        // Until the preference answers, an HTML file is held on the page side
        // with nothing loaded, so neither the page nor its source flashes.
        renderHtml: renderHtml || htmlUnsettled,
        revealPath: revealRequest?.path ?? null,
      })
    : "text";
  const awaitingHtmlChoice = selectedKind === "html" && htmlUnsettled;
  const editor = useFileEditor(host, session, selected, selectedKind, revision, visible);
  const media = useMediaLease(
    host,
    session,
    selected,
    selectedKind,
    revision,
    visible && !awaitingHtmlChoice,
  );
  const currentRead = read?.relativePath === selected && read.revision === revision ? read : null;
  // Native parity: a bump while the selected file's save state is latched
  // (dirty/saving/conflict/error) stays pending instead of clobbering local
  // edits; when the latch opens the pending seq fires one catch-up refresh.
  const savePending =
    editor.surface?.path === selected &&
    editor.surface !== null &&
    editorSavePending(editor.surface.saveState.kind);
  useMutationRefresh({
    mutationSeq: changes.mutationSeq,
    enabled: visible && !savePending,
    refresh,
    resumed: changes.resumed,
  });
  const kindByPath = useMemo(() => new Map(entries.map((e) => [e.path, e.kind])), [entries]);
  const searching = query.trim() !== "";
  const rows = useMemo(
    () => visibleRows(entries, expanded, "", kit !== null),
    [entries, expanded, kit],
  );
  const rowIndex = useMemo(
    () => new Map(rows.map((row, index) => [row.entry.path, index])),
    [rows],
  );
  // Native parity (FileBrowserPanel's virtualized tree): only the rows near
  // the viewport mount, so an expanded tree of any size stays cheap. The
  // focused row stays mounted so keyboard focus survives scrolling.
  const [focusedRow, setFocusedRow] = useState<string | null>(null);
  const tabStopPath =
    focusedRow ?? (selected && rowIndex.has(selected) ? selected : rows[0]?.entry.path);
  const tree = useWindowedRows(host, {
    count: rows.length,
    rowHeight: TREE_ROW_HEIGHT,
    ...(tabStopPath !== undefined ? { keep: rowIndex.get(tabStopPath) } : {}),
  });
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusTarget = useRef<string | null>(null);
  useEffect(() => {
    const path = focusTarget.current;
    const button = path === null ? undefined : rowButtons.current.get(path);
    if (button === undefined) return;
    focusTarget.current = null;
    button.focus({ preventScroll: true });
  });
  const focusRow = (index: number) => {
    const path = rows[index]?.entry.path;
    if (path === undefined) return;
    focusTarget.current = path;
    setFocusedRow(path);
    tree.reveal(index);
  };
  // Native parity (FileTreeController's focus reconciliation): when a refresh
  // or collapse takes away the focused row, focus moves to its nearest open
  // folder if it is only hidden, else to the row now in its place.
  const lastFocusedIndex = useRef(0);
  const revealFocusRow = tree.reveal;
  useEffect(() => {
    if (focusedRow === null) return;
    const index = rowIndex.get(focusedRow);
    if (index !== undefined) {
      lastFocusedIndex.current = index;
      return;
    }
    let next: number | undefined;
    if (kindByPath.has(focusedRow))
      for (
        let path = parentPath(focusedRow);
        path !== null && next === undefined;
        path = parentPath(path)
      )
        next = rowIndex.get(path);
    next ??= Math.min(lastFocusedIndex.current, rows.length - 1);
    const path = rows[next]?.entry.path ?? null;
    focusTarget.current = path;
    setFocusedRow(path);
    if (path !== null) revealFocusRow(next);
  }, [focusedRow, rowIndex, rows, kindByPath, revealFocusRow]);
  const toggleTreeFolder = (row: (typeof rows)[number]) =>
    setFolders((previous) => {
      const next = toggleFolder(previous, row.entry.path);
      // Flattened intermediates open with their visible row, so a new sibling
      // can split the chain without hiding the branch the user opened.
      return expanded.has(row.entry.path) ? next : openFolders(next, row.directoryPaths ?? []);
    });
  // Tree keys, as native's: up/down/home/end move; right opens a folder or
  // enters it; left closes it or moves to its parent.
  const onTreeKeyDown = (event: KeyboardEvent) => {
    const index = focusedRow === null ? undefined : rowIndex.get(focusedRow);
    const row = index === undefined ? undefined : rows[index];
    if (index === undefined || row === undefined) return;
    const open = row.expandable && expanded.has(row.entry.path);
    let next: number | undefined;
    if (event.key === "ArrowDown") next = Math.min(rows.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    else if (event.key === "ArrowRight" && row.expandable)
      next = open ? ((rows[index + 1]?.depth ?? 0) > row.depth ? index + 1 : index) : undefined;
    else if (event.key === "ArrowLeft") {
      const parent = parentPath(row.entry.path);
      const parentIndex = kit
        ? rows.slice(0, index).findLastIndex((candidate) => candidate.depth < row.depth)
        : parent === null
          ? index
          : rowIndex.get(parent);
      next = open ? undefined : parentIndex === -1 ? index : parentIndex;
    } else return;
    event.preventDefault();
    if (next === undefined) toggleTreeFolder(row);
    else focusRow(next);
  };
  // A file selected from anywhere — a link, search, the breadcrumb — scrolls
  // into view in the tree once its folders have opened.
  const [treeReveal, setTreeReveal] = useState<string | null>(selected);
  const revealTreeRow = tree.reveal;
  useEffect(() => {
    if (treeReveal === null) return;
    const index = rowIndex.get(treeReveal);
    if (index === undefined) return;
    setTreeReveal(null);
    revealTreeRow(index);
  }, [treeReveal, rowIndex, revealTreeRow]);
  const everyFolderOpen = allDirectoriesExpanded(directories, expanded);
  const toggleAllDirectories = () => setFolders({ all: !everyFolderOpen, paths: new Set() });
  const expandAllLabel = everyFolderOpen ? "Collapse all folders" : "Expand all folders";
  const [fileOpen, setFileOpen] = useState<{ path: string; state: FileOpenState } | null>(null);
  // Rendered-vs-source is a preference, not a property of one file — the same
  // shape as the native panel's localStorage flag, persisted with the view.
  const [renderMarkdown, setRenderMarkdown] = useState(() =>
    restoredRenderMarkdown(session.restoreState),
  );
  // Native parity (FilePreviewPanel): a pending line reveal shows the source,
  // since the line only exists there, until the user chooses the rendered
  // view for that request. That choice is not saved, so a reload reveals the
  // line again.
  const [renderedOverReveal, setRenderedOverReveal] = useState<typeof revealRequest>(null);
  const revealPending =
    revealRequest !== null &&
    revealRequest.path === selected &&
    !(
      renderedOverReveal?.path === revealRequest.path && renderedOverReveal.id === revealRequest.id
    );
  const markdownRendered = renderMarkdown && !revealPending;
  const toggleMarkdown = () => {
    setRenderMarkdown(!markdownRendered);
    if (!markdownRendered) setRenderedOverReveal(revealRequest);
  };
  // Native parity (FilePreviewPanel): the explorer beside an open file can be
  // hidden. The choice is the client's shared one, the native panel's own,
  // read as the view opens and written on each toggle; the view record keeps
  // it for hosts that predate the preference. A toggle before the read
  // answers wins.
  const [explorerOpen, setExplorerOpen] = useState(() =>
    restoredExplorerOpen(session.restoreState),
  );
  const [explorerChosen, setExplorerChosen] = useState(false);
  const [readExplorerOpen, setReadExplorerOpen] = useState(preferences.fileExplorerOpen);
  if (preferences.fileExplorerOpen !== readExplorerOpen) {
    setReadExplorerOpen(preferences.fileExplorerOpen);
    if (preferences.fileExplorerOpen !== undefined && !explorerChosen)
      setExplorerOpen(preferences.fileExplorerOpen);
  }
  const toggleExplorer = () => {
    const next = !explorerOpen;
    setExplorerOpen(next);
    setExplorerChosen(true);
    void writeFileExplorerOpen({
      client: host,
      context: session.context,
      signal: session.signal,
      fileExplorerOpen: next,
    });
  };
  const showExplorer = showsFileExplorer(selected, explorerOpen);
  // The latest reveal of the selected file persists with it, so a reload
  // reveals that line rather than the one the view first opened at.
  const revealLine = revealRequest?.path === selected ? revealRequest.line : null;
  // Row 12: selection, expansion and preview mode persist through one
  // `session.save`; the ref skips re-saving a state that is already stored.
  const savedViewStateRef = useRef<string | null>(null);
  useEffect(() => {
    const state = filesViewState(
      selected,
      folders,
      renderMarkdown,
      renderHtml,
      explorerOpen,
      revealLine,
    );
    const serialized = JSON.stringify(state);
    // The first run only records the restored state — nothing changed yet.
    if (savedViewStateRef.current === null) {
      savedViewStateRef.current = serialized;
      return;
    }
    if (serialized === savedViewStateRef.current) return;
    if (session.save(state)) savedViewStateRef.current = serialized;
  }, [session, selected, folders, renderMarkdown, renderHtml, explorerOpen, revealLine]);

  // Row 14: review comments on file lines. The host editor's line selection
  // expands to full lines; submit lands a real composer draft review comment
  // through the grant-gated `t3.messages/enrichment.attachAnnotation` seam.
  // The draft form captures its range + excerpt pinned to the live buffer
  // when opened — a collapsing selection (the button click blurs the editor)
  // never retargets it, and a drifted buffer turns the draft stale instead
  // of letting submit ship offsets captured against different bytes.
  const commentThreadId = session.context.resource.threadId;
  const { reason: commentBlockReason, capabilities: commentCapabilities } = useCommentTransport(
    host,
    session,
    commentThreadId,
  );
  // Row 13: Add to chat routes the selected file's mention through the
  // composer draft bridge (`t3.composer/context` `insertMention` — the
  // byte-exact native append). The grant-free probe gates the toolbar
  // affordance; a denied write grant surfaces as the inline named error.
  const addChat = useAddToChat(host, session, commentThreadId);
  const [commentBody, setCommentBody] = useState("");
  const [commentSubmit, setCommentSubmit] = useState<{
    busy: boolean;
    error: string | null;
  }>({ busy: false, error: null });
  // The draft is the record of what was posted: listed through
  // `listAnnotations` and removable through `removeAnnotation` when the
  // composer offers them.
  const posted = usePostedComments(host, session, commentThreadId, commentCapabilities, visible);
  // The grant-free capability probe lives in useCommentTransport: a
  // rejected probe names the degraded transport instead of parking the
  // toolbar on "Checking…" forever.
  const commentSurface = editor.surface?.path === selected ? editor.surface : null;
  // Offsets are only meaningful against the buffer they were made in: the
  // hook clears the selection on a path switch, a re-select of the current
  // file, and any new contents identity (edit, reload, external sync).
  const {
    selectionRange,
    setSelection: setEditorSelection,
    clearSelection: clearEditorSelection,
  } = useEditorSelection(commentSurface, selected);
  const {
    draft: commentDraft,
    draftStale: commentDraftStale,
    openDraft,
    closeDraft,
  } = useCommentDraft(commentSurface, selected);
  const openCommentDraft = (range: FileCommentRange) => {
    openDraft(range);
    setCommentBody("");
    setCommentSubmit({ busy: false, error: null });
  };
  const closeCommentDraft = () => {
    closeDraft();
    setCommentBody("");
    setCommentSubmit({ busy: false, error: null });
  };
  const submitCommentDraft = () => {
    const draft = commentDraft;
    const body = commentBody.trim();
    // Stale draft = the pinned buffer drifted under the form; the offsets it
    // captured are dead and must never reach attachAnnotation.
    if (draft === null || commentDraftStale || body === "" || commentSubmit.busy) return;
    setCommentSubmit({ busy: true, error: null });
    void bindApi(messagesEnrichmentApi, host, session.context)
      .invoke(
        "attachAnnotation",
        {
          ...(commentThreadId !== undefined ? { threadId: commentThreadId } : {}),
          annotation: {
            filePath: draft.path,
            startLine: draft.range.startLine,
            endLine: draft.range.endLine,
            body,
            excerpt: draft.excerpt,
          },
        },
        session.signal,
      )
      .then(
        (result) => {
          posted.recordAttached({
            path: draft.path,
            annotationId: result.annotationId,
            rangeLabel: formatCommentRangeLabel(draft.range.startLine, draft.range.endLine),
            text: body,
          });
          closeCommentDraft();
        },
        (error) => {
          setCommentSubmit({
            busy: false,
            error: error instanceof Error ? error.message : "Comment could not be attached",
          });
        },
      );
  };

  useEffect(() => {
    const needle = query.trim();
    if (!needle || !visible) return;
    const key = `${searchMode} ${needle} ${kindFilter} ${revision}`;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    const timer = setTimeout(() => {
      const api = bindApi(workspaceSearchApi, host, session.context);
      if (searchMode === "contents") {
        // The contents contract has no kind field — the selector is disabled
        // in this mode rather than silently ignored.
        void api.invoke("searchContents", { query: needle, limit: SEARCH_LIMIT }, signal).then(
          (result) => {
            if (!signal.aborted)
              setSearch({ key, outcome: { mode: "contents", results: result, error: null } });
          },
          (error) => {
            if (!signal.aborted)
              setSearch({
                key,
                outcome: {
                  mode: "contents",
                  results: null,
                  error:
                    error instanceof Error
                      ? error.message
                      : "Workspace contents search unavailable",
                },
              });
          },
        );
        return;
      }
      void api
        .invoke(
          "search",
          {
            query: needle,
            limit: SEARCH_LIMIT,
            ...(kindFilter === "all" ? {} : { kind: kindFilter }),
          },
          signal,
        )
        .then(
          (result) => {
            if (!signal.aborted)
              setSearch({ key, outcome: { mode: "names", results: result, error: null } });
          },
          (error) => {
            if (!signal.aborted)
              setSearch({
                key,
                outcome: {
                  mode: "names",
                  results: null,
                  error: error instanceof Error ? error.message : "Workspace search unavailable",
                },
              });
          },
        );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [host, session, query, kindFilter, searchMode, revision, visible]);
  const activeSearch =
    searching && search?.key === `${searchMode} ${query.trim()} ${kindFilter} ${revision}`
      ? search
      : null;

  // Choosing the rendered page also settles a reveal that forced the source.
  // A failed preference write (an older host) leaves the per-view choice.
  const toggleHtml = () => {
    const next = selectedKind !== "html";
    setRenderHtml(next);
    setHtmlChosen(true);
    preferences.chooseHtml();
    if (next) setRevealRequest(null);
    void writeRenderHtml({
      client: host,
      context: session.context,
      signal: session.signal,
      renderHtml: next,
    });
  };

  const select = (path: string, line?: number) => {
    setSelected(path);
    setTreeReveal(path);
    // Selecting is navigating: any held selection and any open draft die
    // here even when the path (and its contents) did not change.
    clearEditorSelection();
    closeCommentDraft();
    // A plain selection also cancels any reveal still pending for another path.
    if (line !== undefined && line > 0) {
      setRevealRequest({ path, line, id: ++revealSequence.current });
    } else {
      setRevealRequest(null);
    }
    const parent = parentPath(path);
    if (parent !== null) openFolderChain(parent);
  };

  /** Opens a folder and every folder above it. */
  const openFolderChain = (path: string) => {
    const chain: string[] = [];
    for (let folder: string | null = path; folder !== null; folder = parentPath(folder))
      chain.push(folder);
    setFolders((previous) => openFolders(previous, chain));
  };

  // A later open of this view (a file link, "Open in panel") arrives in
  // place: it selects the named file, and a line reveals in the editor that
  // is already open, so pending edits and save state stay with it. A path
  // already shown without a line only focuses the view.
  const navigate = (state: unknown) => {
    const path = restoredSelection(state);
    const line = restoredRevealLine(state) ?? undefined;
    if (path !== null && (line !== undefined || path !== selected)) select(path, line);
  };
  const navigateRef = useRef(navigate);
  useLayoutEffect(() => {
    navigateRef.current = navigate;
  });
  useEffect(() => session.onNavigate?.((state) => navigateRef.current(state)), [session]);

  // Rows drag a serialized composer mention on the MIME the host
  // composer claims — the drop handler there does the insertion, so the
  // plugin needs no composer contract. No text/plain fallback, matching the
  // native tree so mention drags stay distinguishable from selected text.
  const startMentionDrag = (event: DragEvent, path: string) => {
    const payload = dragMentionPayload([path]);
    if (payload === null) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(COMPOSER_MENTION_DRAG_TYPE, payload);
    event.dataTransfer.effectAllowed = "copy";
  };

  // "Open in panel" opens the file where the host's own file links land —
  // `t3.ui/navigation.openFile` on this view's thread, presented by the
  // selected t3.file/presentation provider (this pack, by default).
  // Native parity: a failed open toasts (the native panel raises a thread
  // toast on preview-open failure) while opening/opened stay inline.
  // When `t3.ui/notifications` is unavailable the inline row stands as the
  // degraded surface — the failure is never dropped silently.
  const failFileOpen = (path: string, state: FileOpenState, title?: string) => {
    // Inline first — the failure surface never depends on the notification
    // grant being granted or the invoke landing.
    setFileOpen({ path, state });
    const input = fileOpenNotification(state, session.context.resource.threadId, title);
    if (input === null) return;
    const signal = session.signal;
    void bindApi(uiNotificationsApi, host, session.context)
      .invoke("notify", input, signal)
      .then(
        () => {
          // The toast carries the failure — drop the inline row, but only
          // if it still shows this same failure. A newer state for the path
          // (a retry's resolving/resolved) wins over a stale clear, and a
          // late rejection simply leaves the row standing.
          if (!signal.aborted)
            setFileOpen((current) =>
              current?.path === path && current.state === state
                ? { path, state: { status: "idle" } }
                : current,
            );
        },
        () => {},
      );
  };

  // "Open file in preview browser" (native's, for pages and PDFs) takes the
  // same path with `openIn: "browser"`. As native, a page that opened says
  // nothing here — the browser shows it — and a failure toasts.
  const openSelected = (openIn: "panel" | "browser") => {
    if (selected === null) return;
    const title = openIn === "browser" ? "Unable to open file in browser" : undefined;
    const path = presentationPath(selected);
    if (path === null) {
      failFileOpen(
        selected,
        {
          status: "unavailable",
          message: `${selected} cannot be opened — not a workspace-relative path`,
        },
        title,
      );
      return;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    setFileOpen({ path, state: { status: "resolving" } });
    void openWorkspaceFile(host, session.context, path, { openIn, signal })
      .then(
        (receipt) => {
          if (signal.aborted) return;
          if (receipt.status === "opened")
            setFileOpen({
              path,
              state:
                openIn === "browser"
                  ? { status: "idle" }
                  : { status: "resolved", message: `Opened ${path}` },
            });
          else
            failFileOpen(
              path,
              {
                status: "unavailable",
                message: `${path} cannot be opened — ${describeOpenFileRefusal(receipt.reason)}`,
              },
              title,
            );
        },
        (error) => {
          if (!signal.aborted) failFileOpen(path, fileOpenFailed(error), title);
        },
      )
      .finally(() => controller.abort());
  };
  const openInPanel = () => openSelected("panel");
  // Native parity (FilePreviewPanel): the preview-browser open is offered only
  // where this client has a preview browser. The open's own refusal still
  // covers a client that changes in between.
  const [browserPreview, setBrowserPreview] = useState(false);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void canOpenFilesInBrowser(host, session.context, signal).then((supported) => {
      if (!signal.aborted) setBrowserPreview(supported);
    });
    return () => controller.abort();
  }, [host, session, visible]);

  // The panel's commands register through `t3.ui/keybindings` so the
  // host arbitrates them — user rules and native defaults outrank the plugin
  // `defaultKey`s, and a focused view's binding is what dispatch reaches.
  useFilesCommands(host, session, visible, {
    refresh,
    focusSearch: () => searchRef.current?.focus(),
    openIn: openInPanel,
    toggleMarkdown: () => {
      if (selected !== null && isMarkdownPath(selected) && selectedKind === "text")
        toggleMarkdown();
      else if (selected !== null && leasePreviewMode(selected) === "html") toggleHtml();
    },
  });

  const editorSurface = editor.surface?.path === selected ? editor.surface : null;
  // Rendered markdown draws from the buffer the surface already read —
  // the live editor contents when editable, else the bounded preview read.
  const markdownText =
    selected !== null && isMarkdownPath(selected)
      ? ((editorSurface?.open.editable === true ? editorSurface.contents : currentRead?.contents) ??
        null)
      : null;
  const markdownBlocks = useMemo(
    () => (markdownRendered && markdownText !== null ? parseMarkdown(markdownText) : null),
    [markdownRendered, markdownText],
  );

  useEffect(() => {
    // The resource read remains the fallback for files the open path reports
    // as not-editable (past the 8 MiB bound, binary, non-UTF-8) — shown
    // read-only at the native 1 MiB preview bound, verified before render.
    if (!selected || !visible || selectedKind !== "text") return;
    if (editorSurface === null || editorSurface.open.editable) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void (async () => {
      try {
        const read = await collectResourceRead(
          bindStreamApi(workspaceResourcesApi, host, session.context).subscribe(
            "read",
            { relativePath: selected, maxBytes: 1024 * 1024 },
            signal,
          ),
          signal,
        );
        if (read.kind === "cancelled" || signal.aborted) return;
        const preview = describeResourcePreview(read);
        setRead({
          relativePath: selected,
          revision,
          contents: preview.contents,
          status: preview.status,
          truncated: preview.truncated,
        });
      } catch (error) {
        if (!signal.aborted)
          setRead({
            relativePath: selected,
            revision,
            contents: "",
            status: error instanceof Error ? error.message : "File unavailable",
            truncated: false,
          });
      }
    })();
    return () => controller.abort();
  }, [host, selected, selectedKind, session, revision, visible, editorSurface]);

  // Workspace links in rendered markdown open through the same
  // select path; a link to a directory expands the tree there instead of
  // attempting a text read.
  const linkActions: MarkdownLinkActions | undefined =
    selected === null
      ? undefined
      : {
          baseDir: parentPath(selected) ?? "",
          openPath: (path, line) => {
            if (path === "") {
              // The workspace root resolves to "" — no tree entry exists for
              // it, so the affordance is revealing the tree's top level.
              setQuery("");
              tree.reveal(0);
              return;
            }
            if (kindByPath.get(path) === "directory") {
              openFolderChain(path);
              return;
            }
            select(path, line);
          },
          revealLine: (line) => {
            setRevealRequest({ path: selected, line, id: ++revealSequence.current });
          },
        };

  // Centered line reveal. Waits for the selected file's content
  // fallback surface — the bounded read-only <pre> — then
  // scrolls the target line into the viewport center and marks the request
  // handled. Its text node gives exact rendered geometry via a Range rect;
  // host code views handle their own reveal. A request that can't run yet (read in flight,
  // rendered-markdown view) stays pending until the surface appears or a
  // plain selection replaces it.
  useEffect(() => {
    const reveal = revealRequest;
    if (reveal === null || reveal === handledRevealRef.current) return;
    if (reveal.path !== selected || selectedKind !== "text" || markdownBlocks !== null) return;
    const text =
      editorSurface?.open.editable === true ? editorSurface.contents : currentRead?.contents;
    const element = readOnlyRef.current;
    if (text === undefined || element === null) return;
    const style = getComputedStyle(element);
    const paddingTop = Number.parseFloat(style.paddingTop) || 0;
    const lineHeight = Number.parseFloat(style.lineHeight) || 16;
    let renderedLine: { top: number; height: number } | undefined;
    {
      const node = element.firstChild;
      if (node !== null && node.nodeType === Node.TEXT_NODE) {
        const offset = Math.min(lineStartOffset(text, reveal.line), node.textContent?.length ?? 0);
        const range = element.ownerDocument.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset);
        const rect = range.getBoundingClientRect();
        if (rect.height > 0) renderedLine = { top: rect.top, height: rect.height };
      }
    }
    const viewport = element.getBoundingClientRect();
    element.scrollTop = resolveCenteredFileLineScrollTop({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      viewportTop: viewport.top,
      viewportHeight: element.clientHeight,
      fileTop: paddingTop,
      estimatedLine: { top: (reveal.line - 1) * lineHeight, height: lineHeight },
      ...(renderedLine !== undefined ? { renderedLine } : {}),
    });
    handledRevealRef.current = reveal;
  }, [revealRequest, selected, selectedKind, markdownBlocks, editorSurface, currentRead]);

  const muted = "var(--t3-files-muted-foreground, var(--muted-foreground, #667085))";
  return (
    <section
      aria-label="Files"
      data-t3-files-panel
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        color: "var(--t3-files-text, var(--foreground, #20252d))",
        background: "var(--t3-files-canvas, var(--background, #fff))",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        ...(themeVars ?? {}),
      }}
    >
      {/* Native focus treatment: the host's 2px accent ring with a 1px canvas
          gap on focus-visible (same rule as the other first-party panels). */}
      <style>
        {`[data-t3-files-fallback-control]:focus-visible{outline:none;box-shadow:0 0 0 1px var(--t3-files-canvas, var(--background, #fff)),0 0 0 3px var(--ring, var(--primary, #1b4ed8))}`}
      </style>
      {showExplorer && (
        <header
          style={{
            display: "flex",
            gap: 6,
            padding: 8,
            borderBottom: "1px solid var(--t3-files-border, var(--border, #dfe3e8))",
            flexShrink: 0,
            alignItems: "center",
          }}
        >
          <Tooltip host={host} label={pending ? "Refreshing…" : "Refresh files"}>
            <button
              data-t3-files-fallback-control
              type="button"
              aria-label="Refresh workspace files"
              onClick={refresh}
              style={toolbarControl}
            >
              Refresh files
            </button>
          </Tooltip>
          <select
            data-t3-files-fallback-control
            aria-label="Search mode"
            value={searchMode}
            onChange={(event) => setSearchMode(event.target.value as "names" | "contents")}
            style={toolbarControl}
          >
            <option value="names">File names</option>
            <option value="contents">File contents</option>
          </select>
          <input
            data-t3-files-fallback-control
            ref={searchRef}
            type="search"
            aria-label="Search workspace files"
            placeholder={searchMode === "contents" ? "Search file contents" : "Search files"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuery("");
                event.currentTarget.blur();
              }
            }}
            style={{ ...toolbarControl, cursor: "auto", flex: 1, minWidth: 0 }}
          />
          <select
            data-t3-files-fallback-control
            aria-label={
              searchMode === "contents"
                ? "Search kind — not used for contents search"
                : "Search kind"
            }
            value={kindFilter}
            disabled={searchMode === "contents"}
            onChange={(event) => setKindFilter(event.target.value as SearchKindFilter)}
            style={toolbarControl}
          >
            <option value="all">All</option>
            <option value="file">Files</option>
            <option value="directory">Directories</option>
          </select>
          {directories.length > 0 && (
            <Tooltip host={host} label={expandAllLabel}>
              <button
                data-t3-files-fallback-control
                type="button"
                aria-label={expandAllLabel}
                onClick={toggleAllDirectories}
                style={toolbarControl}
              >
                {expandAllLabel}
              </button>
            </Tooltip>
          )}
        </header>
      )}
      {showExplorer && (
        <ul
          ref={tree.ref}
          role={searching ? undefined : "tree"}
          aria-label="Workspace files"
          onScroll={tree.onScroll}
          onKeyDown={searching ? undefined : onTreeKeyDown}
          style={{
            listStyle: "none",
            margin: 0,
            padding: searching ? 6 : "0 6px",
            overflow: "auto",
            flex: 1,
            minHeight: 0,
            position: "relative",
          }}
        >
          {searching
            ? activeSearch?.outcome.mode === "contents"
              ? keyed(
                  activeSearch.outcome.results?.matches ?? [],
                  (match) => `${match.path}:${match.lineNumber}`,
                ).map(({ item: match, key }) => (
                  <li key={key}>
                    <button
                      data-t3-files-fallback-control
                      type="button"
                      aria-current={match.path === selected ? "true" : undefined}
                      draggable
                      onDragStart={(event) => startMentionDrag(event, match.path)}
                      onClick={() => select(match.path, match.lineNumber)}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        font: "inherit",
                        fontSize: 12,
                        padding: "4px 6px",
                        border: "1px solid transparent",
                        borderRadius: 5,
                        cursor: "pointer",
                        color: "var(--t3-files-text, var(--foreground, #20252d))",
                        background:
                          match.path === selected
                            ? "var(--t3-files-accent-surface, var(--accent, #e8eef7))"
                            : "transparent",
                      }}
                    >
                      <span
                        style={{
                          display: "block",
                          color: muted,
                          fontSize: 12,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {match.path}:{match.lineNumber}
                      </span>
                      <span
                        style={{
                          display: "block",
                          fontFamily:
                            "var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {keyed(
                          contentMatchSegments(match.lineContent, match.matchRanges),
                          (segment) => `s:${segment.match}:${nodeDigest(segment.text)}`,
                        ).map(({ item: segment, key: segmentKey }) =>
                          segment.match ? (
                            <mark
                              key={segmentKey}
                              style={{
                                background:
                                  "var(--t3-files-accent-surface, var(--accent, #e8eef7))",
                                color: "inherit",
                              }}
                            >
                              {segment.text}
                            </mark>
                          ) : (
                            <span key={segmentKey}>{segment.text}</span>
                          ),
                        )}
                      </span>
                    </button>
                  </li>
                ))
              : (activeSearch?.outcome.mode === "names"
                  ? (activeSearch.outcome.results?.entries ?? [])
                  : []
                ).map((entry) => (
                  <li key={entry.path}>
                    <button
                      data-t3-files-fallback-control
                      type="button"
                      aria-current={entry.path === selected ? "true" : undefined}
                      draggable
                      onDragStart={(event) => startMentionDrag(event, entry.path)}
                      onClick={() =>
                        entry.kind === "directory"
                          ? (setQuery(""), openFolderChain(entry.path))
                          : select(entry.path)
                      }
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        font: "inherit",
                        fontSize: 12,
                        padding: "4px 6px",
                        border: "1px solid transparent",
                        borderRadius: 5,
                        cursor: "pointer",
                        color: "var(--t3-files-text, var(--foreground, #20252d))",
                        background:
                          entry.path === selected
                            ? "var(--t3-files-accent-surface, var(--accent, #e8eef7))"
                            : "transparent",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {entry.kind === "directory" ? "▸ " : ""}
                      {entry.path}
                    </button>
                  </li>
                ))
            : [
                <li
                  key="tree-extent"
                  role="none"
                  aria-hidden="true"
                  style={{ height: tree.height }}
                />,
                ...tree.indexes.map((index) => {
                  const row = rows[index]!;
                  return (
                    <li
                      key={row.entry.path}
                      role="none"
                      style={{
                        position: "absolute",
                        top: index * TREE_ROW_HEIGHT,
                        left: kit ? 16 : 6,
                        right: kit ? 16 : 6,
                        height: TREE_ROW_HEIGHT,
                      }}
                    >
                      <FileTreeRow
                        kit={kit}
                        path={row.entry.path}
                        label={row.label}
                        depth={row.depth}
                        aria-setsize={rows.length}
                        aria-posinset={index + 1}
                        directory={row.expandable}
                        expanded={expanded.has(row.entry.path)}
                        selected={row.entry.path === selected}
                        tabIndex={row.entry.path === tabStopPath ? 0 : -1}
                        ref={(button) => {
                          if (button === null) rowButtons.current.delete(row.entry.path);
                          else rowButtons.current.set(row.entry.path, button);
                        }}
                        aria-current={row.entry.path === selected ? "true" : undefined}
                        draggable
                        onDragStart={(event) => startMentionDrag(event, row.entry.path)}
                        onFocus={() => setFocusedRow(row.entry.path)}
                        onBlur={(event) => {
                          // A row removed while focused keeps the tree's focus
                          // for the reconciliation above.
                          if (!event.currentTarget.isConnected) return;
                          setFocusedRow((current) => (current === row.entry.path ? null : current));
                        }}
                        onClick={() => {
                          if (!row.expandable) {
                            select(row.entry.path);
                            return;
                          }
                          toggleTreeFolder(row);
                        }}
                      />
                    </li>
                  );
                }),
              ]}
        </ul>
      )}
      {showExplorer && (
        <output
          aria-label="Tree status"
          style={{ padding: "6px 10px", color: muted, fontSize: 12 }}
        >
          {(searching
            ? (activeSearch?.outcome.error ??
              (searchMode === "contents"
                ? describeContentSearch(
                    activeSearch?.outcome.mode === "contents" ? activeSearch.outcome.results : null,
                    query,
                    SEARCH_LIMIT,
                  )
                : describeSearch(
                    activeSearch?.outcome.mode === "names" ? activeSearch.outcome.results : null,
                    query,
                    SEARCH_LIMIT,
                  )))
            : status + (kindByPath.size > 0 ? ` — ${entries.length} entries` : "")) +
            (changes.status === "degraded"
              ? " · agent updates unavailable — use Refresh files"
              : "")}
        </output>
      )}
      {selected !== null && (
        <FileBreadcrumbBar
          host={host}
          selected={selected}
          entries={entries}
          truncated={truncated}
          onSelect={select}
        />
      )}
      {selected && (
        <output
          aria-label="File status"
          style={{ padding: "6px 10px", color: muted, fontSize: 12 }}
        >
          {selected +
            ": " +
            (selectedKind === "text"
              ? editorSurface === null
                ? "Reading file"
                : editorSurface.open.editable
                  ? describeSaveState(editorSurface.saveState)
                  : editorSurface.open.message + (currentRead ? ` — ${currentRead.status}` : "")
              : describeMediaLease(media.state))}
        </output>
      )}
      {selected && (
        <div
          role="toolbar"
          aria-label="File actions"
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            padding: "4px 10px",
            borderTop: "1px solid var(--t3-files-border, var(--border, #dfe3e8))",
            flexShrink: 0,
          }}
        >
          <ActionButton {...actionProps} type="button" onClick={openInPanel}>
            Open in panel
          </ActionButton>
          {externalEditor.visible && (
            <>
              <ActionButton
                {...actionProps}
                type="button"
                disabled={
                  externalEditor.blockReason !== null || externalEditor.state.kind === "opening"
                }
                onClick={() => externalEditor.openInEditor(selected)}
              >
                Open in{" "}
                {externalEditor.editors.find(({ id }) => id === externalEditor.preferredEditor)
                  ?.label ?? "editor"}
              </ActionButton>
              {kit ? (
                <kit.Menu
                  open={editorMenuOpen}
                  onOpenChange={(open) => {
                    setEditorMenuOpen(open);
                    if (open) externalEditor.markHintShown();
                  }}
                >
                  <kit.MenuTrigger>
                    <kit.Button variant="outline" size="xs" type="button">
                      Choose editor
                    </kit.Button>
                  </kit.MenuTrigger>
                  <kit.MenuPopup align="start">
                    {externalEditor.remoteHint && (
                      <kit.MenuNote>{externalEditor.remoteHint}</kit.MenuNote>
                    )}
                    {externalEditor.editors.map((editor) => (
                      <kit.MenuItem
                        key={editor.id}
                        disabled={
                          externalEditor.blockReason !== null ||
                          externalEditor.state.kind === "opening"
                        }
                        onClick={() => {
                          setEditorMenuOpen(false);
                          externalEditor.openInEditor(selected, editor.id);
                        }}
                      >
                        {editor.label}
                      </kit.MenuItem>
                    ))}
                  </kit.MenuPopup>
                </kit.Menu>
              ) : (
                <details
                  style={{ position: "relative" }}
                  onToggle={(event) => {
                    if (event.currentTarget.open) externalEditor.markHintShown();
                  }}
                >
                  <summary style={toolbarControl}>Choose editor</summary>
                  {externalEditor.remoteHint && <p>{externalEditor.remoteHint}</p>}
                  {externalEditor.editors.map((editor) => (
                    <ActionButton
                      {...actionProps}
                      key={editor.id}
                      type="button"
                      disabled={
                        externalEditor.blockReason !== null ||
                        externalEditor.state.kind === "opening"
                      }
                      onClick={() => externalEditor.openInEditor(selected, editor.id)}
                    >
                      {editor.label}
                    </ActionButton>
                  ))}
                </details>
              )}
            </>
          )}
          {externalEditor.state.kind === "failed" && externalEditor.state.path === selected && (
            <span role="alert" style={{ color: "#b42318", fontSize: 11 }}>
              {externalEditor.state.message}
            </span>
          )}
          {browserPreview && opensInPreviewBrowser(selected) && (
            <ActionButton {...actionProps} type="button" onClick={() => openSelected("browser")}>
              Open file in preview browser
            </ActionButton>
          )}
          {addChat.blockReason === null ? (
            <ActionButton
              {...actionProps}
              type="button"
              disabled={addChat.state.kind === "adding"}
              onClick={() => {
                if (selected !== null) addChat.addToChat(selected);
              }}
            >
              Add to chat
            </ActionButton>
          ) : (
            <span style={{ color: muted, fontSize: 11 }}>
              Add to chat unavailable — {addChat.blockReason}
            </span>
          )}
          {addChat.state.kind !== "idle" && addChat.state.path === selected && (
            <span
              role={addChat.state.kind === "failed" ? "alert" : undefined}
              style={{
                color: addChat.state.kind === "failed" ? "#b42318" : muted,
                fontSize: 11,
              }}
            >
              {addChat.state.kind === "adding"
                ? "Adding…"
                : addChat.state.kind === "added"
                  ? "Added to chat"
                  : addChat.state.message}
            </span>
          )}
          {isMarkdownPath(selected) && selectedKind === "text" && (
            <Tooltip
              host={host}
              label={markdownRendered ? "Show markdown source" : "Show rendered markdown"}
            >
              <ActionButton
                {...actionProps}
                type="button"
                aria-pressed={markdownRendered}
                onClick={toggleMarkdown}
              >
                {markdownRendered ? "Show markdown source" : "Show rendered markdown"}
              </ActionButton>
            </Tooltip>
          )}
          {leasePreviewMode(selected) === "html" && (
            <ActionButton
              {...actionProps}
              type="button"
              aria-pressed={selectedKind === "html"}
              onClick={toggleHtml}
            >
              {selectedKind === "html" ? "Show HTML source" : "Show rendered page"}
            </ActionButton>
          )}
          {selectedKind === "text" && markdownBlocks === null && wordWrap.value !== null && (
            <Tooltip host={host} label={wordWrap.value ? "Disable word wrap" : "Enable word wrap"}>
              <ActionButton
                {...actionProps}
                type="button"
                aria-pressed={wordWrap.value}
                onClick={wordWrap.toggle}
              >
                {wordWrap.value ? "Disable word wrap" : "Enable word wrap"}
              </ActionButton>
            </Tooltip>
          )}
          {wordWrap.writeError !== null && (
            <span role="alert" style={{ color: "#b42318", fontSize: 11 }}>
              {wordWrap.writeError}
            </span>
          )}
          {presentationPath(selected) !== null && (
            <Tooltip host={host} label={explorerOpen ? "Hide file explorer" : "Show file explorer"}>
              <ActionButton
                {...actionProps}
                type="button"
                aria-pressed={explorerOpen}
                onClick={toggleExplorer}
              >
                {explorerOpen ? "Hide file explorer" : "Show file explorer"}
              </ActionButton>
            </Tooltip>
          )}
          {fileOpen !== null && fileOpen.path === selected && fileOpen.state.status !== "idle" && (
            <span style={{ color: muted, fontSize: 12 }}>{describeFileOpen(fileOpen.state)}</span>
          )}
        </div>
      )}
      {selected && selectedKind === "text" && editorSurface?.open.editable === true && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
            borderTop: "1px solid var(--t3-files-border, var(--border, #dfe3e8))",
          }}
        >
          {markdownBlocks !== null ? (
            <RenderedMarkdown blocks={markdownBlocks} links={linkActions} />
          ) : (
            <>
              {commentDraft !== null ? (
                <div
                  role="group"
                  aria-label={`Comment on ${formatCommentRangeLabel(commentDraft.range.startLine, commentDraft.range.endLine)}`}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    padding: "6px 10px",
                    borderBottom: "1px solid var(--t3-files-border, var(--border, #dfe3e8))",
                    flexShrink: 0,
                  }}
                >
                  <span style={{ fontSize: 12, color: muted }}>
                    Comment on{" "}
                    {formatCommentRangeLabel(
                      commentDraft.range.startLine,
                      commentDraft.range.endLine,
                    )}
                    {commentDraft.truncated
                      ? ` — excerpt truncated to ${COMMENT_EXCERPT_MAX_CHARS} characters`
                      : ""}
                  </span>
                  {commentDraftStale && (
                    <span role="status" style={{ fontSize: 12, color: muted }}>
                      The file changed since this draft opened — select the lines again to comment
                      on them.
                    </span>
                  )}
                  <textarea
                    data-t3-files-fallback-control
                    aria-label="Comment text"
                    value={commentBody}
                    onChange={(event) => setCommentBody(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") closeCommentDraft();
                    }}
                    rows={3}
                    style={{
                      resize: "vertical",
                      border: "1px solid var(--t3-files-border, var(--border, #dfe3e8))",
                      padding: 6,
                      color: "inherit",
                      background: "transparent",
                      fontFamily: "inherit",
                      fontSize: 12,
                    }}
                  />
                  {commentSubmit.error !== null && (
                    <span role="alert" style={{ fontSize: 12, color: "#b42318" }}>
                      {commentSubmit.error}
                    </span>
                  )}
                  <div style={{ display: "flex", gap: 6 }}>
                    <ActionButton
                      {...actionProps}
                      type="button"
                      disabled={
                        commentDraftStale || commentBody.trim() === "" || commentSubmit.busy
                      }
                      onClick={submitCommentDraft}
                    >
                      {commentSubmit.busy ? "Submitting…" : "Submit comment"}
                    </ActionButton>
                    <ActionButton
                      {...actionProps}
                      type="button"
                      disabled={commentSubmit.busy}
                      onClick={closeCommentDraft}
                    >
                      Cancel
                    </ActionButton>
                  </div>
                </div>
              ) : selectionRange !== null ? (
                <div
                  role="toolbar"
                  aria-label="File comment"
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    padding: "4px 10px",
                    borderBottom: "1px solid var(--t3-files-border, var(--border, #dfe3e8))",
                    flexShrink: 0,
                    fontSize: 12,
                  }}
                >
                  {commentBlockReason === null ? (
                    <ActionButton
                      {...actionProps}
                      type="button"
                      onClick={() => openCommentDraft(selectionRange)}
                    >
                      Comment on{" "}
                      {formatCommentRangeLabel(selectionRange.startLine, selectionRange.endLine)}
                    </ActionButton>
                  ) : (
                    <span style={{ color: muted }}>
                      Commenting unavailable — {commentBlockReason}
                    </span>
                  )}
                </div>
              ) : null}
              <EditableFileBody
                host={host}
                documentId={`${session.context.resource.environmentId}:${session.context.resource.projectId}:${selected}`}
                path={selected}
                contents={editorSurface.contents}
                wordWrap={wordWrap.value}
                reveal={
                  revealRequest?.path === selected
                    ? { line: revealRequest.line, requestId: revealRequest.id }
                    : null
                }
                onChange={editor.change}
                onSelectionChange={(range) => {
                  if (range === null) clearEditorSelection();
                  else
                    setEditorSelection({
                      path: selected,
                      ...range,
                    });
                }}
                renderFallback={() => (
                  <pre
                    ref={readOnlyRef}
                    style={{ flex: 1, minHeight: 0, overflow: "auto", margin: 0, padding: 12 }}
                  >
                    {editorSurface.contents}
                  </pre>
                )}
              />
            </>
          )}
          {(posted.comments.some((comment) => comment.path === selected) ||
            posted.error !== null) && (
            <section
              aria-label="Review comments added here"
              style={{
                padding: "6px 10px",
                borderTop: "1px solid var(--t3-files-border, var(--border, #dfe3e8))",
                flexShrink: 0,
                fontSize: 12,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              {posted.comments
                .filter((comment) => comment.path === selected)
                .map((comment) => (
                  <span
                    key={comment.annotationId}
                    style={{ display: "flex", gap: 6, alignItems: "center" }}
                  >
                    <span>
                      {comment.rangeLabel}
                      {comment.text !== null ? ` — ${comment.text}` : ""}
                    </span>
                    {comment.truncated === true && (
                      <ActionButton
                        {...actionProps}
                        type="button"
                        aria-label={`Show the whole comment on ${comment.rangeLabel}`}
                        onClick={() => posted.readFull(comment.annotationId)}
                      >
                        Show all
                      </ActionButton>
                    )}
                    {posted.removable && (
                      <ActionButton
                        {...actionProps}
                        type="button"
                        aria-label={`Remove comment on ${comment.rangeLabel}`}
                        onClick={() => posted.remove(comment.annotationId)}
                      >
                        Remove
                      </ActionButton>
                    )}
                  </span>
                ))}
              {posted.error !== null && <span role="alert">{posted.error}</span>}
              {posted.capped && (
                <span style={{ color: muted }}>
                  Showing the first {LISTED_ANNOTATIONS_CAP} comments in the draft.
                </span>
              )}
              {!posted.removable && (
                <span style={{ color: muted }}>
                  Removal is from the composer chip — this view cannot remove comments.
                </span>
              )}
            </section>
          )}
          {editorSurface.saveState.kind === "conflict" && (
            <div
              role="alert"
              style={{
                display: "flex",
                gap: 6,
                alignItems: "center",
                padding: "6px 10px",
                borderTop: "1px solid var(--t3-files-border, var(--border, #dfe3e8))",
                fontSize: 12,
                color: "var(--t3-files-text, var(--foreground, #20252d))",
              }}
            >
              File changed on disk — your edits are kept.
              <ActionButton {...actionProps} type="button" onClick={editor.reload}>
                Reload file
              </ActionButton>
              <ActionButton {...actionProps} type="button" onClick={editor.keepMine}>
                Keep my version
              </ActionButton>
            </div>
          )}
          {editorSurface.saveState.kind === "error" && (
            <div
              role="alert"
              style={{
                display: "flex",
                gap: 6,
                alignItems: "center",
                padding: "6px 10px",
                borderTop: "1px solid var(--t3-files-border, var(--border, #dfe3e8))",
                fontSize: 12,
                color: "var(--t3-files-text, var(--foreground, #20252d))",
              }}
            >
              {describeSaveState(editorSurface.saveState)}
              <ActionButton {...actionProps} type="button" onClick={editor.retry}>
                Retry save
              </ActionButton>
            </div>
          )}
        </div>
      )}
      {selected &&
        selectedKind === "text" &&
        editorSurface !== null &&
        !editorSurface.open.editable &&
        (markdownBlocks !== null ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              minHeight: 0,
              borderTop: "1px solid var(--t3-files-border, var(--border, #dfe3e8))",
            }}
          >
            <RenderedMarkdown blocks={markdownBlocks} links={linkActions} />
          </div>
        ) : (
          <ReadOnlyFileBody
            host={host}
            path={selected}
            contents={currentRead?.contents ?? ""}
            wordWrap={wordWrap.value}
            reveal={
              revealRequest !== null && revealRequest.path === selected
                ? { line: revealRequest.line, requestId: revealRequest.id }
                : null
            }
            renderFallback={() => (
              <pre
                ref={readOnlyRef}
                aria-label="File contents"
                style={{
                  overflow: "auto",
                  flex: 1,
                  margin: 0,
                  padding: 12,
                  borderTop: "1px solid var(--t3-files-border, var(--border, #dfe3e8))",
                  fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace)",
                  fontSize: 12,
                  ...(wordWrap.value === true
                    ? { whiteSpace: "pre-wrap", overflowWrap: "anywhere" }
                    : {}),
                }}
              >
                {currentRead?.contents ?? ""}
              </pre>
            )}
          />
        ))}
      {selected && selectedKind !== "text" && (
        <figure
          aria-label="Workspace media preview"
          style={{
            margin: 0,
            padding: 12,
            borderTop: "1px solid var(--t3-files-border, var(--border, #dfe3e8))",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            flex: 1,
            minHeight: 0,
            overflow: "auto",
          }}
        >
          {media.mode === "image" && media.url !== null ? (
            <img
              src={media.url}
              alt={selected.split("/").at(-1)}
              onError={media.notifyAssetFailed}
              style={{ maxWidth: "100%", objectFit: "contain", alignSelf: "flex-start" }}
            />
          ) : null}
          {(media.mode === "document" || media.mode === "html") && media.url !== null ? (
            // HTML is sandboxed to an opaque origin; the built-in PDF viewer
            // needs an unsandboxed frame — parity with the native FilePreviewPanel.
            <iframe
              key={media.url}
              src={media.url}
              title={selected.split("/").at(-1)}
              sandbox={documentFrameSandbox(media.mode)}
              style={{ flex: 1, minHeight: 0, width: "100%", border: 0, background: "#fff" }}
            />
          ) : null}
        </figure>
      )}
    </section>
  );
}

export default defineExtension({
  id: manifestId,
  version: "0.11.0",
  provides: [filePresentationApi.definition],
  serverEntry: "server.ts",
  requires: [
    requireApi(workspaceTreeApi),
    requireApi(workspaceSearchApi),
    requireApi(workspaceChangesApi),
    requireApi(textEditsApi),
    requireApi(workspaceResourcesApi),
    requireApi(resourcesLeaseApi),
    requireApi(uiThemeApi),
    // Explicit floor until the defineApi `baseline` option unifies these at merge.
    requireApi(uiKeybindingsApi, "^1.1.0"),
    requireApi(uiNotificationsApi),
    requireApi(uiPreferencesApi),
    requireApi(uiNavigationApi),
    requireApi(uiEditorApi, "^1.1.0"),
    requireApi(messagesEnrichmentApi),
    requireApi(composerContextApi),
  ],
  surfaces: [
    {
      name: "view",
      title: "Files",
      scope: "project",
      placements: ["side-panel"],
      clients: ["web", "desktop"],
      capabilities: [],
      stateVersion: 1,
      validateRestore: isFilesViewState,
      createView(host, session) {
        return { renderer: () => <FilesView host={host} session={session} /> };
      },
    },
  ],
});
