/**
 * FLAT EARTH EXPLORER — app.js (v5)
 *
 * KEY FIXES vs v2:
 *   SPIKE FIX: CircleGeometry → PlaneGeometry for top face.
 *              CircleGeometry wraps UVs at its seam (u≈0 meets u≈1),
 *              causing the GPU to sweep across the full texture width
 *              = radial spikes. PlaneGeometry has a plain 0→1 grid,
 *              no wraparound. Circle shape enforced by "if(r>0.5)discard"
 *              in the fragment shader.
 *   CENTERING: World map at zoom=1, center=(20,15) shows Eurasia + Africa
 *              spread naturally across the AE disc.
 *   ICE WALL:  Replaced flat cylinder with procedural ice mountain peaks.
 *   BEDROCK:   Inverted displaced terrain on underside of disc.
 *   ZOOM:      Wheel/buttons change camDist only — texture never reloads.
 */
"use strict";

/* ═══════════════════════════════════════════════════════
   0.  CONSTANTS & SEEDED RNG
═══════════════════════════════════════════════════════ */
const DISC_RADIUS = 10;
const DISC_SEGS   = 256;
const WATERFALL_H = 3.5;

// Seeded RNG — mountains look identical on every load
let _seed = 42;
function seededRand() {
  _seed = (_seed * 1664525 + 1013904223) & 0xffffffff;
  return (_seed >>> 0) / 0xffffffff;
}
function rng(a, b) { return a + seededRand() * (b - a); }

/* ═══════════════════════════════════════════════════════
   1.  STATE
═══════════════════════════════════════════════════════ */
let state = {
  camDist:    22,
  camTheta:   Math.PI / 4,
  camPhi:     Math.PI / 3,
  targetLat:  0,
  targetLon:  0,
  nightMode:  false,
  waterfallOn:true,
  streetMode: false,
  dragging:   false,
  lastMouse:  { x: 0, y: 0 },
  pinchDist:  null,
  hintShown:  false,
};

/* ═══════════════════════════════════════════════════════
   2.  RENDERER / SCENE / CAMERA
═══════════════════════════════════════════════════════ */
const canvas   = document.getElementById("glCanvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled   = true;
renderer.shadowMap.type      = THREE.PCFSoftShadowMap;
renderer.toneMapping         = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x090c14);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 2000);

/* Stars */
(function buildStars() {
  const geo = new THREE.BufferGeometry();
  const n   = 9000;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) pos[i] = (Math.random() - 0.5) * 1400;
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.25, sizeAttenuation: true })));
})();

/* Lights */
const ambient = new THREE.AmbientLight(0x1a2a40, 0.7);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xfff4e0, 2.0);
sun.position.set(18, 24, 12);
sun.castShadow = true;
scene.add(sun);
const rimLight = new THREE.DirectionalLight(0x4aeadc, 0.25);
rimLight.position.set(-20, 5, -15);
scene.add(rimLight);
const underLight = new THREE.DirectionalLight(0x221408, 0.7);
underLight.position.set(5, -20, 8);
scene.add(underLight);

/* ═══════════════════════════════════════════════════════
   3.  DISC CYLINDER BODY (sides + bottom rim)
═══════════════════════════════════════════════════════ */
const discGeo = new THREE.CylinderGeometry(DISC_RADIUS, DISC_RADIUS, 0.18, DISC_SEGS, 1, false);
const discMat = new THREE.MeshStandardMaterial({ color: 0x0f2535, roughness: 0.9, metalness: 0.05 });
const disc    = new THREE.Mesh(discGeo, discMat);
disc.receiveShadow = true;
scene.add(disc);

