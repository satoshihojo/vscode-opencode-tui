declare module "node:sqlite" {
export class StatementSync {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  }

  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean; timeout?: number });
    prepare(query: string): StatementSync;
    exec(query: string): unknown;
    close(): void;
  }
}
