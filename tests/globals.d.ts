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
      slotOf(type: string): string;
      entryOn(entry: any): boolean;
      activeMaterial(fx: any[]): any;
      inSlot(fx: any[], slot: string): any[];
    };
    /* The gradient stripe engine. Its panel reads these off the engine rather
     * than repeating them, so the tests assert against the same source. */
    /* The mesh gradient engine. Loaded in tests for its plain-JS half —
     * defaultPoints and the grid limits — while available() reports false,
     * since jsdom has no WebGL2. */
    MeshGradient?: {
      MIN_N: number;
      MAX_N: number;
      defaultPoints(cols: number, rows: number): any[];
      resample(points: any[], fromC: number, fromR: number, toC: number, toR: number): any[];
      evalAt(points: any[], cols: number, rows: number, u: number, v: number): any;
      available(): boolean;
      /* What the DRAW path calls — the cached surface for a box. Declared
       * because a test stubs it to put the material branch in the state jsdom
       * cannot reach on its own. */
      get(w: number, h: number, opts?: any): any;
      /* The per-node channel table. The fragment shader reads this array's
       * ORDER as its channel layout, and the panel and the clamps are both
       * built from it, so it is the definition rather than a copy of one. */
      NODE_FX: { key: string; label: string; def: number }[];
    };
    /* The pixel-slot filter bank. Every pixel effect goes through apply() by
     * name, which is what makes that slot observable under jsdom — the calls
     * are the passes and their order is the stack order. */
    Filters?: {
      apply(type: string, layer: any, params: any): any;
    };
    GradientEngine?: {
      MAX_STOPS: number;
      PRESETS: { name: string; g1: any[]; g2: any[] }[];
      seedFromFill(fill: any): { g1: any[]; g2: any[] };
    };
  }
}
export {};