/* ═══════════════════════════════════════════════════════
   4.  TOP FACE — PlaneGeometry (fixes the spike artefact)

   Why CircleGeometry caused spikes:
     Its UVs wrap around the perimeter — triangles near the seam
     span u≈0 on one side and u≈1 on the other.  The GPU
     interpolates straight across the entire texture = radial spikes.

   PlaneGeometry fix:
     UV.x goes 0→1 left→right, UV.y goes 0→1 bottom→top.
     No seam, no wraparound.  We enforce the circle by calling
     "discard" in the fragment shader for any fragment outside r=0.5.
═══════════════════════════════════════════════════════ */
const topGeo = new THREE.PlaneGeometry(DISC_RADIUS * 2, DISC_RADIUS * 2, 2, 2);
const topMat = new THREE.ShaderMaterial({
  uniforms: {
    tMap:     { value: null },
    nightAmt: { value: 0.0 },
    hasTex:   { value: 0.0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main(){
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tMap;
    uniform float nightAmt;
    uniform float hasTex;
    varying vec2 vUv;
    void main(){
      float r = length(vUv - 0.5);
      if(r > 0.5) discard;                   // circle clip — replaces CircleGeometry shape
      float nr = r * 2.0;
      vec3 base = mix(vec3(0.08,0.30,0.55), vec3(0.03,0.12,0.32), smoothstep(0.4,1.0,nr));
      vec4 col  = vec4(base, 1.0);
      if(hasTex > 0.5){
        vec2 safeUv = clamp(vUv, 0.01, 0.99);
        vec4 t = texture2D(tMap, safeUv);
        col = mix(col, t, 0.93);
      }
      vec3 night = col.rgb * 0.06 + vec3(0.0,0.005,0.02);
      col.rgb = mix(col.rgb, night, nightAmt);
      col.rgb *= 1.0 - smoothstep(0.42,0.5,r)*0.6;
      gl_FragColor = col;
    }
  `,
});
const topMesh = new THREE.Mesh(topGeo, topMat);
topMesh.rotation.x = -Math.PI / 2;
topMesh.position.y  = 0.091;
topMesh.receiveShadow = true;
scene.add(topMesh);

/* Atmosphere glow ring */
(function() {
  const geo = new THREE.RingGeometry(DISC_RADIUS * 0.97, DISC_RADIUS * 1.09, DISC_SEGS);
  const mat = new THREE.MeshBasicMaterial({ color: 0x4aeadc, side: THREE.DoubleSide, transparent: true, opacity: 0.12 });
  const m   = new THREE.Mesh(geo, mat);
  m.rotation.x = -Math.PI / 2;
  m.position.y  = 0.093;
  scene.add(m);
})();

/* ═══════════════════════════════════════════════════════
   5.  ICE MOUNTAINS  (replaces the flat cylinder wall)
═══════════════════════════════════════════════════════ */
const iceMountainsGroup = new THREE.Group();

(function buildIceMountains() {
  const snowMat   = new THREE.MeshStandardMaterial({ color: 0xeef8ff, roughness: 0.40, metalness: 0.18 });
  const iceMat    = new THREE.MeshStandardMaterial({ color: 0x88c4e0, roughness: 0.22, metalness: 0.32, transparent: true, opacity: 0.90 });
  const rockMat   = new THREE.MeshStandardMaterial({ color: 0x4a6070, roughness: 0.75, metalness: 0.08 });
  const shadowMat = new THREE.MeshStandardMaterial({ color: 0x2a3a48, roughness: 0.85, metalness: 0.05 });

  var rings = [
    { count: 80,  ringR: DISC_RADIUS + 0.05, minH: 1.4, maxH: 3.8, minBaseR: 0.22, maxBaseR: 0.55 },
    { count: 130, ringR: DISC_RADIUS - 0.50, minH: 0.25,maxH: 1.5, minBaseR: 0.07, maxBaseR: 0.22 },
    { count: 55,  ringR: DISC_RADIUS + 0.70, minH: 0.3, maxH: 1.0, minBaseR: 0.08, maxBaseR: 0.24 },
  ];

  for (var ri = 0; ri < rings.length; ri++) {
    var ring = rings[ri];
    for (var i = 0; i < ring.count; i++) {
      var angle  = (i / ring.count) * Math.PI * 2 + rng(-0.05, 0.05);
      var h      = rng(ring.minH, ring.maxH);
      var base   = rng(ring.minBaseR, ring.maxBaseR);
      var segs   = 3 + Math.floor(seededRand() * 4);

      var geo = new THREE.ConeGeometry(base, h, segs);
      var pos = geo.attributes.position;

      // Displace vertices for jagged look — more at base, none at tip
      for (var v = 0; v < pos.count; v++) {
        var vy  = pos.getY(v);
        var inf = 1.0 - Math.max(0, (vy + h * 0.5) / h);
        pos.setX(v, pos.getX(v) + rng(-base * 0.40, base * 0.40) * inf);
        pos.setZ(v, pos.getZ(v) + rng(-base * 0.40, base * 0.40) * inf);
        pos.setY(v, vy + rng(-h * 0.05, h * 0.05));
      }
      geo.computeVertexNormals();

      var norm = (h - ring.minH) / (ring.maxH - ring.minH);
      var mat  = norm > 0.65 ? snowMat : (norm > 0.38 ? iceMat : (norm > 0.18 ? rockMat : shadowMat));

      var mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = mesh.receiveShadow = true;

      var r = ring.ringR + rng(-0.35, 0.35);
      mesh.position.set(r * Math.cos(angle), 0.09 + h / 2, r * Math.sin(angle));
      mesh.rotation.y = rng(0, Math.PI * 2);
      mesh.rotation.z = rng(-0.20, 0.20);
      mesh.rotation.x = rng(-0.07, 0.07);
      iceMountainsGroup.add(mesh);
    }
  }

  scene.add(iceMountainsGroup);
})();

/* ═══════════════════════════════════════════════════════
   6.  WATERFALL
═══════════════════════════════════════════════════════ */
const wfGeo = new THREE.CylinderGeometry(DISC_RADIUS + 0.015, DISC_RADIUS + 0.015, WATERFALL_H, 128, 32, true);
const wfMat = new THREE.ShaderMaterial({
  uniforms: { time: { value: 0 }, opacity: { value: 0.8 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    uniform float time;
    uniform float opacity;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5); }
    float noise(vec2 p){
      vec2 i=floor(p),f=fract(p);
      f=f*f*(3.0-2.0*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
    }
    void main(){
      float lane  = floor(vUv.x*60.0);
      float speed = time*1.2+hash(vec2(lane,0.0))*0.6;
      float fall  = fract(vUv.y+speed);
      float streak= smoothstep(0.0,0.14,fall)*smoothstep(1.0,0.50,fall);
      float t1    = noise(vec2(vUv.x*32.0,vUv.y*8.0+time*0.5));
      float t2    = noise(vec2(vUv.x*68.0,vUv.y*18.0+time*0.9));
      float turb  = t1*0.55+t2*0.25;
      float foam  = smoothstep(0.46,0.54,fall)*smoothstep(0.70,0.54,fall);
      vec3 deep   = vec3(0.03,0.15,0.45);
      vec3 mid    = vec3(0.10,0.40,0.80);
      vec3 wht    = vec3(0.90,0.97,1.00);
      vec3 col    = mix(deep,mid,streak);
      col         = mix(col,wht,foam*0.88);
      col        += turb*0.07;
      float alpha = (streak*(0.55+turb*0.30)+foam*0.55);
      alpha      *= opacity*smoothstep(1.0,0.60,vUv.y);
      gl_FragColor = vec4(col,clamp(alpha,0.0,0.95));
    }
  `,
  transparent: true, side: THREE.DoubleSide, depthWrite: false,
});
const waterfall = new THREE.Mesh(wfGeo, wfMat);
waterfall.position.y = 0.09 - WATERFALL_H / 2;
scene.add(waterfall);

/* ═══════════════════════════════════════════════════════
   7.  BEDROCK UNDERSIDE — inverted displaced terrain
═══════════════════════════════════════════════════════ */
(function buildBedrock() {
  // Primary hanging rock layer
  var geo  = new THREE.CircleGeometry(DISC_RADIUS * 0.99, 160);
  var pos  = geo.attributes.position;
  for (var i = 0; i < pos.count; i++) {
    var x = pos.getX(i), z = pos.getZ(i);
    var r = Math.sqrt(x*x + z*z) / DISC_RADIUS;
    var d = 0;
    d += Math.sin(x*1.7+0.4) * Math.cos(z*2.0+0.8) * 0.9;
    d += Math.sin(x*3.5-z*2.8+1.2) * 0.45;
    d += Math.sin(x*6.9+z*5.3-0.7) * 0.22;
    d += Math.sin(x*12.3-z*9.1+2.1) * 0.10;
    d += Math.sin(x*22.7+z*17.3)    * 0.05;
    var hang = Math.max(0, d + 0.6) * 3.0;
    var fade = Math.pow(1.0 - Math.min(r, 1.0), 0.4);
    pos.setY(i, -hang * fade);
  }
  geo.computeVertexNormals();
  var mat  = new THREE.MeshStandardMaterial({ color: 0x2a1c10, roughness: 0.97, metalness: 0.02, side: THREE.DoubleSide });
  var mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.y = -0.1;
  mesh.receiveShadow = true;
  scene.add(mesh);

  // Darker crevice layer
  var geo2  = new THREE.CircleGeometry(DISC_RADIUS * 0.78, 120);
  var pos2  = geo2.attributes.position;
  for (var j = 0; j < pos2.count; j++) {
    var x2 = pos2.getX(j), z2 = pos2.getZ(j);
    var r2  = Math.sqrt(x2*x2 + z2*z2) / (DISC_RADIUS * 0.78);
    var d2  = 0;
    d2 += Math.sin(x2*2.1+1.0) * Math.cos(z2*2.6+0.3) * 0.6;
    d2 += Math.sin(x2*4.3-z2*3.7) * 0.3;
    d2 += Math.sin(x2*8.9+z2*7.1) * 0.15;
    var hang2 = Math.max(0, d2 + 0.4) * 2.5;
    var fade2 = Math.pow(1.0 - Math.min(r2, 1.0), 0.5);
    pos2.setY(j, -hang2 * fade2 - 0.3);
  }
  geo2.computeVertexNormals();
  var mat2  = new THREE.MeshStandardMaterial({ color: 0x140b04, roughness: 0.99, metalness: 0.0, side: THREE.DoubleSide });
  var mesh2 = new THREE.Mesh(geo2, mat2);
  mesh2.rotation.x = Math.PI / 2;
  mesh2.position.y = -0.12;
  scene.add(mesh2);
})();

/* ═══════════════════════════════════════════════════════
   8.  MAP TEXTURE  — TextureLoader (avoids canvas cross-origin issues)
       World view: zoom=1, center=(20,15) — Eurasia+Africa fill disc well.
       Texture is NEVER reloaded on zoom/scroll — only on Reset & search flyTo.
═══════════════════════════════════════════════════════ */
function applyTexture(tex) {
  tex.wrapS     = THREE.ClampToEdgeWrapping;
  tex.wrapT     = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  topMat.uniforms.tMap.value   = tex;
  topMat.uniforms.hasTex.value = 1.0;
}

function loadDiscTexture() {
  if (!window.MAPS_API_KEY || window.MAPS_API_KEY === "YOUR_GOOGLE_MAPS_API_KEY") {
    drawPlaceholderDisc(); return;
  }
  var url = "https://maps.googleapis.com/maps/api/staticmap?center=20,15&zoom=1&size=640x640&maptype=satellite&key=" + window.MAPS_API_KEY;
  var loader = new THREE.TextureLoader();
  loader.crossOrigin = "anonymous";
  loader.load(url, applyTexture, undefined, function() { drawPlaceholderDisc(); });
}

function loadZoomedTexture(lat, lon, zoom) {
  if (!window.MAPS_API_KEY || window.MAPS_API_KEY === "YOUR_GOOGLE_MAPS_API_KEY") return;
  var url = "https://maps.googleapis.com/maps/api/staticmap?center=" + lat.toFixed(4) + "," + lon.toFixed(4) + "&zoom=" + zoom + "&size=640x640&maptype=satellite&key=" + window.MAPS_API_KEY;
  var loader = new THREE.TextureLoader();
  loader.crossOrigin = "anonymous";
  loader.load(url, applyTexture, undefined, function() {});
}

function drawPlaceholderDisc() {
  var c   = document.createElement("canvas");
  c.width = c.height = 1024;
  var ctx = c.getContext("2d");
  var ocean = ctx.createRadialGradient(512,512,0,512,512,512);
  ocean.addColorStop(0,    "#1b6494");
  ocean.addColorStop(0.55, "#0f4470");
  ocean.addColorStop(0.85, "#082e52");
  ocean.addColorStop(1,    "#041c38");
  ctx.beginPath(); ctx.arc(512,512,510,0,Math.PI*2);
  ctx.fillStyle = ocean; ctx.fill();
  [ {cx:430,cy:340,rx:80,ry:110,rot:-0.3,col:"#3d7a3d"},
    {cx:300,cy:440,rx:60,ry:80, rot:0.2, col:"#4a8a2a"},
    {cx:590,cy:360,rx:90,ry:75, rot:0.5, col:"#5a8a3a"},
    {cx:625,cy:495,rx:50,ry:45, rot:-0.1,col:"#6aaa4a"},
  ].forEach(function(b) {
    ctx.save(); ctx.translate(b.cx,b.cy); ctx.rotate(b.rot);
    var g = ctx.createRadialGradient(0,0,0,0,0,Math.max(b.rx,b.ry));
    g.addColorStop(0,b.col); g.addColorStop(1,b.col+"88");
    ctx.beginPath(); ctx.ellipse(0,0,b.rx,b.ry,0,0,Math.PI*2);
    ctx.fillStyle=g; ctx.fill(); ctx.restore();
  });
  var ice = ctx.createRadialGradient(512,512,0,512,512,65);
  ice.addColorStop(0,"rgba(230,245,255,0.95)"); ice.addColorStop(1,"rgba(200,230,255,0)");
  ctx.beginPath(); ctx.arc(512,512,65,0,Math.PI*2); ctx.fillStyle=ice; ctx.fill();
  var tex = new THREE.CanvasTexture(c);
  tex.wrapS     = THREE.ClampToEdgeWrapping;
  tex.wrapT     = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  topMat.uniforms.tMap.value   = tex;
  topMat.uniforms.hasTex.value = 1.0;
}

/* ═══════════════════════════════════════════════════════
   9.  PROJECTION UTILS
═══════════════════════════════════════════════════════ */
function uvToLatLon(u, v) {
  // PlaneGeometry UV: (0.5, 0.5) = disc centre = North Pole
  var sc = 1 / (Math.PI * 0.505);
  var x  = (u - 0.5) / sc;
  var y  = (v - 0.5) / sc;
  var c  = Math.sqrt(x*x + y*y);
  if (c === 0) return [90, 0];
  return [(Math.PI/2 - c) * 180/Math.PI, Math.atan2(x,-y) * 180/Math.PI];
}

/* ═══════════════════════════════════════════════════════
   10. CAMERA — zoom changes camDist only, never touches texture
═══════════════════════════════════════════════════════ */
function updateCamera() {
  var d = state.camDist, t = state.camTheta, p = state.camPhi;
  camera.position.set(
    d * Math.sin(p) * Math.sin(t),
    d * Math.cos(p),
    d * Math.sin(p) * Math.cos(t)
  );
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();

  var altKm = Math.max(0, (d - DISC_RADIUS) * 637);
  document.getElementById("coordAlt").textContent =
    altKm > 9999 ? (altKm/1000).toFixed(0) + ",000 km" : altKm.toFixed(0) + " km";

  var fov    = camera.fov * Math.PI / 180;
  var kpp    = (altKm * 2 * Math.tan(fov/2)) / window.innerHeight;
  var pw     = Math.min(120, Math.max(40, 1000 / Math.max(kpp, 0.1)));
  var km     = Math.round(kpp * pw / 100) * 100 || 1000;
  document.getElementById("scaleLine").style.width  = pw + "px";
  document.getElementById("scaleLabel").textContent = km.toLocaleString() + " km";

  if (p > Math.PI * 0.41 && d < 13) showIceToast();
}

/* ═══════════════════════════════════════════════════════
   11. INPUT — mouse / touch / wheel
═══════════════════════════════════════════════════════ */
canvas.addEventListener("mousedown", function(e) {
  state.dragging  = true;
  state.lastMouse = { x: e.clientX, y: e.clientY };
});
window.addEventListener("mouseup", function() { state.dragging = false; });
window.addEventListener("mousemove", function(e) {
  if (!state.dragging) return;
  state.camTheta -= (e.clientX - state.lastMouse.x) * 0.005;
  state.camPhi    = Math.max(0.12, Math.min(Math.PI * 0.49, state.camPhi + (e.clientY - state.lastMouse.y) * 0.005));
  state.lastMouse = { x: e.clientX, y: e.clientY };
  updateCamera();
  updateCoordsFromMouse(e.clientX, e.clientY);
});

// Zoom = camera distance only. Texture never changes on scroll.
canvas.addEventListener("wheel", function(e) {
  e.preventDefault();
  state.camDist = Math.max(11, Math.min(80, state.camDist + e.deltaY * 0.03));
  updateCamera();
}, { passive: false });

canvas.addEventListener("touchstart", function(e) {
  if (e.touches.length === 2) {
    var dx = e.touches[0].clientX - e.touches[1].clientX;
    var dy = e.touches[0].clientY - e.touches[1].clientY;
    state.pinchDist = Math.sqrt(dx*dx + dy*dy);
  } else {
    state.dragging  = true;
    state.lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  e.preventDefault();
}, { passive: false });

canvas.addEventListener("touchmove", function(e) {
  if (e.touches.length === 2 && state.pinchDist !== null) {
    var dx   = e.touches[0].clientX - e.touches[1].clientX;
    var dy   = e.touches[0].clientY - e.touches[1].clientY;
    var dist = Math.sqrt(dx*dx + dy*dy);
    state.camDist   = Math.max(11, Math.min(80, state.camDist + (state.pinchDist - dist) * 0.08));
    state.pinchDist = dist;
    updateCamera();
  } else if (state.dragging && e.touches.length === 1) {
    state.camTheta -= (e.touches[0].clientX - state.lastMouse.x) * 0.005;
    state.camPhi    = Math.max(0.12, Math.min(Math.PI * 0.49, state.camPhi + (e.touches[0].clientY - state.lastMouse.y) * 0.005));
    state.lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    updateCamera();
  }
  e.preventDefault();
}, { passive: false });
canvas.addEventListener("touchend", function() { state.dragging = false; state.pinchDist = null; });

canvas.addEventListener("dblclick", function(e) {
  var rect  = canvas.getBoundingClientRect();
  var mouse = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width)  * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
  var ray = new THREE.Raycaster();
  ray.setFromCamera(mouse, camera);
  var hits = ray.intersectObject(topMesh);
  if (hits.length > 0) {
    var ll = uvToLatLon(hits[0].uv.x, hits[0].uv.y);
    if (ll[0] < -60) { showIceToast(); return; }
    openStreetView(ll[0], ll[1]);
    if (!state.hintShown) { document.getElementById("hintToast").classList.add("hidden"); state.hintShown = true; }
  }
});

function updateCoordsFromMouse(cx, cy) {
  var rect  = canvas.getBoundingClientRect();
  var mouse = new THREE.Vector2(
    ((cx - rect.left) / rect.width)  * 2 - 1,
    -((cy - rect.top) / rect.height) * 2 + 1
  );
  var ray = new THREE.Raycaster();
  ray.setFromCamera(mouse, camera);
  var hits = ray.intersectObject(topMesh);
  if (hits.length > 0) {
    var ll = uvToLatLon(hits[0].uv.x, hits[0].uv.y);
    document.getElementById("coordLat").textContent = Math.abs(ll[0]).toFixed(3) + "°" + (ll[0] >= 0 ? "N" : "S");
    document.getElementById("coordLon").textContent = Math.abs(ll[1]).toFixed(3) + "°" + (ll[1] >= 0 ? "E" : "W");
  }
}

/* ═══════════════════════════════════════════════════════
   12. UI BUTTONS
═══════════════════════════════════════════════════════ */
document.getElementById("menuBtn").addEventListener("click", function() {
  document.getElementById("sidePanel").classList.toggle("panel-open");
  document.getElementById("sidePanel").classList.toggle("panel-closed");
  document.getElementById("panelOverlay").classList.toggle("visible");
});
document.getElementById("panelClose").addEventListener("click", closePanel);
document.getElementById("panelOverlay").addEventListener("click", closePanel);
function closePanel() {
  document.getElementById("sidePanel").classList.remove("panel-open");
  document.getElementById("sidePanel").classList.add("panel-closed");
  document.getElementById("panelOverlay").classList.remove("visible");
}

document.getElementById("navDisc").addEventListener("click", function() { closeStreetView(); setNavActive("navDisc"); closePanel(); });
document.getElementById("navStreet").addEventListener("click", function() { openStreetView(state.targetLat, state.targetLon); setNavActive("navStreet"); closePanel(); });
function setNavActive(id) {
  document.querySelectorAll(".panel-nav-item").forEach(function(b) { b.classList.remove("active"); });
  document.getElementById(id).classList.add("active");
}

function bindToggle(id, cb) {
  document.getElementById(id).addEventListener("click", function() {
    var el = document.getElementById(id);
    el.classList.toggle("active");
    cb(el.classList.contains("active"));
  });
}
bindToggle("toggleNight",     function(on) { state.nightMode = on; });
bindToggle("toggleWaterfall", function(on) { state.waterfallOn = on; waterfall.visible = on; });
bindToggle("toggleIce",       function(on) { iceMountainsGroup.visible = on; });
bindToggle("toggleSatellite", function(on) { topMat.uniforms.hasTex.value = on ? 1.0 : 0.0; });

document.getElementById("zoomIn").addEventListener("click", function() {
  state.camDist = Math.max(11, state.camDist - 2.5); updateCamera();
});
document.getElementById("zoomOut").addEventListener("click", function() {
  state.camDist = Math.min(80, state.camDist + 2.5); updateCamera();
});
document.getElementById("btnReset").addEventListener("click", function() {
  state.camDist  = 22;
  state.camTheta = Math.PI / 4;
  state.camPhi   = Math.PI / 3;
  updateCamera();
  loadDiscTexture(); // reload world overview on reset only
});
document.getElementById("btnCompass").addEventListener("click", function() {
  state.camTheta = Math.PI / 4; updateCamera();
});

/* ═══════════════════════════════════════════════════════
   13. SEARCH
═══════════════════════════════════════════════════════ */
var searchInput   = document.getElementById("searchInput");
var searchResults = document.getElementById("searchResults");

document.getElementById("searchBtn").addEventListener("click", doSearch);
searchInput.addEventListener("keydown", function(e) { if (e.key === "Enter") doSearch(); });

function doSearch() {
  var q = searchInput.value.trim(); if (!q) return;
  if (!window.MAPS_API_KEY || window.MAPS_API_KEY === "YOUR_GOOGLE_MAPS_API_KEY") { showFallbackSearch(q); return; }
  fetch("https://maps.googleapis.com/maps/api/geocode/json?address=" + encodeURIComponent(q) + "&key=" + window.MAPS_API_KEY)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.status === "REQUEST_DENIED" || data.status === "ERROR") { showFallbackSearch(q); return; }
      if (data.results && data.results.length) { showSearchResults(data.results.slice(0,5)); }
      else { searchResults.innerHTML="<div class='result-item'><span class='result-text'>No results found.</span></div>"; searchResults.classList.add("open"); }
    })
    .catch(function() { showFallbackSearch(q); });
}

