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
    };
    /* The spectral field engine. Loaded in tests for its plain-JS half — the
     * settings model and its clamps — while available() reports false, since
     * jsdom has no WebGL2. */
    /* The spectral field engine. Its numerical half — the distance
     * transform, the boundary trace and the solver — is exported so it can be
     * tested on masks built by hand: jsdom has no rasteriser, and those are
     * where the architecture actually lives. */
    SpectralField?: {
      STOP_LIMIT: number;
      DEBUG_VIEWS: string[];
      DEFAULTS(): any;
      DEFAULT_STOPS(): any[];
      normalize(s: any): any;
      available(): boolean;
      render(w: number, h: number, s: any, opts?: any): any;
      get(w: number, h: number, s: any, opts?: any): any;
      stopHandle(stop: any, s: any, opts: any, w: number, h: number): any;
      sFromPoint(x: number, y: number, s: any, opts: any, w: number, h: number): number;
      hexToLinear(hex: string): number[];
      linearToHex(lin: number[]): string;
      srgbToLinear(c: number): number;
      linearToSrgb(c: number): number;
      rasterMask(drawPath: any, w: number, h: number): Float32Array;
      distanceInside(mask: Float32Array, w: number, h: number): Float32Array;
      traceBoundary(mask: Float32Array, w: number, h: number): number[][];
      arcLength(pts: number[][]): { s: Float32Array; total: number };
      solveHarmonic(
        mask: Float32Array,
        bnd: Float32Array,
        w: number,
        h: number,
        sweeps: number,
      ): Float32Array;
      solveSize(w: number, h: number): number[];
    };
    GradientEngine?: {
      MAX_STOPS: number;
      PRESETS: { name: string; g1: any[]; g2: any[] }[];
      seedFromFill(fill: any): { g1: any[]; g2: any[] };
    };
  }
}
export {};
