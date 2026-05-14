import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenCodeSessionEventMonitor, ServerSentEventParser, extractOpenCodeEvent } from "../../src/opencode/session-event-monitor";

describe("ServerSentEventParser", () => {
  it("parses complete and split server-sent events", () => {
    const parser = new ServerSentEventParser();

    assert.deepEqual(parser.push("data: {\"type\":\"session.status\","), []);
    assert.deepEqual(parser.push("\"properties\":{\"sessionID\":\"ses_1\",\"status\":{\"type\":\"busy\"}}}\n\n"), [
      {
        data: "{\"type\":\"session.status\",\"properties\":{\"sessionID\":\"ses_1\",\"status\":{\"type\":\"busy\"}}}",
      },
    ]);
  });

  it("combines multi-line data fields and ignores comments", () => {
    const parser = new ServerSentEventParser();

    assert.deepEqual(parser.push(": keepalive\nid: 1\nevent: message\ndata: one\ndata: two\n\n"), [
      {
        event: "message",
        id: "1",
        data: "one\ntwo",
      },
    ]);
  });

  it("rejects oversized buffered events", () => {
    const parser = new ServerSentEventParser(4);

    assert.throws(() => parser.push("data: too long"), /buffer exceeded/);
  });
});

describe("extractOpenCodeEvent", () => {
  it("extracts raw and wrapped OpenCode events", () => {
    assert.deepEqual(extractOpenCodeEvent({ type: "session.idle", properties: { sessionID: "ses_1" } }), {
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    });

    assert.deepEqual(extractOpenCodeEvent({
      directory: "/workspace",
      payload: { type: "permission.updated", properties: { id: "per_1", sessionID: "ses_1", title: "Run command" } },
    }), {
      type: "permission.updated",
      properties: { id: "per_1", sessionID: "ses_1", title: "Run command" },
    });
  });

  it("returns undefined for malformed payloads", () => {
    assert.equal(extractOpenCodeEvent({ payload: { properties: {} } }), undefined);
    assert.equal(extractOpenCodeEvent(null), undefined);
  });
});

describe("OpenCodeSessionEventMonitor", () => {
  it("reports stream errors and keeps retrying until disposed", async () => {
    let calls = 0;
    const errors: string[] = [];
    const monitor = new OpenCodeSessionEventMonitor({
      port: 12345,
      retryDelaysMs: [1],
      fetch: async () => {
        calls += 1;
        throw new Error(`connect ${calls}`);
      },
      onEvent: () => {},
      onError: (error) => {
        errors.push(error.message);
        if (errors.length === 2) {
          monitor.dispose();
        }
      },
    });

    monitor.start();
    await waitFor(() => errors.length >= 2);

    assert.deepEqual(errors, ["connect 1", "connect 2"]);
    assert.equal(calls, 2);
  });
});

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.fail("Timed out waiting for condition");
}