var demoPlaces = [
  { name:"London, UK",          lat:51.505,  lng:-0.09   },
  { name:"New York, USA",       lat:40.713,  lng:-74.006 },
  { name:"Tokyo, Japan",        lat:35.683,  lng:139.767 },
  { name:"Sydney, Australia",   lat:-33.868, lng:151.209 },
  { name:"Paris, France",       lat:48.857,  lng:2.352   },
  { name:"Cairo, Egypt",        lat:30.033,  lng:31.233  },
  { name:"North Pole",          lat:89.9,    lng:0       },
  { name:"Antarctica Ice Wall", lat:-70,     lng:0       },
];
function showFallbackSearch(q) {
  var filtered = demoPlaces.filter(function(p) { return p.name.toLowerCase().indexOf(q.toLowerCase()) >= 0; });
  showSearchResults((filtered.length ? filtered : demoPlaces).map(function(p) {
    return { formatted_address: p.name, geometry: { location: { lat: p.lat, lng: p.lng } } };
  }));
}

function showSearchResults(results) {
  searchResults.innerHTML = "";
  results.forEach(function(r) {
    var li = document.createElement("div");
    li.className = "result-item";
    li.innerHTML = '<svg class="result-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg><span class="result-text">' + r.formatted_address + "</span>";
    li.addEventListener("click", function() {
      var loc = r.geometry.location;
      flyTo(loc.lat, loc.lng);
      searchResults.classList.remove("open");
      searchInput.value = r.formatted_address;
    });
    searchResults.appendChild(li);
  });
  searchResults.classList.add("open");
}

