import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { Water } from 'three/addons/objects/Water.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------- utils ----------
let seed = 20261020;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const rr = (a, b) => a + (b - a) * rand();
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const LAKE_R = 26;
// ---------- wind: one field everything listens to; direction wanders, strength breathes, gusts roll through ----------
const WIND = { dir: new THREE.Vector2(1, 0), strength: 0.4, gust: 0, gustTarget: 0, nextGust: 5 };
const windU = { uTime: { value: 0 }, uWindDir: { value: WIND.dir }, uWind: { value: 0.4 } };
const WIND_GLSL = `
  uniform float uTime; uniform vec2 uWindDir; uniform float uWind;
  // wind direction expressed in this instance's local frame (instances are randomly rotated)
  vec3 windLocal() { vec3 d = transpose(mat3(instanceMatrix)) * vec3(uWindDir.x, 0., uWindDir.y); d.y = 0.; return normalize(d + vec3(1e-5)); }
`;
function updateWind(t, dt) {
  const ang = 0.6 + 0.5 * Math.sin(t * 0.031) + 0.25 * Math.sin(t * 0.077 + 1.3);
  WIND.dir.set(Math.cos(ang), Math.sin(ang));
  if (t > WIND.nextGust) { WIND.gustTarget = 0.35 + Math.random() * 0.55; WIND.nextGust = t + 6 + Math.random() * 11; }
  WIND.gust += (WIND.gustTarget - WIND.gust) * Math.min(1, dt * 1.3);   // gust builds over ~1.5 s
  WIND.gustTarget *= Math.exp(-dt * 0.45);                               // then dies away
  const base = 0.3 + 0.16 * Math.sin(t * 0.13) + 0.09 * Math.sin(t * 0.29 + 2.0);
  WIND.strength = Math.min(1.3, Math.max(0.05, base + WIND.gust));
  windU.uTime.value = t; windU.uWind.value = WIND.strength;
}
const CABIN = { x: -15, z: 26.5, rot: 1.1, side: -1 };  // straddles the left shore: land half up the bank, lake half on stilts
const STRETCH = 0.85;   // lake is an ellipse: x is stretched by 1/STRETCH

// value noise for terrain shape (CPU)
const perm = new Uint8Array(512);
{ const p = [...Array(256).keys()]; for (let i = 255; i > 0; i--) { const j = (rand() * (i + 1)) | 0; [p[i], p[j]] = [p[j], p[i]]; } for (let i = 0; i < 512; i++) perm[i] = p[i & 255]; }
const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
function grad(h, x, y) { const u = h & 1 ? x : -x, v = h & 2 ? y : -y; return (h & 4 ? u + v : u - v) * 0.7; }
function perlin(x, y) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255; x -= Math.floor(x); y -= Math.floor(y);
  const u = fade(x), v = fade(y), a = perm[X] + Y, b = perm[X + 1] + Y;
  const l1 = grad(perm[a], x, y) + u * (grad(perm[b], x - 1, y) - grad(perm[a], x, y));
  const l2 = grad(perm[a + 1], x, y - 1) + u * (grad(perm[b + 1], x - 1, y - 1) - grad(perm[a + 1], x, y - 1));
  return l1 + v * (l2 - l1);
}
function fbm(x, y, oct = 5) { let s = 0, a = 1, f = 1, n = 0; for (let i = 0; i < oct; i++) { s += a * perlin(x * f, y * f); n += a; a *= 0.5; f *= 2.03; } return s / n; }
function ridged(x, y) { let s = 0, a = 0.6, f = 1; for (let i = 0; i < 5; i++) { s += a * (1 - Math.abs(perlin(x * f, y * f))) ** 2; a *= 0.5; f *= 2.1; } return s; }

function heightAt(x, z) {
  const r = Math.hypot(x * STRETCH, z);
  const shore = smooth(LAKE_R - 5, LAKE_R + 7, r);
  const rolling = fbm(x * 0.025, z * 0.025) * 5 + fbm(x * 0.09, z * 0.09, 3) * 0.8;
  const mount = smooth(60, 140, r) * (ridged(x * 0.008, z * 0.008) * 48 + 8) * (z < 40 ? 1 : 0.25);
  return -3 + shore * (3.4 + Math.max(rolling, -2) + smooth(LAKE_R + 8, 70, r) * 6) + mount;
}

// ---------- renderer ----------
const canvas = document.querySelector('canvas.webgl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
// phones and tablets: start lighter (the frame-rate governor below raises it again if there's headroom)
const MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(innerWidth, innerHeight) < 600;
const HQ = new URLSearchParams(location.search).has('hq');   // full-quality mode for screenshots
const MAX_PR = HQ ? Math.max(2, devicePixelRatio) : Math.min(devicePixelRatio, MOBILE ? 1.5 : 1.25);
renderer.setPixelRatio(MOBILE && !HQ ? 1 : MAX_PR);   // adapted at runtime by the frame-rate governor below
// keep roughly the same horizontal view on any screen shape: narrow/portrait screens get a taller field of view
const fovFor = (base, aspect = innerWidth / innerHeight) => {
  const ref = 16 / 10;                               // the framing was composed for a 16:10 screen
  if (aspect >= ref) return base;
  const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(base) / 2) * ref * 0.82);   // allow a little crop on narrow screens
  return Math.min(base * 1.9, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hfov / 2) / aspect)));
};
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.autoUpdate = false;                       // refreshed on demand (light moves, wind) instead of every frame
renderer.shadowMap.needsUpdate = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(fovFor(48), innerWidth / innerHeight, 0.12, 3000);
scene.fog = new THREE.FogExp2(0x1a2340, 0.0042);

// ---------- lighting ----------
const hemi = new THREE.HemisphereLight(0x8fa6d8, 0x1a1a14, 0.4);
const key = new THREE.DirectionalLight(0xb9c8ff, 0.6);  // moon at night, sun by day
key.castShadow = true;
key.shadow.mapSize.set(MOBILE ? 1024 : 2048, MOBILE ? 1024 : 2048);
Object.assign(key.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 400 });
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.04;
scene.add(hemi, key, key.target);
key.target.position.set(0, 0, 20);

// ---------- sky (physical) + night dome ----------
const sky = new Sky();
sky.scale.setScalar(2500);
scene.add(sky);
const skyU = sky.material.uniforms;
const sunDir = new THREE.Vector3();
const moonDir = new THREE.Vector3(0.22, 0.42, -1).normalize();

function moonTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(118, 112, 10, 128, 128, 128);
  g.addColorStop(0, '#fbf6ea'); g.addColorStop(0.85, '#d9d2c2'); g.addColorStop(1, '#b8b1a2');
  x.fillStyle = g; x.beginPath(); x.arc(128, 128, 126, 0, Math.PI * 2); x.fill();
  // maria and craters
  x.globalCompositeOperation = 'multiply';
  for (const [cx, cy, r, a] of [[90, 95, 40, .55], [150, 80, 28, .6], [165, 150, 38, .5], [105, 165, 24, .65], [140, 118, 18, .7]]) {
    const m = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    m.addColorStop(0, `rgba(150,145,135,${a})`); m.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = m; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
  }
  for (let i = 0; i < 90; i++) {
    const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * 115, r = rr(1.5, 7);
    x.fillStyle = `rgba(160,155,145,${rr(.25, .6)})`;
    x.beginPath(); x.arc(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, r, 0, Math.PI * 2); x.fill();
  }
  x.globalCompositeOperation = 'destination-in';
  x.beginPath(); x.arc(128, 128, 126, 0, Math.PI * 2); x.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const nightU = { uNight: { value: 1 }, uTime: { value: 0 } };
const nightDome = new THREE.Mesh(
  new THREE.SphereGeometry(2000, 64, 32),
  new THREE.ShaderMaterial({
    uniforms: nightU, side: THREE.BackSide, depthWrite: false, transparent: true, fog: false,
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `
      uniform float uNight, uTime; varying vec3 vDir;
      float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719)))*43758.5453); }
      void main(){
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 c = mix(vec3(.035,.05,.10), vec3(.006,.009,.03), pow(clamp(h,0.,1.), .5));
        c = mix(vec3(.02,.025,.05), c, smoothstep(-.1,.02,h));
        for (int l=0; l<2; l++){
          float sc = l==0 ? 340. : 700.;
          vec3 g = floor(d*sc);
          float r = hash(g + float(l)*7.);
          float s = step(l==0 ? .9965 : .993, r);
          vec3 cell = fract(d*sc) - .5;
          float core = smoothstep(.5, .0, length(cell));
          float tw = .7 + .3*sin(uTime*(1.5+r*3.) + r*40.);
          vec3 tint = mix(vec3(.75,.85,1.), vec3(1.,.88,.75), hash(g+3.));
          c += tint * s * core * tw * (l==0 ? 1.6 : .7);
        }
        // milky way band
        float band = exp(-pow(dot(d, normalize(vec3(.35,.6,.72))), 2.) * 18.);
        c += vec3(.35,.38,.5) * band * .12 * (.6 + .4*hash(floor(d*900.)));
        gl_FragColor = vec4(c, uNight);
      }`,
  })
);
nightDome.renderOrder = 2;
scene.add(nightDome);
// daytime sky: soft teal gradient, big lit cumulus behind the peaks, a few high cirrus streaks
const dayU = { uDay: { value: 0 }, uTime: { value: 0 }, uSun: { value: new THREE.Vector3() } };
const dayDome = new THREE.Mesh(
  new THREE.SphereGeometry(2100, 64, 32),
  new THREE.ShaderMaterial({
    uniforms: dayU, side: THREE.BackSide, depthWrite: false, transparent: true, fog: false,
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `
      uniform float uDay, uTime; uniform vec3 uSun; varying vec3 vDir;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
      float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),u.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x), u.y); }
      float fbm(vec2 p){ float s=0., a=.5; for(int i=0;i<6;i++){ s+=a*vnoise(p); p=p*2.03+vec2(1.7,9.2); a*=.5; } return s; }
      void main(){
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.);
        // gradient: deeper teal overhead, pale mint at the horizon
        vec3 top = vec3(.10,.36,.44), mid = vec3(.24,.52,.56), hor = vec3(.56,.72,.70);
        vec3 c = mix(hor, mid, smoothstep(0., .18, h));
        c = mix(c, top, smoothstep(.18, .75, h));
        // sun glow
        float sd = max(dot(d, normalize(uSun)), 0.);
        c += vec3(1.,.93,.78) * (pow(sd, 24.) * .12 + pow(sd, 600.) * .5);
        // cumulus: projected onto a cloud layer, densest low in the sky
        vec2 uv = d.xz / (d.y + .18) * 1.15 + vec2(uTime * .004, 0.);
        float warp = fbm(uv * .8 + 3.);
        float n = fbm(uv * 1.4 + warp * 1.6);
        float band = smoothstep(.0, .05, h) * (1. - smoothstep(.30, .65, h));
        float puff = fbm(uv * 5.5 + warp);                                  // small billows eat the edges
        float cov = smoothstep(.44, .54, n + (puff - .5) * .22) * band;
        // light the cloud: brighter where noise rises toward the sun, warm peach in the shadowed folds
        float lit = clamp((fbm(uv * 1.4 + warp * 1.6 + normalize(uSun.xz) * .05) - n) * 14. + .55 + (puff - .5) * .6, 0., 1.);
        vec3 cloud = mix(vec3(.88,.74,.66), vec3(1.3,1.24,1.14), lit);
        cloud = mix(cloud, vec3(.72,.80,.84), smoothstep(.62, .44, n) * .4);   // soft grey edges
        c = mix(c, cloud, cov);
        // cirrus streaks high up
        vec2 cu = d.xz / (d.y + .25) * vec2(.35, 3.) + vec2(uTime * .006, 0.);
        float ci = smoothstep(.62, .85, fbm(cu)) * smoothstep(.15, .35, h) * (1. - cov);
        c = mix(c, vec3(1.05,1.05,1.02), ci * .5);
        c = mix(c, hor, smoothstep(.02, -.04, d.y));
        gl_FragColor = vec4(c, uDay);
      }`,
  })
);
dayDome.renderOrder = 1;
scene.add(dayDome);

const moon = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: moonTexture(), transparent: true, depthWrite: false, fog: false, toneMapped: false, color: new THREE.Color(1.6, 1.6, 1.55) }));
moon.scale.setScalar(46);
moon.renderOrder = 3;
moon.position.copy(moonDir).multiplyScalar(1500);
scene.add(moon);

// aurora curtains
const auroraU = { uTime: { value: 0 }, uNight: { value: 1 } };
{
  const m = new THREE.ShaderMaterial({
    uniforms: auroraU, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false,
    vertexShader: `uniform float uTime; varying vec2 vUv;
      void main(){ vUv = uv; vec3 p = position; p.z += sin(p.x*.006 + uTime*.08)*60. + sin(p.x*.017 - uTime*.05)*25.;
        gl_Position = projectionMatrix*modelViewMatrix*vec4(p,1.); }`,
    fragmentShader: `uniform float uTime, uNight; varying vec2 vUv;
      float h(float n){ return fract(sin(n)*43758.5453); }
      void main(){
        float x = vUv.x*90.;
        float rays = mix(h(floor(x)), h(floor(x)+1.), fract(x));
        rays = .4 + .6*smoothstep(.2, 1., rays + .3*sin(uTime*.4 + vUv.x*20.));
        float fade = smoothstep(0.,.18,vUv.y) * pow(1.-vUv.y, 1.6) * smoothstep(0.,.2,vUv.x) * smoothstep(1.,.8,vUv.x);
        vec3 c = mix(vec3(.1,1.,.45), vec3(.6,.2,.9), smoothstep(.35,1.,vUv.y));
        gl_FragColor = vec4(c, fade * rays * .22 * uNight);
      }`,
  });
  for (let i = 0; i < 2; i++) {
    const a = new THREE.Mesh(new THREE.PlaneGeometry(1400, 220, 200, 1), m);
    a.position.set(i * 120 - 60, 260 + i * 40, -900 - i * 120);
    a.rotation.x = -0.15;
    scene.add(a);
  }
}

