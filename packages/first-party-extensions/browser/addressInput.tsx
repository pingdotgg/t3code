import { useState, type CSSProperties, type Ref, type ReactNode } from "react";
import { resolveUiKit, type ClientUiKit } from "@t3tools/extension-sdk/ui";
import type { ClientHost } from "@t3tools/extension-sdk/environment";

/**
 * The address a cancelled edit returns to: the workspace file on show (its
 * page URL is a minted lease), else the page the held session shows, else
 * the committed navigation target.
 */
export function committedAddress(input: {
  readonly fileSource: string | null;
  readonly pageUrl: string | null;
  readonly target: string | null;
}): string {
  return input.fileSource ?? input.pageUrl ?? input.target ?? "";
}

/**
 * The address field, like native's: unfocused it shows `committed`, so it
 * follows guest navigation, redirects and Back/Forward; focusing starts the
 * edit from that address, all selected so typing replaces it, and live
 * navigation never overwrites the draft being typed. Enter submits a non-blank draft, trimmed, and leaves the field,
 * so it follows wherever the page goes next (a redirect included); Escape
 * cancels the edit — the draft returns to `committed` and focus leaves.
 */
export function AddressInput(props: {
  readonly host?: Pick<ClientHost, "uiKit">;
  readonly kit?: ClientUiKit | null;
  readonly value: string;
  readonly committed: string;
  readonly onValueChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly inputRef: Ref<HTMLInputElement>;
  readonly style: CSSProperties;
  readonly addon?: ReactNode;
}) {
  const { value, committed, onValueChange, onSubmit, inputRef, style } = props;
  const [focused, setFocused] = useState(false);
  const kit = props.kit === undefined ? resolveUiKit(props.host ?? {}) : props.kit;
  const Input = kit?.Input ?? "input";
  const InputGroup = kit?.InputGroup ?? "div";
  return (
    <InputGroup
      {...(kit ? ({ variant: "ghost", controlSize: "sm" } as const) : {})}
      style={{ flex: 1, minWidth: 0 }}
    >
      <Input
        {...(kit ? ({ controlSize: "sm" } as const) : {})}
        {...(!kit ? { "data-t3-browser-fallback-control": "" } : {})}
        type="text"
        spellCheck={false}
        aria-label="Address"
        placeholder="Search or enter URL"
        ref={inputRef}
        value={focused ? value : committed}
        onChange={(event) => onValueChange(event.target.value)}
        onFocus={(event) => {
          onValueChange(committed);
          setFocused(true);
          // Select the whole address once the edit starts, as native does, so typing replaces it.
          const input = event.currentTarget;
          queueMicrotask(() => input.select());
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            const next = value.trim();
            if (next.length === 0) return;
            onSubmit(next);
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onValueChange(committed);
            event.currentTarget.blur();
          }
        }}
        style={kit ? undefined : style}
      />
      {kit && !focused && props.addon ? (
        <kit.InputGroupAddon align="inline-end" revealOnHover>
          {props.addon}
        </kit.InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}
