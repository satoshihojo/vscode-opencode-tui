import type { NormalizedProposal, ProposalEdit } from "../types/proposal";

export type WorkspaceEditOperationSpec = {
  kind: ProposalEdit["kind"];
  uri: string;
  newText: string;
  position?: {
    line: number;
    character: number;
  };
  metadata: {
    needsConfirmation: boolean;
    label: string;
    description?: string;
  };
};

export type WorkspaceEditSpec = {
  target: NormalizedProposal["target"];
  operations: WorkspaceEditOperationSpec[];
};

export function toWorkspaceEditSpec(proposal: NormalizedProposal): WorkspaceEditSpec {
  return {
    target: proposal.target,
    operations: proposal.edits.map((edit) => ({
      kind: edit.kind,
      uri: proposal.target.uri,
      newText: edit.newText,
      position: edit.kind === "insert" ? edit.position : undefined,
      metadata: {
        needsConfirmation: proposal.confirmation.needsConfirmation,
        label: proposal.confirmation.label,
        description: proposal.confirmation.description,
      },
    })),
  };
}
