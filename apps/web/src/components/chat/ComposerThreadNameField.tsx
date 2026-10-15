import { PencilLineIcon } from "lucide-react";
import { memo, useRef } from "react";

import { ComposerBanner } from "./ComposerBanner";

/**
 * Strip attached above a new thread's composer that names the thread before
 * its first send. A typed name replaces the generated title. Empty keeps the
 * generated one.
 */
export const ComposerThreadNameField = memo(function ComposerThreadNameField(props: {
  name: string;
  onNameChange: (name: string) => void;
  onSubmit: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root density="comfortable" data-composer-thread-name="true">
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <PencilLineIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <input
              ref={inputRef}
              aria-label="Thread name"
              placeholder="Thread name (optional)"
              value={props.name}
              onChange={(event) => props.onNameChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229)
                  return;
                event.preventDefault();
                props.onSubmit();
              }}
              className="h-7 w-full min-w-0 text-ellipsis bg-transparent font-medium text-foreground outline-none placeholder:font-normal placeholder:text-muted-foreground sm:h-6"
            />
          </ComposerBanner.Content>
          {props.name ? (
            <ComposerBanner.Actions>
              <ComposerBanner.Dismiss
                aria-label="Clear thread name"
                onClick={() => {
                  props.onNameChange("");
                  inputRef.current?.focus();
                }}
              />
            </ComposerBanner.Actions>
          ) : null}
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
});
