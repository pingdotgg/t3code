import {
  collectThreadTags,
  suggestThreadTags,
  validateThreadTag,
} from "@t3tools/client-runtime/state/threadTagFilter";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useSetThreadTag } from "../hooks/useSetThreadTag";
import { useQuietThreadShell, useQuietThreadShells } from "../state/entities";
import {
  threadTagPickerAtom,
  type ThreadTagPickerAnchor,
  type ThreadTagPickerTarget,
} from "../state/threadTagPicker";
import { Checkbox } from "./ui/checkbox";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxStatus,
} from "./ui/combobox";

const CREATE_ROW = "\u0000create";

export function ThreadTagPickerHost() {
  const target = useAtomValue(threadTagPickerAtom);
  return target ? (
    <ThreadTagPicker
      key={`${target.threadRef.environmentId}:${target.threadRef.threadId}`}
      target={target}
    />
  ) : null;
}

/** Follows the anchor while it stays in the page; a row the tag filter removes falls back to center. */
function liveAnchor(anchor: ThreadTagPickerAnchor | null) {
  return {
    getBoundingClientRect: () => {
      if (anchor instanceof Element && anchor.isConnected) return anchor.getBoundingClientRect();
      if (anchor !== null && !(anchor instanceof Element))
        return new DOMRect(anchor.x, anchor.y, 0, 0);
      return new DOMRect(window.innerWidth / 2, window.innerHeight / 3, 0, 0);
    },
  };
}

function ThreadTagPicker(props: { readonly target: ThreadTagPickerTarget }) {
  const { threadRef, anchor } = props.target;
  const thread = useQuietThreadShell(threadRef);
  const shells = useQuietThreadShells();
  const setThreadTag = useSetThreadTag();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const own = thread?.tags ?? [];
  const needle = query.trim().toLowerCase();
  const known = collectThreadTags(
    shells.filter((shell) => shell.environmentId === threadRef.environmentId),
  );
  // suggestThreadTags ignores case, so a thread's "BUG" never also lists the known "bug".
  const rows = [...own.toSorted(), ...suggestThreadTags(known, own)].filter(
    (tag) => needle === "" || tag.toLowerCase().includes(needle),
  );
  const canCreate =
    needle !== "" && ![...own, ...known].some((tag) => tag.toLowerCase() === needle);
  const items = canCreate ? [...rows, CREATE_ROW] : rows;

  const apply = (tag: string, tagged: boolean) => setThreadTag(threadRef, tag, tagged);
  const create = () => {
    const checked = validateThreadTag(query, own);
    if (checked.kind === "empty") return;
    if (checked.kind === "error") {
      setError(checked.message);
      return;
    }
    setQuery("");
    setError(null);
    void apply(checked.tag, true);
  };

  if (thread === null) return null;

  return (
    <Combobox
      multiple
      open
      autoHighlight
      items={items}
      filteredItems={items}
      value={own}
      inputValue={query}
      onInputValueChange={(value) => {
        setQuery(value);
        setError(null);
      }}
      onOpenChange={(open) => (open ? undefined : appAtomRegistry.set(threadTagPickerAtom, null))}
      onValueChange={(next) => {
        if (next.includes(CREATE_ROW)) {
          create();
          return;
        }
        for (const tag of next) if (!own.includes(tag)) void apply(tag, true);
        for (const tag of own) if (!next.includes(tag)) void apply(tag, false);
      }}
    >
      <ComboboxPopup anchor={liveAnchor(anchor)} align="start" className="w-64">
        <ComboboxSearchInput aria-label="Search or create tag" placeholder="Search or add tag" />
        <ComboboxEmpty>No tags yet.</ComboboxEmpty>
        <ComboboxList>
          {(tag: string) =>
            tag === CREATE_ROW ? (
              <ComboboxItem key={tag} value={tag}>
                <span className="truncate">Create tag "{query.trim()}"</span>
              </ComboboxItem>
            ) : (
              <ComboboxItem key={tag} value={tag} selectedFill={false}>
                <Checkbox checked={own.includes(tag)} tabIndex={-1} aria-hidden />
                <span className="truncate">{tag}</span>
              </ComboboxItem>
            )
          }
        </ComboboxList>
        {error ? <ComboboxStatus role="alert">{error}</ComboboxStatus> : null}
      </ComboboxPopup>
    </Combobox>
  );
}