document.addEventListener("click", function(e) {
  if (!e.target.closest("#searchBar")) searchResults.classList.remove("open");
});

function flyTo(lat, lon) {
  state.targetLat = lat; state.targetLon = lon;
  document.getElementById("coordLat").textContent = Math.abs(lat).toFixed(3) + "°" + (lat >= 0 ? "N" : "S");
  document.getElementById("coordLon").textContent = Math.abs(lon).toFixed(3) + "°" + (lon >= 0 ? "E" : "W");
  loadZoomedTexture(lat, lon, 4);
}

/* ═══════════════════════════════════════════════════════
   14. STREET VIEW
═══════════════════════════════════════════════════════ */
var mapsJsLoaded   = false;
var streetPanorama = null;

function ensureMapsJs(cb) {
  if (mapsJsLoaded) { cb(); return; }
  if (!window.MAPS_API_KEY || window.MAPS_API_KEY === "YOUR_GOOGLE_MAPS_API_KEY") { alert("Add your API key to use Street View."); return; }
  var s = document.createElement("script");
  s.src = "https://maps.googleapis.com/maps/api/js?key=" + window.MAPS_API_KEY + "&v=weekly";
  s.async = true;
  s.onload = function() { mapsJsLoaded = true; cb(); };
  document.head.appendChild(s);
}

