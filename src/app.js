/**
 * FLAT EARTH EXPLORER — app.js (v4)
 *
 * SPIKE FIX: CircleGeometry has a UV wrap seam that causes radial spikes.
 *            Replaced with PlaneGeometry — simple 0..1 grid UVs, no seams.
 *            The circle shape is enforced by discarding fragments in the shader.
 *
 * Other changes vs v2:
 *  - Ice mountains (procedural ConeGeometry peaks around edge)
 *  - Inverted bedrock underside (displaced CircleGeometry facing down)
 *  - Zoom is camera-distance only — texture never reloads on scroll
 *  - World map loads at zoom=0 (full Earth) so continents fill the disc
 */
"use strict";

/* ─────────────────────────────────────────────────
   CONSTANTS & SEEDED RNG
───────────────────────────────────────────────── */
const DISC_R    = 10;
const DISC_SEGS = 512;   // cylinder edge smoothness
const WF_H      = 3.8;   // waterfall height

let _s = 42;
const srng = () => { _s = (_s * 1664525 + 1013904223) & 0xffffffff; return ((_s >>> 0) / 0xffffffff); };
const rng  = (a, b) => a + srng() * (b - a);

/* ─────────────────────────────────────────────────
   STATE
───────────────────────────────────────────────── */
const state = {
  camDist:   24,
  camTheta:  Math.PI / 4,
  camPhi:    Math.PI / 3,
  nightMode: false,
  street:    false,
  drag:      false,
  lastXY:    { x: 0, y: 0 },
  pinch:     null,
  hinted:    false,
};

/* ─────────────────────────────────────────────────
   RENDERER / SCENE / CAMERA
───────────────────────────────────────────────── */
const canvas = document.getElementById("glCanvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled   = true;
renderer.shadowMap.type      = THREE.PCFSoftShadowMap;
renderer.toneMapping         = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene  = new THREE.Scene();
scene.background = new THREE.Color(0x070a12);
scene.fog        = new THREE.FogExp2(0x070a12, 0.008);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 2000);

/* stars */
(() => {
  const g = new THREE.BufferGeometry();
  const p = new Float32Array(12000 * 3);
  for (let i = 0; i < p.length; i++) p[i] = (Math.random() - 0.5) * 1600;
  g.setAttribute("position", new THREE.BufferAttribute(p, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 0.22, sizeAttenuation: true })));
})();

/* lights */
const ambientLight = new THREE.AmbientLight(0x1a2a40, 0.75);
scene.add(ambientLight);
const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
sun.position.set(18, 28, 12);
sun.castShadow = true;
scene.add(sun);
scene.add(Object.assign(new THREE.DirectionalLight(0x4aeadc, 0.22), { position: new THREE.Vector3(-20, 6, -15) }));
// under-light for bedrock
scene.add(Object.assign(new THREE.DirectionalLight(0x2a1800, 0.8), { position: new THREE.Vector3(4, -22, 6) }));

/* ─────────────────────────────────────────────────
   DISC CYLINDER BODY (edge / underside rim)
───────────────────────────────────────────────── */
const bodyGeo = new THREE.CylinderGeometry(DISC_R, DISC_R, 0.22, DISC_SEGS, 1, false);
const bodyMat = new THREE.MeshStandardMaterial({ color: 0x0f2535, roughness: 0.92, metalness: 0.04 });
const body    = new THREE.Mesh(bodyGeo, bodyMat);
body.receiveShadow = true;
scene.add(body);

