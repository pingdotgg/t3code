import { ArrowRightIcon, CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";

import { filterBaseRefChoices, type BaseRefChoice } from "../lib/baseRefChoices";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./ui/combobox";
import { Switch } from "./ui/switch";

const AUTOMATIC_BASE_REF = "__automatic_base_ref__";

export function DiffPanelBaseRefPicker(props: {
  readonly headRef: string | null | undefined;
  readonly baseRef: string;
  readonly choices: ReadonlyArray<BaseRefChoice>;
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly selectBaseRef: (baseRef: string | null) => void;
}) {
  const valueForChoice = (choice: BaseRefChoice) =>
    props.baseRef === choice.remote?.name
      ? props.baseRef
      : (choice.local?.name ?? choice.remote?.name ?? choice.id);
  const items = [AUTOMATIC_BASE_REF, ...props.choices.map(valueForChoice)];
  const filteredItems = [
    ...(props.query.trim().length === 0 ? [AUTOMATIC_BASE_REF] : []),
    ...filterBaseRefChoices(props.choices, props.query).map(valueForChoice),
  ];
  const headRef = props.headRef ?? "HEAD";

  return (
    <div
      className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden text-xs text-muted-foreground"
      title={`${headRef} → ${props.baseRef}`}
      aria-label={`Comparing ${headRef} against ${props.baseRef}`}
    >
      <span className="min-w-0 max-w-48 truncate">{headRef}</span>
      <ArrowRightIcon className="size-3.5 shrink-0 opacity-70" />
      <Combobox
        items={items}
        filteredItems={filteredItems}
        value={props.baseRef}
        onOpenChange={(open) => {
          if (!open) props.setQuery("");
        }}
        onValueChange={(value) => {
          if (!value) return;
          props.selectBaseRef(value === AUTOMATIC_BASE_REF ? null : value);
        }}
      >
        <ComboboxTrigger
          className="inline-flex min-w-0 max-w-48 items-center gap-1 overflow-hidden rounded-md px-1.5 py-1 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Change comparison target. Currently ${props.baseRef}`}
        >
          <span className="min-w-0 truncate">{props.baseRef}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
        </ComboboxTrigger>
        <ComboboxPopup
          align="start"
          className="w-72 min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden [&>[data-slot=combobox-popup]]:min-w-0 [&>[data-slot=combobox-popup]]:overflow-hidden"
        >
          <div className="min-w-0 shrink-0 px-3 pt-2.5">
            <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
              <SearchIcon
                aria-hidden="true"
                className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
              />
              <ComboboxInput
                className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5"
                inputClassName="rounded-none bg-transparent text-sm"
                placeholder="Search refs..."
                showTrigger={false}
                size="sm"
                unstyled
                value={props.query}
                onChange={(event) => props.setQuery(event.target.value)}
              />
            </div>
          </div>
          <div className="grid shrink-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 border-b border-border/70 ps-3 pe-6.5 pt-2 pb-1.5 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
            <span aria-hidden="true" />
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center">
              <span>Branch</span>
              <span className="text-right">Remote</span>
            </div>
          </div>
          <ComboboxEmpty>No matching refs.</ComboboxEmpty>
          <ComboboxList className="max-h-64 min-w-0 overflow-x-hidden">
            <ComboboxItem
              className="h-8 w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)] py-0"
              contentClassName="w-full min-w-0 overflow-hidden"
              value={AUTOMATIC_BASE_REF}
            >
              <span className="block min-w-0 truncate">Automatic</span>
            </ComboboxItem>
            {props.choices.map((choice) => {
              const item = valueForChoice(choice);
              const hasBoth = choice.local !== null && choice.remote !== null;
              const useRemote = choice.remote?.name === item;
              return (
                <ComboboxItem
                  key={choice.id}
                  className="h-8 w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)] py-0"
                  contentClassName="w-full min-w-0 overflow-hidden"
                  value={item}
                >
                  <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center overflow-hidden">
                    <span className="block min-w-0 truncate pe-2">{choice.label}</span>
                    {hasBoth ? (
                      <div
                        className="flex justify-end"
                        onClick={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                      >
                        <Switch
                          aria-label={`Use remote version of ${choice.label}`}
                          checked={useRemote}
                          className="[--thumb-size:--spacing(3)]"
                          onCheckedChange={(checked) => {
                            const nextRef = checked ? choice.remote?.name : choice.local?.name;
                            if (nextRef) props.selectBaseRef(nextRef);
                          }}
                        />
                      </div>
                    ) : choice.remote ? (
                      <span className="flex justify-end text-muted-foreground" title="Remote only">
                        <CheckIcon aria-hidden="true" className="size-3" />
                      </span>
                    ) : null}
                  </div>
                </ComboboxItem>
              );
            })}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    </div>
  );
}
