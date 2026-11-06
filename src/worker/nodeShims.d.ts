// The app's tsconfig is browser-only (no @types/node); these are the few Node
// file functions the headless worker uses.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string, encoding: "utf8"): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
}