/* ─────────────────────────────────────────────────
   TOP FACE — PlaneGeometry (NO UV SEAM = NO SPIKES)

   CircleGeometry wraps UVs around its perimeter.
   Where u≈0 and u≈1 meet, triangles span the full
   texture width → the GPU interpolates across the
   whole image → radial spikes.

   PlaneGeometry has a simple uniform grid:
   u goes 0→1 left→right, v goes 0→1 bottom→top.
   No wraparound at all. We clip to a circle by
   discarding fragment if length(uv-0.5) > 0.5.
───────────────────────────────────────────────── */
const topGeo  = new THREE.PlaneGeometry(DISC_R * 2, DISC_R * 2, 2, 2);
const topMat  = new THREE.ShaderMaterial({
  uniforms: {
    tMap:     { value: null },
    hasTex:   { value: 0.0 },
    nightAmt: { value: 0.0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;   // simple 0..1 grid, no seams
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tMap;
    uniform float     hasTex;
    uniform float     nightAmt;
    varying vec2 vUv;
    void main() {
      float r = length(vUv - 0.5);

      // Clip to disc shape — this is what replaces CircleGeometry's shape
      if (r > 0.5) discard;

      // Normalised radius 0..1
      float nr = r * 2.0;

      // Base ocean gradient
      vec3 base = mix(vec3(0.08,0.30,0.55), vec3(0.03,0.10,0.28), smoothstep(0.4, 1.0, nr));
      vec4 col  = vec4(base, 1.0);

      if (hasTex > 0.5) {
        // Clamp UVs away from the absolute edge to stop any border bleed
        vec2 safeUv = clamp(vUv, 0.01, 0.99);
        vec4 t = texture2D(tMap, safeUv);
        col = mix(col, t, 0.94);
      }

      // Night mode
      vec3 nightCol = col.rgb * 0.05 + vec3(0.0, 0.004, 0.018);
      col.rgb = mix(col.rgb, nightCol, nightAmt);

      // Soft vignette toward Antarctica ring
      col.rgb *= 1.0 - smoothstep(0.42, 0.5, r) * 0.6;

      gl_FragColor = col;
    }
  `,
  side: THREE.FrontSide,
});
const topMesh = new THREE.Mesh(topGeo, topMat);
topMesh.rotation.x = -Math.PI / 2;
topMesh.position.y  = 0.112;
topMesh.receiveShadow = true;
scene.add(topMesh);

/* atmosphere glow ring */
(() => {
  const geo = new THREE.RingGeometry(DISC_R * 0.97, DISC_R * 1.10, DISC_SEGS);
  const mat = new THREE.MeshBasicMaterial({ color: 0x4aeadc, side: THREE.DoubleSide, transparent: true, opacity: 0.10 });
  const m   = new THREE.Mesh(geo, mat);
  m.rotation.x = -Math.PI / 2;
  m.position.y  = 0.114;
  scene.add(m);
})();

/* ─────────────────────────────────────────────────
   ICE MOUNTAINS  (replaces flat cylinder wall)
   Three rings of jagged displaced cones
───────────────────────────────────────────────── */
const iceGroup = new THREE.Group();
scene.add(iceGroup);

(() => {
  const mats = {
    snow:   new THREE.MeshStandardMaterial({ color: 0xeef8ff, roughness: 0.40, metalness: 0.18 }),
    ice:    new THREE.MeshStandardMaterial({ color: 0x88c4e0, roughness: 0.20, metalness: 0.35, transparent: true, opacity: 0.90 }),
    rock:   new THREE.MeshStandardMaterial({ color: 0x4a6070, roughness: 0.75, metalness: 0.08 }),
    shadow: new THREE.MeshStandardMaterial({ color: 0x2a3a48, roughness: 0.85, metalness: 0.05 }),
  };

  const rings = [
    // outer tall dramatic peaks
    { n: 80,  r: DISC_R + 0.08, hMin: 1.4, hMax: 3.8, bMin: 0.22, bMax: 0.55 },
    // inner shorter jagged foothills
    { n: 130, r: DISC_R - 0.50, hMin: 0.25, hMax: 1.5, bMin: 0.07, bMax: 0.22 },
    // staggered outer lower layer
    { n: 55,  r: DISC_R + 0.72, hMin: 0.3, hMax: 1.0, bMin: 0.08, bMax: 0.24 },
  ];

  rings.forEach(({ n, r, hMin, hMax, bMin, bMax }) => {
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2 + rng(-0.05, 0.05);
      const h     = rng(hMin, hMax);
      const base  = rng(bMin, bMax);
      const segs  = 3 + Math.floor(srng() * 4);   // triangular to hexagonal

      const geo  = new THREE.ConeGeometry(base, h, segs);
      const pos  = geo.attributes.position;

      // Displace vertices for jagged rocky look — more at base, none at tip
      for (let v = 0; v < pos.count; v++) {
        const vy  = pos.getY(v);
        const t   = 1.0 - Math.max(0, (vy + h * 0.5) / h); // 0 at tip, 1 at base
        pos.setX(v, pos.getX(v) + rng(-base * 0.4,  base * 0.4)  * t);
        pos.setZ(v, pos.getZ(v) + rng(-base * 0.4,  base * 0.4)  * t);
        pos.setY(v, vy           + rng(-h    * 0.05, h    * 0.05));
      }
      geo.computeVertexNormals();

      // Material by relative height
      const norm = (h - hMin) / (hMax - hMin);
      const mat  = norm > 0.65 ? mats.snow : norm > 0.38 ? mats.ice : norm > 0.18 ? mats.rock : mats.shadow;

      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = mesh.receiveShadow = true;

      const rad = r + rng(-0.35, 0.35);
      mesh.position.set(rad * Math.cos(angle), 0.11 + h / 2, rad * Math.sin(angle));
      mesh.rotation.set(rng(-0.07, 0.07), rng(0, Math.PI * 2), rng(-0.20, 0.20));
      iceGroup.add(mesh);
    }
  });
})();

/* ─────────────────────────────────────────────────
   WATERFALL  (animated water shader below ice ring)
───────────────────────────────────────────────── */
const wfGeo = new THREE.CylinderGeometry(DISC_R + 0.02, DISC_R + 0.02, WF_H, 128, 48, true);
const wfMat = new THREE.ShaderMaterial({
  uniforms: { time: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader: `
    uniform float time;
    varying vec2 vUv;

    float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5); }
    float noise(vec2 p){
      vec2 i=floor(p), f=fract(p);
      f=f*f*(3.-2.*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
    }

    void main(){
      // Each vertical lane falls at a slightly different speed
      float lane   = floor(vUv.x * 60.);
      float speed  = time * 1.2 + hash(vec2(lane,0.)) * 0.6;
      float fall   = fract(vUv.y + speed);

      // Primary streak
      float streak = smoothstep(0.0,0.14,fall) * smoothstep(1.0,0.50,fall);

      // Turbulence ripples
      float t1 = noise(vec2(vUv.x*32., vUv.y*8.  + time*0.5));
      float t2 = noise(vec2(vUv.x*68., vUv.y*18. + time*0.9));
      float turb = t1*0.55 + t2*0.25;

      // Foam at streak crest
      float foam = smoothstep(0.46,0.54,fall) * smoothstep(0.70,0.54,fall);

      // Colour: deep navy → mid blue → white foam
      vec3 deep = vec3(0.03,0.15,0.45);
      vec3 mid  = vec3(0.10,0.40,0.80);
      vec3 wht  = vec3(0.90,0.97,1.00);
      vec3 col  = mix(deep, mid, streak);
      col       = mix(col, wht, foam*0.88);
      col      += turb * 0.07;

      float alpha = (streak*(0.55+turb*0.30) + foam*0.55);
      alpha *= smoothstep(1.0, 0.60, vUv.y);   // mist fade at bottom
      alpha  = clamp(alpha, 0., 0.95);

      gl_FragColor = vec4(col, alpha);
    }
  `,
  transparent: true, side: THREE.DoubleSide, depthWrite: false,
});
const wfMesh = new THREE.Mesh(wfGeo, wfMat);
wfMesh.position.y = 0.11 - WF_H / 2;
scene.add(wfMesh);

/* Mist spray pool at base */
(() => {
  const geo = new THREE.CylinderGeometry(DISC_R + 0.5, DISC_R + 2.5, 0.3, 96, 1, true);
  const mat = new THREE.MeshBasicMaterial({ color: 0x8dd4f0, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false });
  const m   = new THREE.Mesh(geo, mat);
  m.position.y = 0.11 - WF_H - 0.1;
  scene.add(m);
})();

/* ─────────────────────────────────────────────────
   BEDROCK UNDERSIDE
   Displaced CircleGeometry pointing DOWN — looks
   like inverted rocky mountain terrain
───────────────────────────────────────────────── */
(() => {
  // Primary bedrock layer
  const geo = new THREE.CircleGeometry(DISC_R * 0.995, 180, 180);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const r = Math.hypot(x, z) / DISC_R;
    // Fractal octave sine displacement
    let d = 0;
    d += Math.sin(x * 1.8 + 0.5)   * Math.cos(z * 2.1 + 0.9) * 1.0;
    d += Math.sin(x * 3.7 - z * 2.9 + 1.3) * 0.50;
    d += Math.sin(x * 7.3 + z * 5.5 - 0.8) * 0.25;
    d += Math.sin(x * 13.1 - z * 9.7 + 2.2) * 0.12;
    d += Math.sin(x * 24.3 + z * 19.1) * 0.06;
    const hang = Math.max(0, d + 0.7) * 3.2;
    // Fade to zero at disc edge (mountains only in middle, flat at rim)
    const fade = Math.pow(1.0 - Math.min(r, 1.0), 0.35);
    pos.setY(i, -hang * fade);
  }
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2a1c10, roughness: 0.97, metalness: 0.02,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.y = -0.12;
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);

  // Darker crevice layer underneath for depth shadow
  const geo2 = new THREE.CircleGeometry(DISC_R * 0.80, 140, 140);
  const pos2 = geo2.attributes.position;
  for (let i = 0; i < pos2.count; i++) {
    const x = pos2.getX(i), z = pos2.getZ(i);
    const r = Math.hypot(x, z) / (DISC_R * 0.80);
    let d = 0;
    d += Math.sin(x * 2.3 + 1.1) * Math.cos(z * 2.8 + 0.4) * 0.7;
    d += Math.sin(x * 4.7 - z * 3.9) * 0.35;
    d += Math.sin(x * 9.3 + z * 7.5) * 0.18;
    const hang = Math.max(0, d + 0.5) * 2.8;
    const fade = Math.pow(1.0 - Math.min(r, 1.0), 0.5);
    pos2.setY(i, -hang * fade - 0.5);
  }
  geo2.computeVertexNormals();
  const mat2 = new THREE.MeshStandardMaterial({ color: 0x140b04, roughness: 0.99, metalness: 0.0, side: THREE.DoubleSide });
  const mesh2 = new THREE.Mesh(geo2, mat2);
  mesh2.rotation.x = Math.PI / 2;
  mesh2.position.y = -0.14;
  scene.add(mesh2);
})();

/* ─────────────────────────────────────────────────
   TEXTURE LOADING
   Uses THREE.TextureLoader directly — no canvas
   intermediary for real API textures.
   World view: zoom=0 (full Earth), center=30,15
   (shifts Atlantic left so Eurasia fills centre).
───────────────────────────────────────────────── */
function setTex(tex) {
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  topMat.uniforms.tMap.value   = tex;
  topMat.uniforms.hasTex.value = 1.0;
}

function loadMapsTexture(lat, lon, zoom) {
  if (!window.MAPS_API_KEY || window.MAPS_API_KEY === "YOUR_GOOGLE_MAPS_API_KEY") {
    buildPlaceholder(); return;
  }
  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lon}&zoom=${zoom}&size=640x640&maptype=satellite&key=${window.MAPS_API_KEY}`;
  new THREE.TextureLoader().load(url, setTex, undefined, () => buildPlaceholder());
}

function buildPlaceholder() {
  const c = document.createElement("canvas");
  c.width = c.height = 1024;
  const ctx = c.getContext("2d");
  // ocean
  const g = ctx.createRadialGradient(512,512,0,512,512,512);
  g.addColorStop(0,"#1b6494"); g.addColorStop(0.55,"#0f4470"); g.addColorStop(1,"#041c38");
  ctx.beginPath(); ctx.arc(512,512,510,0,Math.PI*2); ctx.fillStyle=g; ctx.fill();
  // continents
  [ {cx:435,cy:345,rx:82,ry:115,rot:-0.3,col:"#3d7a3d"},
    {cx:305,cy:445,rx:62,ry:82, rot: 0.2,col:"#4a8a2a"},
    {cx:595,cy:365,rx:92,ry:78, rot: 0.5,col:"#5a8a3a"},
    {cx:630,cy:500,rx:52,ry:48, rot:-0.1,col:"#6aaa4a"},
  ].forEach(({cx,cy,rx,ry,rot,col})=>{
    ctx.save(); ctx.translate(cx,cy); ctx.rotate(rot);
    const gr=ctx.createRadialGradient(0,0,0,0,0,Math.max(rx,ry));
    gr.addColorStop(0,col); gr.addColorStop(1,col+"88");
    ctx.beginPath(); ctx.ellipse(0,0,rx,ry,0,0,Math.PI*2);
    ctx.fillStyle=gr; ctx.fill(); ctx.restore();
  });
  // north-pole ice cap
  const ig=ctx.createRadialGradient(512,512,0,512,512,60);
  ig.addColorStop(0,"rgba(230,245,255,.96)"); ig.addColorStop(1,"rgba(200,230,255,0)");
  ctx.beginPath(); ctx.arc(512,512,60,0,Math.PI*2); ctx.fillStyle=ig; ctx.fill();

  const t = new THREE.CanvasTexture(c);
  t.wrapS=t.wrapT=THREE.ClampToEdgeWrapping;
  t.minFilter=t.magFilter=THREE.LinearFilter;
  topMat.uniforms.tMap.value=t; topMat.uniforms.hasTex.value=1.0;
}

/* ─────────────────────────────────────────────────
   PROJECTION HELPERS
───────────────────────────────────────────────── */
function uvToLatLon(u, v) {
  // PlaneGeometry UV: (0.5,0.5) = centre of disc = North Pole
  const sc = 1 / (Math.PI * 0.505);
  const x  = (u - 0.5) / sc;
  const y  = (v - 0.5) / sc;
  const c  = Math.hypot(x, y);
  if (c < 1e-9) return [90, 0];
  return [(Math.PI / 2 - c) * 180 / Math.PI, Math.atan2(x, -y) * 180 / Math.PI];
}

/* ─────────────────────────────────────────────────
   CAMERA  — zoom changes camDist only, never texture
───────────────────────────────────────────────── */
function setCamera() {
  const { camDist: d, camTheta: t, camPhi: p } = state;
  camera.position.set(d*Math.sin(p)*Math.sin(t), d*Math.cos(p), d*Math.sin(p)*Math.cos(t));
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();

  const altKm = Math.max(0, (d - DISC_R) * 637);
  el("coordAlt").textContent = altKm > 9999
    ? (altKm/1000).toFixed(0) + ",000 km" : altKm.toFixed(0) + " km";

  const fovR   = camera.fov * Math.PI / 180;
  const kpp    = (altKm * 2 * Math.tan(fovR / 2)) / innerHeight;
  const pw     = Math.min(120, Math.max(40, 1000 / Math.max(kpp, 0.1)));
  const km     = Math.round(kpp * pw / 100) * 100 || 1000;
  el("scaleLine").style.width  = pw + "px";
  el("scaleLabel").textContent = km.toLocaleString() + " km";

  if (p > Math.PI * 0.41 && d < 14) showIceToast();
}

const el = id => document.getElementById(id);

/* ─────────────────────────────────────────────────
   INPUT — mouse / wheel / touch
───────────────────────────────────────────────── */
canvas.addEventListener("mousedown", e => { state.drag=true; state.lastXY={x:e.clientX,y:e.clientY}; });
window.addEventListener("mouseup",   () => state.drag=false);
window.addEventListener("mousemove", e => {
  if (!state.drag) return;
  state.camTheta -= (e.clientX - state.lastXY.x) * 0.005;
  state.camPhi    = Math.max(0.12, Math.min(Math.PI*0.49, state.camPhi + (e.clientY - state.lastXY.y) * 0.005));
  state.lastXY    = { x:e.clientX, y:e.clientY };
  setCamera();
  hoverCoords(e.clientX, e.clientY);
});

// ZOOM: camera distance only — no texture reload
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  state.camDist = Math.max(11, Math.min(80, state.camDist + e.deltaY * 0.03));
  setCamera();
}, { passive: false });

