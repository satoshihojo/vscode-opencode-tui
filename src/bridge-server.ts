import * as crypto from "node:crypto";
import * as http from "node:http";
import * as vscode from "vscode";
import { ZodError } from "zod";
import { createApplyPatchFailureRecord, type ApplyPatchFailureRecord } from "./apply-patch-failure-log";
import { BRIDGE_TOKEN_ENV, BRIDGE_TOKEN_HEADER, BRIDGE_URL_ENV, WORKSPACE_ROOTS_ENV, BridgeMessageSchema, type BridgeMessage, type BridgeResponse, type TuiSessionActiveMessage } from "./bridge-protocol";
import { prepareOperation, type FileState, type PreparedOperation } from "./bridge-editing";
import { BRIDGE_PLUGIN_FILENAME, TUI_CONFIG_FILENAME } from "./plugin-constants";

const MAX_BRIDGE_REQUEST_BYTES = 5 * 1024 * 1024;

type BridgeServerDeps = {
  asAbsolutePath(relativePath: string): string;
  queuePreparedOperation(prepared: PreparedOperation): Promise<BridgeResponse>;
  readPendingFileState?(uri: vscode.Uri): FileState | undefined | Promise<FileState | undefined>;
  recordApplyPatchFailure?(record: ApplyPatchFailureRecord): Promise<void> | void;
  notifyTuiActiveSession?(message: TuiSessionActiveMessage): Promise<boolean> | boolean;
  showErrorMessage(message: string): void;
};

export class BridgeServer implements vscode.Disposable {
  private readonly token = crypto.randomUUID();
  private port = 0;
  private readonly server: http.Server;
  private readonly ready: Promise<void>;
  private requestQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: BridgeServerDeps) {
    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server.on("error", (error) => {
      this.deps.showErrorMessage(`OpenCode bridge failed to start: ${error.message}`);
    });
    this.ready = new Promise((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.once("listening", () => {
        this.server.off("error", onError);
        const address = this.server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to bind OpenCode bridge server."));
          return;
        }

        this.port = address.port;
        resolve();
      });
      this.server.listen(0, "127.0.0.1");
    });
  }

  async waitUntilReady() {
    await this.ready;
  }

  createConfigContent() {
    if (this.port === 0) {
      throw new Error("OpenCode bridge is not ready yet.");
    }

    return JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugin: [
        vscode.Uri.file(this.deps.asAbsolutePath(BRIDGE_PLUGIN_FILENAME)).toString(),
      ],
    });
  }

  environment() {
    if (this.port === 0) {
      throw new Error("OpenCode bridge is not ready yet.");
    }

    return {
      [BRIDGE_URL_ENV]: `http://127.0.0.1:${this.port}/bridge`,
      [BRIDGE_TOKEN_ENV]: this.token,
      [WORKSPACE_ROOTS_ENV]: JSON.stringify((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)),
      OPENCODE_TUI_CONFIG: this.deps.asAbsolutePath(TUI_CONFIG_FILENAME),
    };
  }

  async dispose() {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  async notifyTuiActiveSessionForTest(message: TuiSessionActiveMessage) {
    return await this.deps.notifyTuiActiveSession?.(message) ?? false;
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    if (request.method !== "POST" || request.url !== "/bridge") {
      this.writeError(response, 404, "Not found");
      return;
    }

    if (request.headers[BRIDGE_TOKEN_HEADER] !== this.token) {
      this.writeError(response, 403, "Forbidden");
      return;
    }

    const next = this.requestQueue.then(async () => {
      let bridgeMessage: BridgeMessage | undefined;
      try {
        const body = await readJsonBody(request);
        bridgeMessage = BridgeMessageSchema.parse(body);
        if (isTuiSessionActiveMessage(bridgeMessage)) {
          const accepted = await this.deps.notifyTuiActiveSession?.(bridgeMessage) ?? false;
          response.writeHead(accepted ? 200 : 409, { "Content-Type": "application/json" });
          response.end(JSON.stringify(
            accepted
              ? { ok: true, result: { output: "", metadata: {} } } satisfies BridgeResponse
              : { ok: false, error: "TUI session activation was not accepted." } satisfies BridgeResponse,
          ));
          return;
        }

        const prepared = await prepareOperation(bridgeMessage, {
          readFileState: (uri) => this.deps.readPendingFileState?.(uri),
        });
        const result = await this.deps.queuePreparedOperation(prepared);
        if (!result.ok && bridgeMessage.tool === "apply_patch") {
          await this.deps.recordApplyPatchFailure?.(createApplyPatchFailureRecord({
            message: result.error,
            directory: bridgeMessage.directory,
            worktree: bridgeMessage.worktree,
            sessionID: bridgeMessage.sessionID,
            patchText: bridgeMessage.payload.patchText,
          }));
        }
        response.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
        response.end(JSON.stringify(result));
      } catch (error) {
        if (error instanceof Error && shouldRecordApplyPatchFailure(error, bridgeMessage)) {
          await this.deps.recordApplyPatchFailure?.(createApplyPatchFailureRecord({
            message: error.message,
            directory: bridgeMessage.directory,
            worktree: bridgeMessage.worktree,
            sessionID: bridgeMessage.sessionID,
            patchText: bridgeMessage.payload.patchText,
          }));
        }
        if (isUnexpectedBridgeError(error)) {
          console.error("Unexpected OpenCode bridge failure:", error);
        }
        const normalized = normalizeBridgeError(error);
        this.writeError(response, normalized.status, normalized.message);
      }
    });

    this.requestQueue = next.then(
      () => undefined,
      () => undefined,
    );

    await next;
  }

  private writeError(response: http.ServerResponse, status: number, error: string) {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: false, error }));
  }
}