// ---------- terrain (colours baked once per vertex; cheap tiling detail per pixel) ----------
function detailTexture() {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d'), img = x.createImageData(S, S);
  // periodic value noise: lattice values wrap at the period, so the texture tiles seamlessly
  const octave = P => {
    const lat = new Float32Array(P * P).map(() => rand());
    const at = (i, k) => lat[((k % P + P) % P) * P + ((i % P + P) % P)];
    return (u, v) => {
      const fx = u * P, fy = v * P, i = Math.floor(fx), k = Math.floor(fy), tx = fade(fx - i), ty = fade(fy - k);
      const a0 = at(i, k) + (at(i + 1, k) - at(i, k)) * tx, a1 = at(i, k + 1) + (at(i + 1, k + 1) - at(i, k + 1)) * tx;
      return a0 + (a1 - a0) * ty;
    };
  };
  const octs = [8, 16, 32, 64, 128].map(octave), amps = [1, 0.6, 0.4, 0.25, 0.15];
  for (let j2 = 0; j2 < S; j2++) for (let i = 0; i < S; i++) {
    let v = 0, n = 0;
    octs.forEach((o, k) => { v += o(i / S, j2 / S) * amps[k]; n += amps[k]; });
    const g = Math.max(0, Math.min(255, 70 + (v / n) * 185));
    const q = (j2 * S + i) * 4; img.data[q] = img.data[q + 1] = img.data[q + 2] = g; img.data[q + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}
const detailTex = detailTexture();
const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
terrainMat.onBeforeCompile = sh => {
  sh.uniforms.uDetail = { value: detailTex };
  sh.vertexShader = 'varying vec2 vXZ;\n' + sh.vertexShader.replace('#include <worldpos_vertex>',
    `#include <worldpos_vertex>
     vXZ = (modelMatrix * vec4(transformed,1.)).xz;`);
  sh.fragmentShader = 'uniform sampler2D uDetail; varying vec2 vXZ;\n' + sh.fragmentShader.replace('#include <color_fragment>',
    `#include <color_fragment>
     float dt = texture2D(uDetail, vXZ * .09).r * texture2D(uDetail, vXZ * .013 + .37).r;
     diffuseColor.rgb *= .55 + dt * .75;`);
};
function terrainColor(x, y, z, slope, out) {
  const n1 = fbm(x * 0.04, z * 0.04, 3), n2 = fbm(x * 0.3, z * 0.3, 2);
  const mix = (a, b, t) => a.lerp(b, Math.min(1, Math.max(0, t)));
  const c = out.setRGB(0.20, 0.17, 0.12);                                   // mud
  mix(c, new THREE.Color(0.30, 0.27, 0.21), smooth(-1.2, -0.2, y));          // sand
  mix(c, new THREE.Color().setRGB(0.20, 0.31, 0.10).lerp(new THREE.Color(0.38, 0.45, 0.17), smooth(-0.3, 0.4, n1)), smooth(0.2, 1.2, y + n2 * 0.6));
  mix(c, new THREE.Color(0.12, 0.19, 0.10), smooth(0, 0.6, n1) * smooth(2, 6, y));   // forest floor
  const hgt = y + n1 * 4;
  mix(c, new THREE.Color(0.31, 0.36, 0.42).lerp(new THREE.Color(0.45, 0.50, 0.57), smooth(-0.4, 0.4, n2)), smooth(0.28, 0.5, slope + n2 * 0.15) + smooth(16, 26, hgt));
  mix(c, new THREE.Color(0.86, 0.92, 0.97), smooth(30, 40, hgt) * (1 - smooth(0.55, 0.75, slope)));
  c.multiplyScalar(0.55 + 0.45 * smooth(-0.1, 0.5, y));                    // wet band at the waterline
  return c;
}
{
  const g = new THREE.PlaneGeometry(900, 900, 360, 360);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, heightAt(p.getX(i), p.getZ(i)));
  g.computeVertexNormals();
  const nrm = g.attributes.normal, cols = new Float32Array(p.count * 3), c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    terrainColor(p.getX(i), p.getY(i), p.getZ(i), 1 - nrm.getY(i), c);
    cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  const t = new THREE.Mesh(g, terrainMat);
  t.receiveShadow = true;
  scene.add(t);
}

// ---------- water (real reflections) ----------
const waterNormals = new THREE.TextureLoader().load('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/textures/waternormals.jpg', t => { t.wrapS = t.wrapT = THREE.RepeatWrapping; markLoaded(); });
// Gerstner waves: [dirX, dirZ, wavelength m, amplitude m, steepness]. Deep-water dispersion: speed = sqrt(g / k).
// The same function drives the GPU surface and the boat's buoyancy, so the boat rides the waves you see.
const WAVES = [
  [0.80, 0.60, 6.0, 0.045, 0.30],
  [0.30, 0.95, 3.4, 0.028, 0.35],
  [-0.50, 0.86, 2.1, 0.016, 0.40],
  [0.95, -0.31, 1.3, 0.009, 0.45],
];
const waveGust = () => 0.6 + 0.65 * WIND.strength;      // waves build with the wind
const shoreDamp = (x, z) => 1 - 0.75 * smooth(LAKE_R - 6, LAKE_R + 3, Math.hypot(x * STRETCH, z));
function waterHeight(x, z, t) {
  const g = waveGust(t) * shoreDamp(x, z);
  let y = 0;
  for (const [dx, dz, L, A] of WAVES) {
    const k = (Math.PI * 2) / L, c = Math.sqrt(9.8 / k);
    y += A * g * Math.sin(k * (dx * x + dz * z - c * t));
  }
  return y;
}
const waveUniforms = { uWaveTime: { value: 0 }, uGust: { value: 1 } };
const WAVE_GLSL = `
  uniform float uWaveTime, uGust;
  varying vec3 vWaveN;
  const vec4 W_D[4] = vec4[4](${WAVES.map(w => `vec4(${w[0].toFixed(3)}, ${w[1].toFixed(3)}, ${w[2].toFixed(3)}, ${w[3].toFixed(4)})`).join(', ')});
  const float W_Q[4] = float[4](${WAVES.map(w => w[4].toFixed(3)).join(', ')});
  vec3 gerstner(vec3 p, out vec3 n) {
    float damp = 1.0 - 0.75 * smoothstep(${(LAKE_R - 6).toFixed(1)}, ${(LAKE_R + 3).toFixed(1)}, length(vec2(p.x * ${STRETCH.toFixed(3)}, p.z)));
    vec3 d = vec3(0.0); vec3 nn = vec3(0.0, 1.0, 0.0);
    for (int i = 0; i < 4; i++) {
      vec2 dir = W_D[i].xy; float L = W_D[i].z, A = W_D[i].w * uGust * damp, Q = W_Q[i];
      float k = 6.2831853 / L, c = sqrt(9.8 / k), f = k * (dot(dir, p.xz) - c * uWaveTime);
      float cf = cos(f), sf = sin(f);
      d += vec3(Q * A * dir.x * cf, A * sf, Q * A * dir.y * cf);
      nn += vec3(-dir.x * k * A * cf, -Q * k * A * sf, -dir.y * k * A * cf);
    }
    n = normalize(nn);
    return d;
  }
`;
const water = new Water(new THREE.PlaneGeometry((LAKE_R + 14) * 2, (LAKE_R + 14) * 2, 220, 220), {
  textureWidth: HQ ? 2048 : MOBILE ? 256 : 512, textureHeight: HQ ? 2048 : MOBILE ? 256 : 512, waterNormals,
  sunDirection: moonDir.clone(), sunColor: 0xfff4e0, waterColor: 0x061420, distortionScale: 0.7, fog: true, alpha: 1,
});
water.rotation.x = -Math.PI / 2;
water.scale.x = 1 / STRETCH;
water.position.y = 0;
water.material.uniforms.size.value = 3.5;
// the stock shader adds a flat 0.1 grey to reflections; at night that reads as a grey lake
water.material.fragmentShader = water.material.fragmentShader.replace('vec3( 0.1 )', 'waterColor * 0.5');
// displace the surface with the Gerstner field (world space) and feed the wave normal to the lighting
Object.assign(water.material.uniforms, waveUniforms);
water.material.vertexShader = water.material.vertexShader
  .replace('uniform float time;', 'uniform float time;\n' + WAVE_GLSL)
  .replace(`mirrorCoord = modelMatrix * vec4( position, 1.0 );
					worldPosition = mirrorCoord.xyzw;
					mirrorCoord = textureMatrix * mirrorCoord;
					vec4 mvPosition =  modelViewMatrix * vec4( position, 1.0 );`,
  `vec4 wp = modelMatrix * vec4( position, 1.0 );
					vec3 wn; wp.xyz += gerstner(wp.xyz, wn); vWaveN = wn;
					worldPosition = wp;
					mirrorCoord = textureMatrix * wp;
					vec4 mvPosition = viewMatrix * wp;`);
water.material.fragmentShader = water.material.fragmentShader
  .replace('uniform float time;', 'uniform float time;\nvarying vec3 vWaveN;')
  .replace('vec3 surfaceNormal = normalize( noise.xzy * vec3( 1.5, 1.0, 1.5 ) );',
           'vec3 surfaceNormal = normalize( noise.xzy * vec3( 1.5, 1.0, 1.5 ) );\n\t\t\t\t\tsurfaceNormal = normalize( vec3( surfaceNormal.x + vWaveN.x * 2.2, surfaceNormal.y, surfaceNormal.z + vWaveN.z * 2.2 ) );');
if (!water.material.vertexShader.includes('gerstner(wp.xyz')) console.warn('wave patch did not apply');
scene.add(water);

// ---------- rocks ----------
{
  const parts = [];
  for (let i = 0; i < 90; i++) {
    const a = rr(0, Math.PI * 2), r = rr(LAKE_R - 4, LAKE_R + 16);
    const x = Math.cos(a) * r / STRETCH, z = Math.sin(a) * r;
    if ((Math.abs(x) < 3 && z > 10) || Math.hypot(x - CABIN.x, z - CABIN.z) < 6) continue;
    const g = new THREE.IcosahedronGeometry(rr(0.3, 1.8), 2);
    const p = g.attributes.position, o = rr(0, 100);
    for (let k = 0; k < p.count; k++) {
      const vx = p.getX(k), vy = p.getY(k), vz = p.getZ(k);
      const d = 1 + fbm(vx * 0.9 + o, vz * 0.9 + vy * 0.7, 3) * 0.45;
      p.setXYZ(k, vx * d, vy * d * 0.6, vz * d);
    }
    g.rotateY(rr(0, 6));
    g.translate(x, heightAt(x, z) + 0.05, z);
    parts.push(g);
  }
  const g = mergeGeometries(parts); g.computeVertexNormals();
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x8d8a84, roughness: 0.9, map: detailTex });
  const uvA = new Float32Array(g.attributes.position.count * 2);
  for (let i = 0; i < g.attributes.position.count; i++) { uvA[i * 2] = g.attributes.position.getX(i) * 0.4; uvA[i * 2 + 1] = (g.attributes.position.getY(i) + g.attributes.position.getZ(i)) * 0.4; }
  g.setAttribute('uv', new THREE.BufferAttribute(uvA, 2));
  const rocks = new THREE.Mesh(g, rockMat);
  rocks.castShadow = rocks.receiveShadow = true;
  scene.add(rocks);
}

// ---------- canvas textures for wood ----------
function woodTexture(base, dark, w = 512, h = 128) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = base; x.fillRect(0, 0, w, h);
  for (let i = 0; i < 70; i++) {
    x.strokeStyle = `rgba(${dark},${rr(0.08, 0.3)})`; x.lineWidth = rr(0.5, 2.5);
    x.beginPath(); let y = rr(0, h); x.moveTo(0, y);
    for (let px = 0; px <= w; px += 16) { y += rr(-1.2, 1.2); x.lineTo(px, y); }
    x.stroke();
  }
  for (let i = 0; i < 4; i++) {
    const kx = rr(0, w), ky = rr(0, h);
    x.fillStyle = `rgba(${dark},.45)`; x.beginPath(); x.ellipse(kx, ky, rr(4, 9), rr(2, 4), 0, 0, 6.3); x.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}
const plankTex = woodTexture('#7a5a3e', '40,26,14');
const plankMat = new THREE.MeshStandardMaterial({ map: plankTex, roughness: 0.85 });
const postMat = new THREE.MeshStandardMaterial({ map: woodTexture('#4a3524', '20,12,6'), roughness: 0.9 });
const logMat = new THREE.MeshStandardMaterial({ map: woodTexture('#6a4a30', '30,18,8'), roughness: 0.9 });