canvas.addEventListener("touchstart", e => {
  e.preventDefault();
  if (e.touches.length === 2) {
    state.pinch = Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY);
  } else { state.drag=true; state.lastXY={x:e.touches[0].clientX,y:e.touches[0].clientY}; }
}, { passive:false });

canvas.addEventListener("touchmove", e => {
  e.preventDefault();
  if (e.touches.length===2 && state.pinch!==null) {
    const d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
    state.camDist=Math.max(11,Math.min(80,state.camDist+(state.pinch-d)*0.08));
    state.pinch=d; setCamera();
  } else if (state.drag && e.touches.length===1) {
    state.camTheta-=(e.touches[0].clientX-state.lastXY.x)*0.005;
    state.camPhi=Math.max(0.12,Math.min(Math.PI*0.49,state.camPhi+(e.touches[0].clientY-state.lastXY.y)*0.005));
    state.lastXY={x:e.touches[0].clientX,y:e.touches[0].clientY};
    setCamera();
  }
}, { passive:false });
canvas.addEventListener("touchend", () => { state.drag=false; state.pinch=null; });

canvas.addEventListener("dblclick", e => {
  const hit = raycastDisc(e.clientX, e.clientY);
  if (!hit) return;
  const [lat,lon] = uvToLatLon(hit.uv.x, hit.uv.y);
  if (lat < -60) { showIceToast(); return; }
  openSV(lat, lon);
  if (!state.hinted) { el("hintToast").classList.add("hidden"); state.hinted=true; }
});

