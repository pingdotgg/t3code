import type { UsageGatewayTagCost, UsageProviderKind, UsageTagCost } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import type { MessageResolver } from "../../i18n/messages";
import { useState } from "react";
import * as Schema from "effect/Schema";
import { formatCount, formatUsd } from "@t3tools/shared/usageFormat";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuCheckboxItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";

const ALL = "all";
const HiddenTags = Schema.Array(Schema.String);

interface TagRow {
  readonly key: string;
  readonly tag: string;
  readonly provider?: UsageProviderKind;
  readonly costUsd: number;
  readonly cost: string;
  readonly counts: readonly string[];
}

const tagKind = (tag: string) => {
  const separator = tag.indexOf(":");
  return separator > 0 ? tag.slice(0, separator) : "other";
};

function gatewayTagRows(rows: readonly UsageGatewayTagCost[]): TagRow[] {
  const totals = new Map<string, { costUsd: number; requests: number }>();
  for (const row of rows) {
    const previous = totals.get(row.tag) ?? { costUsd: 0, requests: 0 };
    totals.set(row.tag, {
      costUsd: previous.costUsd + row.costUsd,
      requests: previous.requests + row.requests,
    });
  }
  return [...totals]
    .map(([tag, { costUsd, requests }]) => ({
      key: tag,
      tag,
      costUsd,
      cost: formatUsd(costUsd),
      counts: [formatCount(requests)],
    }))
    .toSorted((a, b) => b.costUsd - a.costUsd || a.tag.localeCompare(b.tag));
}

function estimateTagRows(rows: readonly UsageTagCost[], m: MessageResolver): TagRow[] {
  return rows.map((row) => ({
    key: JSON.stringify([row.provider, row.tag]),
    tag: row.tag,
    provider: row.provider,
    costUsd: row.costUsd,
    cost:
      row.pricedTurns === 0
        ? m(msg("Unpriced"))
        : `${formatUsd(row.costUsd)}${row.unpricedTurns > 0 ? "+" : ""}`,
    counts: [formatCount(row.pricedTurns), formatCount(row.unpricedTurns)],
  }));
}

