import {
  prsReadApi,
  prsWriteApi,
  type PrsActor,
  type PrsDetail,
  type PrsLabel,
  type PrsLabelCandidate,
  type PrsOperationsSupport,
  type PrsRef,
  type PrsReviewerCandidate,
  type PrsWriteOperationsSupport,
} from "@t3tools/extension-sdk/catalogue";
import { Tooltip } from "@t3tools/extension-sdk/authoring";
import { bindApi } from "@t3tools/extension-sdk/capabilities";
import { resolveFloatingLayer, type ClientHost } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { MutationToastPatch } from "./mutationToasts.js";
import { border, muted, prsReadableFailure } from "./prsPresentation.js";
import { prsActorTooltip } from "./prsViewModel.js";

const rowStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  flexWrap: "wrap",
} as const;
const labelWords = {
  trigger: "Change labels",
  search: "Search labels",
  permission: "Changing labels needs triage access on this repository",
  unavailable: "Labels cannot be changed from here",
  empty: "This repository has no labels.",
  noMatch: "No label matches that.",
  error: "The labels could not be read.",
  truncated: "This repository has more labels than are listed here. Apply the rest on the host.",
};
const reviewerWords = {
  trigger: "Request a review",
  search: "Search people with access",
  permission: "Asking someone to review needs write access on this repository",
  unavailable: "Reviews cannot be requested from here",
  empty: "Nobody else has access to this repository.",
  noMatch: "Nobody with access matches that.",
  error: "The people with access could not be read.",
  truncated:
    "This repository has more people with access than are listed here. Ask for the rest on the host.",
};

type Candidate =
  | { kind: "label"; key: string; name: string; value: PrsLabelCandidate }
  | { kind: "reviewer"; key: string; name: string; value: PrsReviewerCandidate };
type CandidateList = { candidates: readonly Candidate[]; truncated: boolean };

function labelColor(color: string | null) {
  const hex = color?.trim().replace(/^#/, "") ?? "";
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : null;
}

function matches(candidate: Candidate, query: string) {
  const needle = query.toLowerCase();
  return (
    candidate.name.toLowerCase().includes(needle) ||
    (candidate.kind === "label" ? candidate.value.description : candidate.value.name)
      ?.toLowerCase()
      .includes(needle) === true
  );
}

function toggleMetadata(detail: PrsDetail, candidate: Candidate, applied: boolean): PrsDetail {
  if (candidate.kind === "label")
    return {
      ...detail,
      labels: applied
        ? detail.labels.some((label) => label.name === candidate.name)
          ? detail.labels
          : [...detail.labels, { name: candidate.name, color: candidate.value.color }]
        : detail.labels.filter((label) => label.name !== candidate.name),
    };
  const reviewers = detail.reviewers.filter(
    (reviewer) => reviewer.login.toLowerCase() !== candidate.name.toLowerCase(),
  );
  return {
    ...detail,
    reviewers: applied
      ? [
          ...reviewers,
          {
            login: candidate.value.login,
            name: candidate.value.name,
            avatarUrl: candidate.value.avatarUrl,
          },
        ]
      : reviewers,
  };
}

function Dot({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden
      style={{
        width: 8,
        height: 8,
        flexShrink: 0,
        borderRadius: "50%",
        background: labelColor(color) ?? muted,
      }}
    />
  );
}

function ActorLabel({ actor, host }: { actor: PrsActor; host: ClientHost }) {
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  return (
    <Tooltip host={host} side="top" label={prsActorTooltip(actor)}>
      <span style={{ ...rowStyle, flexWrap: "nowrap", gap: 6, minWidth: 0, fontWeight: 500 }}>
        {actor.avatarUrl === null || failedAvatar === actor.avatarUrl ? (
          <span
            aria-hidden
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 16,
              height: 16,
              flexShrink: 0,
              borderRadius: "50%",
              background: "var(--t3-version-control-muted, var(--muted, #f4f5f7))",
              color: muted,
              fontSize: 8,
            }}
          >
            {actor.login.slice(0, 1).toUpperCase()}
          </span>
        ) : (
          <img
            aria-hidden
            src={actor.avatarUrl}
            alt=""
            loading="lazy"
            width="16"
            height="16"
            onError={() => setFailedAvatar(actor.avatarUrl)}
            style={{ flexShrink: 0, borderRadius: "50%", objectFit: "cover" }}
          />
        )}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {actor.login}
        </span>
      </span>
    </Tooltip>
  );
}

