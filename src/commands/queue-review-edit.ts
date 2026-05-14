import { normalizeProposal } from "../copilot/apply-discard-probe";
import type { DocumentSnapshot, NormalizedProposal } from "../types/proposal";

export type QueueProbeMode = "auto" | "active" | "scratch";

type QueueReviewEditResult = {
  applied: boolean;
  saved: boolean;
  wasDirtyBeforeApply: boolean;
};

type QueueReviewEditDeps = {
  getActiveDocument(): Promise<DocumentSnapshot | undefined>;
  createScratchDocument(): Promise<DocumentSnapshot>;
  applyProposal(proposal: NormalizedProposal): Promise<QueueReviewEditResult>;
  queueProposal(proposal: NormalizedProposal, originalText: string, result: QueueReviewEditResult): Promise<void>;
  revealReviewPanel(): void;
  showInformationMessage(message: string): void;
  showWarningMessage(message: string): void;
  showErrorMessage(message: string): void;
};

export function createQueueReviewEditCommand(mode: QueueProbeMode, deps: QueueReviewEditDeps) {
  return async () => {
    try {
      const activeDocument = mode === "scratch" ? undefined : await deps.getActiveDocument();
      const scratchDocument = !activeDocument && mode !== "active" ? await deps.createScratchDocument() : undefined;

      if (mode === "active" && !activeDocument) {
        deps.showWarningMessage("OpenCode Review Queue requires an active editor for this command.");
        return;
      }

      const proposal = normalizeProposal({
        activeDocument,
        scratchDocument,
      });
      const originalText = activeDocument?.text ?? scratchDocument?.text ?? "";
      const result = await deps.applyProposal(proposal);
      if (!result.applied) {
        deps.showWarningMessage("OpenCode Review Queue could not apply the edit.");
        return;
      }

      await deps.queueProposal(proposal, originalText, result);
      deps.revealReviewPanel();
      deps.showInformationMessage(
        result.saved
          ? `Queued review item and saved file: ${proposal.confirmation.label}`
          : `Queued review item: ${proposal.confirmation.label}`,
      );
    } catch (error) {
      deps.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };
}