function raycastDisc(cx, cy) {
  const rect = canvas.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((cx-rect.left)/rect.width )*2-1,
    -((cy-rect.top )/rect.height)*2+1
  );
  const ray = new THREE.Raycaster();
  ray.setFromCamera(mouse, camera);
  const hits = ray.intersectObject(topMesh);
  return hits.length ? hits[0] : null;
}

function hoverCoords(cx, cy) {
  const hit = raycastDisc(cx, cy);
  if (!hit) return;
  const [lat,lon] = uvToLatLon(hit.uv.x, hit.uv.y);
  el("coordLat").textContent = Math.abs(lat).toFixed(3)+"°"+(lat>=0?"N":"S");
  el("coordLon").textContent = Math.abs(lon).toFixed(3)+"°"+(lon>=0?"E":"W");
}

/* ─────────────────────────────────────────────────
   UI PANEL & TOGGLES
───────────────────────────────────────────────── */
el("menuBtn").addEventListener("click", () => {
  el("sidePanel").classList.toggle("panel-open");
  el("sidePanel").classList.toggle("panel-closed");
  el("panelOverlay").classList.toggle("visible");
});
const closePanel = () => {
  el("sidePanel").classList.replace("panel-open","panel-closed");
  el("panelOverlay").classList.remove("visible");
};
el("panelClose").addEventListener("click",   closePanel);
el("panelOverlay").addEventListener("click", closePanel);

