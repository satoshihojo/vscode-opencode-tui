import type { OpenCodeSessionSummary } from "../opencode/session-repository";

export type ReviewSessionMetadata = {
  sessionTitlesById: Record<string, string>;
  sessionCanonicalIdsById: Record<string, string>;
};

type SessionRecord = Pick<OpenCodeSessionSummary, "id" | "parentId" | "title">;

export function mergeReviewSessionMetadata(
  base: ReviewSessionMetadata,
  sessions: readonly SessionRecord[],
): ReviewSessionMetadata {
  const sessionTitlesById = { ...base.sessionTitlesById };
  const sessionCanonicalIdsById = { ...base.sessionCanonicalIdsById };
  const sessionsById = new Map<string, SessionRecord>();

  for (const session of sessions) {
    sessionsById.set(session.id, session);
  }

  const resolveCanonicalId = (sessionId: string, seen = new Set<string>()): string => {
    const session = sessionsById.get(sessionId);
    const cached = sessionCanonicalIdsById[sessionId];
    if (cached && (!session?.parentId || cached !== sessionId)) {
      return cached;
    }

    if (seen.has(sessionId)) {
      return sessionId;
    }

    seen.add(sessionId);
    const canonicalId = session?.parentId ? resolveCanonicalId(session.parentId, seen) : sessionId;
    sessionCanonicalIdsById[sessionId] = canonicalId;
    return canonicalId;
  };

  for (const session of sessions) {
    const canonicalId = resolveCanonicalId(session.id);
    const title = canonicalId === session.id ? session.title?.trim() : undefined;
    if (title && !sessionTitlesById[canonicalId]) {
      sessionTitlesById[canonicalId] = title;
    }
  }

  return {
    sessionTitlesById,
    sessionCanonicalIdsById,
  };
}

export function normalizeSourceSessionIds(
  sessionIds: readonly string[],
  sessionCanonicalIdsById: Record<string, string>,
) {
  const normalizedIds = sessionIds
    .filter((sessionId): sessionId is string => typeof sessionId === "string")
    .map((sessionId) => sessionCanonicalIdsById[sessionId] ?? sessionId);

  return [...new Set(normalizedIds)];
}
