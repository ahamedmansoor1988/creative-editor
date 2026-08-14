/* Test-only ambient declarations.
 * public/app.js intentionally exposes a small hook for automation; declare it
 * so the type checker knows about it without app.js itself being typed yet. */
declare global {
  interface Window {
    __editor?: {
      doc: any;
      sel: number;
      render(): void;
      refresh(): void;
    };
  }
}
export {};