function openStreetView(lat, lon) {
  state.streetMode = true;
  document.getElementById("streetOverlay").classList.remove("hidden");
  document.getElementById("streetCoords").textContent =
    Math.abs(lat).toFixed(4) + "°" + (lat>=0?"N":"S") + ", " + Math.abs(lon).toFixed(4) + "°" + (lon>=0?"E":"W");
  setNavActive("navStreet");
  ensureMapsJs(function() {
    var pos = { lat: lat, lng: lon };
    if (!streetPanorama) {
      streetPanorama = new google.maps.StreetViewPanorama(
        document.getElementById("streetMap"),
        { position: pos, pov: { heading: 34, pitch: 10 }, zoom: 1, addressControl: false, fullscreenControl: false }
      );
    } else {
      streetPanorama.setPosition(pos);
    }
  });
}

function closeStreetView() {
  state.streetMode = false;
  document.getElementById("streetOverlay").classList.add("hidden");
  setNavActive("navDisc");
}
document.getElementById("closeStreet").addEventListener("click", closeStreetView);

/* ═══════════════════════════════════════════════════════
   15. TOASTS
═══════════════════════════════════════════════════════ */
var iceToastTimer = null;
function showIceToast() {
  var el = document.getElementById("iceToast");
  el.classList.remove("hidden", "out");
  clearTimeout(iceToastTimer);
  iceToastTimer = setTimeout(function() {
    el.classList.add("out");
    setTimeout(function() { el.classList.add("hidden"); }, 350);
  }, 3500);
}

