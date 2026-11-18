import { msg, T, useGT, useMessages } from "gt-react";
import { useId, useState } from "react";
import { create } from "zustand";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { StatusDot, type StatusDotTone } from "../components/ui/status-dot";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { SubmitKbd } from "../components/SubmitKbd";
import { LAYOUT_TAB_GROUP_COLORS, type LayoutTabGroupColor } from "./layoutModel";

/** Each group color is a status hue of the theme, so themes recolor groups too. */
export const TAB_GROUP_TONE = {
  grey: "neutral",
  blue: "info",
  red: "danger",
  yellow: "warning",
  green: "success",
  purple: "merged",
} as const satisfies Record<LayoutTabGroupColor, StatusDotTone>;

export const TAB_GROUP_COLOR_LABEL = {
  grey: msg("Grey", { $context: "tab group color" }),
  blue: msg("Blue", { $context: "tab group color" }),
  red: msg("Red", { $context: "tab group color" }),
  yellow: msg("Yellow", { $context: "tab group color" }),
  green: msg("Green", { $context: "tab group color" }),
  purple: msg("Purple", { $context: "tab group color" }),
} as const satisfies Record<LayoutTabGroupColor, string>;

export interface TabGroupDraft {
  readonly title: string;
  readonly color: LayoutTabGroupColor;
}

interface Request {
  readonly id: number;
  /** A `msg()` string, resolved as the dialog renders. */
  readonly heading: string;
  /** A `msg()` string, resolved as the dialog renders. */
  readonly action: string;
  readonly initial: TabGroupDraft;
  readonly resolve: (draft: TabGroupDraft | null) => void;
}

const useRequest = create<{ request: Request | null }>(() => ({ request: null }));
let requestCount = 0;

/** Ask for a group's name and color. Null when dismissed. */
export function requestTabGroupEditor(
  options: Omit<Request, "id" | "resolve">,
): Promise<TabGroupDraft | null> {
  useRequest.getState().request?.resolve(null);
  requestCount += 1;
  const id = requestCount;
  return new Promise((resolve) => useRequest.setState({ request: { ...options, id, resolve } }));
}

function finish(draft: TabGroupDraft | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(draft);
}

export function TabGroupEditorHost() {
  const request = useRequest((state) => state.request);
  return request ? <TabGroupEditor key={request.id} request={request} /> : null;
}

function TabGroupEditor({ request }: { request: Request }) {
  const gt = useGT();
  const resolve = useMessages();
  const id = useId();
  const [title, setTitle] = useState(request.initial.title);
  const [color, setColor] = useState(request.initial.color);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            finish({ title: title.trim(), color });
          }}
        >
          <DialogHeader>
            <DialogTitle>{resolve(request.heading)}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-title`}>
                  <T>Name</T>
                </Label>
                <Input
                  id={`${id}-title`}
                  autoFocus
                  placeholder={gt("Unnamed group")}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>
              <ToggleGroup
                aria-label={gt("Color", { $context: "noun, a tab group color" })}
                value={[color]}
                onValueChange={(next) => {
                  const picked = LAYOUT_TAB_GROUP_COLORS.find((candidate) => candidate === next[0]);
                  if (picked) setColor(picked);
                }}
              >
                {LAYOUT_TAB_GROUP_COLORS.map((candidate) => (
                  <Toggle
                    key={candidate}
                    value={candidate}
                    aria-label={resolve(TAB_GROUP_COLOR_LABEL[candidate])}
                  >
                    <StatusDot tone={TAB_GROUP_TONE[candidate]} size="md" />
                  </Toggle>
                ))}
              </ToggleGroup>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button size="standard" type="button" variant="secondary" onClick={() => finish(null)}>
              <T>Cancel</T>
            </Button>
            <Button size="standard" type="submit">
              {resolve(request.action)}
              <SubmitKbd />
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
