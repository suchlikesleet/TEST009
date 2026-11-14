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
  dir: [0.8, -0.6], // travel direction
  perp: [0.6, 0.8],
  k: (Math.PI * 2) / 38, // ~38 units between ridges
  speed: 1.5, // phase speed (rad/s) -> ridges move ~13 units/s
  amp: 1.15,
  sharp: 22, // higher = narrower ridge (~6 units wide)
};

const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };

/** 0..1 strength of the rolling swell at a point (1 = on a crest). */
export function rollerAt(x, z, t) {
  const R = ROLLER;
  const along = x * R.dir[0] + z * R.dir[1];
  const across = x * R.perp[0] + z * R.perp[1];
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
    float along = dot(p, vec2(${ROLLER.dir[0].toFixed(3)}, ${ROLLER.dir[1].toFixed(3)}));
    float across = dot(p, vec2(${ROLLER.perp[0].toFixed(3)}, ${ROLLER.perp[1].toFixed(3)}));
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
  uniform vec3 uBand2;
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
    float along = dot(p, vec2(${ROLLER.dir[0].toFixed(3)}, ${ROLLER.dir[1].toFixed(3)}));
    float across = dot(p, vec2(${ROLLER.perp[0].toFixed(3)}, ${ROLLER.perp[1].toFixed(3)}));
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

    // ---------- Stylized look: flat colour bands, stepped shading, crisp foam ----------
    // Depth bands with clean (anti-aliased) edges instead of smooth gradients.
    float b1 = aastep(1.3, thick);
    float b2 = aastep(3.2, thick);
    float b3 = aastep(5.6, thick);
    vec3 tint = mix(mix(mix(uBand0, uBand1, b1), uBand2, b2), uDeep, b3);
    // Shallow bands let the seabed and objects show through, tinted; deep water hides them.
    float see = mix(mix(mix(0.6, 0.38, b1), 0.16, b2), 0.0, b3);
    vec3 col = mix(tint, below * tint * 1.9, see);

    // Two-step wave shading so the ordinary swell reads as soft bands.
    vec3 ln = normalize(vec3(n.x * 4.0, n.y, n.z * 4.0));
    float lit = dot(ln, uSunDir) - uSunDir.y;
    col *= mix(0.9, 1.0, aastep(-0.12, lit)) * mix(1.0, 1.08, aastep(0.16, lit));
    // Rolling swells: a solid shadow band on the leading face, a light band behind.
    col *= mix(0.68, 1.0, aastep(-0.3, vRollerSlope)) * mix(1.0, 1.14, aastep(0.3, vRollerSlope));

    vec2 fp = vWorld.xz;
    float n1 = noise(fp * 0.8 + vec2(uTime * 0.35, uTime * 0.22));
    float n2 = noise(fp * 1.1 - vec2(uTime * 0.4, -uTime * 0.25));
    float n3 = noise(fp * 2.2 + vec2(-uTime * 0.3, uTime * 0.45));

    // Sparkles: little white glints that twinkle on sunlit wave faces.
    float sparkle = aastep(0.97, n3 * (0.6 + 0.5 * n1)) * aastep(0.06, lit);
    col = mix(col, vec3(1.0), sparkle * 0.85);

    // Foam (all hard-edged):
    // 1. solid foam where water is thin — shores, buoys, the hull
    float edge = 1.0 - aastep(0.5 + (n1 - 0.5) * 0.4, thick);
    // 2. a second foam ring a little further out that breathes in and out
    float ringPos = 1.1 + 0.25 * sin(uTime * 1.4 + n1 * 2.5);
    float ring = (1.0 - aastep(0.1 + (n2 - 0.5) * 0.06, abs(thick - ringPos))) * (1.0 - b2);
    // 3. a crisp whitecap line along every rolling swell, with foam bits trailing behind
    float cap = aastep(0.84 + (n1 - 0.5) * 0.1, vRoller);
    float trail = aastep(0.74, n3) * aastep(0.12, vRoller) * aastep(0.25, vRollerSlope);
    // 4. a few small caps on ordinary wave crests
    float crest = aastep(0.88, n2) * aastep(0.5, vHeight - vRoller * ${ROLLER.amp.toFixed(3)});
    float foam = max(max(edge, ring), max(max(cap, trail * 0.9), crest * 0.8));
    col = mix(col, vec3(0.97, 0.99, 1.0), foam);

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
      uBand2: { value: new THREE.Color('#1f9bc9') }, // mid
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
