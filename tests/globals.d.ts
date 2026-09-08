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
      LEGACY_ORDER: string[];
      slotOf(type: string): string;
      isBackdrop(type: string): boolean;
      types(): string[];
      meta(type: string): any;
      label(type: string): string;
      entryOn(entry: any): boolean;
      activeMaterial(fx: any[]): any;
      inSlot(fx: any[], slot: string): any[];
    };
    /* The browsable capability catalog and the (removed) standalone Lens
     * engine. LensEngine is declared only so the removal tests can reference it
     * and assert it is undefined. */
    EngineCatalog?: {
      get(id: string): any;
      ready(): any[];
      status(id: string): string;
      READY: string;
      compatibility(id: string, obj: any): any;
      search(q: string): any[];
      resolve(id: string): any;
      all(): any[];
    };
    LensEngine?: any;
    /* WebGL material engines and the engine picker, referenced by the browser
     * half of the shader tests (they report available()===false under jsdom). */
    GlassEngine?: any;
    GlassObjectEngine?: any;
    __engines?: any;
    /* The MCP editor bridge's console/test hook. */
    __mcp?: { HANDLERS: Record<string, any>; run(cmd: any): void };
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
      /* A whole net curve at once, with the fixed axis collapsed first — the
       * overlay's smoothness at zoom depends on being able to afford hundreds
       * of points per curve. */
      sampleCurve(
        points: any[],
        cols: number,
        rows: number,
        along: string,
        at: number,
        steps: number,
      ): Float32Array;
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
      /* Exported for tests. The distribution of these two IS the correctness
       * of every noise-driven effect, and it cannot be observed through
       * apply() under jsdom, which has no raster to measure. */
      hash2(x: number, y: number, seed: number): number;
      grain3(x: number, y: number, seed: number): number;
      /* Pure-pixel cores exported so tests can measure a single pass directly
       * (halftone coverage, warp/displacement geometry) without a full raster.
       * Loosely typed: the tests pass ImageData-shaped stand-ins. */
      stylizePixels?(...args: any[]): any;
      distortionPixels?(...args: any[]): any;
      warpPixels?(...args: any[]): any;
      displacementPixels?(...args: any[]): any;
      channelFxPixels?(...args: any[]): any;
      colorAdjustPixels?(...args: any[]): any;
      colorMapPixels?(...args: any[]): any;
      ENVELOPES?: any;
    };
    GradientEngine?: {
      MAX_STOPS: number;
      PRESETS: { name: string; g1: any[]; g2: any[] }[];
      seedFromFill(fill: any): { g1: any[]; g2: any[] };
    };
  }
}
export {};
