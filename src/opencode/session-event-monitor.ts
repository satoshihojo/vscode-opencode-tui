export type OpenCodeEvent = {
  type: string;
  properties?: Record<string, unknown>;
};

export type OpenCodeEventMonitorOptions = {
  port: number;
  fetch?: typeof fetch;
  retryDelaysMs?: number[];
  maxEventBytes?: number;
  onEvent(event: OpenCodeEvent): void;
  onError?(error: Error): void;
  onMalformedEvent?(error: Error): void;
};

type ServerSentEvent = {
  event?: string;
  id?: string;
  data: string;
};

const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024;

export class OpenCodeSessionEventMonitor {
  private readonly abortController = new AbortController();
  private disposed = false;
  private started = false;

  constructor(private readonly options: OpenCodeEventMonitorOptions) {}

  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    void this.run();
  }

  dispose() {
    this.disposed = true;
    this.abortController.abort();
  }

  private async run() {
    const retryDelaysMs = this.options.retryDelaysMs ?? [250, 500, 1000, 2000, 5000];
    let attempt = 0;
    while (!this.disposed && !this.abortController.signal.aborted) {
      try {
        await this.readEventStream();
        if (this.disposed || this.abortController.signal.aborted) {
          return;
        }
        throw new Error("OpenCode event stream closed unexpectedly.");
      } catch (error) {
        if (this.disposed || this.abortController.signal.aborted) {
          return;
        }

        const nextError = error instanceof Error ? error : new Error(String(error));
        this.options.onError?.(nextError);
        const delayMs = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] ?? 5000;
        attempt += 1;
        await wait(delayMs, this.abortController.signal);
      }
    }
  }

  private async readEventStream() {
    const fetchImpl = this.options.fetch ?? fetch;
    const parser = new ServerSentEventParser(this.options.maxEventBytes);
    const decoder = new TextDecoder();

    const response = await fetchImpl(`http://127.0.0.1:${this.options.port}/event`, {
      headers: { accept: "text/event-stream" },
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`OpenCode event stream failed with HTTP ${response.status}.`);
    }

    if (!response.body) {
      throw new Error("OpenCode event stream did not return a readable body.");
    }

    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      if (this.disposed) {
        return;
      }

      for (const event of parser.push(decoder.decode(chunk, { stream: true }))) {
        this.handleSseEvent(event);
      }
    }

    for (const event of parser.end(decoder.decode())) {
      this.handleSseEvent(event);
    }
  }

  private handleSseEvent(event: ServerSentEvent) {
    if (!event.data.trim()) {
      return;
    }

    try {
      if (event.data.length > (this.options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES)) {
        throw new Error("OpenCode event payload exceeded the maximum size.");
      }
      const parsed = JSON.parse(event.data) as unknown;
      const opencodeEvent = extractOpenCodeEvent(parsed);
      if (opencodeEvent) {
        this.options.onEvent(opencodeEvent);
      }
    } catch (error) {
      this.options.onMalformedEvent?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export class ServerSentEventParser {
  private buffer = "";

  constructor(private readonly maxEventBytes = DEFAULT_MAX_EVENT_BYTES) {}

  push(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > this.maxEventBytes) {
      this.buffer = "";
      throw new Error("OpenCode event stream buffer exceeded the maximum size.");
    }
    const events: ServerSentEvent[] = [];

    while (true) {
      const separatorIndex = this.findSeparator();
      if (!separatorIndex) {
        break;
      }

      const rawEvent = this.buffer.slice(0, separatorIndex.index);
      this.buffer = this.buffer.slice(separatorIndex.index + separatorIndex.length);
      const event = parseServerSentEvent(rawEvent);
      if (event) {
        events.push(event);
      }
    }

    return events;
  }

  end(chunk = "") {
    const events = this.push(chunk);
    if (this.buffer.length > 0) {
      const event = parseServerSentEvent(this.buffer);
      this.buffer = "";
      if (event) {
        events.push(event);
      }
    }
    return events;
  }

  private findSeparator(): { index: number; length: number } | undefined {
    const newlineSeparator = this.buffer.indexOf("\n\n");
    const windowsSeparator = this.buffer.indexOf("\r\n\r\n");
    if (newlineSeparator < 0) {
      return windowsSeparator < 0 ? undefined : { index: windowsSeparator, length: 4 };
    }
    if (windowsSeparator < 0) {
      return { index: newlineSeparator, length: 2 };
    }
    return newlineSeparator < windowsSeparator
      ? { index: newlineSeparator, length: 2 }
      : { index: windowsSeparator, length: 4 };
  }
}

function wait(durationMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function extractOpenCodeEvent(value: unknown): OpenCodeEvent | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const candidate = isRecord(record.payload) ? record.payload : record;
  if (typeof candidate.type !== "string") {
    return undefined;
  }

  return {
    type: candidate.type,
    properties: isRecord(candidate.properties) ? candidate.properties : undefined,
  };
}

function parseServerSentEvent(rawEvent: string): ServerSentEvent | undefined {
  const data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;

  for (const rawLine of rawEvent.split(/\r?\n/)) {
    if (rawLine.length === 0 || rawLine.startsWith(":")) {
      continue;
    }

    const delimiterIndex = rawLine.indexOf(":");
    const field = delimiterIndex < 0 ? rawLine : rawLine.slice(0, delimiterIndex);
    const value = delimiterIndex < 0
      ? ""
      : rawLine.slice(delimiterIndex + 1).replace(/^ /, "");

    if (field === "data") {
      data.push(value);
    } else if (field === "event") {
      event = value;
    } else if (field === "id") {
      id = value;
    }
  }

  if (data.length === 0) {
    return undefined;
  }

  return {
    ...(event ? { event } : {}),
    ...(id ? { id } : {}),
    data: data.join("\n"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