setTimeout(function() {
  var h = document.getElementById("hintToast");
  if (h && !h.classList.contains("hidden")) {
    h.classList.add("out");
    setTimeout(function() { h.classList.add("hidden"); }, 350);
  }
}, 8000);

/* ═══════════════════════════════════════════════════════
   16. NIGHT TRANSITION
═══════════════════════════════════════════════════════ */
function tickNight() {
  var target  = state.nightMode ? 1 : 0;
  var current = topMat.uniforms.nightAmt.value;
  topMat.uniforms.nightAmt.value += (target - current) * 0.025;
  ambient.intensity = 0.7  - topMat.uniforms.nightAmt.value * 0.55;
  sun.intensity     = 2.0  - topMat.uniforms.nightAmt.value * 1.9;
}

/* ═══════════════════════════════════════════════════════
   17. RENDER LOOP
═══════════════════════════════════════════════════════ */
var clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  wfMat.uniforms.time.value = clock.getElapsedTime();
  tickNight();
  if (!state.dragging && !state.streetMode) {
    state.camTheta += 0.00006;
    camera.position.set(
      state.camDist * Math.sin(state.camPhi) * Math.sin(state.camTheta),
      state.camDist * Math.cos(state.camPhi),
      state.camDist * Math.sin(state.camPhi) * Math.cos(state.camTheta)
    );
    camera.lookAt(0, 0, 0);
  }
  renderer.render(scene, camera);
}

