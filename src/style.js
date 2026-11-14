import * as THREE from 'three';
import { SURFACE_LAYER } from './water.js';

// Three flat light levels -> cel-shaded look.
const tones = new Uint8Array([110, 190, 255]);
export const gradientMap = new THREE.DataTexture(tones, tones.length, 1, THREE.RedFormat);
gradientMap.minFilter = gradientMap.magFilter = THREE.NearestFilter;
gradientMap.generateMipmaps = false;
gradientMap.needsUpdate = true;

/** Cel-shaded material. */
export function toon(color, extra = {}) {
  return new THREE.MeshToonMaterial({ color, gradientMap, ...extra });
}

const OUTLINE_COLOR = new THREE.Color('#163044');

/**
 * Adds a cartoon outline to a mesh (the "inverted hull" trick): a slightly inflated copy
 * drawn back-faces-only in a dark colour, so only a rim shows around the silhouette.
 * Normals are averaged across hard edges so the inflated shell has no cracks.
 */
export function addOutline(mesh, thickness = 0.08) {
  const geo = mesh.geometry.clone();
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const sums = new Map();
  const keyOf = (i) => `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
  for (let i = 0; i < pos.count; i++) {
    const k = keyOf(i);
    const s = sums.get(k) || [0, 0, 0];
    s[0] += nrm.getX(i); s[1] += nrm.getY(i); s[2] += nrm.getZ(i);
    sums.set(k, s);
  }
  const smooth = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const s = sums.get(keyOf(i));
    const l = Math.hypot(s[0], s[1], s[2]) || 1;
    smooth.set([s[0] / l, s[1] / l, s[2] / l], i * 3);
  }
  geo.setAttribute('outlineNormal', new THREE.BufferAttribute(smooth, 3));

  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: OUTLINE_COLOR }, uThick: { value: thickness } },
    vertexShader: /* glsl */ `
      attribute vec3 outlineNormal;
      uniform float uThick;
      void main() {
        vec3 p = position + outlineNormal * uThick;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      void main() {
        gl_FragColor = vec4(uColor, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
  });
  const shell = new THREE.Mesh(geo, mat);
  shell.userData.isOutline = true;
  shell.castShadow = false;
  // Only drawn in the final pass, never in the under-water pass or the shadow map.
  shell.layers.set(SURFACE_LAYER);
  mesh.add(shell);
  return mesh;
}
