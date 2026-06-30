import type {
  BoardId,
  BoardSnapshot,
  BoardStreamItem,
  BoardTicketView,
  EnvironmentApi,
  EnvironmentId,
  LaneKey,
  ProjectId,
  StepRunId,
  TicketId,
  WorkflowImportBoardInput,
  WorkflowCreateWorkflowBoardInput,
  WorkflowGenerateWorkflowDraftInput,
  WorkflowProposeBoardImprovementInput,
  WorkflowResolveBoardProposalInput,
} from "@t3tools/contracts";

interface SubscriptionOptions {
  readonly onResubscribe?: () => void;
  readonly onSnapshot?: (snapshot: BoardSnapshot) => void;
  readonly onTicketUpdate?: (ticket: BoardTicketView) => void;
}

export const subscribeBoard = (
  api: EnvironmentApi,
  environmentId: EnvironmentId,
  boardId: BoardId,
  options?: SubscriptionOptions,
): (() => void) =>
  api.workflow.subscribeBoard(
    { boardId },
    (item: BoardStreamItem) => {
      // Board state is now folded by the workflowEnvironment.board atom —
      // the applyBoardStreamItem Zustand side-effect has been removed.
      if (item.kind === "snapshot") {
        options?.onSnapshot?.(item.snapshot);
      }
      if (item.kind === "ticket") {
        options?.onTicketUpdate?.(item.ticket);
      }
    },
    options,
  );

export const createTicket = (
  api: EnvironmentApi,
  input: Parameters<EnvironmentApi["workflow"]["createTicket"]>[0],
) => api.workflow.createTicket(input);

export const listBoards = (api: EnvironmentApi, projectId: ProjectId) =>
  api.workflow.listBoards({ projectId });

export const createBoard = (
  api: EnvironmentApi,
  input: Parameters<EnvironmentApi["workflow"]["createBoard"]>[0],
) => api.workflow.createBoard(input);

export const importBoard = (api: EnvironmentApi, input: WorkflowImportBoardInput) =>
  api.workflow.importBoard(input);

export const createWorkflowBoard = (api: EnvironmentApi, input: WorkflowCreateWorkflowBoardInput) =>
  api.workflow.createWorkflowBoard(input);

export const generateWorkflowDraft = (
  api: EnvironmentApi,
  input: WorkflowGenerateWorkflowDraftInput,
) => api.workflow.generateWorkflowDraft(input);

export const listBoardTemplates = (api: EnvironmentApi) => api.workflow.listBoardTemplates({});

export const deleteBoard = (api: EnvironmentApi, boardId: BoardId) =>
  api.workflow.deleteBoard({ boardId });

export const renameBoard = (api: EnvironmentApi, boardId: BoardId, name: string) =>
  api.workflow.renameBoard({ boardId, name });

export const editTicket = (
  api: EnvironmentApi,
  input: Parameters<EnvironmentApi["workflow"]["editTicket"]>[0],
) => api.workflow.editTicket(input);

export const moveTicket = (api: EnvironmentApi, ticketId: TicketId, toLane: LaneKey) =>
  api.workflow.moveTicket({ ticketId, toLane });

export const resolveApproval = (api: EnvironmentApi, stepRunId: StepRunId, approved: boolean) =>
  api.workflow.resolveApproval({ stepRunId, approved });

export const postTicketMessage = (
  api: EnvironmentApi,
  input: Parameters<EnvironmentApi["workflow"]["postTicketMessage"]>[0],
) => api.workflow.postTicketMessage(input);

export const editTicketMessage = (
  api: EnvironmentApi,
  input: Parameters<EnvironmentApi["workflow"]["editTicketMessage"]>[0],
) => api.workflow.editTicketMessage(input);

export const answerTicketStep = (
  api: EnvironmentApi,
  input: Parameters<EnvironmentApi["workflow"]["answerTicketStep"]>[0],
) => api.workflow.answerTicketStep(input);

export const getTicketDiff = (api: EnvironmentApi, ticketId: TicketId) =>
  api.workflow.getTicketDiff({ ticketId });

export const proposeBoardImprovement = (
  api: EnvironmentApi,
  input: WorkflowProposeBoardImprovementInput,
) => api.workflow.proposeBoardImprovement(input);

export const listBoardProposals = (api: EnvironmentApi, boardId: BoardId) =>
  api.workflow.listBoardProposals({ boardId });

export const getBoardProposal = (api: EnvironmentApi, proposalId: string) =>
  api.workflow.getBoardProposal({ proposalId });

export const resolveBoardProposal = (
  api: EnvironmentApi,
  input: WorkflowResolveBoardProposalInput,
) => api.workflow.resolveBoardProposal(input);

export const revertBoardProposal = (api: EnvironmentApi, proposalId: string) =>
  api.workflow.revertBoardProposal({ proposalId });