function LabelChip({ label }: { label: PrsLabel }) {
  const color = labelColor(label.color);
  return (
    <span
      className={`t3-prs-label-chip${color === null ? "" : " t3-prs-label-colored"}`}
      style={{ "--label": color ?? undefined } as React.CSSProperties}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label.name}
      </span>
    </span>
  );
}

function PickerIcon({ kind }: { kind: "labels" | "reviewers" }) {
  return (
    <svg
      aria-hidden
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === "labels" ? (
        <>
          <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42z" />
          <circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />
        </>
      ) : (
        <>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M20 8v6M23 11h-6" />
          <circle cx="9" cy="7" r="4" />
        </>
      )}
    </svg>
  );
}

export function PrsMetadataPicker({
  kind,
  host,
  session,
  reference,
  detail,
  readOperations,
  writeOperations,
  report,
}: {
  kind: "labels" | "reviewers";
  host: ClientHost;
  session: ViewSession;
  reference: PrsRef;
  detail: PrsDetail;
  readOperations: PrsOperationsSupport | null;
  writeOperations: PrsWriteOperationsSupport | null;
  report: (patch: MutationToastPatch, onReceiptLost: () => void) => boolean;
}) {
  const words = kind === "labels" ? labelWords : reviewerWords;
  const supported =
    kind === "labels"
      ? detail.capabilities.labels === true
      : detail.capabilities.reviewers.request && detail.capabilities.reviewers.listCandidates;
  const permitted =
    kind === "labels"
      ? detail.viewerPermissions.labels !== false
      : detail.viewerPermissions.requestReviewers;
  const canRead =
    readOperations?.[kind === "labels" ? "prs.labelCandidates" : "prs.reviewerCandidates"] === true;
  const canWrite =
    writeOperations?.[kind === "labels" ? "prs.setLabels" : "prs.requestReviewers"] === true;
  const allowed = supported && permitted && canRead && canWrite;
  const disabledReason = !permitted ? words.permission : words.unavailable;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [list, setList] = useState<CandidateList | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [optimistic, setOptimistic] = useState<{
    source: PrsDetail;
    value: PrsDetail;
    candidate: Candidate;
    applied: boolean;
  } | null>(null);
  const [receipt, setReceipt] = useState<MutationToastPatch | null>(null);
  const detailRef = useRef(detail);
  const pendingRef = useRef(false);
  const mutation = useRef<AbortController | null>(null);
  const live = useRef(true);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const attachTrigger = useCallback((element: HTMLButtonElement | null) => {
    trigger.current = element;
    setAnchor(element);
  }, []);
  const search = useRef<HTMLInputElement | null>(null);
  const activeOption = useRef<HTMLButtonElement | null>(null);
  const popup = useRef<HTMLDivElement | null>(null);
  const [popupElement, setPopupElement] = useState<HTMLDivElement | null>(null);
  const attachPopup = useCallback((element: HTMLDivElement | null) => {
    popup.current = element;
    setPopupElement(element);
  }, []);
  const listId = useId();
  const shown =
    optimistic?.source === detail
      ? optimistic.value
      : pending && optimistic !== null
        ? toggleMetadata(detail, optimistic.candidate, optimistic.applied)
        : detail;
  const candidates = (list?.candidates ?? []).filter((candidate) => matches(candidate, query));
  const active = candidates[Math.min(highlight, candidates.length - 1)];
  const activeId = active === undefined ? undefined : `${listId}-${candidates.indexOf(active)}`;
  const isSelected = (candidate: Candidate) =>
    pending && optimistic?.candidate.key === candidate.key
      ? optimistic.applied
      : candidate.kind === "label"
        ? candidate.value.isApplied
        : candidate.value.isRequested;

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      mutation.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!allowed) setOpen(false);
  }, [allowed]);
  useEffect(() => {
    if (!open || !allowed || list !== null) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    const api = bindApi(prsReadApi, host, session.context);
    const read = async (): Promise<CandidateList> => {
      if (kind === "labels") {
        const result = await api.invoke("labelCandidates", reference, signal);
        return {
          truncated: result.truncated,
          candidates: result.candidates.map((value) => ({
            kind: "label",
            key: value.name,
            name: value.name,
            value,
          })),
        };
      }
      const result = await api.invoke("reviewerCandidates", reference, signal);
      return {
        truncated: result.truncated,
        candidates: result.candidates.map((value) => ({
          kind: "reviewer",
          key: `${value.kind}:${value.id}`,
          name: value.login,
          value,
        })),
      };
    };
    void read().then(
      (result) => {
        if (!signal.aborted) setList(result);
      },
      (error: unknown) => {
        if (!signal.aborted) setReadError(prsReadableFailure(error, words.error));
      },
    );
    return () => controller.abort();
  }, [open, allowed, list, kind, host, session, reference, words.error]);
  useEffect(() => {
    if (open) activeOption.current?.scrollIntoView({ block: "nearest" });
  }, [open, activeId, active?.key, popupElement]);
  useEffect(() => {
    if (!open || popupElement === null) return;
    const timer = setTimeout(() => search.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open, popupElement]);
  useEffect(() => {
    if (!open || typeof document === "undefined" || !("addEventListener" in document)) return;
    const onPress = (event: Event) => {
      if (
        !trigger.current?.contains(event.target as Node) &&
        !popup.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("mousedown", onPress);
    return () => document.removeEventListener("mousedown", onPress);
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const showReceipt = (patch: MutationToastPatch) => {
    const lost = () => {
      if (live.current && !session.signal.aborted) setReceipt(patch);
    };
    if (!report(patch, lost)) lost();
  };
  const toggle = async (candidate: Candidate) => {
    if (!allowed || pendingRef.current || session.signal.aborted) return;
    const applied = !isSelected(candidate);
    const previous = optimistic;
    pendingRef.current = true;
    setPending(true);
    setReceipt(null);
    setOptimistic({
      source: detail,
      value: toggleMetadata(shown, candidate, applied),
      candidate,
      applied,
    });
    const controller = new AbortController();
    mutation.current = controller;
    const signal = AbortSignal.any([controller.signal, session.signal]);
    const api = bindApi(prsWriteApi, host, session.context);
    try {
      if (candidate.kind === "label")
        await api.invoke("setLabels", { ...reference, labels: [candidate.name], applied }, signal);
      else
        await api.invoke(
          "requestReviewers",
          {
            ...reference,
            reviewers: [{ id: candidate.value.id, kind: candidate.value.kind }],
            requested: applied,
          },
          signal,
        );
      if (signal.aborted) return;
      setList((current) =>
        current === null
          ? null
          : {
              ...current,
              candidates: current.candidates.map((entry) =>
                entry.key !== candidate.key
                  ? entry
                  : entry.kind === "label"
                    ? { ...entry, value: { ...entry.value, isApplied: applied } }
                    : { ...entry, value: { ...entry.value, isRequested: applied } },
              ),
            },
      );
      setOptimistic((current) =>
        current === null || current.source === detailRef.current
          ? current
          : {
              ...current,
              source: detailRef.current,
              value: toggleMetadata(detailRef.current, candidate, applied),
            },
      );
      if (candidate.kind === "reviewer")
        showReceipt({
          severity: "success",
          title: applied
            ? `Review requested from ${candidate.name}`
            : `Review request to ${candidate.name} taken back`,
        });
    } catch (error) {
      if (signal.aborted) return;
      setOptimistic(previous);
      showReceipt({
        severity: "error",
        title:
          candidate.kind === "label"
            ? applied
              ? `Could not put ${candidate.name} on`
              : `Could not take ${candidate.name} off`
            : applied
              ? `Could not ask ${candidate.name} for a review`
              : `Could not take back the review request to ${candidate.name}`,
        body: prsReadableFailure(
          error,
          candidate.kind === "label"
            ? "The host refused it. Check that you have triage access on this repository."
            : "The host refused it. Check that you have write access on this repository, and that they still have access to it.",
        ),
      });
    } finally {
      pendingRef.current = false;
      if (!signal.aborted) setPending(false);
    }
  };

  const surface = {
    role: "dialog",
    "aria-label": words.trigger,
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Tab") close();
      else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    },
    onBlur: (event: React.FocusEvent<HTMLDivElement>) => {
      if (
        event.relatedTarget !== null &&
        !popup.current?.contains(event.relatedTarget as Node) &&
        !trigger.current?.contains(event.relatedTarget as Node)
      )
        setOpen(false);
    },
    style: {
      width: 288,
      border,
      borderRadius: 8,
      fontSize: 14,
      background: "var(--t3-version-control-popover, var(--popover, #fff))",
      color: "var(--t3-version-control-foreground, var(--foreground, #111827))",
      boxShadow: "0 4px 12px #0002",
    },
  };
  const body = (
    <>
      <div
        style={{
          minWidth: 0,
          margin: "10px 12px 0",
          paddingBottom: 6,
          position: "relative",
          borderBottom: border,
        }}
      >
        <svg
          aria-hidden
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={{ position: "absolute", top: 6, left: 0, color: muted, opacity: 0.55 }}
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          ref={search}
          role="combobox"
          aria-label={words.search}
          placeholder={words.search}
          aria-controls={listId}
          aria-expanded
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlight(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setHighlight((current) =>
                candidates.length === 0
                  ? 0
                  : (Math.min(current, candidates.length - 1) +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      candidates.length) %
                    candidates.length,
              );
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (active !== undefined) void toggle(active);
            }
          }}
          style={{
            boxSizing: "border-box",
            width: "100%",
            font: "inherit",
            height: 26,
            lineHeight: "26px",
            padding: "0 0 0 20px",
            border: "none",
            background: "transparent",
            color: "inherit",
          }}
        />
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label={kind === "labels" ? "Repository labels" : "People with access"}
        aria-multiselectable
        style={{ maxHeight: 288, overflowY: "auto", padding: 4 }}
      >
        {list === null ? (
          readError !== null ? (
            <p style={{ margin: 0, padding: 8, color: muted, fontSize: 12 }}>
              {words.error} {readError === words.error ? null : readError}
            </p>
          ) : (
            <div aria-busy aria-label="Loading candidates" style={{ padding: 8 }}>
              {[0, 1, 2, 3].map((index) => (
                <div
                  key={index}
                  aria-hidden
                  style={{
                    height: 16,
                    width: "75%",
                    margin: "4px 0",
                    borderRadius: 4,
                    background: "var(--t3-version-control-muted, var(--muted, #f4f5f7))",
                  }}
                />
              ))}
            </div>
          )
        ) : candidates.length === 0 ? (
          <p style={{ margin: 0, padding: 8, color: muted, fontSize: 12 }}>
            {query.length > 0 ? words.noMatch : words.empty}
          </p>
        ) : (
          candidates.map((candidate, index) => (
            <button
              key={candidate.key}
              ref={active?.key === candidate.key ? activeOption : undefined}
              id={`${listId}-${index}`}
              type="button"
              role="option"
              aria-label={candidate.name}
              aria-selected={isSelected(candidate)}
              disabled={pending}
              tabIndex={-1}
              onMouseMove={() => setHighlight(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void toggle(candidate)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                minHeight: 28,
                padding: "4px 8px",
                border: "none",
                borderRadius: 4,
                font: "inherit",
                textAlign: "left",
                cursor: pending ? "default" : "pointer",
                color: "inherit",
                background:
                  active?.key === candidate.key
                    ? "var(--t3-version-control-muted, var(--muted, #f4f5f7))"
                    : "transparent",
                opacity: pending ? 0.5 : 1,
              }}
            >
              {candidate.kind === "label" ? <Dot color={candidate.value.color} /> : null}
              <span
                style={{
                  minWidth: 0,
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {candidate.kind === "label" ? (
                  candidate.name
                ) : (
                  <ActorLabel host={host} actor={candidate.value} />
                )}
                {candidate.kind === "label" && candidate.value.description ? (
                  <span style={{ color: muted }}> · {candidate.value.description}</span>
                ) : null}
              </span>
              {candidate.kind === "reviewer" && candidate.value.kind === "team" ? (
                <span style={{ color: muted }}>team</span>
              ) : null}
              {isSelected(candidate) ? (
                <svg
                  role="img"
                  aria-label={candidate.kind === "label" ? "Applied" : "Already asked"}
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="m20 6-11 11-5-5" />
                </svg>
              ) : null}
            </button>
          ))
        )}
        {list?.truncated === true ? (
          <p style={{ margin: 0, padding: "6px 8px", color: muted, fontSize: 12 }}>
            {words.truncated}
          </p>
        ) : null}
      </div>
    </>
  );
  const Popover = resolveFloatingLayer(host)?.Popover;

  return (
    <span style={rowStyle}>
      {kind === "labels" ? (
        <style>{`
        .t3-prs-label-chip { display: inline-flex; align-items: center; min-width: 22px; max-width: 192px; height: 22px; padding: 0 3px; border: 1px solid transparent; border-radius: 2px; font-size: 14px; font-weight: 500; background: var(--secondary, #f4f5f7); color: var(--secondary-foreground, #111827); }
        .t3-prs-label-colored { background: color-mix(in srgb, var(--label) 8%, transparent); color: color-mix(in srgb, var(--label) 30%, var(--t3-version-control-foreground, var(--foreground, #111827))); }
        .dark .t3-prs-label-colored { background: color-mix(in srgb, var(--label) 12%, transparent); color: color-mix(in srgb, var(--label) 45%, var(--t3-version-control-foreground, var(--foreground, #fff))); }
        @media (min-width: 640px) { .t3-prs-label-chip { min-width: 18px; height: 18px; font-size: 12px; } }
      `}</style>
      ) : null}
      <span
        aria-label={`${kind === "labels" ? "Labels" : "Reviewers"} on pull request`}
        style={rowStyle}
      >
        {(kind === "labels" ? shown.labels.length : shown.reviewers.length) === 0 ? (
          <span style={{ color: muted }}>None</span>
        ) : kind === "labels" ? (
          shown.labels.map((label) => <LabelChip key={label.name} label={label} />)
        ) : (
          shown.reviewers.map((reviewer) => (
            <ActorLabel key={reviewer.login} host={host} actor={reviewer} />
          ))
        )}
      </span>
      {supported ? (
        <span style={{ position: "relative", display: "inline-flex" }}>
          <Tooltip
            host={host}
            side="bottom"
            showWhenDisabled
            label={allowed ? words.trigger : disabledReason}
          >
            <button
              ref={attachTrigger}
              type="button"
              aria-label={words.trigger}
              aria-haspopup="dialog"
              aria-expanded={open && allowed}
              disabled={!allowed}
              onClick={() => {
                if (allowed) {
                  setReadError(null);
                  setOpen((current) => !current);
                }
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 24,
                height: 24,
                border: "none",
                borderRadius: 4,
                background: "transparent",
                color: "inherit",
                cursor: allowed ? "pointer" : "default",
                opacity: allowed ? 1 : 0.5,
              }}
            >
              <PickerIcon kind={kind} />
            </button>
          </Tooltip>
          {open && allowed ? (
            Popover !== undefined && anchor !== null ? (
              <Popover
                {...surface}
                anchor={anchor}
                side="bottom"
                align="start"
                offset={4}
                elementRef={attachPopup}
              >
                {body}
              </Popover>
            ) : (
              <div
                {...surface}
                ref={attachPopup}
                style={{ ...surface.style, position: "absolute", left: 0, top: "100%", zIndex: 10 }}
              >
                {body}
              </div>
            )
          ) : null}
        </span>
      ) : null}
      {receipt !== null ? (
        <span role={receipt.severity === "error" ? "alert" : "status"}>
          {receipt.title}
          {receipt.body ? ` — ${receipt.body}` : ""}
        </span>
      ) : null}
    </span>
  );
}