// ---------- spruce trees (branch cards with needle texture) ----------
function branchTexture() {
  const W = 256, H = 128, c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.lineCap = 'round';
  const needle = (px, py, ang, len, shade) => {
    x.strokeStyle = `hsl(${115 + rr(-10, 10)}, ${rr(42, 58)}%, ${shade + rr(-4, 4)}%)`;
    x.lineWidth = rr(1, 1.8);
    x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(ang) * len, py + Math.sin(ang) * len); x.stroke();
  };
  // main stem runs left (trunk side) to right (tip), tapering
  const stemY = H / 2;
  const twig = (sx, sy, ang, len, depth) => {
    const steps = Math.max(4, (len / 4) | 0);
    for (let i = 0; i < steps; i++) {
      const t = i / steps, px = sx + Math.cos(ang) * len * t, py = sy + Math.sin(ang) * len * t;
      const nl = (1 - t * 0.6) * (depth ? 9 : 13);
      const shade = 13 + t * 9 + (depth ? 3 : 0);
      for (let k = 0; k < 2; k++) {
        needle(px, py, ang - 1.1 + rr(-0.3, 0.3), nl * rr(0.7, 1.1), shade);
        needle(px, py, ang + 1.1 + rr(-0.3, 0.3), nl * rr(0.7, 1.1), shade);
      }
      if (!depth && i % 3 === 1 && t < 0.85) {
        twig(px, py, ang - rr(0.5, 0.8), len * (1 - t) * 0.45, 1);
        twig(px, py, ang + rr(0.5, 0.8), len * (1 - t) * 0.45, 1);
      }
    }
    x.strokeStyle = '#2a2016'; x.lineWidth = depth ? 1 : 2.4;
    x.beginPath(); x.moveTo(sx, sy); x.lineTo(sx + Math.cos(ang) * len, sy + Math.sin(ang) * len); x.stroke();
  };
  twig(4, stemY, 0, W - 18, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
const branchTex = branchTexture();
const barkTex = woodTexture('#3b2d22', '15,10,6', 128, 512);

function makeSpruce(height, whorls, perWhorl) {
  const cards = [], trunks = [];
  // trunk: buried 1.5 m with a root flare, runs all the way into the leader
  const trunk = new THREE.CylinderGeometry(0.02, 0.26, height + 1.5, 9, 6);
  const tp = trunk.attributes.position;
  for (let i = 0; i < tp.count; i++) {
    const y = tp.getY(i) + (height + 1.5) / 2 - 1.5;             // -1.5 .. height
    const flare = 1 + Math.max(0, 0.6 - y) * 0.9;                // wider at the root
    tp.setX(i, tp.getX(i) * flare); tp.setZ(i, tp.getZ(i) * flare);
    tp.setY(i, y);
  }
  trunk.deleteAttribute('uv');
  trunks.push(trunk);

  const crownBase = height * 0.12;
  const card = (len, w) => { const g = new THREE.PlaneGeometry(len, w); g.translate(len / 2, 0, 0); return g; };
  for (let L = 0; L < whorls; L++) {
    const t = L / (whorls - 1);                                  // 0 bottom .. 1 top
    const y = crownBase + Math.pow(t, 0.92) * (height - crownBase - 0.5);
    const radius = Math.max(0.25, (1 - t) * height * 0.26 * (0.85 + 0.15 * Math.sin(t * 3)));
    const n = Math.max(3, Math.round(perWhorl - t * 3));
    const droop = 0.25 + (1 - t) * 0.35;                         // lower branches hang more
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + L * 2.4 + rr(-0.25, 0.25);
      const len = radius * rr(0.85, 1.1);
      for (const roll of [0, Math.PI / 2]) {                     // crossed pair → volume from any angle
        const g = card(len, len * 0.7);
        g.rotateX(roll + Math.PI / 2);
        g.rotateZ(-droop + rr(-0.08, 0.08));
        g.rotateY(a);
        g.translate(0, y + rr(-0.1, 0.1), 0);
        cards.push(g);
      }
    }
  }
  // leader: crossed vertical cards bridging the last whorl and the tip
  for (const r of [0, Math.PI / 2]) {
    const g = new THREE.PlaneGeometry(1.4, 0.45);
    g.rotateZ(Math.PI / 2); g.translate(0, height - 0.15, 0); g.rotateY(r);
    cards.push(g);
  }
  // foliage normals: mostly up with a little outward lean (no hard lit/unlit split),
  // plus baked occlusion: darker toward the trunk and the bottom of the crown
  const merged = mergeGeometries(cards);
  const p = merged.attributes.position, nrm = merged.attributes.normal;
  const ao = new Float32Array(p.count * 3), v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), r = Math.hypot(x, z);
    v.set(x, 0, z); if (r > 1e-4) v.multiplyScalar(0.55 / r);
    v.y = 1; v.normalize();
    nrm.setXYZ(i, v.x, v.y, v.z);
    const crown = Math.max(0.05, (1 - y / height) * height * 0.26);          // crown radius at this height
    const outer = Math.min(1, r / crown);
    const k = (0.5 + 0.5 * outer) * (0.65 + 0.35 * Math.min(1, y / height + 0.25));
    ao[i * 3] = ao[i * 3 + 1] = ao[i * 3 + 2] = k;
  }
  merged.setAttribute('color', new THREE.BufferAttribute(ao, 3));
  return { foliage: merged, trunk: mergeGeometries(trunks) };
}

const foliageMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: branchTex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 1, metalness: 0, emissive: 0x0c1a0a, emissiveIntensity: 1 });
// cards are double-sided; keep the outward crown normal on both faces so crossed pairs shade alike
const TREE_SWAY = `
  vec4 ip = instanceMatrix * vec4(0., 0., 0., 1.);
  vec3 wd = windLocal();
  float hN = max(position.y, 0.) / 12.;
  float ph = ip.x * .37 + ip.z * .29;
  float sway = uWind * (.55 + .45 * sin(uTime * .9 + ph)) + .15 * uWind * sin(uTime * 1.7 + ph * 1.3);
  transformed += wd * sway * .38 * hN * hN;`;
const treeWind = (sh, flutter) => {
  Object.assign(sh.uniforms, windU);
  sh.vertexShader = WIND_GLSL + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>' + TREE_SWAY + (flutter
    ? `\n  transformed += vec3(sin(uTime * 4.1 + position.x * 6. + ph), 0., cos(uTime * 3.3 + position.z * 6. + ph)) * .035 * hN * (.3 + uWind);`
    : ''));
};
foliageMat.onBeforeCompile = sh => {
  treeWind(sh, true);
  sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>',
    THREE.ShaderChunk.normal_fragment_begin.replaceAll('normal *= faceDirection;', '').replaceAll('normal = normal * faceDirection;', ''));
};
const foliageDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: branchTex, alphaTest: 0.45, side: THREE.DoubleSide });
const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3828, roughness: 1 });
trunkMat.onBeforeCompile = sh => treeWind(sh, false);
{
  const variants = [makeSpruce(11, 22, 9), makeSpruce(9, 18, 8), makeSpruce(13, 25, 9)];
  const farVariant = makeSpruce(11, 12, 6);   // cheap model for distant slopes
  // Poisson-ish placement on a jittered grid, so trunks never overlap
  const cell = 4.0, spots = [];
  for (let gx = -230; gx < 230; gx += cell) for (let gz = -230; gz < 70; gz += cell) {
    const x = gx + rr(0.2, cell - 0.2), z = gz + rr(0.2, cell - 0.2);
    const r = Math.hypot(x * STRETCH, z);
    if (r < LAKE_R + 3 || r > 160) continue;
    if (Math.abs(x) < 5 && z > 12 && z < 60) continue;         // dock path / home view corridor
    if (Math.hypot(x - CABIN.x, z - CABIN.z) < 9) continue;    // cabin clearing
    if (z > 34 && Math.abs(x - 4) < 26) continue;              // home camera foreground
    // ground under the whole footprint; skip steep ground (trees don't grow on cliffs)
    const e = 0.9, hs = [heightAt(x, z), heightAt(x + e, z), heightAt(x - e, z), heightAt(x, z + e), heightAt(x, z - e)];
    const lo = Math.min(...hs), hi = Math.max(...hs);
    if (hi - lo > 1.3) continue;
    if (lo < 0.5 || lo > 30) continue;
    // natural stands: density follows a noise field, thinning toward the tree line
    const dens = 0.55 + fbm(x * 0.025, z * 0.025, 3) * 1.2 - smooth(20, 30, lo) * 0.6 - (1 - smooth(LAKE_R + 3, LAKE_R + 12, r)) * 0.35;
    if (rand() > dens) continue;
    const sc = (0.7 + rand() * 0.55) * (0.8 + 0.35 * smooth(LAKE_R, 60, r)) * (1 - smooth(18, 30, lo) * 0.35);
    const d = Math.hypot(x, z - 25);
    spots.push({ x, y: lo - 0.15, z, sc, near: d < 45, v: d > 85 ? 3 : (rand() * 3) | 0 });
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3(), e = new THREE.Euler();
  const tint = new THREE.Color();
  for (const near of [true, false]) [...variants, farVariant].forEach((geo, vi) => {
    const list = spots.filter(o => o.v === vi && o.near === near);
    if (!list.length) return;
    const fol = new THREE.InstancedMesh(geo.foliage, foliageMat, list.length);
    const tr = new THREE.InstancedMesh(geo.trunk, trunkMat, list.length);
    list.forEach((o, i) => {
      q.setFromEuler(e.set(rr(-0.02, 0.02), rr(0, 6.28), rr(-0.02, 0.02)));   // trees grow vertically
      o.sy = o.sc * rr(0.92, 1.12);
      s.set(o.sc, o.sy, o.sc);
      m.compose(v.set(o.x, o.y, o.z), q, s);
      fol.setMatrixAt(i, m); tr.setMatrixAt(i, m);
      fol.setColorAt(i, tint.setHSL(0.40 + rr(-0.03, 0.03), 0.38 + rr(0, 0.12), 0.30 + rr(-0.06, 0.06)));
    });
    fol.customDepthMaterial = foliageDepth;
    fol.castShadow = tr.castShadow = near;
    fol.receiveShadow = false;           // self/neighbour shadowing on cards turns whole trees black
    tr.receiveShadow = true;
    scene.add(fol, tr);
  });
}

// ---------- dock + lanterns ----------
const lampLights = [], lampGlows = [];
const creamTrim = new THREE.MeshStandardMaterial({ color: 0xe9dcc4, roughness: 0.6 });
const lampGlowMat = new THREE.MeshStandardMaterial({ color: 0x1a1008, emissive: 0xffa040, emissiveIntensity: 3, roughness: 0.4 });
const windowMat = new THREE.MeshStandardMaterial({ color: 0x1c2a33, roughness: 0.12, metalness: 0.4, emissive: 0xffa040, emissiveIntensity: 2.4 });
{
  const dock = new THREE.Group();
  const startZ = 33, endZ = 13;
  for (let z = startZ; z > endZ; z -= 0.5) {
    const g = new THREE.BoxGeometry(2.6, 0.08, 0.44);
    const uv = g.attributes.uv; const off = rand();
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) + off, uv.getY(i) * 0.25 + off);
    const plank = new THREE.Mesh(g, plankMat);
    plank.position.set(rr(-0.03, 0.03), 0.72 + rr(-0.015, 0.015), z);
    plank.rotation.set(rr(-0.01, 0.01), rr(-0.015, 0.015), rr(-0.012, 0.012));
    plank.castShadow = plank.receiveShadow = true;
    dock.add(plank);
  }
  for (const x of [-1.15, 1.15]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.2, startZ - endZ), postMat);
    beam.position.set(x, 0.58, (startZ + endZ) / 2); beam.castShadow = true; dock.add(beam);
  }
  for (let z = startZ; z >= endZ - 0.01; z -= 2.5) for (const x of [-1.2, 1.2]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 3.4, 10), postMat);
    post.position.set(x, -0.8, z); post.castShadow = true;
    dock.add(post);
  }
  for (const x of [-1.25, 1.25]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 1.7, 8), postMat);
    pole.position.set(x, 1.6, endZ + 0.25);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.34, 0.24), new THREE.MeshStandardMaterial({ color: 0x151515, metalness: 0.7, roughness: 0.5, wireframe: true }));
    frame.position.set(x, 2.6, endZ + 0.25);
    const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.2, 10), lampGlowMat);
    glow.position.copy(frame.position);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.14, 4), new THREE.MeshStandardMaterial({ color: 0x1b1b1b, metalness: 0.8, roughness: 0.4 }));
    cap.position.set(x, 2.84, endZ + 0.25); cap.rotation.y = Math.PI / 4;
    const light = new THREE.PointLight(0xffa050, 3, 12, 2);
    light.position.copy(frame.position);
    dock.add(pole, frame, glow, cap, light);
    lampLights.push(light); lampGlows.push(glow);
  }
  scene.add(dock);
}

// rowboat
const boat = new THREE.Group();
const boatState = { vy: 0 };
{
  const pts = [];
  for (let i = 0; i <= 10; i++) { const t = i / 10; pts.push(new THREE.Vector2(Math.sin(t * Math.PI / 2) * 0.75 + 0.02, -0.45 + t * 0.55)); }
  const hull = new THREE.LatheGeometry(pts, 24);
  hull.scale(1, 1, 2.6);
  const hullMesh = new THREE.Mesh(hull, new THREE.MeshStandardMaterial({ color: 0x6b3f26, roughness: 0.7, side: THREE.DoubleSide }));
  hullMesh.castShadow = true;
  boat.add(hullMesh);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.77, 0.035, 6, 32), postMat); rim.rotation.x = Math.PI / 2; rim.scale.set(1, 2.6, 1); rim.position.y = 0.1; boat.add(rim);
  for (const z of [-0.7, 0.6]) { const seat = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.05, 0.3), plankMat); seat.position.set(0, -0.02, z); boat.add(seat); }
  const oar = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 2.8, 6), postMat); oar.rotation.set(Math.PI / 2, 0, 0.35); oar.position.set(0.55, 0.12, 0.1); boat.add(oar);
  boat.position.set(3.4, 0.05, 16.5);
  boat.rotation.y = 0.4;
  scene.add(boat);
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const views = {
  home:    { pos: V(4.5, 3.6, 46),  look: V(-1, 8.5, -10) },
  about:   { pos: V(4.2, 2.3, 17),  look: V(-12, 3, -16) },
  work:    { pos: V(0, 14, 32),     look: V(0, 22, -120) },
  contact: { pos: V(2, 2.6, 40),  look: V(-17, 11, 16) },
};

