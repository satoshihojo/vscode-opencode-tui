export type DocumentSnapshot = {
  uri: string;
  fileName: string;
  languageId: string;
  text: string;
};

export type ProposalTarget =
  | {
      kind: "existing";
      uri: string;
    }
  | {
      kind: "scratch";
      uri: string;
      initialText: string;
    };

export type TextPosition = {
  line: number;
  character: number;
};

export type ProposalEdit =
  | {
      kind: "insert";
      position: TextPosition;
      newText: string;
    }
  | {
      kind: "replaceAll";
      newText: string;
    };

export type ProposalConfirmation = {
  needsConfirmation: boolean;
  label: string;
  description?: string;
};

export type NormalizedProposal = {
  target: ProposalTarget;
  edits: ProposalEdit[];
  confirmation: ProposalConfirmation;
};
