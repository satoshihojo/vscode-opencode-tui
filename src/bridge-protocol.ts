import { z } from "zod";

export const BRIDGE_TOKEN_HEADER = "x-opencode-vscode-bridge-token";
export const BRIDGE_URL_ENV = "OPENCODE_VSCODE_BRIDGE_URL";
export const BRIDGE_PORT_ENV = "OPENCODE_VSCODE_BRIDGE_PORT";
export const BRIDGE_TOKEN_ENV = "OPENCODE_VSCODE_BRIDGE_TOKEN";
export const WORKSPACE_ROOTS_ENV = "OPENCODE_VSCODE_WORKSPACE_ROOTS";

export type BridgeToolName = "edit" | "write" | "apply_patch";

export type EditPayload = {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
};

export type WritePayload = {
  filePath: string;
  content: string;
};

export type ApplyPatchPayload = {
  patchText: string;
};

export type BridgePermissionRule = {
  permission: string;
  pattern: string;
  action: "allow" | "deny" | "ask";
};

export const EditPayloadSchema = z.object({
  filePath: z.string(),
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
});

export const WritePayloadSchema = z.object({
  filePath: z.string(),
  content: z.string(),
});

export const ApplyPatchPayloadSchema = z.object({
  patchText: z.string(),
});

const SessionIdSchema = z.string().max(128).regex(/^ses[A-Za-z0-9_]+$/);
const PermissionRuleSchema = z.object({
  permission: z.string(),
  pattern: z.string(),
  action: z.enum(["allow", "deny", "ask"]),
});
const TuiTitleSchema = z.string().max(240);
const TuiUpdatedSchema = z.union([z.number().finite(), z.string().max(64)]);
const ActivationTimestampSchema = z.number().int().nonnegative().safe();

export const TuiSessionActiveMessageSchema = z.object({
  type: z.literal("tui.session.active"),
  sessionID: SessionIdSchema,
  openCodePort: z.number().int().positive().max(65535).optional(),
  title: TuiTitleSchema.optional(),
  updated: TuiUpdatedSchema.optional(),
  activationTimestamp: ActivationTimestampSchema,
});

export const BridgeRequestSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("edit"),
    payload: EditPayloadSchema,
    directory: z.string(),
    worktree: z.string(),
    sessionID: SessionIdSchema.optional(),
    permission: z.array(PermissionRuleSchema).optional(),
  }),
  z.object({
    tool: z.literal("write"),
    payload: WritePayloadSchema,
    directory: z.string(),
    worktree: z.string(),
    sessionID: SessionIdSchema.optional(),
    permission: z.array(PermissionRuleSchema).optional(),
  }),
  z.object({
    tool: z.literal("apply_patch"),
    payload: ApplyPatchPayloadSchema,
    directory: z.string(),
    worktree: z.string(),
    sessionID: SessionIdSchema.optional(),
    permission: z.array(PermissionRuleSchema).optional(),
  }),
]);

export type BridgeRequest =
  | {
      tool: "edit";
      payload: EditPayload;
      directory: string;
      worktree: string;
      sessionID?: string;
      permission?: BridgePermissionRule[];
    }
  | {
      tool: "write";
      payload: WritePayload;
      directory: string;
      worktree: string;
      sessionID?: string;
      permission?: BridgePermissionRule[];
    }
  | {
      tool: "apply_patch";
      payload: ApplyPatchPayload;
      directory: string;
      worktree: string;
      sessionID?: string;
      permission?: BridgePermissionRule[];
    };

export type TuiSessionActiveMessage = {
  type: "tui.session.active";
  sessionID: string;
  openCodePort?: number;
  title?: string;
  updated?: number | string;
  activationTimestamp: number;
};

export const BridgeMessageSchema = z.union([BridgeRequestSchema, TuiSessionActiveMessageSchema]);

export type BridgeMessage = BridgeRequest | TuiSessionActiveMessage;

export type BridgeResult = {
  output: string;
  metadata: Record<string, unknown>;
};

export type BridgeResponse =
  | {
      ok: true;
      result: BridgeResult;
    }
  | {
      ok: false;
      error: string;
    };
