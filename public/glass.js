/* Glass engine — WebGL2 bridge for the Canvas2D editor.
 * The fragment shader is carried VERBATIM from the locked standalone glass
 * app (highres-webgl-app.html): real refraction (IOR 1.52), Schlick Fresnel,
 * mip-based frost, per-channel dispersion, Beer-Lambert tint. Controls the
 * editor does not expose are pinned to that app's defaults via uniforms.
 * Pipeline per glass object: the 2D canvas painted SO FAR (everything behind
 * the glass) is uploaded as the backdrop texture, one shader pass renders
 * backdrop+glass full-frame, and the result replaces the canvas content. */
(function(){
"use strict";

const VERTEX = `#version 300 es
      in vec2 position;
      out vec2 uv;
      void main() {
        uv = position * 0.5 + 0.5;
        gl_Position = vec4(position, 0.0, 1.0);
      }`;

const FRAG = `#version 300 es
      precision highp float;
      in vec2 uv;
      out vec4 fragColor;
      uniform sampler2D backdrop;
      uniform vec2 resolution;
      uniform vec2 objectCenter;
      uniform vec2 objectSize;
      uniform float objectRadius;
      uniform float objectShape;
      uniform vec3 fillA;
      uniform vec3 fillB;
      uniform float hasGlass;
      uniform float depth;
      uniform float refraction;
      uniform float frost;
      uniform float reflection;
      uniform float light;
      uniform float edgeMode;
      uniform float edgeGlow;
      uniform float edgeBlur;
      uniform float edgeBlurOffset;
      uniform float flutes;
      uniform float fluteWidth;
      uniform float fluteAngle;
      uniform float fluteMode;
      uniform float fluteCount;
      uniform float fluteRandom;
      uniform float lightAngle;
      uniform float lightElevation;
      uniform float dispersion;
      uniform vec3 tint;
      uniform float opacity;
      uniform float debugView;

      // ------------------------------------------------------------ shape --
      // objectShape: 0 rectangle, 1 circle, 2 pill, 3 triangle.
      float roundedBoxSdf(vec2 p, vec2 halfSize, float radius) {
        vec2 q = abs(p) - halfSize + radius;
        return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
      }

      // A pill/capsule is exactly "distance to the core segment, minus the
      // radius" — same closed form used for the mask AND, undivided by r,
      // for the smooth edge-proximity field below. The segment runs along
      // whichever axis is longer, endpoints inset by r from the full extent.
      vec2 pillSegHalf(vec2 halfSize) {
        float r = min(halfSize.x, halfSize.y);
        return halfSize.x >= halfSize.y ? vec2(max(halfSize.x - r, 0.0), 0.0)
                                         : vec2(0.0, max(halfSize.y - r, 0.0));
      }
      float distToPillCore(vec2 p, vec2 segHalf) {
        vec2 pa = p + segHalf;
        vec2 ba = segHalf * 2.0;
        float denom = dot(ba, ba);
        float h = denom > 0.0 ? clamp(dot(pa, ba) / denom, 0.0, 1.0) : 0.0;
        return length(pa - ba * h);
      }

      // iq's exact signed distance to a triangle (any winding); rounding a
      // convex shape by subtracting r from its own SDF is the same Minkowski
      // trick roundedBoxSdf already relies on.
      float sdTriangle(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
        vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
        vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
        vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
        vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
        vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
        float s = sign(e0.x * e2.y - e0.y * e2.x);
        vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                          vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                          vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
        return -sqrt(d.x) * sign(d.y);
      }

      // Apex-up isosceles triangle inscribed in the object's bounding box.
      // frag pixel space is y-up here (matches objectCenter's convention),
      // so the apex sits at +halfSize.y.
      void triVerts(vec2 halfSize, out vec2 p0, out vec2 p1, out vec2 p2) {
        p0 = vec2(0.0, halfSize.y);
        p1 = vec2(-halfSize.x, -halfSize.y);
        p2 = vec2(halfSize.x, -halfSize.y);
      }

      float objectSdf(vec2 frag) {
        vec2 center = objectCenter * resolution;
        vec2 size = objectSize * resolution;
        vec2 local = frag - center;
        vec2 half_ = size * 0.5;
        if (objectShape < 0.5) {
          return roundedBoxSdf(local, half_, min(size.x, size.y) * objectRadius);
        }
        if (objectShape < 1.5) {
          return length(local) - min(size.x, size.y) * 0.5;
        }
        if (objectShape < 2.5) {
          return distToPillCore(local, pillSegHalf(half_)) - min(half_.x, half_.y);
        }
        vec2 p0, p1, p2;
        triVerts(half_, p0, p1, p2);
        return sdTriangle(local, p0, p1, p2) - min(size.x, size.y) * objectRadius * 0.6;
      }

      float minSizePx() {
        return min(objectSize.x * resolution.x, objectSize.y * resolution.y);
      }

      /* Optical edge length-scale in px. The edge profile is an exponential
         decay — strongest tilt at the silhouette, fading continuously into
         the face with NO ridge boundary. Depth widens that smooth falloff
         (~2% to ~10% of size; the visible influence tails to roughly 2-3x
         this). A hard-stopped band reads as a tray lip; a smooth decay reads
         as thick polished glass. */
      float bevelPx() {
        float d01 = min(abs(depth) / 200.0, 1.0);
        return max(1.5, mix(0.02, 0.10, d01) * minSizePx());
      }

      /* Edge-proximity field for the SURFACE PROFILE and body glow: 0 at the
         centre, 1 at the boundary. A superellipse (radial for the circle) is
         C-infinity everywhere — no corners, no medial axis — so nothing in
         the tilt can ever print a contour, notch, or crease. The exact SDF
         is still used for the mask, rim line, and silhouette taper. */
      /* Returned UNCLAMPED: clamping the field flattens its gradient in the
         corner regions where s > 1, killing tilt direction there. Consumers
         clamp the VALUE where needed; the gradient always reads the raw
         field. */
      float edgeField(vec2 fragPx) {
        vec2 local = fragPx - objectCenter * resolution;
        vec2 half_ = objectSize * resolution * 0.5;
        if (objectShape < 0.5) {
          // Exponent 6: contours follow the rectangle's proportions instead
          // of bulging oval, still smooth everywhere.
          vec2 lp = abs(local) / max(half_, vec2(1.0));
          return pow(pow(lp.x, 6.0) + pow(lp.y, 6.0), 1.0 / 6.0);
        }
        if (objectShape < 1.5) {
          return length(local) / max(min(half_.x, half_.y), 1.0);
        }
        if (objectShape < 2.5) {
          // Exact: unsigned distance to the core segment, divided by the
          // radius — the same closed form as the circle field, generalised
          // to a segment. Smooth everywhere except the single point where
          // distance is 0, same singularity class the circle field already
          // has at its centre.
          float r = min(half_.x, half_.y);
          return distToPillCore(local, pillSegHalf(half_)) / max(r, 1.0);
        }
        // Triangle: a smooth-minimum of the three perpendicular edge
        // distances, normalised by the incircle radius. An earlier version
        // used a cubic bump in barycentric coordinates (0 at the centroid, 1
        // on every edge/vertex) — C-infinity, so it fixed the crease this
        // field exists to avoid, but its transition rate is highly
        // NON-UNIFORM: slow near vertices, fast near mid-edge. A fixed-width
        // band built on it (Edge Blur, rimFeather) came out as a thin line
        // along the edges and fat separate blobs at the corners — smooth,
        // but not uniform, which reads as "hard"/uneven at a glance. softmin
        // of the true (signed, per-edge) distances is both smooth (no
        // min()-kink, unlike the exact SDF) AND close to uniform-width
        // (unlike the cubic bump), because it converges toward the true
        // metric distance everywhere except a narrow, deliberately smoothed
        // band straddling the medial axis.
        vec2 p0, p1, p2;
        triVerts(half_, p0, p1, p2);
        vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
        float wind = sign(e0.x * e2.y - e0.y * e2.x);
        float d0 = wind * dot(local - p0, vec2(e0.y, -e0.x)) / length(e0);
        float d1 = wind * dot(local - p1, vec2(e1.y, -e1.x)) / length(e1);
        float d2 = wind * dot(local - p2, vec2(e2.y, -e2.x)) / length(e2);
        float k = 26.0 / max(minSizePx(), 1.0);
        float dc0 = clamp(d0, -2.0 * minSizePx(), 2.0 * minSizePx());
        float dc1 = clamp(d1, -2.0 * minSizePx(), 2.0 * minSizePx());
        float dc2 = clamp(d2, -2.0 * minSizePx(), 2.0 * minSizePx());
        // log(3)/k bias-corrects softmin-of-3-equal-values back to the true
        // value, so the field lands at 0 exactly at the incircle centre.
        float dSoft = -log(exp(-k * dc0) + exp(-k * dc1) + exp(-k * dc2)) / k + log(3.0) / k;
        // objectSdf's mask is sdTriangle(sharp) - rTri: like roundedBoxSdf,
        // subtracting a radius from an exact SDF DILATES the shape outward
        // (this is how both rect's and the triangle's corner rounding is
        // built), so the true rendered boundary sits rTri OUTSIDE the sharp
        // triangle's edges, not on them. dSoft is ~0 at the sharp edge, so at
        // the true (dilated) boundary it reads ~ -rTri, not 0 — the field
        // never reached its max there, leaving an under-tilted (too-flat,
        // visibly blue/purple) ring right at the edge. Adding rTri re-zeros
        // the field to the ACTUAL rendered edge instead of the sharp
        // geometry underneath it.
        float rTri = 2.0 * min(half_.x, half_.y) * objectRadius * 0.6;
        float dSoftRounded = dSoft + rTri;
        float sideSlant = length(vec2(half_.x, 2.0 * half_.y));
        float inradius = (2.0 * half_.x * half_.y) / max(half_.x + sideSlant, 1.0);
        float refScale = max(inradius + rTri, 1.0);
        return 1.0 - clamp(dSoftRounded / refScale, 0.0, 1.0);
      }

      vec3 objectFill(vec2 p) {
        vec2 local = (p - objectCenter) / objectSize + 0.5;
        float g = clamp(local.x * 0.78 + local.y * 0.28, 0.0, 1.0);
        return mix(fillA, fillB, g);
      }

      // ------------------------------------------------------------ color --
      vec3 toLin(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }
      vec3 toSrgb(vec3 c) { return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2)); }

      vec3 tapBackdrop(vec2 fragPx, float lod) {
        vec2 c = clamp(fragPx / resolution, vec2(0.001), vec2(0.999));
        return toLin(textureLod(backdrop, c, lod).rgb);
      }

      /* Rough transmission: mip LOD plus a small rotated-grid gather so frost
         stays smooth instead of blocky trilinear. */
      vec3 frosted(vec2 fragPx, float lod, float frostPx) {
        vec3 c = tapBackdrop(fragPx, lod);
        if (frostPx > 0.5) {
          float r = frostPx * 0.55;
          c += tapBackdrop(fragPx + vec2( r,  r * 0.35), lod);
          c += tapBackdrop(fragPx + vec2(-r * 0.35,  r), lod);
          c += tapBackdrop(fragPx + vec2(-r, -r * 0.35), lod);
          c += tapBackdrop(fragPx + vec2( r * 0.35, -r), lod);
          c /= 5.0;
        }
        return c;
      }

      /* Screen-space refracted sample offset from the real transmitted ray.
         Length-capped, and tapered to zero across the outermost ~1.5px so
         silhouette pixels never fetch arbitrary far content. */
      vec2 refrOffset(vec3 n, float eta, float refractPx, float maxOff, float dPx) {
        vec3 T = refract(vec3(0.0, 0.0, -1.0), n, eta);
        vec2 v = T.xy / max(-T.z, 0.06);
        // Saturate the ray ratio: near the rim it grows so steeply that the
        // pixel->sample mapping's magnification explodes, smearing whatever
        // sits behind the bevel into a structureless halo band. Bounded, the
        // edge still bends hard but the refracted image keeps its structure.
        vec2 o = v / (1.0 + 0.45 * length(v)) * refractPx;
        float l = length(o);
        return o * min(1.0, maxOff / max(l, 1e-3)) * smoothstep(0.0, 1.5, dPx);
      }

      // 1D hash for Flute Random — deterministic per rib index, no seams
      // (same family as the output dither hash below, different domain).
      float hash11(float p) {
        p = fract(p * 0.1031);
        p *= p + 33.33;
        p *= p + p;
        return fract(p);
      }

      void main() {
        vec2 frag = uv * resolution;
        vec3 baseS = texture(backdrop, uv).rgb;
        float sd = objectSdf(frag);
        float mask = smoothstep(1.2, -1.2, sd);
        float hardMask = step(sd, 0.0);
        float d = max(-sd, 0.0);                     // px inside the shape
        float moveAngle = radians(lightAngle);
        float depthSigned = clamp(depth / 200.0, -1.0, 1.0);
        float depthSign = depthSigned < 0.0 ? -1.0 : 1.0;

        /* ---- surface: power ramp of the edge field ----------------------- */
        // tilt = sEdge^k has a monotonically decaying gradient toward the
        // centre — there is no shoulder, so no contour can form anywhere.
        // Depth lowers the exponent: the edge influence reaches further in
        // and merges smoothly. The field has no corners or medial axis, so
        // corner notches and diagonal creases are impossible by construction.
        float B = bevelPx();
        float depth01k = abs(depthSigned);
        // High exponents keep the GEOMETRY flat across the face (the
        // reference's normal map is one shade almost everywhere) — the wide
        // smooth face gradient is light (glow + sheen), not curvature.
        float sEdge = min(edgeField(frag), 1.0);
        float kPow = mix(24.0, 4.5, depth01k);
        float tilt = pow(sEdge, kPow);
        float h = 1.0 - tilt;                        // ~1 across the body

        vec2 e = vec2(1.2, 0.0);
        vec2 g = vec2(
          edgeField(frag + e.xy) - edgeField(frag - e.xy),
          edgeField(frag + e.yx) - edgeField(frag - e.yx)
        );
        vec2 outward = g / max(length(g), 1e-5);
        float normalK = 0.55 + 0.85 * depth01k;
        vec3 n = normalize(vec3(outward * tilt * 6.4 * normalK * depthSign, 1.0));

        // Flutes: fluted/reeded glass — a repeating row of thin semicircular
        // ridges (a real pressed-glass pattern) that each bend light
        // sideways by a different amount, producing the classic wavy
        // banding. Blended into the SHADING normal only — outward (the
        // silhouette-relative direction used for the rim's arc bias) is left
        // untouched — so refraction, Fresnel, reflection, rim and glow all
        // pick up the ribbing automatically, consistently, because every one
        // of them already derives from n.
        //
        // Flute Angle rotates which direction the ribs run: the ridge
        // PROFILE varies along the axis at fluteAngle (0 = ribs vary along
        // local x, i.e. vertical ribs; 90 = vary along y, horizontal ribs),
        // and the resulting tilt is applied along that same axis, so the
        // ridges always bend light perpendicular to their own length,
        // exactly like a real corrugated sheet at any orientation.
        if (flutes > 0.5) {
          float flutes01 = flutes / 100.0;
          vec2 fluteLocal = frag - objectCenter * resolution;
          // By Width: fluteWidth is a direct px spacing (rib count changes
          // as the object resizes). By Count: the spacing is DERIVED from
          // the object's own size so a fixed number of ribs always fits
          // across it, regardless of size.
          float ribW = fluteMode > 0.5
            ? max(minSizePx() / max(fluteCount, 1.0), 2.0)
            : max(fluteWidth, 2.0);
          float fa = radians(fluteAngle);
          vec2 ribAxis = vec2(cos(fa), sin(fa));
          float axisCoord = dot(fluteLocal, ribAxis);

          float ribX;
          if (fluteRandom > 0.5) {
            // Real fluted glass is pressed, not machine-perfect: each rib
            // gets its own pseudo-random width. Grid lines at every integer
            // rib index are displaced by up to ~45% of a rib width (hashed
            // per index, so it's deterministic and seam-free — the same
            // boundary is computed identically from both sides), which
            // makes adjacent ribs land at genuinely different widths. A
            // small fixed window around the naive index guarantees the
            // true containing pair is found even after displacement.
            float jitterAmt = clamp(fluteRandom / 100.0, 0.0, 1.0) * 0.45;
            float i0 = floor(axisCoord / ribW);
            float bestLo = (i0 + (hash11(i0) - 0.5) * 2.0 * jitterAmt) * ribW;
            float bestHi = (i0 + 1.0 + (hash11(i0 + 1.0) - 0.5) * 2.0 * jitterAmt) * ribW;
            for (int k = -2; k <= 2; k++) {
              float ia = i0 + float(k);
              float pa = (ia + (hash11(ia) - 0.5) * 2.0 * jitterAmt) * ribW;
              float pb = (ia + 1.0 + (hash11(ia + 1.0) - 0.5) * 2.0 * jitterAmt) * ribW;
              if (axisCoord >= pa && axisCoord < pb) { bestLo = pa; bestHi = pb; }
            }
            float ribWidthLocal = max(bestHi - bestLo, 1.0);
            ribX = ((axisCoord - bestLo) / ribWidthLocal) * 2.0 - 1.0;
          } else {
            ribX = fract(axisCoord / ribW) * 2.0 - 1.0;
          }

          float ribH = sqrt(max(1.0 - ribX * ribX, 0.0));
          float ribSlope = -ribX / max(ribH, 0.12);
          n = normalize(n + vec3(ribAxis * ribSlope * flutes01 * 0.9, 0.0));
        }

        if (debugView > 0.5 && debugView < 1.5) {
          fragColor = vec4(vec3(hardMask), 1.0);
          return;
        }
        if (debugView > 1.5 && debugView < 2.5) {
          fragColor = vec4(vec3(h) * hardMask, 1.0);
          return;
        }
        if (debugView > 2.5 && debugView < 3.5) {
          fragColor = vec4(mix(vec3(0.0), n * 0.5 + 0.5, hardMask), 1.0);
          return;
        }

        /* ---- dielectric response ---------------------------------------- */
        float reflection01 = reflection / 100.0;
        float light01 = light / 100.0;
        float frost01 = frost / 100.0;
        float edgeLight01 = light01;

        // Schlick Fresnel at IOR 1.52: ~4% head-on, rising at the tilted rim.
        float cosV = clamp(n.z, 0.0, 1.0);
        float F = 0.04 + 0.96 * pow(1.0 - cosV, 5.0);

        // Neutral vertical environment sampled by the reflected ray.
        vec3 R = vec3(2.0 * n.z * n.x, 2.0 * n.z * n.y, 2.0 * n.z * n.z - 1.0);
        float env = mix(0.50, 1.30, smoothstep(-0.7, 0.9, R.y));
        vec3 refl = vec3(env) * F * reflection01 * 0.42;

        // Edge-light direction. The point-glint specular (GGX) is retired:
        // the material's lighting is the rim arc + glow + sheen, all driven
        // by Edge Light / Edge Angle.
        float elev = radians(lightElevation);
        vec3 L = normalize(vec3(cos(moveAngle) * cos(elev), sin(moveAngle) * cos(elev), sin(elev)));

        /* ---- rim: light caught in the slab's polished edge --------------- */
        // The signature of sheet glass: a thin bright line at the silhouette
        // whose intensity arcs around the shape with the light (bright facing
        // the light, a weaker counter-arc opposite), plus a fainter second
        // line where the edge meets the face. Derived from the edge direction
        // and light — not painted at fixed positions.
        // One line only: the reference shows a single crisp edge with the
        // face merging into it seamlessly — an inner second line reads as a
        // tray lip, so there is none.
        float d01p = abs(depthSigned);
        float presence = smoothstep(0.0, 0.30, d01p) * (0.45 + 0.55 * d01p);
        float facing = dot(outward, normalize(L.xy + vec2(1e-4)));
        float arcDirectional = pow(max(facing, 0.0), 2.0) + 0.22 * pow(max(-facing, 0.0), 3.0);
        float arc = mix(arcDirectional, 1.0, clamp(edgeMode, 0.0, 1.0));
        float r1a = 0.65 + min(B * 0.055, 1.25);
        float rimWidthPx = mix(0.75, 1.85, d01p);
        float rim1 = smoothstep(0.0, 0.85, d) * (1.0 - smoothstep(r1a, r1a + rimWidthPx, d));
        // Built from sEdge (the kneeless field), NOT d (the exact SDF): d's
        // gradient genuinely kinks along a polygon's internal bisectors
        // (the Voronoi split between edges), invisible in d's own VALUE but
        // printed straight into any WIDE band as a Mach-band crease once
        // that value drives a spatially-varying product — exactly what a
        // triangle's sharper vertex angles exposed (rect's ~45-degree
        // diagonal kink was mild enough to pass unnoticed; a triangle's
        // up-to-120-degree bisector swing was not). sEdge has no such kink
        // on any shape by construction, so this stays seam-free everywhere.
        float rimFeather = smoothstep(0.68, 0.965, sEdge);
        vec3 rimC = vec3(0.86, 0.97, 1.0) * rim1 * presence
          * (0.10 * reflection01 + (0.20 + 0.95 * arc) * edgeLight01);

        /* ---- edge glow: independent, user-positioned halo ----------------- */
        // A separate band from the rim/body-glow above — its own intensity
        // (Edge Glow), spread (Edge Blur), and radial position (Edge Blur
        // Offset, in units of the blur width itself: 0 sits centred on the
        // true boundary, higher values slide it inward). Built from the
        // exact SDF interior distance d — a plain scalar fed into a
        // Gaussian, so unlike a gradient/normal it is unaffected by any
        // medial-axis kink the mask's own SDF has at corners.
        // Same fix as rimFeather above: built from sEdge, not the exact
        // distance d, so the band stays seam-free on straight-edged shapes.
        // Edge Blur / Edge Blur Offset are expressed in sEdge units (0..1,
        // shape-relative) instead of raw px — width and inward offset both
        // scale naturally with object size as a result.
        float eg01 = edgeGlow / 100.0;
        float eb01 = edgeBlur / 100.0;
        float ebo01 = edgeBlurOffset / 100.0;
        float blurW = mix(0.008, 0.55, eb01 * eb01);
        float offsetW = ebo01 * blurW * 1.6;
        float distFromPeakS = (1.0 - sEdge) - offsetW;
        float edgeGlowBand = exp(-(distFromPeakS * distFromPeakS) / max(2.0 * blurW * blurW, 0.0004));
        // Capped well short of 1.0: every other light layer in this material
        // (refl, glowC, rimC) is pre-scaled down for the same reason — an
        // additive term that can reach full white saturates into a solid
        // painted stroke, exactly the "white outline pretending to be
        // Fresnel" failure this material is built to avoid. Edge Glow should
        // stay a soft, translucent halo at every slider value, never opaque.
        vec3 edgeGlowC = vec3(0.90, 0.97, 1.02) * edgeGlowBand * eg01 * 0.32 * (0.5 + 0.5 * presence);

        /* ---- body glow: edge light scattering through the slab ----------- */
        // In real sheet glass the light caught at the edge bleeds deep into
        // the body, merging in the centre at full depth. The falloff must be
        // seamless — the distance field's gradient flips across the diagonals
        // and would print an X into a wide gradient — so edge proximity comes
        // from a superellipse field instead: smooth everywhere by
        // construction. Dithered at output, it cannot band or pixelate.
        vec2 glocal = frag - objectCenter * resolution;
        // Power ramp, not exponential: an exponential has an inflection knee
        // and the eye finds it as a ghost contour tracing the field's shape.
        // A power of the field is kneeless — same cure as the normals.
        float gPow = mix(9.0, 2.6, d01p);
        float glow = pow(sEdge, gPow);
        // Direction for the glow's light bias must be smooth across the whole
        // body — the nearest-edge direction flips across the diagonals and
        // prints an X into the gradient. Radial direction is seamless; it is
        // blended to neutral at the very centre where it is undefined.
        vec2 gdir = glocal / max(length(glocal), 1e-3);
        float gFacing = dot(gdir, normalize(L.xy + vec2(1e-4)));
        float arcSoft = pow(max(gFacing, 0.0), 1.2) + 0.45 * pow(max(-gFacing, 0.0), 1.4);
        arcSoft = mix(0.5, arcSoft, smoothstep(0.05, 0.30, sEdge));
        // Kept faint: a strong concentric falloff prints an inner-shape ring
        // on the face. The dominant face gradient is the LINEAR sheen below —
        // the reference tiles carry one diagonal wash, no concentric shape.
        vec3 glowC = vec3(0.72, 0.90, 1.0) * glow * rimFeather * presence
          * (0.35 + 0.65 * arcSoft)
          * (0.004 * reflection01 + 0.010 * edgeLight01);

        // Face sheen: a broad linear luminance sweep across the whole face in
        // the light direction — the soft diagonal wash lit glass panels carry.
        // A pure linear gradient: seam-free by definition.
        float sweep = dot(glocal / max(minSizePx(), 1.0), normalize(L.xy + vec2(1e-4)));
        float sheen = smoothstep(-0.62, 0.62, sweep);
        vec3 sheenC = vec3(0.76, 0.91, 1.05) * sheen * edgeLight01 * 0.012 * (0.35 + 0.65 * presence);

        if (debugView > 3.5) {
          fragColor = vec4(toSrgb(refl + glowC + sheenC + rimC + edgeGlowC) * hardMask, 1.0);
          return;
        }

        if (mask <= 0.0001) {
          fragColor = vec4(baseS, 1.0);
          return;
        }

        if (hasGlass < 0.5) {
          fragColor = vec4(mix(baseS, objectFill(uv), mask), 1.0);
          return;
        }

        /* ---- transmission ------------------------------------------------ */
        float refractionSigned = clamp(refraction / 200.0, -1.0, 1.0);
        float refraction01 = abs(refractionSigned);
        float disp01 = dispersion / 100.0;
        float op01 = opacity / 100.0;

        // The extended +/-200 range allows offsets past the naive fold-over
        // threshold; refrOffset's ray-ratio saturation is what keeps the
        // pixel->sample mapping coherent (no mirrored duplicates) up there.
        float refractPx = sign(refractionSigned) * pow(refraction01, 1.1) * B * 1.8;
        float maxOff = abs(refractPx) * 1.5 + 2.0;
        float frostPx = pow(frost01, 1.5) * 0.12 * minSizePx();
        float maxLod = floor(log2(max(resolution.x, resolution.y)));
        float lodBase = frostPx > 0.5 ? clamp(log2(frostPx), 0.0, maxLod) : 0.0;
        float eta = 1.0 / 1.52;

        vec3 trans;
        if (disp01 > 0.001) {
          // Wavelength-dependent eta: blue bends more than red. Rescaled to
          // the bounded offset range so max Dispersion separates channels by
          // a clearly visible few px at refracted edges.
          float spread = disp01 * 0.09;
          vec2 oR = refrOffset(n, eta * (1.0 + spread), refractPx, maxOff, d);
          vec2 oG = refrOffset(n, eta, refractPx, maxOff, d);
          vec2 oB = refrOffset(n, eta * (1.0 - spread), refractPx, maxOff, d);
          float tl = clamp(lodBase + log2(1.0 + length(oG) * 0.012), 0.0, maxLod);
          trans = vec3(
            frosted(frag + oR, tl, frostPx).r,
            frosted(frag + oG, tl, frostPx).g,
            frosted(frag + oB, tl, frostPx).b
          );
        } else {
          vec2 o = refrOffset(n, eta, refractPx, maxOff, d);
          // Travel blur: light displaced far through thick glass never lands
          // pixel-sharp; also keeps extreme settings free of edge dither.
          float tl = clamp(lodBase + log2(1.0 + length(o) * 0.012), 0.0, maxLod);
          trans = frosted(frag + o, tl, frostPx);
        }

        // Beer-Lambert tint over the optical path (longer through the edge).
        // White tint stays neutral across the face; a whisper of intrinsic
        // absorption (strongest in red, like soda-lime glass) darkens the
        // edge-on path and gives the rim its faint teal — scaled by Depth.
        vec3 tintLin = toLin(tint);
        vec3 absorb = -log(clamp(tintLin, vec3(0.02), vec3(1.0)));
        vec3 edgeAbsorb = vec3(0.040, 0.018, 0.010) * d01p;
        float path = 0.35 + 1.15 * (1.0 - h);
        trans *= exp(-(absorb + edgeAbsorb) * path);

        /* ---- opacity + composite ---------------------------------------- */
        // Lower opacity lightens BOTH the transmitted backdrop (toward a
        // milky body) and the reflections — per the material spec sheet.
        vec3 milk = tintLin * 0.92;
        vec3 body = mix(milk, trans, op01);

        float fade = mix(0.3, 1.0, op01);
        vec3 glassLin = body * (1.0 - F * 0.48) + (refl + glowC + sheenC + rimC + edgeGlowC) * fade;

        vec3 outLin = mix(toLin(baseS), glassLin, mask);
        // Ordered dither: slow, wide gradients (the body glow) would band on
        // an 8-bit target without it.
        float dith = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
        fragColor = vec4(toSrgb(outLin) + vec3((dith - 0.5) / 255.0), 1.0);
      }`;

let gl=null, glCanvas=null, prog=null, loc=null, tex=null, vao=null;
let failed=false;

function init(){
  if(gl||failed) return !failed;
  try{
    glCanvas=document.createElement('canvas');
    gl=glCanvas.getContext('webgl2',{premultipliedAlpha:false,antialias:false});
    if(!gl) throw new Error('WebGL2 unavailable');
    const compile=(type,s)=>{
      const sh=gl.createShader(type);
      gl.shaderSource(sh,s); gl.compileShader(sh);
      if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    };
    prog=gl.createProgram();
    gl.attachShader(prog,compile(gl.VERTEX_SHADER,VERTEX));
    gl.attachShader(prog,compile(gl.FRAGMENT_SHADER,FRAG));
    gl.linkProgram(prog);
    if(!gl.getProgramParameter(prog,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    const names=['backdrop','resolution','objectCenter','objectSize','objectRadius','objectShape',
      'fillA','fillB','hasGlass','depth','refraction','frost','reflection','light','edgeMode',
      'edgeGlow','edgeBlur','edgeBlurOffset','flutes','fluteWidth','fluteAngle','fluteMode',
      'fluteCount','fluteRandom','lightAngle','lightElevation','dispersion','tint','opacity','debugView'];
    loc={position:gl.getAttribLocation(prog,'position')};
    names.forEach(n=>loc[n]=gl.getUniformLocation(prog,n));
    const buf=gl.createBuffer();
    vao=gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER,buf);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1, 3,-1, -1,3]),gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc.position);
    gl.vertexAttribPointer(loc.position,2,gl.FLOAT,false,0,0);
    tex=gl.createTexture();
    return true;
  }catch(e){
    console.warn('glass engine disabled:',e.message);
    failed=true; gl=null;
    return false;
  }
}

