export type OpenCodeTerminalLabelState = "normal" | "running" | "permission" | "error" | "idle";

export const OPENCODE_TERMINAL_ATTENTION_PREFIX = "$(bell) ";

export const OPENCODE_TERMINAL_STATE_PREFIXES: Record<Exclude<OpenCodeTerminalLabelState, "normal">, string> = {
  running: "[run] ",
  permission: "[perm] ",
  error: "[err] ",
  idle: "[idle] ",
};

const OPENCODE_TERMINAL_PREFIXES = [
  OPENCODE_TERMINAL_ATTENTION_PREFIX,
  ...Object.values(OPENCODE_TERMINAL_STATE_PREFIXES),
];

export function applyTerminalAttentionLabel(label: string, state: OpenCodeTerminalLabelState) {
  const normalizedLabel = clearTerminalAttentionLabel(label);
  return normalizedLabel;
}

export function clearTerminalAttentionLabel(label: string) {
  let normalizedLabel = label;
  while (true) {
    const prefix = OPENCODE_TERMINAL_PREFIXES.find((candidate) => normalizedLabel.startsWith(candidate));
    if (!prefix) {
      return normalizedLabel;
    }

    normalizedLabel = normalizedLabel.slice(prefix.length);
  }
}

export function hasTerminalAttentionLabel(label: string) {
  return clearTerminalAttentionLabel(label) !== label;
}