// ---------- lake house: half on the bank, half over the water on stilts ----------
const chimneyTop = new THREE.Vector3();
const houseNav = {};                                  // world-space points for walking in through the front door
const walkPts = [];                                   // walkway centreline (world), used to keep reeds off it
{
  const house = new THREE.Group();
  const DW = 7.2, DD = 6.6;                         // deck footprint
  // local -> world for this house (mirrored on x: local +x is the land side, local -x hangs over the lake)
  const cr = Math.cos(CABIN.rot), sr = Math.sin(CABIN.rot);
  const toWorld = (lx, lz) => { const x = lx * CABIN.side; return [CABIN.x + x * cr + lz * sr, CABIN.z - x * sr + lz * cr]; };
  const groundAt = (lx, lz) => heightAt(...toWorld(lx, lz));
  let highest = 0;
  for (let lx = -DW / 2; lx <= DW / 2; lx += 0.6) for (let lz = -DD / 2; lz <= DD / 2; lz += 0.6) highest = Math.max(highest, groundAt(lx, lz));
  const DECK_Y = highest + 0.35;                    // deck clears the highest ground under the house
  const W = 4.6, D = 3.6, logs = 9, r = 0.16, CZ = -1.2;   // cabin sits toward the back of the deck
  const deckMat = plankMat;

  // deck boards
  for (let z = -DD / 2; z < DD / 2; z += 0.42) {
    const g = new THREE.BoxGeometry(DW, 0.08, 0.38);
    const uv = g.attributes.uv; const off = rand();
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2 + off, uv.getY(i) * 0.25 + off);
    const b = new THREE.Mesh(g, deckMat);
    b.position.set(0, DECK_Y, z + 0.21);
    b.castShadow = b.receiveShadow = true;
    house.add(b);
  }
  // rim joists + stilts driven into the lakebed
  for (const s of [-1, 1]) {
    const jx = new THREE.Mesh(new THREE.BoxGeometry(DW + 0.2, 0.28, 0.16), postMat); jx.position.set(0, DECK_Y - 0.16, s * DD / 2); house.add(jx);
    const jz = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.28, DD + 0.2), postMat); jz.position.set(s * DW / 2, DECK_Y - 0.16, 0); house.add(jz);
  }
  for (const x of [-DW / 2 + 0.2, -1.2, 1.2, DW / 2 - 0.2]) for (const z of [-DD / 2 + 0.2, -0.9, 1.2, DD / 2 - 0.2]) {
    const ground = groundAt(x, z);
    const onLand = ground > 0.05;
    const bottom = onLand ? ground - 0.15 : ground - 0.6;      // stilts are driven into the lakebed
    const stilt = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, DECK_Y - bottom, 10), postMat);
    stilt.position.set(x, (DECK_Y + bottom) / 2, z);
    stilt.castShadow = true;
    house.add(stilt);
    if (onLand) {
      const footing = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.5), new THREE.MeshStandardMaterial({ color: 0x7d7a74, roughness: 1, map: detailTex }));
      footing.position.set(x, ground + 0.05, z); footing.castShadow = footing.receiveShadow = true; house.add(footing);
    }
  }
  // cross bracing between the outer stilts
  for (const lx of [-DW / 2 + 0.2, -1.2]) {
    const low = Math.min(groundAt(lx, -DD / 2), groundAt(lx, DD / 2));
    if (low > -0.3) continue;
    for (const s of [-1, 1]) {
      const br = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, Math.hypot(DD * 0.9, DECK_Y - low - 0.4)), postMat);
      br.position.set(lx, (DECK_Y + low + 0.2) / 2, 0); br.rotation.x = s * Math.atan2(DECK_Y - low - 0.4, DD * 0.9); house.add(br);
    }
  }

  // log cabin on the deck
  const cabin = new THREE.Group();
  const DOOR_X = -0.9, DOOR_W = 0.92, DOOR_H = 1.85;
  const WIN_X = 1.0, WIN_Y = 1.25, WIN_W = 0.95, WIN_H = 0.72;
  for (let i = 0; i < logs; i++) {
    const y = r + i * r * 1.85;
    const walls = [[W + 0.5, 0, -D / 2, 0], [D + 0.5, W / 2, 0, Math.PI / 2], [D + 0.5, -W / 2, 0, Math.PI / 2]];
    // front wall: split each log row around the doorway and the window opening
    const gaps = [];
    if (y + r < DOOR_H + 0.1) gaps.push([DOOR_X - DOOR_W / 2, DOOR_X + DOOR_W / 2]);
    if (y - r < WIN_Y + WIN_H / 2 && y + r > WIN_Y - WIN_H / 2 + 0.03) gaps.push([WIN_X - WIN_W / 2, WIN_X + WIN_W / 2]);
    let from = -(W + 0.5) / 2;
    for (const [a, b] of gaps.sort((p, q) => p[0] - q[0])) { if (a > from) walls.push([a - from, (from + a) / 2, D / 2, 0]); from = b; }
    walls.push([(W + 0.5) / 2 - from, (from + (W + 0.5) / 2) / 2, D / 2, 0]);
    for (const [len, x, z, rot] of walls) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), logMat);
      log.rotation.z = Math.PI / 2; log.rotation.y = rot;
      log.position.set(x, y + (rot ? r * 0.9 : 0), z);
      log.castShadow = log.receiveShadow = true;
      cabin.add(log);
    }
  }
  const wallTop = r + logs * r * 1.85;
  const shingles = (() => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 256;
    const x = c.getContext('2d');
    x.fillStyle = '#4a3b30'; x.fillRect(0, 0, 256, 256);
    for (let row = 0; row < 16; row++) for (let col = -1; col < 9; col++) {
      const w = 32, h = 16, ox = col * w + (row % 2) * 16;
      const v = 60 + rr(-14, 14);
      x.fillStyle = `rgb(${v + 18},${v + 6},${v - 4})`; x.fillRect(ox + 1, row * h + 1, w - 2, h - 1);
      x.fillStyle = 'rgba(0,0,0,.35)'; x.fillRect(ox + 1, row * h + h - 3, w - 2, 3);
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(2.5, 1.5); t.anisotropy = 8;
    return t;
  })();
  const roofMat = new THREE.MeshStandardMaterial({ map: shingles, roughness: 0.95 });
  for (const s of [-1, 1]) {
    const roof = new THREE.Mesh(new THREE.BoxGeometry(W + 1.2, 0.12, D / 2 + 0.9), roofMat);
    roof.position.set(0, wallTop + 0.75, s * (D / 4 + 0.2));
    roof.rotation.x = s * 0.62;
    roof.castShadow = true;
    cabin.add(roof);
  }
  const gable = new THREE.BufferGeometry();
  gable.setAttribute('position', new THREE.Float32BufferAttribute([-D / 2, 0, 0, D / 2, 0, 0, 0, 1.4, 0], 3)); gable.computeVertexNormals();
  for (const x of [-W / 2, W / 2]) { const g = new THREE.Mesh(gable, new THREE.MeshStandardMaterial({ color: 0x4a3322, side: THREE.DoubleSide })); g.rotation.y = Math.PI / 2; g.position.set(x, wallTop, 0); cabin.add(g); }
  // open casement window: frame, lintel and sill in the log wall, two glazed sashes swung outward
  const winFrame = new THREE.Group();
  for (const [w, h, x, y] of [[WIN_W + 0.16, 0.16, 0, WIN_H / 2 + 0.08], [0.08, WIN_H, -WIN_W / 2 - 0.04, 0], [0.08, WIN_H, WIN_W / 2 + 0.04, 0]]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.4), postMat); b.position.set(x, y, 0); winFrame.add(b);
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(WIN_W + 0.4, 0.22, 0.36), logMat); lintel.position.set(0, WIN_H / 2 + 0.2, 0); winFrame.add(lintel);
  const sill = new THREE.Mesh(new THREE.BoxGeometry(WIN_W + 0.3, 0.06, 0.5), postMat); sill.position.set(0, -WIN_H / 2 - 0.03, 0.04); winFrame.add(sill);
  const glassMat = new THREE.MeshStandardMaterial({ color: 0xbfd8e0, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
  const sashes = [];
  for (const s of [-1, 1]) {
    const hinge = new THREE.Group(); hinge.position.set(s * WIN_W / 2, 0, 0.2);
    const sw = WIN_W / 2, sash = new THREE.Group(); sash.position.x = -s * sw / 2;
    for (const [w, h, x, y] of [[sw, 0.05, 0, WIN_H / 2 - 0.025], [sw, 0.05, 0, -WIN_H / 2 + 0.025], [0.05, WIN_H, -sw / 2 + 0.025, 0], [0.05, WIN_H, sw / 2 - 0.025, 0], [sw, 0.03, 0, 0]]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.04), creamTrim); b.position.set(x, y, 0); sash.add(b);
    }
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(sw - 0.06, WIN_H - 0.06), glassMat); sash.add(pane);
    hinge.add(sash); hinge.rotation.y = s * 1.15;          // swung open outward
    winFrame.add(hinge); sashes.push(hinge);
  }
  winFrame.position.set(WIN_X, WIN_Y, D / 2);
  const win = new THREE.Group();
  const doorPivot = new THREE.Group();                         // hinge on the left jamb
  doorPivot.position.set(DOOR_X - DOOR_W / 2 + 0.04, 0, D / 2);
  const doorLeaf = new THREE.Mesh(new THREE.BoxGeometry(DOOR_W - 0.08, DOOR_H - 0.06, 0.07), postMat);
  doorLeaf.position.set((DOOR_W - 0.08) / 2, (DOOR_H - 0.06) / 2, 0);
  doorLeaf.castShadow = true;
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshStandardMaterial({ color: 0xb08a4a, metalness: 0.8, roughness: 0.35 }));
  knob.position.set(DOOR_W - 0.2, 0.95, 0.06);
  doorPivot.add(doorLeaf, knob);
  const door = new THREE.Group();
  for (const [w, h, x, y] of [[0.1, DOOR_H + 0.1, DOOR_X - DOOR_W / 2 - 0.02, (DOOR_H + 0.1) / 2], [0.1, DOOR_H + 0.1, DOOR_X + DOOR_W / 2 + 0.02, (DOOR_H + 0.1) / 2], [DOOR_W + 0.24, 0.12, DOOR_X, DOOR_H + 0.06]]) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.42), postMat); f.position.set(x, y, D / 2); door.add(f);
  }
  door.add(doorPivot);

  // ---- interior ----
  const inner = new THREE.Group();
  const floorTex = plankTex.clone(); floorTex.repeat.set(3, 3); floorTex.needsUpdate = true;
  const floor = new THREE.Mesh(new THREE.BoxGeometry(W - 0.1, 0.04, D - 0.1), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.6 }));
  floor.position.y = 0.02; floor.receiveShadow = true; inner.add(floor);
  for (const z of [-0.7, 0.7]) { const beam = new THREE.Mesh(new THREE.BoxGeometry(W, 0.16, 0.14), logMat); beam.position.set(0, wallTop - 0.08, z); inner.add(beam); }
  // rug
  const rugTex = (() => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 160; const x = c.getContext('2d');
    x.fillStyle = '#7a2e22'; x.fillRect(0, 0, 256, 160);
    x.strokeStyle = '#d9a35a'; x.lineWidth = 6; x.strokeRect(12, 12, 232, 136);
    x.strokeStyle = '#2f3d4a'; x.lineWidth = 4; x.strokeRect(26, 26, 204, 108);
    for (let i = 0; i < 5; i++) { x.fillStyle = i % 2 ? '#d9a35a' : '#2f3d4a'; x.beginPath(); x.moveTo(128, 50 + i * 8); x.lineTo(160 - i * 6, 80); x.lineTo(128, 110 - i * 8); x.lineTo(96 + i * 6, 80); x.fill(); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 1.25), new THREE.MeshStandardMaterial({ map: rugTex, roughness: 1 }));
  rug.rotation.x = -Math.PI / 2; rug.position.set(0.1, 0.05, 0.1); inner.add(rug);
  // stone fireplace on the back wall: a real recessed firebox (two piers, lintel, sooty back), hearthstone in front
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x8a847c, roughness: 1, map: detailTex });
  const sootTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
    x.fillStyle = '#1a1310'; x.fillRect(0, 0, 256, 256);
    for (let row = 0; row < 10; row++) for (let col = -1; col < 6; col++) {          // fire brick, blackened toward the top
      const v = 40 + rr(-10, 10) - row * 2.5;
      x.fillStyle = `rgb(${v + 22},${v + 8},${v})`; x.fillRect(col * 52 + (row % 2) * 26 + 2, row * 26 + 2, 48, 22);
    }
    const g = x.createLinearGradient(0, 0, 0, 256); g.addColorStop(0, 'rgba(0,0,0,.85)'); g.addColorStop(0.7, 'rgba(0,0,0,.25)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, 256, 256);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const sootMat = new THREE.MeshStandardMaterial({ map: sootTex, roughness: 1 });
  const FX = 1.2, FW = 1.4, FH = 1.15, FD = 0.6, OW = 0.8, OH = 0.72;     // fireplace centre x, outer w/h/d, opening w/h
  const zBack = -D / 2 + 0.15, zFront = zBack + FD;
  const box = (w, h, d, x, y, z, m) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); b.castShadow = b.receiveShadow = true; inner.add(b); return b; };
  const pier = (FW - OW) / 2;
  box(pier, FH, FD, FX - OW / 2 - pier / 2, FH / 2, zBack + FD / 2, stoneMat);
  box(pier, FH, FD, FX + OW / 2 + pier / 2, FH / 2, zBack + FD / 2, stoneMat);
  box(OW, FH - OH, FD, FX, OH + (FH - OH) / 2, zBack + FD / 2, stoneMat);
  box(OW, OH, 0.12, FX, OH / 2, zBack + 0.06, sootMat);                                  // back of the firebox
  for (const s of [-1, 1]) box(0.02, OH, FD - 0.12, FX + s * (OW / 2 - 0.01), OH / 2, zBack + 0.12 + (FD - 0.12) / 2, sootMat);   // sooty side walls
  box(OW, 0.02, FD - 0.12, FX, OH - 0.01, zBack + 0.12 + (FD - 0.12) / 2, sootMat);
  box(FW + 0.3, 0.06, 0.5, FX, 0.03, zFront + 0.2, stoneMat);                             // hearthstone
  const stack = new THREE.Mesh(new THREE.BoxGeometry(0.8, wallTop - FH, 0.45), stoneMat); stack.position.set(FX, FH + (wallTop - FH) / 2, zBack + 0.23); inner.add(stack);
  const mantel = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 0.3), logMat); mantel.position.set(FX, FH + 0.04, zFront - 0.05); inner.add(mantel);

  // ---- fire: charred logs with glowing cracks, a coal bed, and a buoyancy-driven particle flame ----
  const fire = new THREE.Group();
  fire.position.set(FX, 0.03, zBack + 0.12 + (FD - 0.12) * 0.45);
  inner.add(fire);
  const charTex = (() => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64; const x = c.getContext('2d');
    x.fillStyle = '#120c08'; x.fillRect(0, 0, 256, 64);
    for (let i = 0; i < 40; i++) { x.fillStyle = `rgba(60,40,28,${rr(0.2, 0.6)})`; x.fillRect(rr(0, 256), rr(0, 64), rr(8, 40), rr(1, 3)); }
    const e = document.createElement('canvas'); e.width = 256; e.height = 64; const y = e.getContext('2d');
    y.fillStyle = '#000'; y.fillRect(0, 0, 256, 64);
    for (let i = 0; i < 26; i++) {                                                        // glowing crack network
      y.strokeStyle = `rgba(255,${(rr(80, 160)) | 0},20,${rr(0.5, 1)})`; y.lineWidth = rr(1, 3);
      y.beginPath(); let px = rr(0, 256), py = rr(0, 64); y.moveTo(px, py);
      for (let k = 0; k < 5; k++) { px += rr(-20, 20); py += rr(-8, 8); y.lineTo(px, py); } y.stroke();
    }
    const a = new THREE.CanvasTexture(c), b = new THREE.CanvasTexture(e); a.colorSpace = b.colorSpace = THREE.SRGBColorSpace;
    return { map: a, emissive: b };
  })();
  const logFireMat = new THREE.MeshStandardMaterial({ map: charTex.map, emissive: 0xffffff, emissiveMap: charTex.emissive, emissiveIntensity: 1.6, roughness: 0.95 });
  for (const [x, z, ry, rz, len] of [[-0.08, 0.03, 0.35, 0.08, 0.62], [0.08, -0.02, -0.4, -0.06, 0.6], [0.0, -0.1, 0.0, 0, 0.66]]) {
    const lg = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, len, 10), logFireMat);
    lg.rotation.set(0, ry, Math.PI / 2 + rz); lg.position.set(x, 0.06 + (z < -0.05 ? 0.0 : 0.05), z); lg.castShadow = true; fire.add(lg);
  }
  const coalMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } }, transparent: true, depthWrite: false,
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: `uniform float uTime; varying vec2 vUv;
      float h(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5); }
      float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
      void main(){
        vec2 p = vUv - .5; float r = length(p * vec2(1., 1.6));
        float lumps = n(vUv * 14.) * .6 + n(vUv * 31. + uTime * .15) * .4;
        float pulse = .65 + .35 * n(vUv * 6. + vec2(uTime * .6, -uTime * .4));
        float heat = smoothstep(.5, .05, r) * smoothstep(.35, .75, lumps) * pulse;
        vec3 c = mix(vec3(.25, .02, 0.), vec3(1.6, .45, .05), heat); c = mix(c, vec3(2.2, 1.2, .35), smoothstep(.75, 1., heat));
        gl_FragColor = vec4(c, smoothstep(.5, .3, r) * (.35 + heat));
      }`,
  });
  coalMat.toneMapped = false;
  const coals = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.42), coalMat); coals.rotation.x = -Math.PI / 2; coals.position.y = 0.012; fire.add(coals);

  // particle flame: each particle carries a temperature; buoyancy ~ temperature, drag, curl-like turbulence, cooling
  const N_FLAME = 320, N_EMBER = 40, N_SMOKE = 46;
  const softDot = `float soft(vec2 c){ float d = length(c - .5) * 2.; return exp(-d * d * 3.5) * step(d, 1.); }`;
  const flameMat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: innerHeight * 0.5 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute float aTemp; attribute float aSize; varying float vT;
      void main(){ vT = aTemp; vec4 mv = modelViewMatrix * vec4(position, 1.); gl_Position = projectionMatrix * mv; gl_PointSize = aSize * 340.0 / -mv.z; }`,
    fragmentShader: `varying float vT; ${softDot}
      void main(){
        float a = soft(gl_PointCoord); if (a <= 0.) discard;
        // blackbody-ish ramp: deep red -> orange -> yellow -> near white with temperature
        vec3 c = mix(vec3(.55, .04, .0), vec3(1., .32, .02), smoothstep(.08, .4, vT));
        c = mix(c, vec3(1., .68, .18), smoothstep(.4, .7, vT));
        c = mix(c, vec3(1., .93, .75), smoothstep(.78, 1., vT));
        gl_FragColor = vec4(c * (.3 + vT * 0.95), a * smoothstep(.0, .2, vT) * .3);
      }`,
  });
  flameMat.toneMapped = false;
  const emberMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute float aTemp; attribute float aSize; varying float vT;
      void main(){ vT = aTemp; vec4 mv = modelViewMatrix * vec4(position, 1.); gl_Position = projectionMatrix * mv; gl_PointSize = max(1.5, aSize * 340.0 / -mv.z); }`,
    fragmentShader: `varying float vT; ${softDot}
      void main(){ float a = soft(gl_PointCoord); gl_FragColor = vec4(vec3(1.9, .75, .2) * vT, a * vT); }`,
  });
  emberMat.toneMapped = false;
  const smokeMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    vertexShader: `attribute float aTemp; attribute float aSize; varying float vT;
      void main(){ vT = aTemp; vec4 mv = modelViewMatrix * vec4(position, 1.); gl_Position = projectionMatrix * mv; gl_PointSize = aSize * 340.0 / -mv.z; }`,
    fragmentShader: `varying float vT; ${softDot}
      void main(){ float a = soft(gl_PointCoord); gl_FragColor = vec4(vec3(.16, .14, .13), a * vT * .22); }`,
  });
  const makeCloud = (n, mat) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('aTemp', new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(n), 1));
    const pts = new THREE.Points(g, mat); pts.frustumCulled = false; fire.add(pts);
    return { g, p: [], n };
  };
  // flame tongues: crossed noise-driven sheets give the fire a coherent licking body inside the particle glow
  const tongueMats = [];
  const tongue = (w, h, x, z, rot, seed) => {
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uSeed: { value: seed } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: `varying vec2 vUv; varying float vFace;
        void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.); vFace = abs(dot(normalize(normalMatrix * normal), normalize(-mv.xyz))); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform float uTime, uSeed; varying vec2 vUv; varying float vFace;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
        float fbm(vec2 p){ float s = 0., a = .5; for (int i = 0; i < 5; i++) { s += a * n(p); p = p * 2.02 + 3.1; a *= .5; } return s; }
        void main(){
          float y = vUv.y, x = vUv.x - .5;
          float n1 = fbm(vec2(x * 3. + uSeed, y * 2.3 - uTime * 2.6));
          float n2 = fbm(vec2(x * 7. - uSeed, y * 4.5 - uTime * 4.1));
          float width = .42 * pow(1. - y, .7) + .02;
          float d = abs(x + (n1 - .5) * .28 * y) / width;
          float body = smoothstep(1., .3, d + (n2 - .5) * .7);
          float top = 1. - smoothstep(.3, .95, y + (n1 - .5) * .5);
          float f = body * top * smoothstep(0., .07, y);
          float T = clamp(f * (1.2 - y * .95), 0., 1.);
          vec3 c = mix(vec3(.55, .04, 0.), vec3(1., .32, .02), smoothstep(.08, .4, T));
          c = mix(c, vec3(1., .68, .18), smoothstep(.4, .7, T));
          c = mix(c, vec3(1., .93, .75), smoothstep(.8, 1., T));
          float facing = smoothstep(.12, .55, vFace);            // sheets fade out as they turn edge-on
          gl_FragColor = vec4(c * (.4 + T * 1.2) * facing, f * .8 * facing);
        }`,
    });
    m.toneMapped = false; tongueMats.push(m);
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
    pl.position.set(x, h / 2 + 0.03, z); pl.rotation.y = rot; fire.add(pl);
  };
  for (let k = 0; k < 3; k++) tongue(0.46, 0.62, 0, 0, (k * Math.PI) / 3, k * 7.3);
  tongue(0.3, 0.42, -0.13, 0.02, 0.4, 21); tongue(0.3, 0.45, 0.13, -0.02, -0.5, 33);
  const flames = makeCloud(N_FLAME, flameMat), embers = makeCloud(N_EMBER, emberMat), smoke = makeCloud(N_SMOKE, smokeMat);
  smoke.g.computeBoundingSphere();
  const spawnFlame = (o = {}) => Object.assign(o, {
    x: rr(-0.2, 0.2), y: rr(0.05, 0.11), z: rr(-0.08, 0.07), vx: 0, vy: rr(0.05, 0.25), vz: 0,
    T: rr(0.82, 1), cool: rr(1.15, 2.1), size: rr(0.2, 0.32), seed: rr(0, 100),
  });
  const spawnEmber = (o = {}) => Object.assign(o, {
    x: rr(-0.15, 0.15), y: rr(0.08, 0.16), z: rr(-0.05, 0.05), vx: rr(-0.35, 0.35), vy: rr(0.7, 1.6), vz: rr(-0.25, 0.2),
    T: 1, heat: rr(0.7, 1.1), life: rr(0.8, 2.2), size: rr(0.008, 0.016), seed: rr(0, 100),
  });
  const spawnSmoke = (o = {}) => Object.assign(o, {
    x: rr(-0.12, 0.12), y: rr(0.42, 0.55), z: rr(-0.06, 0.04), vy: rr(0.25, 0.45), T: 1, size: rr(0.14, 0.22), seed: rr(0, 100),
  });
  for (let i = 0; i < N_FLAME; i++) { const f = spawnFlame(); f.T = rr(0, 1); f.y += (1 - f.T) * 0.4; flames.p.push(f); }
  for (let i = 0; i < N_EMBER; i++) { const e = spawnEmber(); e.T = 0; e.life = rr(0, 2); embers.p.push(e); }
  for (let i = 0; i < N_SMOKE; i++) { const s = spawnSmoke(); s.T = rr(0, 1); smoke.p.push(s); }
  // smooth pseudo-curl field: divergence-free-ish swirls that grow with height
  const swirl = (x, y, z, t, s) => [
    Math.sin(y * 9.1 - t * 6.3 + s) * 0.7 + Math.sin(z * 13.0 + y * 5.0 - t * 9.7) * 0.35,
    Math.sin(x * 11.0 + t * 4.1 + s * 0.5) * 0.25,
    Math.cos(y * 8.3 - t * 7.1 + s * 1.3) * 0.55 + Math.sin(x * 12.0 - t * 5.3) * 0.3,
  ];
  let fireHeat = 1;
  const updateFire = (dt, t) => {
    dt = Math.min(dt, 0.033);
    let heatSum = 0;
    const fp = flames.g.attributes.position.array, ft = flames.g.attributes.aTemp.array, fs = flames.g.attributes.aSize.array;
    flames.p.forEach((f, i) => {
      f.T -= f.cool * dt * (0.7 + f.y * 1.6);                         // cools faster as it rises
      if (f.T <= 0 || f.y > 0.72) spawnFlame(f);
      const h = Math.max(0, f.y - 0.06);
      const [sx, sy, sz] = swirl(f.x, f.y, f.z, t, f.seed);
      const drag = 2.4;
      f.vy += (3.2 * f.T - drag * f.vy + sy * 0.3) * dt;              // buoyancy proportional to temperature
      f.vx += (sx * (0.6 + h * 5) - drag * f.vx - f.x * (4 + h * 10)) * dt;   // turbulence + plume pulling inward (necking)
      f.vz += (sz * (0.5 + h * 4) - drag * f.vz - f.z * (4 + h * 10)) * dt;
      f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
      fp[i * 3] = f.x; fp[i * 3 + 1] = f.y; fp[i * 3 + 2] = f.z;
      ft[i] = Math.max(0, f.T); fs[i] = f.size * (0.3 + f.T * 0.85);
      heatSum += f.T;
    });
    flames.g.attributes.position.needsUpdate = flames.g.attributes.aTemp.needsUpdate = flames.g.attributes.aSize.needsUpdate = true;

    const ep = embers.g.attributes.position.array, et = embers.g.attributes.aTemp.array, es = embers.g.attributes.aSize.array;
    embers.p.forEach((e, i) => {
      e.life -= dt;
      if (e.life <= 0) { if (Math.random() < dt * 2.5) spawnEmber(e); else { et[i] = 0; return; } }
      e.heat = Math.max(0, e.heat - dt * 0.6);
      const [sx, , sz] = swirl(e.x, e.y, e.z, t, e.seed);
      e.vy += (1.7 * e.heat - 1.1 - 0.6 * e.vy) * dt;                  // buoyant while hot, then gravity wins
      e.vx += (sx * 1.2 - 0.6 * e.vx) * dt; e.vz += (sz * 1.0 - 0.6 * e.vz) * dt;
      e.x += e.vx * dt; e.y += e.vy * dt; e.z += e.vz * dt;
      if (e.y < 0.02) { e.y = 0.02; e.vy *= -0.3; e.vx *= 0.5; }      // land on the coals and bounce a little
      ep[i * 3] = e.x; ep[i * 3 + 1] = e.y; ep[i * 3 + 2] = e.z;
      et[i] = Math.min(1, e.life) * (0.6 + 0.4 * Math.sin(t * 40 + e.seed)); es[i] = e.size;
    });
    embers.g.attributes.position.needsUpdate = embers.g.attributes.aTemp.needsUpdate = embers.g.attributes.aSize.needsUpdate = true;

    const sp = smoke.g.attributes.position.array, st = smoke.g.attributes.aTemp.array, ss = smoke.g.attributes.aSize.array;
    smoke.p.forEach((s, i) => {
      s.T -= dt * 0.55;
      if (s.T <= 0) spawnSmoke(s);
      const [sx, , sz] = swirl(s.x, s.y, s.z, t * 0.5, s.seed);
      s.y += s.vy * dt; s.x += sx * 0.05 * dt - s.x * 0.8 * dt; s.z += sz * 0.04 * dt - (s.z + 0.05) * 0.6 * dt;   // drawn back and up into the flue
      sp[i * 3] = s.x; sp[i * 3 + 1] = s.y; sp[i * 3 + 2] = s.z;
      st[i] = s.T * smooth(0.42, 0.55, s.y) * (1 - smooth(0.62, 0.72, s.y + 0.0)); ss[i] = s.size * (1.6 - s.T * 0.6);
    });
    smoke.g.attributes.position.needsUpdate = smoke.g.attributes.aTemp.needsUpdate = smoke.g.attributes.aSize.needsUpdate = true;

    // light follows the actual heat of the flame, with fast crackle on top
    const target = heatSum / (N_FLAME * 0.5);
    fireHeat += (target - fireHeat) * Math.min(1, dt * 8);
    const crackle = 0.85 + 0.15 * Math.sin(t * 31) * Math.sin(t * 17.3);
    fireLight.intensity = 3.0 * fireHeat * crackle;
    fireLight.position.set(FX + Math.sin(t * 7.1) * 0.03, 0.45 + Math.sin(t * 5.3) * 0.04, zFront + 0.25);
    logFireMat.emissiveIntensity = 1.1 + 0.6 * fireHeat * crackle;
    coalMat.uniforms.uTime.value = t;
    tongueMats.forEach(m => { m.uniforms.uTime.value = t; });
  };
  const fireLight = new THREE.PointLight(0xff7a2a, 3.5, 6, 2); inner.add(fireLight);
  // table, lamp, chair
  const table = new THREE.Group();
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.05, 0.62), logMat); top.position.y = 0.75; top.castShadow = true; table.add(top);
  for (const [lx, lz] of [[-0.44, -0.25], [0.44, -0.25], [-0.44, 0.25], [0.44, 0.25]]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.73, 0.05), logMat); leg.position.set(lx, 0.37, lz); table.add(leg); }
  const lampBase = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.3, 10), new THREE.MeshStandardMaterial({ color: 0x3a3028, metalness: 0.5, roughness: 0.5 })); lampBase.position.set(0.28, 0.93, -0.08); table.add(lampBase);
  const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.17, 0.18, 14, 1, true), new THREE.MeshStandardMaterial({ color: 0xf2d9a8, emissive: 0xffb060, emissiveIntensity: 1.4, side: THREE.DoubleSide })); shade.position.set(0.28, 1.13, -0.08); table.add(shade);
  const book = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.04, 0.3), new THREE.MeshStandardMaterial({ color: 0x2e4a5c })); book.position.set(-0.2, 0.795, 0.05); book.rotation.y = 0.3; table.add(book);
  const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.09, 12), new THREE.MeshStandardMaterial({ color: 0xe9e2d4 })); mug.position.set(0.05, 0.82, 0.15); table.add(mug);
  table.position.set(-0.9, 0, -0.75); inner.add(table);
  const lampLight = new THREE.PointLight(0xffb060, 2.6, 6, 2); lampLight.position.set(-0.62, 1.15, -0.83); inner.add(lampLight);
  const chair = new THREE.Group();
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.05, 0.45), logMat); seat.position.y = 0.45; chair.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.5, 0.05), logMat); back.position.set(0, 0.72, -0.2); chair.add(back);
  for (const [lx, lz] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.45, 0.04), logMat); leg.position.set(lx, 0.22, lz); chair.add(leg); }
  chair.position.set(-0.9, 0, -0.05); chair.rotation.y = Math.PI; inner.add(chair);
  // bookshelf on the side wall
  const shelf = new THREE.Group();
  const carcass = new THREE.Mesh(new THREE.BoxGeometry(0.32, 1.7, 1.0), logMat); carcass.position.y = 0.85; shelf.add(carcass);
  const spines = [0x7a2e22, 0x2e4a5c, 0xd9a35a, 0x3e5a3a, 0x5a3a5a, 0xc9b38a];
  for (let s = 0; s < 4; s++) {
    let z = -0.42;
    while (z < 0.4) {
      const w = rr(0.04, 0.08), h = rr(0.22, 0.32);
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.22, h, w), new THREE.MeshStandardMaterial({ color: spines[(rand() * spines.length) | 0], roughness: 0.8 }));
      b.position.set(0.06, 0.2 + s * 0.4 + h / 2, z + w / 2); shelf.add(b); z += w + 0.01;
    }
  }
  shelf.position.set(-W / 2 + 0.36, 0, -0.6); inner.add(shelf);
  door.add(inner);
  houseNav.doorPivot = doorPivot; houseNav.fire = fire; houseNav.fireLight = fireLight; houseNav.updateFire = updateFire; houseNav.lampLight = lampLight; houseNav.door = 0; houseNav.doorTarget = 0;
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.2, 0.5), new THREE.MeshStandardMaterial({ color: 0x55525a, roughness: 1 }));
  chimney.position.set(1.4, wallTop + 1.1, -0.5); chimney.castShadow = true;
  cabin.add(winFrame, win, door, chimney);
  cabin.position.set(0, DECK_Y + 0.04, CZ);
  house.add(cabin);

  // covered porch: two posts and a shed roof in front of the door
  const porchZ = CZ + D / 2 + 1.5;
  for (const x of [-W / 2, W / 2]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, wallTop, 8), postMat);
    post.position.set(x, DECK_Y + wallTop / 2, porchZ); post.castShadow = true; house.add(post);
  }
  const porchRoof = new THREE.Mesh(new THREE.BoxGeometry(W + 0.6, 0.1, 1.9), roofMat);
  porchRoof.position.set(0, DECK_Y + wallTop + 0.12, porchZ - 0.6); porchRoof.rotation.x = 0.22; porchRoof.castShadow = true;
  house.add(porchRoof);

  // railing around the open deck edge, with a gap where the walkway joins
  const railH = 0.95, railMat = postMat;
  const rail = (x1, z1, x2, z2) => {
    const len = Math.hypot(x2 - x1, z2 - z1), ang = Math.atan2(x2 - x1, z2 - z1);
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.07, len), railMat);
    top.position.set((x1 + x2) / 2, DECK_Y + railH, (z1 + z2) / 2); top.rotation.y = ang; house.add(top);
    const n = Math.max(2, Math.round(len / 0.45));
    for (let i = 0; i <= n; i++) {
      const t = i / n, b = new THREE.Mesh(new THREE.BoxGeometry(0.05, railH, 0.05), railMat);
      b.position.set(x1 + (x2 - x1) * t, DECK_Y + railH / 2, z1 + (z2 - z1) * t); house.add(b);
    }
  };
  const ex = DW / 2 - 0.05, ez = DD / 2 - 0.05;
  rail(-ex, ez, ex, ez);          // front
  rail(-ex, -ez, -ex, ez);        // left side
  rail(-ex, -ez, ex, -ez);        // back
  rail(ex, -ez, ex, 0.2);         // land side, open where the steps go down (z 0.2 .. 1.8)
  rail(ex, 1.8, ex, ez);

  // porch lantern + window light
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.2, 10), lampGlowMat);
  lamp.position.set(W / 2 - 0.15, DECK_Y + wallTop - 0.35, porchZ - 0.05); house.add(lamp);
  const porchLight = new THREE.PointLight(0xffa050, 2.2, 9, 2); porchLight.position.copy(lamp.position); house.add(porchLight);
  const winLight = new THREE.PointLight(0xff9a40, 2.0, 8, 2); winLight.position.set(1.0, DECK_Y + 1.3, CZ + D / 2 + 0.9); house.add(winLight);
  lampLights.push(porchLight, winLight);

  // ladder down into the water off the front
  for (const x of [-0.25, 0.25]) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.6, 0.05), postMat); s.position.set(-2.4 + x, DECK_Y - 0.6, ez + 0.08); house.add(s); }
  for (let k = 0; k < 4; k++) { const rung = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.04, 0.04), postMat); rung.position.set(-2.4, DECK_Y - 0.2 - k * 0.35, ez + 0.08); house.add(rung); }

  house.position.set(CABIN.x, 0, CABIN.z);
  house.rotation.y = CABIN.rot;
  house.scale.x = CABIN.side;          // mirrored so the walkway side faces the left shore
  scene.add(house);
  house.updateMatrixWorld();
  cabin.updateMatrixWorld();
  chimneyTop.set(1.4, wallTop + 2.3, -0.5).applyMatrix4(cabin.matrixWorld);
  const w = (x, y, z) => cabin.localToWorld(new THREE.Vector3(x, y, z));
  Object.assign(houseNav, {
    porch: w(DOOR_X, 1.7, D / 2 + 3.4),          // standing on the deck, facing the door
    stoop: w(DOOR_X, 1.55, D / 2 + 0.9),
    threshold: w(DOOR_X, 1.5, D / 2),
    inside: w(DOOR_X + 0.1, 1.55, D / 2 - 0.42),
    doorLook: w(DOOR_X, 1.05, D / 2 - 0.5),
    roomLook: w(0.35, 0.95, -D / 2),
    winApproach: w(WIN_X + 0.3, WIN_Y + 0.45, D / 2 + 2.6),   // under the porch roof, lined up with the open window
    winOut: w(WIN_X, WIN_Y + 0.08, D / 2 + 0.9),
    winCenter: w(WIN_X, WIN_Y, D / 2),
    winIn: w(WIN_X - 0.1, WIN_Y + 0.02, D / 2 - 0.7),
    lampTop: w(-0.62, 1.27, -0.83),                       // lands on the table lamp's shade
    winInside: w(WIN_X + 0.05, WIN_Y + 0.25, D / 2 - 0.4),  // camera rests just inside the window
    lampLook: w(-1.2, 1.05, -D / 2 + 0.2),
  });

  // steps from the deck's open land side down to the bank
  const stepGround = groundAt(DW / 2 + 1.2, 1.0);
  const rise = DECK_Y - stepGround, nSteps = Math.max(1, Math.round(rise / 0.22));
  for (let k = 1; k <= nSteps; k++) {
    const tread = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.07, 1.4), plankMat);
    tread.position.set(DW / 2 + k * 0.32, DECK_Y - k * (rise / (nSteps + 0.5)), 1.0);
    tread.castShadow = tread.receiveShadow = true;
    house.add(tread);
  }
  for (const z of [0.3, 1.7]) {
    const len = Math.hypot(nSteps * 0.32, rise);
    const stringer = new THREE.Mesh(new THREE.BoxGeometry(len, 0.18, 0.06), postMat);
    stringer.position.set(DW / 2 + nSteps * 0.16, DECK_Y - rise / 2, z);
    stringer.rotation.z = -Math.atan2(rise, nSteps * 0.32);
    house.add(stringer);
  }
}



