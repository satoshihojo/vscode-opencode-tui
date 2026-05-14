import type { NormalizedProposal } from "../types/proposal";

export function shouldSaveAfterApply(input: {
  targetKind: NormalizedProposal["target"]["kind"];
  wasDirtyBeforeApply: boolean;
  scheme: string;
}) {
  return input.targetKind === "existing" && input.scheme === "file" && !input.wasDirtyBeforeApply;
}
