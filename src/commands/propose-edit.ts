import { normalizeProposal } from "../copilot/apply-discard-probe";
import type { DocumentSnapshot, NormalizedProposal } from "../types/proposal";

export type ProbeMode = "auto" | "active" | "scratch";

type CommandDeps = {
  getActiveDocument(): Promise<DocumentSnapshot | undefined>;
  createScratchDocument(): Promise<DocumentSnapshot>;
  applyProposal(proposal: NormalizedProposal): Promise<{
    applied: boolean;
    saved: boolean;
    wasDirtyBeforeApply: boolean;
  }>;
  showInformationMessage(message: string): void;
  showWarningMessage(message: string): void;
  showErrorMessage(message: string): void;
};

export function createProposeEditCommand(mode: ProbeMode, deps: CommandDeps) {
  return async () => {
    try {
      const activeDocument = mode === "scratch" ? undefined : await deps.getActiveDocument();
      const scratchDocument = !activeDocument && mode !== "active" ? await deps.createScratchDocument() : undefined;

      if (mode === "active" && !activeDocument) {
        deps.showWarningMessage("OpenCode TUI Integration Probe requires an active editor for this command.");
        return;
      }

      const proposal = normalizeProposal({
        activeDocument,
        scratchDocument,
      });
      const result = await deps.applyProposal(proposal);

      if (!result.applied) {
        deps.showWarningMessage("OpenCode TUI Integration Probe could not submit the proposal to VS Code.");
        return;
      }

      deps.showInformationMessage(
        result.saved
          ? `OpenCode TUI Integration Probe submitted and saved: ${proposal.confirmation.label}`
          : `OpenCode TUI Integration Probe submitted: ${proposal.confirmation.label}`,
      );
    } catch (error) {
      deps.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };
}
