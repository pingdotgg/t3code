import { ArrowDownUpIcon, LanguagesIcon, SearchIcon } from "lucide-react";
import { T, useGT, useLocale } from "gt-react";
import { useState } from "react";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSearchInput,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { languageLabel } from "./SpeechLanguageSelect";

/**
 * Search, language filter, and sort for a list of downloadable models. Callers own the state, so
 * each catalog decides how its models match and order.
 */
export function ModelCatalogToolbar<Sort extends string>(props: {
  searchLabel: string;
  search: string;
  onSearch: (search: string) => void;
  /** Every language the catalog's models speak, in display order. */
  languages: readonly string[];
  selectedLanguages: readonly string[];
  onSelectLanguages: (languages: string[]) => void;
  sort: Sort;
  /** Each sort's short label, in menu order. */
  sortLabels: Record<Sort, string>;
  /** A longer menu label for a sort, such as the language it ranks by. */
  sortMenuLabel?: (sort: Sort) => string;
  onSort: (sort: Sort) => void;
  downloadedOnly: boolean;
  onDownloadedOnly: (downloadedOnly: boolean) => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const [languageSearch, setLanguageSearch] = useState("");
  const { search, onSearch, selectedLanguages, sort, sortLabels } = props;
  const needle = languageSearch.trim().toLocaleLowerCase();
  const visibleLanguages = props.languages.filter(
    (code) =>
      !needle ||
      code.includes(needle) ||
      languageLabel(code, locale).toLocaleLowerCase().includes(needle),
  );
  const languagesLabel =
    selectedLanguages.length === 0
      ? gt("All languages")
      : selectedLanguages.map((code) => languageLabel(code, locale)).join(", ");
  return (
    <div className="mt-3 flex min-w-0 gap-2">
      <InputGroup className="min-w-0 flex-1 **:[input]:h-9 sm:**:[input]:h-8">
        <InputGroupAddon>
          <SearchIcon aria-hidden />
        </InputGroupAddon>
        {/* Native search inputs clear on Escape even during IME composition. */}
        <InputGroupInput
          type="text"
          role="searchbox"
          aria-label={props.searchLabel}
          placeholder={gt("Search models")}
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            const composing = event.nativeEvent.isComposing || event.keyCode === 229;
            if (!composing && !search && !event.repeat) return;
            event.stopPropagation();
            if (composing) return;
            event.preventDefault();
            onSearch("");
          }}
        />
      </InputGroup>
      <Menu onOpenChange={(open) => (open ? undefined : setLanguageSearch(""))}>
        <MenuTrigger
          render={<Button variant="outline" className="max-w-56" />}
          aria-label={gt("Filter by language: {languagesLabel}", { languagesLabel })}
        >
          <LanguagesIcon />
          <span className="hidden truncate @min-[34rem]/voice-models:inline">{languagesLabel}</span>
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuSearchInput
            autoFocus
            aria-label={gt("Search languages")}
            placeholder={gt("Search languages")}
            value={languageSearch}
            onChange={(e) => setLanguageSearch(e.target.value)}
          />
          <div
            role="group"
            aria-label={gt("Browse models by language")}
            className="max-h-72 overflow-y-auto"
          >
            {needle ? null : (
              <MenuCheckboxItem
                checked={selectedLanguages.length === 0}
                onCheckedChange={() => props.onSelectLanguages([])}
              >
                <T>All languages</T>
              </MenuCheckboxItem>
            )}
            {visibleLanguages.map((code) => (
              <MenuCheckboxItem
                key={code}
                checked={selectedLanguages.includes(code)}
                onCheckedChange={() =>
                  props.onSelectLanguages(
                    selectedLanguages.includes(code)
                      ? selectedLanguages.filter((language) => language !== code)
                      : [...selectedLanguages, code],
                  )
                }
              >
                {languageLabel(code, locale)}
              </MenuCheckboxItem>
            ))}
            {visibleLanguages.length === 0 && (
              <p className="px-2 py-1.5 text-sm text-muted-foreground">
                <T>No languages match.</T>
              </p>
            )}
          </div>
        </MenuPopup>
      </Menu>
      <Menu>
        <MenuTrigger
          render={<Button variant="outline" />}
          aria-label={
            props.downloadedOnly
              ? gt("Sort and filter models: {sort}, downloaded only", { sort: sortLabels[sort] })
              : gt("Sort and filter models: {sort}", { sort: sortLabels[sort] })
          }
        >
          <ArrowDownUpIcon />
          <span className="hidden @min-[34rem]/voice-models:inline">{sortLabels[sort]}</span>
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuGroup>
            <MenuGroupLabel>
              <T>Sort by</T>
            </MenuGroupLabel>
            <MenuRadioGroup value={sort} onValueChange={(value) => props.onSort(value as Sort)}>
              {(Object.keys(sortLabels) as Sort[]).map((value) => (
                <MenuRadioItem key={value} value={value} closeOnClick>
                  <span className="flex items-center justify-between gap-3">
                    {props.sortMenuLabel?.(value) ?? sortLabels[value]}
                    <MenuRadioItemIndicator />
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
          <MenuSeparator />
          <MenuCheckboxItem checked={props.downloadedOnly} onCheckedChange={props.onDownloadedOnly}>
            <T>Downloaded only</T>
          </MenuCheckboxItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