el("navDisc").addEventListener("click",   () => { closeSV(); setNav("navDisc");   closePanel(); });
el("navStreet").addEventListener("click", () => { openSV(0,0);  setNav("navStreet"); closePanel(); });
const setNav = id => document.querySelectorAll(".panel-nav-item").forEach(b => b.classList.toggle("active", b.id===id));

const toggle = (id, fn) => el(id).addEventListener("click", () => { el(id).classList.toggle("active"); fn(el(id).classList.contains("active")); });
toggle("toggleNight",     on => state.nightMode = on);
toggle("toggleWaterfall", on => wfMesh.visible  = on);
toggle("toggleIce",       on => iceGroup.visible = on);
toggle("toggleSatellite", on => topMat.uniforms.hasTex.value = on ? 1 : 0);

el("zoomIn") .addEventListener("click", () => { state.camDist=Math.max(11,state.camDist-2.5); setCamera(); });
el("zoomOut").addEventListener("click", () => { state.camDist=Math.min(80,state.camDist+2.5); setCamera(); });
el("btnReset").addEventListener("click", () => {
  Object.assign(state,{camDist:24,camTheta:Math.PI/4,camPhi:Math.PI/3});
  setCamera();
  loadMapsTexture(30, 15, 0);  // reload world overview
});
el("btnCompass").addEventListener("click", () => { state.camTheta=Math.PI/4; setCamera(); });