export function UsageTagCosts({
  estimates,
  gateway,
}: {
  readonly estimates: readonly UsageTagCost[];
  /** Gateway-reported spend; when present it replaces the local estimates. */
  readonly gateway: readonly UsageGatewayTagCost[] | undefined;
}) {
  const gt = useGT();
  const m = useMessages();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState(ALL);
  const [provider, setProvider] = useState<UsageProviderKind | typeof ALL>(ALL);
  const [hiddenTags, setHiddenTags] = useLocalStorage(
    "t3code:usage-hidden-tags:v1",
    [] as readonly string[],
    HiddenTags,
  );
  const fromGateway = gateway !== undefined;
  const rows = fromGateway ? gatewayTagRows(gateway) : estimateTagRows(estimates, m);
  const countHeadings = fromGateway ? [gt("Requests")] : [gt("Priced turns"), gt("Unpriced")];
  const hidden = new Set(hiddenTags);
  const tags = [...new Set(rows.map((row) => row.tag))].toSorted();
  const kinds = [...new Set(tags.map(tagKind))].toSorted();
  const providers = PROVIDER_ORDER.filter((value) => rows.some((row) => row.provider === value));
  const query = search.trim().toLowerCase();
  const matching = rows.filter(
    (row) =>
      !hidden.has(row.tag) &&
      (kind === ALL || tagKind(row.tag) === kind) &&
      (fromGateway || provider === ALL || row.provider === provider) &&
      row.tag.toLowerCase().includes(query),
  );
  const peak = matching.reduce((max, row) => Math.max(max, row.costUsd), 0);
  const hiddenCount = tags.filter((tag) => hidden.has(tag)).length;
  const toggleTag = (tag: string, shown: boolean) =>
    setHiddenTags((previous) =>
      shown ? previous.filter((value) => value !== tag) : [...previous, tag],
    );

  return (
    <section className="flex flex-col gap-3" aria-labelledby="tag-cost-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="tag-cost-heading" className="text-sm font-medium text-foreground">
          {fromGateway ? gt("Spend by request tag") : gt("Cost by request tag")}
        </h2>
        <div className="flex flex-wrap items-center gap-1">
          <Select value={kind} onValueChange={(value) => setKind(value ?? ALL)}>
            <SelectTrigger aria-label={gt("Tag type")} size="compact" className="w-auto min-w-0">
              <SelectValue>{kind === ALL ? gt("All types") : kind}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value={ALL}>{gt("All types")}</SelectItem>
              {kinds.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {fromGateway ? null : (
            <Select value={provider} onValueChange={(value) => setProvider(value ?? ALL)}>
              <SelectTrigger
                aria-label={gt("Tag provider")}
                size="compact"
                className="w-auto min-w-0"
              >
                <SelectValue>
                  {provider === ALL ? gt("All providers") : PROVIDER_PRESENTATION[provider].label}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value={ALL}>{gt("All providers")}</SelectItem>
                {providers.map((value) => (
                  <SelectItem key={value} value={value}>
                    {PROVIDER_PRESENTATION[value].label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
          <Menu>
            <MenuTrigger render={<Button size="xs" variant="ghost" />} disabled={tags.length === 0}>
              {hiddenCount === 0
                ? gt("Hide tags")
                : gt("{count} hidden", { count: formatCount(hiddenCount) })}
            </MenuTrigger>
            <MenuPopup align="end" className="max-h-80">
              <MenuCheckboxItem
                checked={hiddenCount === 0}
                closeOnClick={false}
                onCheckedChange={(checked) =>
                  setHiddenTags((previous) =>
                    checked
                      ? previous.filter((tag) => !tags.includes(tag))
                      : [...previous, ...tags],
                  )
                }
              >
                {gt("Show all tags")}
              </MenuCheckboxItem>
              <MenuSeparator />
              {tags.map((tag) => (
                <MenuCheckboxItem
                  key={tag}
                  checked={!hidden.has(tag)}
                  closeOnClick={false}
                  onCheckedChange={(checked) => toggleTag(tag, checked)}
                >
                  <span className="truncate font-mono text-xs">{tag}</span>
                </MenuCheckboxItem>
              ))}
            </MenuPopup>
          </Menu>
          <div className="w-48 max-w-full">
            <Input
              aria-label={gt("Search request tags")}
              placeholder={gt("Search tags")}
              size="sm"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {fromGateway
          ? gt("Spend the LiteLLM gateway reports for your keys, in daily totals.")
          : gt(
              "The gateway did not share tag spend for this key, so these are local main-agent estimates at gateway rates. Unpriced turns are excluded.",
            )}{" "}
        {gt("A request can carry several tags, so rows do not add up to total spend.")}
      </p>
      {matching.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          {rows.length > 0
            ? gt("No tags match these filters.")
            : gt("No tag spend in this period. Run a tagged LiteLLM turn to start tracking.")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b text-xs text-muted-foreground">
              <tr>
                <th className="pb-2 font-medium">{gt("Tag")}</th>
                {fromGateway ? null : <th className="px-3 pb-2 font-medium">{gt("Provider")}</th>}
                <th className="pb-2 text-right font-medium">
                  {fromGateway ? gt("Spend") : gt("Estimate")}
                </th>
                {countHeadings.map((heading) => (
                  <th key={heading} className="ps-3 pb-2 text-right font-medium">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matching.slice(0, 100).map((row) => (
                <tr key={row.key} className="border-b border-border/50">
                  <td className="min-w-32 py-3">
                    <span className="break-all font-mono text-xs">{row.tag}</span>
                    <div className="mt-1 h-1 rounded-full bg-muted" aria-hidden>
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${peak === 0 ? 0 : (row.costUsd / peak) * 100}%` }}
                      />
                    </div>
                  </td>
                  {row.provider === undefined ? null : (
                    <td className="px-3 text-xs text-muted-foreground">
                      {PROVIDER_PRESENTATION[row.provider].label}
                    </td>
                  )}
                  <td className="text-right tabular-nums">{row.cost}</td>
                  {row.counts.map((value, index) => (
                    <td
                      key={countHeadings[index]}
                      className={
                        index === 0
                          ? "ps-3 text-right tabular-nums"
                          : "ps-3 text-right tabular-nums text-muted-foreground"
                      }
                    >
                      {value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {matching.length > 100 ? (
            <p className="pt-2 text-xs text-muted-foreground">
              {gt("Showing the first 100 rows. Use the filters to narrow the list.")}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