// ---------- dirt path to the dock ----------
const pathCurve = new THREE.CatmullRomCurve3([
  V(14, 0, 62), V(10, 0, 55), V(5.5, 0, 50), V(6.5, 0, 44), V(3.5, 0, 39), V(1.2, 0, 35.5), V(0, 0, 33.2),
]);
const pathPts = pathCurve.getSpacedPoints(160);
const nearPath = (x, z, r) => pathPts.some(p => (p.x - x) ** 2 + (p.z - z) ** 2 < r * r);
{
  const pos = [], col = [], idx = [], c = new THREE.Color();
  pathPts.forEach((p, i) => {
    const tng = pathCurve.getTangentAt(i / (pathPts.length - 1));
    const side = new THREE.Vector3(-tng.z, 0, tng.x).normalize();
    const w = 0.75 + Math.sin(i * 0.37) * 0.12 + rr(-0.05, 0.05);
    for (const s of [-1, -0.45, 0.45, 1]) {
      const x = p.x + side.x * w * s, z = p.z + side.z * w * s;
      pos.push(x, heightAt(x, z) + 0.05, z);
      const edge = Math.abs(s) === 1;
      c.setRGB(0.50, 0.41, 0.30).multiplyScalar(rr(0.85, 1.05) * (edge ? 0.8 : 1));
      col.push(c.r, c.g, c.b);
    }
    if (i < pathPts.length - 1) for (let k = 0; k < 3; k++) {
      const a = i * 4 + k, b = a + 4;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2 }));
  m.receiveShadow = true;
  scene.add(m);
}

