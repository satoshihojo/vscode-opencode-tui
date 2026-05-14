export const OPENCODE_TERMINAL_VIEW_COLUMN = 2;

export type EditorLayoutSpec = {
  orientation: 0;
  groups: Array<{ size: number }>;
};

type CommandExecutor = (command: string, ...args: unknown[]) => unknown | PromiseLike<unknown>;

export function createSideBySideEditorLayout(): EditorLayoutSpec {
  return {
    orientation: 0,
    groups: [{ size: 4 / 7 }, { size: 3 / 7 }],
  };
}

export async function prepareSideBySideEditorLayout(executeCommand: CommandExecutor) {
  void executeCommand;
}
