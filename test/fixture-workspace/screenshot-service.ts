import { workspace, window } from "vscode";

type ReviewSummary = {
  total: number;
  pending: number;
  saved: number;
};

export async function loadReviewSummary(): Promise<ReviewSummary> {
  const documents = await workspace.findFiles("src/**/*.ts", "**/node_modules/**", 200);
  const pending = documents.filter((document) => document.path.includes("review")).length;

  return {
    total: documents.length,
    pending,
    saved: documents.length - pending,
  };
}

export async function showReviewSummary() {
  const summary = await loadReviewSummary();
  void window.showInformationMessage(
    `Review queue: ${summary.pending} pending files out of ${summary.total}`,
  );
}