window.addEventListener("resize", function() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ═══════════════════════════════════════════════════════
   18. INIT  — wrapped in try/catch so loader always dismisses
═══════════════════════════════════════════════════════ */
var LOADER_MSGS = [
  "Initialising flat projection…",
  "Loading azimuthal equidistant map…",
  "Carving Antarctic ice mountains…",
  "Shaping bedrock underside…",
  "Connecting to satellite imagery…",
  "Almost there…",
];

function init() {
  try {
    updateCamera();
    drawPlaceholderDisc();
    loadDiscTexture();
  } catch(err) {
    console.error("Init setup error:", err);
  }

  var fill   = document.getElementById("loaderFill");
  var status = document.getElementById("loaderStatus");
  var pct    = 0;
  var msgIdx = 0;

  var tick = setInterval(function() {
    pct += Math.random() * 20;
    if (pct > 90) pct = 90;
    fill.style.width = pct + "%";
    if (msgIdx < LOADER_MSGS.length - 1) status.textContent = LOADER_MSGS[++msgIdx];
  }, 300);

  // Give textures a moment to start loading, then dismiss loader
  setTimeout(function() {
    clearInterval(tick);
    fill.style.width = "100%";
    status.textContent = "Ready.";
    setTimeout(function() {
      document.getElementById("loader").classList.add("out");
      setTimeout(function() { document.getElementById("loader").style.display = "none"; }, 750);
    }, 350);
    animate();
  }, 1800);
}

init();