// ---------- shoreline bushes ----------
{
  const parts = [];
  let placed = 0, guard = 0;
  while (placed < 70 && guard++ < 3000) {
    const a = rr(0, Math.PI * 2), r = rr(LAKE_R + 1.5, LAKE_R + 9);
    const x = Math.cos(a) * r / STRETCH, z = Math.sin(a) * r;
    const y = heightAt(x, z);
    if (y < 0.4 || nearPath(x, z, 2.2) || (Math.abs(x) < 3 && z > 12) || Math.hypot(x - CABIN.x, z - CABIN.z) < 5.5 || walkPts.some(p => (p.x - x) ** 2 + (p.z - z) ** 2 < 5)) continue;
    if (Object.values(views).some(v => Math.hypot(x - v.pos.x, z - v.pos.z) < 5)) continue;
    const lobes = 3 + ((rand() * 3) | 0), size = rr(0.5, 1.1);
    for (let k = 0; k < lobes; k++) {
      const g = new THREE.IcosahedronGeometry(size * rr(0.6, 1), 2);
      const p = g.attributes.position, o = rr(0, 50);
      for (let i = 0; i < p.count; i++) {
        const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i), d = 1 + fbm(vx * 2 + o, vz * 2 + vy * 1.5, 2) * 0.35;
        p.setXYZ(i, vx * d, Math.max(vy * d * 0.75, -0.1), vz * d);
      }
      g.translate(x + rr(-0.6, 0.6) * size, y + size * 0.35, z + rr(-0.6, 0.6) * size);
      const n = p.count, cc = new Float32Array(n * 3), tone = new THREE.Color().setHSL(0.27 + rr(-0.04, 0.04), 0.42, 0.24 + rr(-0.04, 0.05));
      for (let i = 0; i < n; i++) { const k2 = 0.75 + 0.35 * Math.min(1, Math.max(0, (p.getY(i) - y) / size)); cc[i * 3] = tone.r * k2; cc[i * 3 + 1] = tone.g * k2; cc[i * 3 + 2] = tone.b * k2; }
      g.setAttribute('color', new THREE.BufferAttribute(cc, 3));
      g.deleteAttribute('uv');
      parts.push(g);
    }
    placed++;
  }
  const g = mergeGeometries(parts); g.computeVertexNormals();
  const bushes = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, map: detailTex }));
  bushes.castShadow = bushes.receiveShadow = true;
  scene.add(bushes);
}

