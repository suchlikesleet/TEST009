import * as THREE from 'three';

// Wave layers: [dirX, dirZ, frequency, speed, amplitude].
// Shared between the GPU shader and the CPU so the boat floats on the same surface you see.
const WAVES = [
  [1.0, 0.2, 0.16, 1.1, 0.32],
  [-0.3, 1.0, 0.22, 0.9, 0.22],
  [0.7, 0.7, 0.41, 1.9, 0.09],
  [-0.8, 0.5, 0.63, 2.6, 0.05],
];

// Rolling swells: occasional tall ridges with whitecaps that sweep across the sea.
// They are the only waves that can launch the boat, so you can see a jump coming.
export const ROLLER = {
  dir: [0.0, 1.0], // travel direction: toward the camera, so crests run left-right on screen
  perp: [1.0, 0.0],
  k: (Math.PI * 2) / 38, // ~38 units between ridges
  speed: 1.5, // phase speed (rad/s) -> ridges move ~13 units/s
  amp: 1.15,
  sharp: 22, // higher = narrower ridge (~6 units wide)
};

const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };

/** 0..1 strength of the rolling swell at a point (1 = on a crest). */
export function rollerAt(x, z, t) {
  const R = ROLLER;
  const across = x * R.perp[0] + z * R.perp[1];
  // Bend the ridges so they curve like real swells instead of ruler-straight lines.
  const along = x * R.dir[0] + z * R.dir[1] + Math.sin(across * 0.07) * 3.5 + Math.sin(across * 0.023 + 1.7) * 6.0;
  const ridge = Math.pow(0.5 + 0.5 * Math.sin(along * R.k - t * R.speed), R.sharp);
  // Break each ridge into segments so they read as separate swells, not endless lines.
  const seg = 0.5 + 0.5 * Math.sin(across * 0.06 + Math.sin(along * 0.013) * 3.0);
  return ridge * smooth(0.12, 0.4, seg);
}

export function waveHeight(x, z, t) {
  let h = 0;
  for (const [dx, dz, f, s, a] of WAVES) {
    h += Math.sin((x * dx + z * dz) * f + t * s) * a;
  }
  return h + rollerAt(x, z, t) * ROLLER.amp;
}

/** Shared clock for every shader that animates with the water (caustics). */
export const waterTime = { value: 0 };

// Layer used for things that must NOT appear in the "under the water" pass
// (the water itself, foam particles, UI-ish markers).
export const SURFACE_LAYER = 1;

// ---------------------------------------------------------------------------
// Caustics: dancing light on anything below the surface (seabed, rocks, hulls).
// ---------------------------------------------------------------------------
const causticsGLSL = /* glsl */ `
  uniform float uWaterTime;
  varying vec3 vCWorld;
  // Tileable caustic pattern (after Dave Hoskins' "Tileable Water Caustic").
  float caustic(vec2 p, float t) {
    vec2 q = mod(p * 0.22, 6.28318) - 250.0;
    vec2 i = q;
    float c = 1.0;
    const float inten = 0.005;
    for (int n = 0; n < 3; n++) {
      float tt = t * 0.45 * (1.0 - (3.5 / float(n + 1)));
      i = q + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
      c += 1.0 / length(vec2(q.x / (sin(i.x + tt) / inten), q.y / (cos(i.y + tt) / inten)));
    }
    c /= 3.0;
    c = 1.17 - pow(c, 1.4);
    return pow(abs(c), 8.0);
  }
`;

export function withCaustics(material, strength = 0.55) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWaterTime = waterTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCWorld;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec4 cWorld = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          cWorld = instanceMatrix * cWorld;
        #endif
        vCWorld = (modelMatrix * cWorld).xyz;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${causticsGLSL}`)
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        float cDepth = smoothstep(0.05, -0.7, vCWorld.y) * exp(vCWorld.y * 0.13);
        float cLine = smoothstep(0.28, 0.4, caustic(vCWorld.xz, uWaterTime));
        gl_FragColor.rgb += vec3(0.8, 1.0, 1.0) * cLine * cDepth * ${strength.toFixed(2)};`
      );
  };
  material.customProgramCacheKey = () => `caustics-${strength}`;
  return material;
}

