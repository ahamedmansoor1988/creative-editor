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
    /* The effect QA gate. READY is a live Set the tests mutate and restore, so
     * they can assert both halves: hidden while empty, back once promoted. */
    FxStack?: {
      READY: Set<string>;
      isReady(type: string): boolean;
    };
    /* The gradient stripe engine. Its panel reads these off the engine rather
     * than repeating them, so the tests assert against the same source. */
    GradientEngine?: {
      MAX_STOPS: number;
      PRESETS: { name: string; g1: any[]; g2: any[] }[];
      seedFromFill(fill: any): { g1: any[]; g2: any[] };
    };
  }
}
export {};
