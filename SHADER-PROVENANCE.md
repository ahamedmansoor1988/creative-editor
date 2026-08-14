# Shader provenance

Per §0 constraint 4: every shader's origin and license, logged. Nothing here is
sourced from Shadertoy or any non-permissive source.

| File | Shaders | Origin | License status |
|------|---------|--------|----------------|
| public/glass.js | physically-based glass (refraction, Fresnel, frost, dispersion, Beer-Lambert) | ported verbatim from the user's own standalone app (`~/Documents/execution agent/highres-webgl-app.html`), authored for the user | user-owned |
| public/blob.js | SDF metaball field + softmax colour blend; liquid variant reuses glass.js source | written in this repo; SDF formulas are standard published math (Inigo Quilez's public-domain SDF reference formulas re-derived) | original / user-owned |
| public/light.js | funnel light cone | ported from the user's own Funnel Light Figma plugin | user-owned |
| public/prism.js | beam path prepass, volumetric trace, spectral fit | ported from the user's own Glass Prism app (`glass-prism.html`); spectral fit is Zucconi's six-bump approximation to the CIE curves (published blog post, MIT-licensed reference implementation) | user-owned + MIT-attributed technique |
| public/capsule.js | path-traced capsule glass + inner lens; fluted/reeded strip | ported from the user's own Glass Capsule app (`glass-capsule.html`) | user-owned |

All future shaders: derived from published physics (Snell, Fresnel, Cauchy) and
written from first principles. Log them here before merging.