const hexToRgb01=h=>{
  const n=parseInt((h||'#ffffff').slice(1),16);
  return [((n>>16)&255)/255,((n>>8)&255)/255,(n&255)/255];
};

/* One glass pass over the current frame canvas.
 * geoms: [{cx,cy,w,h,shape:0|1|2,radius01}] in FRAME px (cy is y-DOWN,
 * canvas convention — flipped internally). params: the Glass engine values. */
function render(frameCanvas, W, H, geoms, P){
  if(!init()) return null;
  glCanvas.width=W; glCanvas.height=H;
  gl.viewport(0,0,W,H);
  gl.useProgram(prog);
  gl.bindVertexArray(vao);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D,tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,frameCanvas);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.uniform1i(loc.backdrop,0);
  gl.uniform2f(loc.resolution,W,H);

  // pinned to the locked app's defaults for controls the editor hides
  gl.uniform3f(loc.fillA,0.9,0.9,0.9);
  gl.uniform3f(loc.fillB,0.7,0.7,0.7);
  gl.uniform1f(loc.hasGlass,1);
  gl.uniform1f(loc.edgeMode,0);
  gl.uniform1f(loc.edgeGlow,P.edgeGlow!==undefined?P.edgeGlow:0);
  gl.uniform1f(loc.edgeBlur,20);
  gl.uniform1f(loc.edgeBlurOffset,0);
  gl.uniform1f(loc.flutes,P.flutes||0);
  gl.uniform1f(loc.fluteWidth,26);
  gl.uniform1f(loc.fluteAngle,0);
  gl.uniform1f(loc.fluteMode,0);
  gl.uniform1f(loc.fluteCount,10);
  gl.uniform1f(loc.fluteRandom,0);
  gl.uniform1f(loc.lightAngle,45);
  gl.uniform1f(loc.lightElevation,30);
  gl.uniform1f(loc.debugView,0);

  gl.uniform1f(loc.depth,P.depth);
  gl.uniform1f(loc.refraction,P.refraction);
  gl.uniform1f(loc.frost,P.frost);
  gl.uniform1f(loc.reflection,P.reflection);
  gl.uniform1f(loc.light,P.light);
  gl.uniform1f(loc.dispersion,P.dispersion);
  const t=hexToRgb01(P.tint);
  gl.uniform3f(loc.tint,t[0],t[1],t[2]);
  gl.uniform1f(loc.opacity,P.opacity);

  // Sequential passes share ONE backdrop upload: siblings sit on the same
  // z-plane so each pass legitimately refracts the same content. Where two
  // glass instances overlap, the later pass wins (documented limitation).
  const ctx2d=frameCanvas.getContext('2d');
  geoms.forEach((g,i)=>{
    if(i>0){
      // subsequent passes need the previous pass composited in
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,frameCanvas);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    gl.uniform2f(loc.objectCenter, g.cx/W, 1-(g.cy/H));
    gl.uniform2f(loc.objectSize, g.w/W, g.h/H);
    gl.uniform1f(loc.objectRadius, g.radius01);
    gl.uniform1f(loc.objectShape, g.shape);
    gl.drawArrays(gl.TRIANGLES,0,3);
    ctx2d.save();
    ctx2d.setTransform(1,0,0,1,0,0);
    ctx2d.globalAlpha=1;
    ctx2d.globalCompositeOperation='source-over';
    ctx2d.drawImage(glCanvas,0,0,W,H);
    ctx2d.restore();
  });
  return true;
}

window.GlassEngine={render, available:()=>init()};
})();
