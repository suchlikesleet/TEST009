import * as THREE from 'three';

// Wave layers: [dirX, dirZ, frequency, speed, amplitude].
// Shared between the GPU shader and the CPU so the boat floats on the same surface you see.
const WAVES = [
  [1.0, 0.2, 0.16, 1.1, 0.32],
  [-0.3, 1.0, 0.22, 0.9, 0.22],
  [0.7, 0.7, 0.41, 1.9, 0.09],
  [-0.8, 0.5, 0.63, 2.6, 0.05],
];

export function waveHeight(x, z, t) {
  let h = 0;
  for (const [dx, dz, f, s, a] of WAVES) {
    h += Math.sin((x * dx + z * dz) * f + t * s) * a;
  }
  return h;
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
        gl_FragColor.rgb += vec3(0.75, 0.95, 1.0) * caustic(vCWorld.xz, uWaterTime) * cDepth * ${strength.toFixed(2)};`
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

  float waveH(vec2 p, float t) {
    float h = 0.0;
    ${glslWaves}
    return h;
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

  float viewZ(float depth) { return perspectiveDepthToViewZ(depth, uNear, uFar); }

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

    // Light absorption: red fades first, then green -> shallow turquoise, deep blue.
    vec3 transmit = exp(-vec3(0.55, 0.21, 0.15) * thick);
    float scatter = 1.0 - exp(-thick * 0.4);
    vec3 waterTint = mix(uShallow, uDeep, clamp(thick * 0.14, 0.0, 1.0));
    vec3 col = below * transmit + waterTint * scatter;

    // Sky reflection + sun glint.
    vec3 v = normalize(uCamPos - vWorld);
    float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);
    col = mix(col, uSky, clamp(fres * 0.7 + 0.03, 0.0, 1.0));
    vec3 hv = normalize(uSunDir + v);
    col += vec3(1.0, 0.97, 0.9) * pow(max(dot(n, hv), 0.0), 140.0) * 0.9;

    // Foam: where water is thin (shores, around buoys and hulls), plus rolling lines toward the beach.
    vec2 fp = vWorld.xz;
    float n1 = noise(fp * 0.8 + vec2(uTime * 0.35, uTime * 0.22));
    float n2 = noise(fp * 1.1 - vec2(uTime * 0.4, -uTime * 0.25));
    float edge = 1.0 - smoothstep(0.0, 0.75, thick + (n1 - 0.5) * 0.7);
    float lines = smoothstep(0.6, 0.85, sin(thick * 6.0 - uTime * 2.2 + n1 * 2.0) * 0.5 + 0.5)
                * (1.0 - smoothstep(0.5, 2.2, thick)) * smoothstep(0.35, 0.7, n2);
    float crest = smoothstep(0.5, 0.7, vHeight + (n1 - 0.5) * 0.3) * smoothstep(0.4, 0.8, n2) * 0.35;
    float foam = clamp(max(max(edge, lines * 0.8), crest), 0.0, 1.0);
    col = mix(col, vec3(0.94, 0.98, 1.0), foam * 0.92);

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
      uDeep: { value: new THREE.Color('#08457a') },
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