// ---------------------------------------------------------------------------
// Water surface
// ---------------------------------------------------------------------------
const glslWaves = WAVES.map(
  ([dx, dz, f, s, a]) =>
    `h += sin(dot(p, vec2(${dx.toFixed(3)}, ${dz.toFixed(3)})) * ${f.toFixed(3)} + t * ${s.toFixed(3)}) * ${a.toFixed(3)};`
).join('\n    ');

const vertexShader = /* glsl */ `
  uniform float uTime;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vHeight;

  float rollerAt(vec2 p, float t) {
    float across = dot(p, vec2(${ROLLER.perp[0].toFixed(3)}, ${ROLLER.perp[1].toFixed(3)}));
    float along = dot(p, vec2(${ROLLER.dir[0].toFixed(3)}, ${ROLLER.dir[1].toFixed(3)})) + sin(across * 0.07) * 3.5 + sin(across * 0.023 + 1.7) * 6.0;
    float ridge = pow(0.5 + 0.5 * sin(along * ${ROLLER.k.toFixed(5)} - t * ${ROLLER.speed.toFixed(3)}), ${ROLLER.sharp.toFixed(1)});
    float seg = 0.5 + 0.5 * sin(across * 0.06 + sin(along * 0.013) * 3.0);
    return ridge * smoothstep(0.12, 0.4, seg);
  }

  float waveH(vec2 p, float t) {
    float h = 0.0;
    ${glslWaves}
    return h + rollerAt(p, t) * ${ROLLER.amp.toFixed(3)};
  }

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    float h = waveH(wp.xz, uTime);
    float e = 0.3;
    float hx = waveH(wp.xz + vec2(e, 0.0), uTime);
    float hz = waveH(wp.xz + vec2(0.0, e), uTime);
    vNormal = normalize(vec3(h - hx, e, h - hz));
    wp.y += h;
    vHeight = h;
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragmentShader = /* glsl */ `
  #include <common>
  #include <packing>

  uniform float uTime;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uBand0;
  uniform vec3 uBand1;
  uniform vec3 uSky;
  uniform vec3 uSunDir;
  uniform vec3 uCamPos;
  uniform sampler2D uSceneColor;
  uniform sampler2D uSceneDepth;
  uniform vec2 uResolution;
  uniform float uNear;
  uniform float uFar;

  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vHeight;

  float rollerAt(vec2 p, float t) {
    float across = dot(p, vec2(${ROLLER.perp[0].toFixed(3)}, ${ROLLER.perp[1].toFixed(3)}));
    float along = dot(p, vec2(${ROLLER.dir[0].toFixed(3)}, ${ROLLER.dir[1].toFixed(3)})) + sin(across * 0.07) * 3.5 + sin(across * 0.023 + 1.7) * 6.0;
    float ridge = pow(0.5 + 0.5 * sin(along * ${ROLLER.k.toFixed(5)} - t * ${ROLLER.speed.toFixed(3)}), ${ROLLER.sharp.toFixed(1)});
    float seg = 0.5 + 0.5 * sin(across * 0.06 + sin(along * 0.013) * 3.0);
    return ridge * smoothstep(0.12, 0.4, seg);
  }

  float viewZ(float depth) { return perspectiveDepthToViewZ(depth, uNear, uFar); }

  // Anti-aliased hard step: crisp cartoon edges without jaggies.
  float aastep(float threshold, float x) {
    float w = max(fwidth(x) * 0.75, 1e-4);
    return smoothstep(threshold - w, threshold + w, x);
  }

  // Sine-free hash (stable at large world coordinates).
  float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // Stylized wave stroke (like a hand-drawn ﹏ line): rounded troughs joined at sharp,
  // pointed crests. Laid out in rows across the wind, broken into short segments that
  // drift downwind. Returns the stroke mask; 'body' is a soft fill just under the stroke.
  float waveStroke(vec2 wp, vec2 wind, float t, float scale, float seed, out float body) {
    // x runs left-to-right on screen, y runs up the screen (against the wind, which blows toward the camera).
    vec2 p = vec2(dot(wp, vec2(wind.y, -wind.x)), dot(wp, wind)) / scale;
    p.y -= t * 0.18;                                  // drift downwind
    p.x += sin(p.y * 0.9 + seed) * 0.5;               // gentle bend along each row
    float row = floor(p.y);
    p.x += hash(vec2(row, seed)) * 9.0;               // rows don't line up
    float fy = 0.5 - fract(p.y);                      // position inside the row, + = up the screen

    const float SEG = 3.5;                            // a segment holds ~3 arcs
    float seg = floor(p.x / SEG);
    float keep = step(0.5, hash(vec2(seg + seed * 7.0, row)));
    float sx = fract(p.x / SEG);
    float taper = smoothstep(0.0, 0.18, sx) * smoothstep(1.0, 0.82, sx); // thin ends

    // One arc per unit: steeper rise into the crest, gentler fall away (like the drawing).
    float u = fract(p.x);
    float us = pow(u, 1.35);
    const float A = 0.38;
    float f = A * 4.0 * (us - 0.5) * (us - 0.5) - A * 0.5;            // +A/2 at the cusps
    float df = A * 8.0 * (us - 0.5) * 1.35 * pow(max(u, 1e-3), 0.35);
    float d = abs(fy - f) / sqrt(1.0 + df * df);       // ~distance to the curve
    float w = 0.042 * taper;
    float aa = max(fwidth(d), 1e-4);
    body = keep * taper * step(fy, f) * (1.0 - smoothstep(0.0, 0.32, f - fy));
    return keep * (1.0 - smoothstep(w - aa, w + aa, d));
  }

  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }

  void main() {
    vec3 n = normalize(vNormal);
    // Swell evaluated per pixel so the thin crest line stays crisp (not per mesh vertex).
    float vRoller = rollerAt(vWorld.xz, uTime);
    vec2 rdir = vec2(${ROLLER.dir[0].toFixed(3)}, ${ROLLER.dir[1].toFixed(3)}) * 0.5;
    float vRollerSlope = clamp((rollerAt(vWorld.xz + rdir, uTime) - rollerAt(vWorld.xz - rdir, uTime)) / 1.0 / 0.16, -1.0, 1.0);
    vec2 uv = gl_FragCoord.xy / uResolution;
    float wZ = viewZ(gl_FragCoord.z);

    // How much water lies between the surface and whatever is behind it.
    float thick0 = max(wZ - viewZ(texture2D(uSceneDepth, uv).x), 0.0);

    // Refraction: bend the view a little, but never pull in things that are above the water.
    vec2 ruv = uv + n.xz * 0.035 * clamp(thick0 * 0.5, 0.0, 1.0);
    float sZ = viewZ(texture2D(uSceneDepth, ruv).x);
    if (sZ > wZ) { ruv = uv; sZ = viewZ(texture2D(uSceneDepth, uv).x); }
    float thick = max(wZ - sZ, 0.0);
    vec3 below = texture2D(uSceneColor, ruv).rgb;

    // ---------- Clear water, with texture only where the sea is rough ----------
    vec2 wp = vWorld.xz;
    float n1 = noise(wp * 0.8 + vec2(uTime * 0.35, uTime * 0.22));
    float n2 = noise(wp * 1.1 - vec2(uTime * 0.4, -uTime * 0.25));
    float lace = noise(wp * 2.4 + vec2(uTime * 0.6, -uTime * 0.4));
    float lace2 = noise(wp * 5.0 - vec2(uTime * 0.5, uTime * 0.7));

    // Clear, see-through water: colour comes from depth, the seabed shows in the shallows.
    vec3 transmit = exp(-vec3(0.5, 0.18, 0.12) * thick);
    float scatter = 1.0 - exp(-thick * 0.38);
    vec3 tint = mix(mix(uBand0, uBand1, smoothstep(0.5, 2.5, thick)), uDeep, smoothstep(2.5, 7.0, thick));
    vec3 col = below * transmit + tint * scatter;
    // Very gentle broad shading from the normal swell, so calm water isn't dead flat.
    vec3 ln = normalize(vec3(n.x * 3.0, n.y, n.z * 3.0));
    col *= clamp(1.0 + 0.45 * (dot(ln, uSunDir) - uSunDir.y), 0.85, 1.12);

    // Wave strokes only appear on the rolling swells. Everywhere else stays calm and clear.
    float swellZone = smoothstep(0.03, 0.4, vRoller);
    float rough = swellZone * smoothstep(1.5, 4.0, thick); // only on swells, never in the shallows

    // Wave strokes (only where rough): a big set plus a smaller, fainter set.
    vec2 wind = vec2(${ROLLER.dir[0].toFixed(3)}, ${ROLLER.dir[1].toFixed(3)});
    float bodyA, bodyB;
    float strokeA = waveStroke(wp, wind, uTime, 3.3, 1.0, bodyA);
    float strokeB = waveStroke(wp + 31.0, normalize(wind + vec2(0.18, 0.0)), uTime * 1.2, 2.0, 4.0, bodyB);
    float face = max(bodyA, bodyB * 0.6);
    col = mix(col, col * (1.0 + 0.28 * face), rough);  // lighter wave body under each stroke

    // Swells: only a faint hint of their slope; their look comes from the rough-water texture.
    col *= 1.0 + 0.12 * vRollerSlope;

    // Golden sun glare in the top-right of the screen, only on rough water.
    float glareZone = 1.0 - smoothstep(0.0, 0.75, length((uv - vec2(1.05, 1.05)) * vec2(uResolution.x / uResolution.y, 1.0)));
    float glint = aastep(0.6, lace2 * face * 1.4) * rough;
    col += vec3(1.0, 0.8, 0.45) * glint * glareZone * 1.2;

    // ---------- Foam ----------
    // Shores, rocks, buoys and the hull: solid at the edge, a little lace just outside.
    float shoreSolid = 1.0 - aastep(0.3 + (lace - 0.5) * 0.3, thick);
    float shoreLace = (1.0 - aastep(1.1 + (n1 - 0.5) * 0.6, thick)) * aastep(0.55, lace) * aastep(0.4, lace2);
    // Breaking little crests, only in rough water (a bit more of them along a swell).
    float chopFoam = max(strokeA, strokeB * 0.75) * aastep(0.35, rough);
    float foam = max(max(shoreSolid, shoreLace), chopFoam);
    col = mix(col, vec3(0.95, 0.98, 1.0), clamp(foam, 0.0, 1.0));

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export class Water {
  constructor(scene, renderer) {
    const geo = new THREE.PlaneGeometry(260, 260, 160, 160);
    geo.rotateX(-Math.PI / 2);

    this.target = this.#makeTarget(1, 1);
    this.uniforms = {
      uTime: waterTime,
      uBand0: { value: new THREE.Color('#8af2e2') }, // very shallow
      uBand1: { value: new THREE.Color('#33cfd0') }, // shallow
      uDeep: { value: new THREE.Color('#1a6db3') }, // deep
      uShallow: { value: new THREE.Color('#2bbbc9') },
      uSky: { value: new THREE.Color('#bfe6f5') },
      uSunDir: { value: new THREE.Vector3(0.4, 1, 0.3).normalize() },
      uCamPos: { value: new THREE.Vector3() },
      uSceneColor: { value: this.target.texture },
      uSceneDepth: { value: this.target.depthTexture },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 1 },
      uFar: { value: 1000 },
    };
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader, fragmentShader })
    );
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(SURFACE_LAYER);
    scene.add(this.mesh);
    this.step = 260 / 160;
    this.renderer = renderer;
  }

  #makeTarget(w, h) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      depthTexture: new THREE.DepthTexture(w, h),
    });
    rt.depthTexture.minFilter = rt.depthTexture.magFilter = THREE.NearestFilter;
    return rt;
  }

  /** Call with the drawing-buffer size (CSS size * pixel ratio). */
  setSize(w, h) {
    this.target.dispose();
    this.target = this.#makeTarget(w, h);
    this.uniforms.uSceneColor.value = this.target.texture;
    this.uniforms.uSceneDepth.value = this.target.depthTexture;
    this.uniforms.uResolution.value.set(w, h);
  }

  update(t, center, camera) {
    waterTime.value = t;
    this.uniforms.uCamPos.value.copy(camera.position);
    this.uniforms.uNear.value = camera.near;
    this.uniforms.uFar.value = camera.far;
    // Follow the boat, snapped to the grid spacing so the waves don't "swim".
    this.mesh.position.x = Math.round(center.x / this.step) * this.step;
    this.mesh.position.z = Math.round(center.z / this.step) * this.step;
  }

  /** Pass 1: everything under/around the water into a texture. Pass 2: full scene with water on top. */
  render(scene, camera) {
    const r = this.renderer;
    const mask = camera.layers.mask;
    camera.layers.set(0);
    r.shadowMap.needsUpdate = true;
    r.setRenderTarget(this.target);
    r.render(scene, camera);
    r.setRenderTarget(null);
    camera.layers.mask = mask;
    r.render(scene, camera);
  }
}
