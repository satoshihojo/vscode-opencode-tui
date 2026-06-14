import { randomUUID } from "node:crypto";
import type { OpenCodeSessionSummary } from "./session-repository";

export function createSessionRestoreId() {
  return randomUUID();
}

export function dedupeSessionsByTitle(sessions: OpenCodeSessionSummary[]): OpenCodeSessionSummary[] {
  const seenTitles = new Set<string>();
  const deduped: OpenCodeSessionSummary[] = [];

  for (const session of sessions) {
    if (session.parentId) {
      continue;
    }

    const titleKey = readNormalizedSessionTitle(session);
    if (!titleKey) {
      deduped.push(session);
      continue;
    }

    if (seenTitles.has(titleKey)) {
      continue;
    }

    seenTitles.add(titleKey);
    deduped.push(session);
  }

  return deduped;
}

function readNormalizedSessionTitle(session: OpenCodeSessionSummary) {
  return typeof session.title === "string" && session.title.trim()
    ? session.title.trim()
    : undefined;
}