// ---------- grass & reeds (instanced, wind) ----------
function windMaterial(color, strength) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0, side: THREE.DoubleSide, vertexColors: true });
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, windU);
    sh.vertexShader = WIND_GLSL + sh.vertexShader.replace('#include <begin_vertex>',
      `#include <begin_vertex>
       vec4 ip = instanceMatrix * vec4(0.,0.,0.,1.);
       vec3 wd = windLocal();
       float travel = sin(dot(ip.xz, uWindDir) * .32 - uTime * 2.3) * .5 + .5;              // gust bands rolling across the field
       float flutter = sin(uTime * 6.5 + ip.x * 4.1 + ip.z * 2.7) * .18 + sin(uTime * 11. + ip.z * 7.) * .07;
       float bend = (uWind * (.35 + .9 * travel) + flutter * (.3 + uWind)) * ${(strength * 1.25).toFixed(3)};
       transformed += wd * bend * position.y * position.y;
       transformed.y -= abs(bend) * .18 * position.y * position.y;                         // bent blades get shorter`);
  };
  return m;
}
function bladeGeo(h, w, segs) {
  const pos = [], colr = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, ww = w * (1 - t * 0.95), y = t * h, bend = t * t * h * 0.18;
    pos.push(-ww / 2, y, bend, ww / 2, y, bend);
    const c = 0.35 + t * 0.65; colr.push(c, c, c, c, c, c);
    if (i < segs) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
function scatter(mesh, n, pick) {
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3(), e = new THREE.Euler();
  let i = 0, guard = 0;
  while (i < n && guard++ < n * 30) {
    const p = pick(); if (!p) continue;
    q.setFromEuler(e.set(rr(-0.2, 0.2), rr(0, 6.28), rr(-0.2, 0.2)));
    s.setScalar(p[3]);
    mesh.setMatrixAt(i++, m.compose(v.set(p[0], p[1], p[2]), q, s));
  }
  mesh.count = i;
  return mesh;
}
{
  const GRASS = MOBILE ? 30000 : 60000;
  const grass = new THREE.InstancedMesh(bladeGeo(0.55, 0.05, 4), windMaterial(0x93b553, 0.35), GRASS);
  scatter(grass, GRASS, () => {
    const x = rr(-30, 30), z = rr(LAKE_R - 2, 60);
    const y = heightAt(x, z);
    if (y < 0.25 || Math.hypot(x * STRETCH, z) < LAKE_R) return null;
    if (Math.abs(x) < 1.4 && z < 34) return null;
    if (nearPath(x, z, 1.0)) return null;
    if (Math.hypot(x - CABIN.x, z - CABIN.z) < 6) return null;
    if (walkPts.some(p => (p.x - x) ** 2 + (p.z - z) ** 2 < 1.5)) return null;
    if (Object.values(views).some(v => Math.hypot(x - v.pos.x, z - v.pos.z) < 4)) return null;   // nothing right at the lens
    return [x, y - 0.03, z, rr(0.6, 1.4)];
  });
  grass.receiveShadow = true;
  scene.add(grass);
  const reflect = water.onBeforeRender;
  let reflectFrame = 0;
  // the mirror pass re-renders the whole world; do it every other frame (water distortion hides the lag) and skip grass/reeds
  water.onBeforeRender = function (...args) {
    if (reflectFrame++ % 2) return;
    grass.visible = reeds.visible = false; reflect.apply(this, args); grass.visible = reeds.visible = true;
  };
  const reeds = new THREE.InstancedMesh(bladeGeo(1.6, 0.04, 5), windMaterial(0x6f8a45, 0.12), 6000);
  scatter(reeds, 6000, () => {
    const a = rr(0, Math.PI * 2), r = rr(LAKE_R - 5, LAKE_R + 1);
    const x = Math.cos(a) * r / STRETCH, z = Math.sin(a) * r;
    const y = heightAt(x, z);
    if (y < -1 || y > 0.9 || (Math.abs(x) < 2.2 && z > 10)) return null;
    if (walkPts.some(p => (p.x - x) ** 2 + (p.z - z) ** 2 < 2.2)) return null;
    if (Math.hypot(x - CABIN.x, z - CABIN.z) < 5.5) return null;
    return [x, Math.max(y, -0.5), z, rr(0.7, 1.3)];
  });
  scene.add(reeds);
}

// ---------- fireflies & chimney smoke ----------
function softSprite() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.3, 'rgba(255,255,255,.5)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
const sprite = softSprite();
const flies = (() => {
  const n = 140, pos = new Float32Array(n * 3), base = [];
  for (let i = 0; i < n; i++) {
    const x = rr(-25, 25), z = rr(LAKE_R - 6, 38);
    base.push([x, Math.max(heightAt(x, z), 0) + rr(0.4, 2.5), z, rr(0, 6.28)]);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: new THREE.Color(1.8, 1.6, 0.6), map: sprite, size: 0.12, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  scene.add(new THREE.Points(g, mat));
  return { g, base, mat };
})();
const smoke = (() => {
  const n = 50, pos = new Float32Array(n * 3), life = [];
  for (let i = 0; i < n; i++) life.push(i / n);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: 0x8a8f9e, map: sprite, size: 1.0, transparent: true, opacity: 0.025, depthWrite: false });
  scene.add(new THREE.Points(g, mat));
  return { g, life };
})();

