export interface IntakeProposalDraft {
  readonly title: string;
  readonly description: string;
  readonly include: boolean;
  // Indices into the ORIGINAL proposal list this one depends on.
  readonly dependsOn: ReadonlyArray<number>;
}

export interface IntakeTicketInput {
  readonly title: string;
  readonly description?: string | undefined;
  readonly dependsOn?: ReadonlyArray<number> | undefined;
}

export interface ApprovedIntakeTicket {
  readonly title: string;
  readonly description?: string | undefined;
  // Indices into the APPROVED ticket list (the array this entry lives in),
  // remapped from original proposal indices; edges to excluded rows drop.
  readonly dependsOnIndices: ReadonlyArray<number>;
}

export const toIntakeDrafts = (
  proposals: ReadonlyArray<{
    readonly title: string;
    readonly description?: string | undefined;
    readonly dependsOn?: ReadonlyArray<number> | undefined;
  }>,
): ReadonlyArray<IntakeProposalDraft> =>
  proposals.map((proposal, index) => ({
    title: proposal.title,
    description: proposal.description ?? "",
    include: true,
    dependsOn: (proposal.dependsOn ?? []).filter(
      (dependency) => Number.isInteger(dependency) && dependency >= 0 && dependency < index,
    ),
  }));

export const updateIntakeDraft = (
  drafts: ReadonlyArray<IntakeProposalDraft>,
  index: number,
  patch: Partial<IntakeProposalDraft>,
): ReadonlyArray<IntakeProposalDraft> =>
  drafts.map((draft, draftIndex) => (draftIndex === index ? { ...draft, ...patch } : draft));

/**
 * The tickets the user actually approved — trimmed, excluded/blank rows
 * dropped, and dependency edges remapped onto the approved list (edges to
 * excluded rows simply disappear).
 */
export const approvedIntakeTickets = (
  drafts: ReadonlyArray<IntakeProposalDraft>,
): ReadonlyArray<ApprovedIntakeTicket> => {
  const approvedIndexByOriginal = new Map<number, number>();
  const approved: ApprovedIntakeTicket[] = [];
  for (const [originalIndex, draft] of drafts.entries()) {
    const title = draft.title.trim();
    if (!draft.include || title === "") {
      continue;
    }
    const description = draft.description.trim();
    const dependsOnIndices = draft.dependsOn
      .map((dependency) => approvedIndexByOriginal.get(dependency))
      .filter((mapped): mapped is number => mapped !== undefined);
    approvedIndexByOriginal.set(originalIndex, approved.length);
    approved.push({
      title,
      ...(description === "" ? {} : { description }),
      dependsOnIndices,
    });
  }
  return approved;
};