function isTuiSessionActiveMessage(message: BridgeMessage): message is TuiSessionActiveMessage {
  return "type" in message && message.type === "tui.session.active";
}

function isUnexpectedBridgeError(error: unknown) {
  return normalizeBridgeError(error).status === 500;
}

function shouldRecordApplyPatchFailure(error: unknown, message: BridgeMessage | undefined): message is Extract<BridgeMessage, { tool: "apply_patch" }> {
  if (!(error instanceof Error)) {
    return false;
  }

  return !!message && "tool" in message && message.tool === "apply_patch";
}

async function readJsonBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const nextChunk = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += nextChunk.length;
    if (size > MAX_BRIDGE_REQUEST_BYTES) {
      throw new Error("Bridge request payload is too large.");
    }
    chunks.push(nextChunk);
  }
  const payload = Buffer.concat(chunks).toString("utf8");
  if (payload.length === 0) {
    return {};
  }

  return JSON.parse(payload);
}

function normalizeBridgeError(error: unknown) {
  if (error instanceof ZodError) {
    return {
      status: 400,
      message: "Invalid bridge request payload.",
    };
  }

  if (error instanceof SyntaxError) {
    return {
      status: 400,
      message: "Invalid JSON request body.",
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message === "Bridge request payload is too large.") {
    return {
      status: 413,
      message,
    };
  }

  if (
    message.includes("outside the active VS Code workspace") ||
    message.startsWith("Bridge request targets a path outside the active workspace") ||
    message.includes("outside the active worktree")
  ) {
    return {
      status: 403,
      message: "Bridge request targets a path outside the active workspace.",
    };
  }

  if (
    message.startsWith("patch rejected:") ||
    message.startsWith("apply_patch verification failed:") ||
    message.startsWith("Patch hunk ") ||
    message.startsWith("Failed to find context") ||
    message.startsWith("Failed to find expected lines") ||
    message.startsWith("Invalid patch format:") ||
    message.startsWith("No changes to apply:") ||
    message.startsWith("Could not find oldString") ||
    message.startsWith("Found multiple matches for oldString") ||
    message.startsWith("Bridge request has ambiguous relative path") ||
    message.includes("requires an open VS Code workspace folder")
  ) {
    return {
      status: 400,
      message,
    };
  }

  return {
    status: 500,
    message: "Unexpected bridge failure.",
  };
}
