import { isValidSessionId } from "./session-manager";
import type { OpenCodeSessionSummary } from "./session-repository";

export type SessionTitlePollerEntry = {
  restoreId: string;
  sessionId?: string;
  cwd?: string;
  title?: string;
  updated?: number | string;
};

export type SessionTitleChangedEvent = {
  restoreId: string;
  sessionId: string;
  title: string;
  previousTitle?: string;
  updated?: number | string;
};

export type SessionTitlePollerScheduler = {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

type SessionTitlePollerRepository = {
  findSessionByIdAsync(sessionId: string, cwd?: string): Promise<OpenCodeSessionSummary | undefined>;
};

type TrackedSessionTitle = Required<Pick<SessionTitlePollerEntry, "restoreId" | "sessionId">> & {
  cwd?: string;
  title?: string;
  updated?: number | string;
};

export type SessionTitlePollerOptions = {
  repository: SessionTitlePollerRepository;
  onTitleChanged(event: SessionTitleChangedEvent): void;
  onError?(error: Error, entry: SessionTitlePollerEntry): void;
  intervalMs?: number;
  scheduler?: SessionTitlePollerScheduler;
};

const DEFAULT_TITLE_POLL_INTERVAL_MS = 2500;

export class OpenCodeSessionTitlePoller {
  private readonly entries = new Map<string, TrackedSessionTitle>();
  private readonly scheduler: SessionTitlePollerScheduler;
  private intervalHandle: unknown;
  private disposed = false;
  private polling = false;

  constructor(private readonly options: SessionTitlePollerOptions) {
    this.scheduler = options.scheduler ?? {
      setInterval: (handler, ms) => setInterval(handler, ms),
      clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
    };
  }

  track(entry: SessionTitlePollerEntry) {
    if (this.disposed || !entry.restoreId || !entry.sessionId || !isValidSessionId(entry.sessionId)) {
      if (entry.restoreId) {
        this.remove(entry.restoreId);
      }
      return;
    }

    const existing = this.entries.get(entry.restoreId);
    const hasUpdated = Object.prototype.hasOwnProperty.call(entry, "updated");
    this.entries.set(entry.restoreId, {
      ...existing,
      restoreId: entry.restoreId,
      sessionId: entry.sessionId,
      ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
      ...(entry.title !== undefined ? { title: entry.title } : {}),
      ...(hasUpdated ? { updated: entry.updated } : {}),
    });
    this.ensureStarted();
  }

  remove(restoreId: string) {
    this.entries.delete(restoreId);
    this.stopIfIdle();
  }

  dispose() {
    this.disposed = true;
    this.entries.clear();
    if (this.intervalHandle !== undefined) {
      this.scheduler.clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }

  private ensureStarted() {
    if (this.intervalHandle !== undefined || this.entries.size === 0) {
      return;
    }

    this.intervalHandle = this.scheduler.setInterval(
      () => { void this.poll(); },
      this.options.intervalMs ?? DEFAULT_TITLE_POLL_INTERVAL_MS,
    );
  }

  private stopIfIdle() {
    if (this.entries.size > 0 || this.intervalHandle === undefined) {
      return;
    }

    this.scheduler.clearInterval(this.intervalHandle);
    this.intervalHandle = undefined;
  }

  private async poll() {
    if (this.disposed || this.polling) {
      return;
    }

    this.polling = true;
    try {
      for (const entry of [...this.entries.values()]) {
        await this.pollEntry(entry);
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollEntry(entry: TrackedSessionTitle) {
    try {
      const session = await this.options.repository.findSessionByIdAsync(entry.sessionId, entry.cwd);
      if (!session || session.parentId || session.id !== entry.sessionId || typeof session.title !== "string") {
        return;
      }

      const title = session.title.trim();
      const titleChanged = title !== entry.title;
      const updatedChanged = session.updated !== entry.updated;
      if (!title || (!titleChanged && !updatedChanged)) {
        return;
      }

      const previousTitle = entry.title;
      this.entries.set(entry.restoreId, { ...entry, title, updated: session.updated });
      this.options.onTitleChanged({
        restoreId: entry.restoreId,
        sessionId: entry.sessionId,
        title,
        ...(session.updated !== undefined ? { updated: session.updated } : {}),
        ...(titleChanged && previousTitle ? { previousTitle } : {}),
      });
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)), entry);
    }
  }
}
