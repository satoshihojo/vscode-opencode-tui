import path from "node:path";
import type { DocumentSnapshot, NormalizedProposal } from "../types/proposal";

export const DEFAULT_SCRATCH_URI = "untitled:OpenCode TUI Integration Probe.md";

const SLASH_COMMENT_LANGUAGES = new Set([
  "c",
  "cpp",
  "csharp",
  "css",
  "dart",
  "go",
  "java",
  "javascript",
  "javascriptreact",
  "jsonc",
  "kotlin",
  "less",
  "objective-c",
  "objective-cpp",
  "php",
  "rust",
  "scala",
  "scss",
  "swift",
  "typescript",
  "typescriptreact",
]);

const HASH_COMMENT_LANGUAGES = new Set([
  "dockerfile",
  "git-commit",
  "git-rebase",
  "ignore",
  "makefile",
  "perl",
  "python",
  "ruby",
  "shellscript",
  "yaml",
]);

const MARKUP_COMMENT_LANGUAGES = new Set([
  "html",
  "markdown",
  "xml",
]);

type NormalizeProposalInput = {
  activeDocument?: DocumentSnapshot;
  scratchDocument?: DocumentSnapshot;
};

export function normalizeProposal(input: NormalizeProposalInput): NormalizedProposal {
  if (input.activeDocument) {
    const document = input.activeDocument;
    const appendPosition = getAppendPosition(document.text);
    const probeLine = buildExistingDocumentProbeLine(document);

    return {
      target: {
        kind: "existing",
        uri: document.uri,
      },
      edits: [
        {
          kind: "insert",
          position: appendPosition,
          newText: buildExistingDocumentProbeText(document, probeLine),
        },
      ],
      confirmation: {
        needsConfirmation: true,
        label: toEditLabel(document.uri),
        description: "Probe whether VS Code surfaces native edit confirmation for this proposal.",
      },
    };
  }

  if (input.scratchDocument) {
    const document = input.scratchDocument;

    return {
      target: {
        kind: "scratch",
        uri: document.uri,
        initialText: document.text,
      },
      edits: [
        {
          kind: "insert",
          position: {
            line: 0,
            character: 0,
          },
          newText: buildScratchProbeText(),
        },
      ],
      confirmation: {
        needsConfirmation: true,
        label: toEditLabel(document.uri),
        description: "Probe whether VS Code surfaces native edit confirmation for a scratch proposal.",
      },
    };
  }

  return {
    target: {
      kind: "scratch",
      uri: DEFAULT_SCRATCH_URI,
      initialText: "",
    },
    edits: [
      {
        kind: "insert",
        position: {
          line: 0,
          character: 0,
        },
        newText: buildScratchProbeText(),
      },
    ],
    confirmation: {
      needsConfirmation: true,
      label: toEditLabel(DEFAULT_SCRATCH_URI),
      description: "Probe whether VS Code surfaces native edit confirmation for a scratch proposal.",
    },
  };
}

export function toEditLabel(uri: string): string {
  return `OpenCode TUI Integration Probe: ${path.posix.basename(stripUriScheme(uri))}`;
}

export function getExistingDocumentProbeSupport(document: Pick<DocumentSnapshot, "languageId">) {
  const style = getCommentStyle(document.languageId);
  if (style) {
    return {
      supported: true as const,
      commentStyle: style,
    };
  }

  return {
    supported: false as const,
    reason: `The active ${document.languageId || "text"} document has no safe probe comment style. Falling back to a scratch document.`,
  };
}

function buildExistingDocumentProbeText(document: DocumentSnapshot, probeLine: string): string {
  const lineEnding = detectLineEnding(document.text);
  const prefix = document.text.length === 0 || document.text.endsWith(lineEnding) ? "" : lineEnding;
  return prefix + joinLines([probeLine, ""], lineEnding);
}

function buildScratchProbeText(): string {
  return joinLines([
    "# Native Apply/Discard probe",
    "",
    "This scratch document verifies whether `WorkspaceEditEntryMetadata.needsConfirmation` surfaces VS Code's native confirmation UI.",
    "",
  ], "\n");
}

function stripUriScheme(uri: string): string {
  return uri.replace(/^[a-z][a-z0-9+.-]*:/i, "");
}

function buildExistingDocumentProbeLine(document: DocumentSnapshot): string {
  const support = getExistingDocumentProbeSupport(document);
  if (!support.supported) {
    throw new Error(support.reason);
  }

  if (support.commentStyle.kind === "block") {
    return `${support.commentStyle.open} opencode-tui-integration probe: native Apply/Discard for ${toProbeDocumentName(document.uri)} ${support.commentStyle.close}`;
  }

  return `${support.commentStyle.prefix} opencode-tui-integration probe: native Apply/Discard for ${toProbeDocumentName(document.uri)}`;
}

function getCommentStyle(languageId: string):
  | { kind: "line"; prefix: string }
  | { kind: "block"; open: string; close: string }
  | undefined {
  if (SLASH_COMMENT_LANGUAGES.has(languageId)) {
    return {
      kind: "line",
      prefix: "//",
    };
  }

  if (HASH_COMMENT_LANGUAGES.has(languageId)) {
    return {
      kind: "line",
      prefix: "#",
    };
  }

  if (MARKUP_COMMENT_LANGUAGES.has(languageId)) {
    return {
      kind: "block",
      open: "<!--",
      close: "-->",
    };
  }

  return undefined;
}

function getAppendPosition(text: string) {
  if (text.length === 0) {
    return {
      line: 0,
      character: 0,
    };
  }

  const lines = text.split(/\r?\n/);
  if (text.endsWith("\n")) {
    return {
      line: lines.length - 1,
      character: 0,
    };
  }

  return {
    line: lines.length - 1,
    character: lines.at(-1)?.length ?? 0,
  };
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function joinLines(lines: string[], lineEnding: "\n" | "\r\n") {
  return lines.join(lineEnding);
}

function toProbeDocumentName(uri: string) {
  return path.posix.basename(stripUriScheme(uri));
}