/* ─────────────────────────────────────────────────
   SEARCH
───────────────────────────────────────────────── */
const sInput   = el("searchInput");
const sResults = el("searchResults");

el("searchBtn").addEventListener("click", doSearch);
sInput.addEventListener("keydown", e => e.key==="Enter" && doSearch());

async function doSearch() {
  const q = sInput.value.trim(); if (!q) return;
  if (!window.MAPS_API_KEY || window.MAPS_API_KEY==="YOUR_GOOGLE_MAPS_API_KEY") { fallback(q); return; }
  try {
    const data = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${window.MAPS_API_KEY}`).then(r=>r.json());
    if (data.status==="REQUEST_DENIED"||data.status==="ERROR") { fallback(q); return; }
    data.results?.length ? showResults(data.results.slice(0,5)) : (sResults.innerHTML="<div class='result-item'><span class='result-text'>No results.</span></div>",sResults.classList.add("open"));
  } catch { fallback(q); }
}

const DEMO = [
  {name:"London, UK",          lat:51.505, lng:-0.09},
  {name:"New York, USA",       lat:40.713, lng:-74.006},
  {name:"Tokyo, Japan",        lat:35.683, lng:139.767},
  {name:"Sydney, Australia",   lat:-33.868,lng:151.209},
  {name:"Paris, France",       lat:48.857, lng:2.352},
  {name:"Cairo, Egypt",        lat:30.033, lng:31.233},
  {name:"North Pole",          lat:89.9,   lng:0},
  {name:"Antarctica Ice Wall", lat:-70,    lng:0},
];
function fallback(q) {
  const f = DEMO.filter(p=>p.name.toLowerCase().includes(q.toLowerCase()));
  showResults((f.length?f:DEMO).map(p=>({formatted_address:p.name,geometry:{location:{lat:p.lat,lng:p.lng}}})));
}

function showResults(res) {
  sResults.innerHTML="";
  res.forEach(r=>{
    const d=document.createElement("div"); d.className="result-item";
    d.innerHTML=`<svg class="result-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg><span class="result-text">${r.formatted_address}</span>`;
    d.addEventListener("click",()=>{
      const {lat,lng}=r.geometry.location;
      flyTo(lat,lng); sResults.classList.remove("open"); sInput.value=r.formatted_address;
    });
    sResults.appendChild(d);
  });
  sResults.classList.add("open");
}
document.addEventListener("click", e => { if(!e.target.closest("#searchBar")) sResults.classList.remove("open"); });