// ---------- post: bloom + grain/vignette ----------
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.35, 0.5, 0.9);
composer.addPass(bloom);
composer.addPass(new OutputPass());
const grainPass = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)) + uTime*7.)*43758.5453); }
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float v = smoothstep(1.15, .35, length(vUv - .5));
      c *= mix(.72, 1., v);
      c += (h(vUv*vec2(1920.,1080.)) - .5) * .035;
      gl_FragColor = vec4(c, 1.);
    }`,
});
composer.addPass(grainPass);

// ---------- camera & sections ----------
const markerDefs = [
  { at: V(0, 3.2, 13.3), go: 'about', label: 'About' },
  { at: V(houseNav.porch.x, 6.0, houseNav.porch.z), go: 'contact', label: 'Contact' },   // above the porch roof, inside the home view's frame
  { at: V(30, 26, -110), go: 'work', label: 'Work' },
];
const camPos = views.home.pos.clone().add(V(0, 5, 18)), camLook = views.home.look.clone();
const tgtPos = views.home.pos.clone(), tgtLook = views.home.look.clone();
const look = { yaw: 0, pitch: 0, ty: 0, tp: 0, drag: false, lx: 0, ly: 0 };

canvas.addEventListener('pointerdown', e => { look.drag = true; look.lx = e.clientX; look.ly = e.clientY; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', e => {
  if (!look.drag) return;
  look.ty = THREE.MathUtils.clamp(look.ty - (e.clientX - look.lx) * 0.004, -0.9, 0.9);
  look.tp = THREE.MathUtils.clamp(look.tp - (e.clientY - look.ly) * 0.003, -0.35, 0.45);
  look.lx = e.clientX; look.ly = e.clientY;
});
const endDrag = () => { look.drag = false; };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

const navLinks = [...document.querySelectorAll('.dock-nav a')];
const glow = document.querySelector('.nav-glow');
function placeGlow() {
  const on = document.querySelector('.dock-nav a.on');
  glow.style.width = on.offsetWidth + 'px';
  glow.style.transform = `translateX(${on.offsetLeft}px)`;
}
// scripted camera walks (into and out of the lake house)
let walk = null;
const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
// camera moves at physical speeds along the path: accelerates, cruises over the lake, brakes to walking pace
// for the stretch around the door (slow zone), and eases to a stop at the end
const CRUISE = 20, WALK = 4.5, ACCEL = 16;          // m/s, m/s, m/s²
function startWalk(points, looks, slowFrom, slowTo, { doorOpenAt, doorCloseAt, onDone } = {}) {
  const path = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const lens = path.getLengths(400), L = lens[lens.length - 1];
  const arcTo = p => {                              // arc length at the sampled point nearest p
    let best = 0, bd = Infinity;
    for (let i = 0; i <= 400; i++) { const d = path.getPoint(i / 400).distanceToSquared(p); if (d < bd) { bd = d; best = i; } }
    return lens[best];
  };
  walk = {
    path, looks: new THREE.CatmullRomCurve3(looks, false, 'centripetal'), L,
    s: 0, v: 0, t: 0, s0: arcTo(slowFrom), s1: arcTo(slowTo),
    doorOpenAt, doorCloseAt, onDone,
  };
  walk.doorOpenS = doorOpenAt !== undefined ? walk.s0 - 3.0 : undefined;   // door swings as you arrive on the porch
  walk.doorCloseS = doorCloseAt !== undefined ? walk.s1 + 1.0 : undefined; // and closes once you're past it
}
const showPanel = section => { for (const id of Object.keys(views)) document.getElementById(id).hidden = id !== section; };
let insideHouse = false;

function go(section) {
  if (!views[section]) return;
  const wasInside = insideHouse;
  document.body.dataset.section = section;
  navLinks.forEach(a => a.classList.toggle('on', a.dataset.go === section));
  placeGlow();
  look.ty = 0; look.tp = 0;
  history.replaceState(null, '', '#' + section);

  if (section === 'contact' && !insideHouse) {
    // walk up onto the porch, open the door, step inside; the contact card appears once we're in the room
    showPanel(null);
    const above = camPos.clone().lerp(houseNav.porch, 0.5); above.y = Math.max(above.y, houseNav.porch.y + 0.8);
    startWalk([camPos.clone(), above, houseNav.porch, houseNav.stoop, houseNav.threshold, houseNav.inside],
              [camLook.clone(), houseNav.doorLook, houseNav.doorLook, houseNav.doorLook, houseNav.roomLook, houseNav.roomLook],
              houseNav.porch, houseNav.inside,
              { doorOpenAt: true, onDone: () => { insideHouse = true; document.body.classList.add('inside'); showPanel('contact'); } });
    tgtPos.copy(houseNav.inside); tgtLook.copy(houseNav.roomLook);
    return;
  }
  if (section === 'contact') { showPanel('contact'); return; }

  if (wasInside) {
    // back out through the door, close it behind us, then head to the requested view
    showPanel(null);
    insideHouse = false;
    document.body.classList.remove('inside');
    const out = houseNav.porch.clone().lerp(views[section].pos, 0.25); out.y = Math.max(out.y, houseNav.porch.y + 1.2);
    startWalk([camPos.clone(), houseNav.threshold, houseNav.stoop, houseNav.porch, out, views[section].pos],
              [camLook.clone(), houseNav.porch, houseNav.porch, views[section].look, views[section].look, views[section].look],
              camPos.clone(), houseNav.stoop,
              { doorCloseAt: true, onDone: () => showPanel(section) });
    tgtPos.copy(views[section].pos); tgtLook.copy(views[section].look);
    houseNav.doorTarget = 1;
    return;
  }
  showPanel(section);
  tgtPos.copy(views[section].pos); tgtLook.copy(views[section].look);
}
document.addEventListener('click', e => {
  const el = e.target.closest('[data-go]');
  if (!el) return;
  e.preventDefault(); go(el.dataset.go);
});
addEventListener('keydown', e => { if (e.key === 'Escape') go('home'); });

const markersEl = document.querySelector('.markers');
const markers = markerDefs.map(d => {
  const b = document.createElement('button');
  b.className = 'marker'; b.type = 'button'; b.dataset.go = d.go;
  b.setAttribute('aria-label', d.label);
  b.innerHTML = `<span>${d.label}</span>`;
  markersEl.appendChild(b);
  return b;
});

// ---------- day / night ----------
let day = 0, dayTarget = 0;
document.querySelector('.mode-toggle').addEventListener('click', () => {
  dayTarget = dayTarget ? 0 : 1;
  document.body.dataset.mode = dayTarget ? 'day' : 'night';
});

// ---------- ambient sound (generated: water + crickets / birds) ----------
let audio = null;
const soundBtn = document.querySelector('.sound-toggle');
function startAudio() {
  const ctx = new AudioContext();
  const master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
  const buf = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate), d = buf.getChannelData(0);
  let b = 0; for (let i = 0; i < d.length; i++) { b = 0.97 * b + 0.03 * (Math.random() * 2 - 1); d[i] = b * 4; }
  const water = ctx.createBufferSource(); water.buffer = buf; water.loop = true;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500;
  const lap = ctx.createGain(); lap.gain.value = 0.5;
  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.18; const lfoG = ctx.createGain(); lfoG.gain.value = 0.25;
  lfo.connect(lfoG).connect(lap.gain);
  water.connect(lp).connect(lap).connect(master); water.start(); lfo.start();
  const fx = ctx.createGain(); fx.gain.value = 0.04; fx.connect(master);
  const call = () => {
    if (!audio) return;
    const t = ctx.currentTime;
    if (dayTarget) {   // bird: a quick descending whistle
      const o = ctx.createOscillator(), g = ctx.createGain();
      const f0 = 2600 + Math.random() * 900;
      o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f0 * 0.7, t + 0.18);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.6, t + 0.02); g.gain.linearRampToValueAtTime(0, t + 0.2);
      o.connect(g).connect(fx); o.start(t); o.stop(t + 0.22);
    } else {           // cricket: three short chirps
      for (let k = 0; k < 3; k++) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 4200 + Math.random() * 300;
        g.gain.setValueAtTime(0, t + k * 0.07); g.gain.linearRampToValueAtTime(1, t + k * 0.07 + 0.01); g.gain.linearRampToValueAtTime(0, t + k * 0.07 + 0.045);
        o.connect(g).connect(fx); o.start(t + k * 0.07); o.stop(t + k * 0.07 + 0.06);
      }
    }
    setTimeout(call, 600 + Math.random() * 1600);
  };
  const wbuf = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate), wd = wbuf.getChannelData(0);
  for (let i = 0; i < wd.length; i++) wd[i] = Math.random() * 2 - 1;
  const windSrc = ctx.createBufferSource(); windSrc.buffer = wbuf; windSrc.loop = true;
  const windFilter = ctx.createBiquadFilter(); windFilter.type = 'bandpass'; windFilter.frequency.value = 450; windFilter.Q.value = 0.6;
  const windGain = ctx.createGain(); windGain.gain.value = 0.05;
  windSrc.connect(windFilter).connect(windGain).connect(master); windSrc.start();
  audio = { ctx, master, windGain, windFilter };
  call();
}
soundBtn.addEventListener('click', () => {
  if (!audio) startAudio();
  const on = soundBtn.dataset.on !== 'true';
  soundBtn.dataset.on = String(on);
  audio.ctx.resume();
  audio.master.gain.setTargetAtTime(on ? 0.5 : 0, audio.ctx.currentTime, 0.4);
});

// ---------- loader ----------
const loaderEl = document.querySelector('.loader');
const moonShadow = document.querySelector('.moon-shadow');
const pctEl = document.querySelector('.loader-pct');
const lineEl = document.querySelector('.loader-line');
const lines = ['Gathering moonlight…', 'Stilling the water…', 'Lighting the lanterns…', 'Planting spruce…', 'Warming the cabin…', 'Waking the fireflies…', 'Raising the mountains…'];
let li = 0;
const lineTimer = setInterval(() => { li = (li + 1) % lines.length; lineEl.textContent = lines[li]; }, 1100);
let shown = 0, firstFrame = false, assetsReady = false;
function markLoaded() { assetsReady = true; }
setTimeout(markLoaded, 8000); // never hang the loader if the CDN texture is slow
function stepLoader() {
  const cap = firstFrame && assetsReady ? 100 : 85;
  shown = Math.min(cap, shown + (cap - shown) * 0.06 + 0.4);
  pctEl.textContent = Math.round(shown) + '%';
  moonShadow.style.setProperty('--p', (shown / 100).toFixed(3));
  if (shown >= 99.5) { pctEl.textContent = '100%'; clearInterval(lineTimer); loaderEl.classList.add('ready'); return; }
  requestAnimationFrame(stepLoader);
}
stepLoader();
document.querySelector('.enter').addEventListener('click', () => {
  document.body.classList.remove('booting');
  placeGlow();
  const initial = location.hash.slice(1);
  go(views[initial] ? initial : 'home');
});

// ---------- loop ----------
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight);
  placeGlow();
});

const clock = new THREE.Clock();
let waterClock = 0, shadowTick = 0, perfFrames = 0, perfTime = 0;
const dir = new THREE.Vector3(), side = new THREE.Vector3(), lookAt = new THREE.Vector3(), proj = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
const fogNight = new THREE.Color(0x0e1426), fogDay = new THREE.Color(0x8fb9bb);
const hemiSkyN = new THREE.Color(0x6f86c8), hemiSkyD = new THREE.Color(0xcfe9e4);
const hemiGroundN = new THREE.Color(0x1a1a14), hemiGroundD = new THREE.Color(0x6d7c48);
const keyN = new THREE.Color(0xa8bbff), keyD = new THREE.Color(0xfff3de);

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
  day += (dayTarget - day) * (1 - Math.exp(-dt * 1.5));
  const night = 1 - day;

  // sun: low golden-hour sun by day, well below the horizon at night
  const elev = THREE.MathUtils.lerp(-10, 24, day), azim = 200;
  sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elev), THREE.MathUtils.degToRad(azim));
  skyU.sunPosition.value.copy(sunDir);
  skyU.turbidity.value = THREE.MathUtils.lerp(2, 6, day);
  skyU.rayleigh.value = THREE.MathUtils.lerp(0.6, 1.6, day);
  skyU.mieCoefficient.value = 0.004; skyU.mieDirectionalG.value = 0.82;
  nightU.uNight.value = night; nightU.uTime.value = t;
  dayU.uDay.value = day; dayU.uTime.value = t; dayU.uSun.value.copy(sunDir);
  auroraU.uTime.value = t; auroraU.uNight.value = night;
  moon.material.opacity = THREE.MathUtils.clamp(night * 1.2 - 0.1, 0, 1);
  moon.lookAt(camera.position);

  const lightDir = day > 0.5 ? sunDir : moonDir;
  key.position.copy(key.target.position).addScaledVector(lightDir, 150);
  key.color.copy(keyN).lerp(keyD, day);
  key.intensity = THREE.MathUtils.lerp(1.1, 2.4, day);
  hemi.color.copy(hemiSkyN).lerp(hemiSkyD, day);
  hemi.groundColor.copy(hemiGroundN).lerp(hemiGroundD, day);
  hemi.intensity = THREE.MathUtils.lerp(0.75, 1.5, day);
  scene.fog.color.copy(fogNight).lerp(fogDay, day);
  scene.fog.density = THREE.MathUtils.lerp(0.0045, 0.0034, day);
  renderer.toneMappingExposure = THREE.MathUtils.lerp(1.05, 0.92, day);

  const wu = water.material.uniforms;
  waterClock += dt * (0.2 + 0.32 * WIND.strength); wu.time.value = waterClock;   // ripples race in gusts
  wu.uWaveTime.value = t; wu.uGust.value = waveGust(t);
  wu.sunDirection.value.copy(lightDir);
  wu.sunColor.value.setRGB(1, 0.95, 0.85).multiplyScalar(THREE.MathUtils.lerp(0.6, 1, day));
  wu.waterColor.value.setRGB(0.02 + day * 0.12, 0.05 + day * 0.33, 0.08 + day * 0.32);

  lampLights.forEach((l, i) => { l.intensity = (2.6 + Math.sin(t * 7 + i) * 0.2 + Math.sin(t * 13 + i * 2) * 0.12) * (0.05 + night * 0.95); });
  lampGlowMat.emissiveIntensity = 0.6 + night * 2.6;
  windowMat.emissiveIntensity = 0.5 + night * 2.0;
  bloom.strength = 0.15 + night * 0.3;
  flies.mat.opacity = night;
  updateWind(t, dt);
  if (audio && audio.windGain) {
    const muffle = insideHouse ? 0.35 : 1;                                  // walls soften the wind indoors
    audio.windGain.gain.setTargetAtTime((0.03 + 0.3 * WIND.strength) * muffle, audio.ctx.currentTime, 0.4);
    audio.windFilter.frequency.setTargetAtTime(280 + 520 * WIND.strength, audio.ctx.currentTime, 0.5);
  }
  grainPass.uniforms.uTime.value = t;

  {
    const wave = (x, z) => waterHeight(x, z, t);
    const bx = boat.position.x, bz = boat.position.z, c = Math.cos(boat.rotation.y), sn = Math.sin(boat.rotation.y);
    const bow = wave(bx + sn * 1.6, bz + c * 1.6), stern = wave(bx - sn * 1.6, bz - c * 1.6);
    const port = wave(bx - c * 0.6, bz + sn * 0.6), stbd = wave(bx + c * 0.6, bz - sn * 0.6);
    const targetY = 0.04 + (bow + stern + port + stbd) / 4;               // floats at its waterline
    boatState.vy += ((targetY - boat.position.y) * 18 - boatState.vy * 3.2) * dt;   // damped spring = buoyancy
    boat.position.y += boatState.vy * dt;
    boat.rotation.x += (Math.atan2(stern - bow, 3.2) - boat.rotation.x) * Math.min(1, dt * 3);
    boat.rotation.z += (Math.atan2(port - stbd, 1.2) - boat.rotation.z) * Math.min(1, dt * 3);
  }

  const fp = flies.g.attributes.position.array;
  flies.base.forEach((b, i) => {
    fp[i * 3] = b[0] + Math.sin(t * 0.4 + b[3]) * 0.9 + WIND.dir.x * WIND.strength * (0.4 + 0.3 * Math.sin(t * 0.7 + b[3]));
    fp[i * 3 + 1] = b[1] + Math.sin(t * 0.9 + b[3] * 3) * 0.35;
    fp[i * 3 + 2] = b[2] + Math.cos(t * 0.35 + b[3]) * 0.9 + WIND.dir.y * WIND.strength * (0.4 + 0.3 * Math.sin(t * 0.7 + b[3]));
  });
  flies.g.attributes.position.needsUpdate = true;
  const sp = smoke.g.attributes.position.array;
  smoke.life.forEach((l, i) => {
    l = (l + dt * 0.08) % 1; smoke.life[i] = l;
    sp[i * 3] = chimneyTop.x + WIND.dir.x * l * l * (2 + 7 * WIND.strength) + Math.sin(l * 7 + i) * 0.35 * l;
    sp[i * 3 + 1] = chimneyTop.y + l * 8;
    sp[i * 3 + 2] = chimneyTop.z + WIND.dir.y * l * l * (2 + 7 * WIND.strength) + Math.cos(l * 5 + i) * 0.35 * l;
  });
  smoke.g.attributes.position.needsUpdate = true;

  if (walk) {
    const w = walk;
    // target speed: cruise, but never faster than lets us brake to walking pace before the slow zone or to a stop at the end
    let target = CRUISE;
    if (w.s >= w.s0 && w.s <= w.s1) target = WALK;
    else if (w.s < w.s0) target = Math.min(target, Math.sqrt(WALK * WALK + 2 * ACCEL * (w.s0 - w.s)));
    target = Math.min(target, Math.sqrt(0.04 + 2 * ACCEL * 0.8 * Math.max(0, w.L - w.s)));
    w.v += Math.max(-ACCEL * 1.5 * dt, Math.min(ACCEL * dt, target - w.v));
    w.s = Math.min(w.L, w.s + Math.max(w.v, 0.15) * dt);
    w.t = w.s / w.L;
    w.path.getPointAt(w.t, camPos);
    w.looks.getPoint(easeInOut(Math.min(1, w.t * 1.15)), camLook);   // the gaze leads the body slightly
    if (w.doorOpenS !== undefined && w.s > w.doorOpenS) houseNav.doorTarget = 1;
    if (w.doorCloseS !== undefined && w.s > w.doorCloseS) houseNav.doorTarget = 0;
    if (w.s >= w.L - 0.01) { const done = w.onDone; walk = null; done && done(); }
  } else {
    const k = 1 - Math.exp(-dt * 1.4);
    camPos.lerp(tgtPos, k); camLook.lerp(tgtLook, k);
  }
  // door swings on its hinge; fire and lamp flicker
  houseNav.door += (houseNav.doorTarget - houseNav.door) * Math.min(1, dt * 6);
  houseNav.doorPivot.rotation.y = houseNav.door * 1.45;
  if (insideHouse || walk || document.body.dataset.section === 'contact') houseNav.updateFire(dt, t);   // the fire is only visible near the house
  // shadows: refresh while the light is moving (day/night blend), otherwise ~6 times a second for the swaying trees and bobbing boat
  shadowTick++;
  if (Math.abs(dayTarget - day) > 0.002 || shadowTick % 10 === 0) renderer.shadowMap.needsUpdate = true;
  if (!look.drag) { look.ty *= 0.985; look.tp *= 0.985; }
  look.yaw += (look.ty - look.yaw) * 0.12; look.pitch += (look.tp - look.pitch) * 0.12;
  camera.position.copy(camPos);
  if (!insideHouse && !walk) camera.position.y += Math.sin(t * 0.45) * 0.06;
  const wantFov = fovFor(insideHouse || (walk && walk.t > 0.75 && document.body.dataset.section === 'contact') ? 64 : 48);
  if (Math.abs(camera.fov - wantFov) > 0.05) { camera.fov += (wantFov - camera.fov) * Math.min(1, dt * 2.5); camera.updateProjectionMatrix(); }
  dir.subVectors(camLook, camPos);
  const dist = dir.length(); dir.normalize();
  dir.applyAxisAngle(UP, look.yaw);
  side.crossVectors(dir, UP).normalize();
  dir.applyAxisAngle(side, look.pitch);
  lookAt.copy(camPos).addScaledVector(dir, dist);
  camera.lookAt(lookAt);

  markers.forEach((el, i) => {
    proj.copy(markerDefs[i].at).project(camera);
    const vis = proj.z < 1 && Math.abs(proj.x) < 1.1 && Math.abs(proj.y) < 1.1;
    el.style.opacity = vis ? '' : '0';
    el.style.transform = `translate(${((proj.x + 1) / 2) * innerWidth}px, ${((1 - proj.y) / 2) * innerHeight}px)`;
  });

  composer.render();
  // frame-rate governor: drop resolution a step if we can't hold ~50 fps, raise it again when there's headroom
  perfFrames++; perfTime += dt;
  if (perfTime > 2 && !HQ) {
    const fps = perfFrames / perfTime, pr = renderer.getPixelRatio();
    const maxPr = MAX_PR;
    let next = pr;
    if (fps < 48 && pr > 0.75) next = Math.max(0.75, pr - 0.125);
    else if (fps > 58 && pr < maxPr) next = Math.min(maxPr, pr + 0.125);
    if (next !== pr) { renderer.setPixelRatio(next); composer.setPixelRatio(next); composer.setSize(innerWidth, innerHeight); }
    perfFrames = 0; perfTime = 0;
  }
  firstFrame = true;
  requestAnimationFrame(tick);
}
tick();







