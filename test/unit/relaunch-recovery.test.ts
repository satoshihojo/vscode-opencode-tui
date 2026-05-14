import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tryTerminateExistingOpenCodeProcessForReuse, waitForOpenCodeProcessExit } from "../../src/opencode/relaunch-recovery";

describe("tryTerminateExistingOpenCodeProcessForReuse", () => {
  it("returns true when the existing process exits after TERM and the terminal stays alive", async () => {
    const signals: Array<{ port: number; signal?: "TERM" | "KILL" }> = [];

    const result = await tryTerminateExistingOpenCodeProcessForReuse({
      existingOpenCodePort: 43111,
      terminal: { exitStatus: undefined },
      platform: "linux",
      signalProcess: (port, signal) => {
        signals.push({ port, signal });
      },
      waitForExit: async (port) => port === 43111,
    });

    assert.equal(result, true);
    assert.deepEqual(signals, [{ port: 43111, signal: "TERM" }]);
  });

  it("returns false when the process does not exit in time", async () => {
    const signals: Array<{ port: number; signal?: "TERM" | "KILL" }> = [];

    const result = await tryTerminateExistingOpenCodeProcessForReuse({
      existingOpenCodePort: 43112,
      terminal: { exitStatus: undefined },
      platform: "linux",
      signalProcess: (port, signal) => {
        signals.push({ port, signal });
      },
      waitForExit: async () => false,
    });

    assert.equal(result, false);
    assert.deepEqual(signals, [{ port: 43112, signal: "TERM" }]);
  });

  it("returns false when there is no tracked OpenCode port", async () => {
    let signaled = false;

    const result = await tryTerminateExistingOpenCodeProcessForReuse({
      terminal: { exitStatus: undefined },
      platform: "linux",
      signalProcess: () => {
        signaled = true;
      },
      waitForExit: async () => true,
    });

    assert.equal(result, false);
    assert.equal(signaled, false);
  });

  it("keeps terminal reuse enabled on Windows", async () => {
    let signaled = false;

    const result = await tryTerminateExistingOpenCodeProcessForReuse({
      existingOpenCodePort: 43114,
      terminal: { exitStatus: undefined },
      platform: "win32",
      signalProcess: () => {
        signaled = true;
      },
      waitForExit: async () => false,
    });

    assert.equal(result, true);
    assert.equal(signaled, false);
  });
});

describe("waitForOpenCodeProcessExit", () => {
  it("polls until the process disappears", async () => {
    const seen: number[] = [];
    let attempts = 0;

    const result = await waitForOpenCodeProcessExit(43113, {
      timeoutMs: 50,
      pollIntervalMs: 5,
      wait: async () => undefined,
      isRunning: (port) => {
        seen.push(port);
        attempts += 1;
        return attempts < 3;
      },
    });

    assert.equal(result, true);
    assert.deepEqual(seen, [43113, 43113, 43113]);
  });
});