function flyTo(lat,lon) {
  el("coordLat").textContent=Math.abs(lat).toFixed(3)+"°"+(lat>=0?"N":"S");
  el("coordLon").textContent=Math.abs(lon).toFixed(3)+"°"+(lon>=0?"E":"W");
  // Load a zoomed satellite view of the destination — zoom=4 shows a region
  loadMapsTexture(lat, lon, 4);
}

/* ─────────────────────────────────────────────────
   STREET VIEW
───────────────────────────────────────────────── */
let mapsJsLoaded=false, svPano=null;
function loadMapsJs(cb) {
  if (mapsJsLoaded) { cb(); return; }
  if (!window.MAPS_API_KEY||window.MAPS_API_KEY==="YOUR_GOOGLE_MAPS_API_KEY") { alert("Add your API key to use Street View."); return; }
  const s=document.createElement("script"); s.async=true;
  s.src=`https://maps.googleapis.com/maps/api/js?key=${window.MAPS_API_KEY}&v=weekly`;
  s.onload=()=>{ mapsJsLoaded=true; cb(); };
  document.head.appendChild(s);
}
function openSV(lat,lon) {
  state.street=true;
  el("streetOverlay").classList.remove("hidden");
  el("streetCoords").textContent=`${Math.abs(lat).toFixed(4)}°${lat>=0?"N":"S"}, ${Math.abs(lon).toFixed(4)}°${lon>=0?"E":"W"}`;
  setNav("navStreet");
  loadMapsJs(()=>{
    const pos={lat,lng:lon};
    svPano ? svPano.setPosition(pos) : (svPano=new google.maps.StreetViewPanorama(el("streetMap"),{position:pos,pov:{heading:34,pitch:10},zoom:1,addressControl:false,fullscreenControl:false}));
  });
}
function closeSV() { state.street=false; el("streetOverlay").classList.add("hidden"); setNav("navDisc"); }
el("closeStreet").addEventListener("click", closeSV);

/* ─────────────────────────────────────────────────
   TOASTS
───────────────────────────────────────────────── */
let iceTmr=null;
function showIceToast() {
  const t=el("iceToast"); t.classList.remove("hidden","out"); clearTimeout(iceTmr);
  iceTmr=setTimeout(()=>{ t.classList.add("out"); setTimeout(()=>t.classList.add("hidden"),350); },3500);
}
setTimeout(()=>{
  const h=el("hintToast");
  if (h&&!h.classList.contains("hidden")){ h.classList.add("out"); setTimeout(()=>h.classList.add("hidden"),350); }
},8000);

/* ─────────────────────────────────────────────────
   NIGHT TRANSITION
───────────────────────────────────────────────── */
function tickNight() {
  const tgt=state.nightMode?1:0, cur=topMat.uniforms.nightAmt.value;
  topMat.uniforms.nightAmt.value += (tgt-cur)*0.025;
  ambientLight.intensity = 0.75 - topMat.uniforms.nightAmt.value*0.58;
  sun.intensity          = 2.20 - topMat.uniforms.nightAmt.value*2.0;
}

/* ─────────────────────────────────────────────────
   RENDER LOOP
───────────────────────────────────────────────── */
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  wfMat.uniforms.time.value = clock.getElapsedTime();
  tickNight();
  if (!state.drag && !state.street) {
    state.camTheta += 0.00005;
    camera.position.set(
      state.camDist*Math.sin(state.camPhi)*Math.sin(state.camTheta),
      state.camDist*Math.cos(state.camPhi),
      state.camDist*Math.sin(state.camPhi)*Math.cos(state.camTheta)
    );
    camera.lookAt(0,0,0);
  }
  renderer.render(scene,camera);
}

window.addEventListener("resize",()=>{
  camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth,innerHeight);
});

/* ─────────────────────────────────────────────────
   INIT
───────────────────────────────────────────────── */
const MSGS=["Initialising flat projection…","Rendering azimuthal equidistant map…","Carving Antarctic ice mountains…","Shaping bedrock underside…","Connecting to satellite imagery…","Almost there…"];

(async function init() {
  setCamera();
  const fill=el("loaderFill"), status=el("loaderStatus");
  let pct=0, mi=0;
  const tick=setInterval(()=>{ pct=Math.min(90,pct+Math.random()*18); fill.style.width=pct+"%"; if(mi<MSGS.length-1)status.textContent=MSGS[++mi]; },300);

  buildPlaceholder();

  // Load world map at zoom=0 (entire world), centered roughly over central Asia/Europe
  // so the AE projection disc shows continents spread well from north pole
  loadMapsTexture(30, 15, 0);

  clearInterval(tick);
  fill.style.width="100%"; status.textContent="Ready.";
  await new Promise(r=>setTimeout(r,400));
  el("loader").classList.add("out");
  setTimeout(()=>el("loader").style.display="none",750);
  animate();
})();
