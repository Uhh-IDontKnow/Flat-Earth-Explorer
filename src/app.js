/**
 * FLAT EARTH EXPLORER — app.js (v2)
 * Modern UI wired to all the new HTML/CSS elements
 */
"use strict";

/* ═══════════════════════════════════════════════════════
   0.  STATE
═══════════════════════════════════════════════════════ */
const DISC_RADIUS  = 10;
const DISC_SEGS    = 256;
const WALL_HEIGHT  = 0.9;
const WALL_SEGS    = 128;
const WATERFALL_H  = 3.5;
const EARTH_R_KM   = 6371;

let state = {
  camDist:     22,
  camTheta:    Math.PI / 4,
  camPhi:      Math.PI / 3,
  targetLat:   0,
  targetLon:   0,
  mapZoom:     3,
  nightMode:   false,
  waterfallOn: true,
  streetMode:  false,
  dragging:    false,
  lastMouse:   { x: 0, y: 0 },
  pinchDist:   null,
  hintShown:   false,
};

/* ═══════════════════════════════════════════════════════
   1.  THREE.JS SETUP
═══════════════════════════════════════════════════════ */
const canvas   = document.getElementById("glCanvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled  = true;
renderer.shadowMap.type     = THREE.PCFSoftShadowMap;
renderer.toneMapping        = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene  = new THREE.Scene();
scene.background = new THREE.Color(0x090c14);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 2000);
updateCamera();

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
const ambient  = new THREE.AmbientLight(0x1a2a40, 0.7);
scene.add(ambient);
const sun      = new THREE.DirectionalLight(0xfff4e0, 2.0);
sun.position.set(18, 24, 12);
sun.castShadow = true;
scene.add(sun);
const rim      = new THREE.DirectionalLight(0x4aeadc, 0.25);
rim.position.set(-20, 5, -15);
scene.add(rim);

/* ═══════════════════════════════════════════════════════
   2.  DISC GEOMETRY
═══════════════════════════════════════════════════════ */
/* Disc body (cylinder, very thin) */
const discGeo = new THREE.CylinderGeometry(DISC_RADIUS, DISC_RADIUS, 0.18, DISC_SEGS, 1, false);
const discMat = new THREE.MeshStandardMaterial({ color: 0x1a5c80, roughness: 0.8, metalness: 0.05 });
const disc    = new THREE.Mesh(discGeo, discMat);
disc.receiveShadow = true;
scene.add(disc);

/* Top face — shader material (receives map texture + night) */
const topGeo = new THREE.CircleGeometry(DISC_RADIUS, DISC_SEGS);
const topMat = new THREE.ShaderMaterial({
  uniforms: {
    tMap:     { value: null },
    nightAmt: { value: 0.0 },
    hasTex:   { value: 0.0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tMap;
    uniform float nightAmt;
    uniform float hasTex;
    varying vec2 vUv;
    void main(){
      float r = length(vUv-0.5)*2.0;
      vec3 base = mix(vec3(0.08,0.30,0.55), vec3(0.03,0.12,0.32), smoothstep(0.5,1.0,r));
      vec4 col  = vec4(base, 1.0);
      if(hasTex>0.5){ vec4 t=texture2D(tMap,vUv); col=mix(col,t,0.93); }
      vec3 night = col.rgb*0.06 + vec3(0.0,0.005,0.02);
      col.rgb = mix(col.rgb, night, nightAmt);
      col.rgb *= 1.0 - smoothstep(0.44, 0.5, r)*0.55;
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
   3.  ICE WALL + WATERFALL
═══════════════════════════════════════════════════════ */
/* Ice wall */
const wallGeo = new THREE.CylinderGeometry(DISC_RADIUS + 0.01, DISC_RADIUS + 0.01, WALL_HEIGHT, WALL_SEGS, 1, true);
const wallMat = new THREE.MeshStandardMaterial({ color: 0xddeeff, roughness: 0.4, metalness: 0.2, side: THREE.DoubleSide, transparent: true, opacity: 0.93 });
const wall    = new THREE.Mesh(wallGeo, wallMat);
wall.position.y = 0.09 - WALL_HEIGHT / 2;
scene.add(wall);

/* Waterfall shader */
const wfGeo = new THREE.CylinderGeometry(DISC_RADIUS + 0.015, DISC_RADIUS + 0.015, WATERFALL_H, WALL_SEGS, 32, true);
const wfMat = new THREE.ShaderMaterial({
  uniforms: { time: { value: 0 }, opacity: { value: 0.55 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    uniform float time; uniform float opacity; varying vec2 vUv;
    float rand(vec2 co){ return fract(sin(dot(co,vec2(12.9898,78.233)))*43758.5453); }
    void main(){
      float speed=time*0.6; float fall=fract(vUv.y+speed+rand(vec2(floor(vUv.x*80.0),0.0)));
      float alpha=smoothstep(0.85,1.0,fall)*(0.4+0.6*rand(vec2(vUv.x*80.0,floor(vUv.y*10.0))));
      vec3 col=mix(vec3(0.5,0.8,1.0),vec3(0.9,0.97,1.0),fall);
      gl_FragColor=vec4(col,alpha*opacity);
    }
  `,
  transparent: true, side: THREE.DoubleSide, depthWrite: false,
});
const waterfall    = new THREE.Mesh(wfGeo, wfMat);
waterfall.position.y = wall.position.y - WATERFALL_H / 2 + 0.01;
scene.add(waterfall);

/* ═══════════════════════════════════════════════════════
   4.  MAP TEXTURE
═══════════════════════════════════════════════════════ */
function latLonToUV(lat, lon) {
  const c  = (Math.PI / 2 - lat * Math.PI / 180);
  const lr = lon * Math.PI / 180;
  const sc = 1 / (Math.PI * 0.505);
  return [c * Math.sin(lr) * sc + 0.5, -c * Math.cos(lr) * sc + 0.5];
}
function uvToLatLon(u, v) {
  const sc = 1 / (Math.PI * 0.505);
  const x  = (u - 0.5) / sc;
  const y  = (v - 0.5) / sc;
  const c  = Math.sqrt(x * x + y * y);
  if (c === 0) return [90, 0];
  return [(Math.PI / 2 - c) * 180 / Math.PI, Math.atan2(x, -y) * 180 / Math.PI];
}

const tileCanvas  = document.createElement("canvas");
tileCanvas.width  = 1024;
tileCanvas.height = 1024;
const tileCtx     = tileCanvas.getContext("2d");
const mapTexture  = new THREE.CanvasTexture(tileCanvas);

function loadImage(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload  = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src     = url;
  });
}

async function loadDiscTexture() {
  if (!window.MAPS_API_KEY || window.MAPS_API_KEY === "YOUR_GOOGLE_MAPS_API_KEY") {
    drawPlaceholderDisc(); return;
  }
  const zoom = Math.min(state.mapZoom, 5);
  const lat  = state.targetLat.toFixed(4);
  const lon  = state.targetLon.toFixed(4);
  const url  = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lon}&zoom=${zoom}&size=640x640&maptype=satellite&key=${window.MAPS_API_KEY}`;
  const img  = await loadImage(url);
  if (!img) { drawPlaceholderDisc(); return; }
  tileCtx.clearRect(0, 0, 1024, 1024);
  tileCtx.save();
  tileCtx.beginPath();
  tileCtx.arc(512, 512, 510, 0, Math.PI * 2);
  tileCtx.clip();
  tileCtx.drawImage(img, 0, 0, 1024, 1024);
  tileCtx.restore();
  mapTexture.needsUpdate   = true;
  topMat.uniforms.tMap.value   = mapTexture;
  topMat.uniforms.hasTex.value = 1.0;
}

function drawPlaceholderDisc() {
  tileCtx.clearRect(0, 0, 1024, 1024);
  const ocean = tileCtx.createRadialGradient(512, 512, 0, 512, 512, 512);
  ocean.addColorStop(0,    "#1b6494");
  ocean.addColorStop(0.55, "#0f4470");
  ocean.addColorStop(0.85, "#082e52");
  ocean.addColorStop(1,    "#041c38");
  tileCtx.beginPath(); tileCtx.arc(512, 512, 510, 0, Math.PI * 2);
  tileCtx.fillStyle = ocean; tileCtx.fill();
  [
    { cx:430, cy:340, rx:80, ry:110, rot:-0.3, c:"#3d7a3d" },
    { cx:300, cy:440, rx:60, ry:80,  rot:0.2,  c:"#4a8a2a" },
    { cx:590, cy:360, rx:90, ry:75,  rot:0.5,  c:"#5a8a3a" },
    { cx:625, cy:495, rx:50, ry:45,  rot:-0.1, c:"#6aaa4a" },
  ].forEach(({ cx, cy, rx, ry, rot, c }) => {
    tileCtx.save(); tileCtx.translate(cx, cy); tileCtx.rotate(rot);
    const g = tileCtx.createRadialGradient(0,0,0,0,0,Math.max(rx,ry));
    g.addColorStop(0, c); g.addColorStop(1, c + "88");
    tileCtx.beginPath(); tileCtx.ellipse(0,0,rx,ry,0,0,Math.PI*2);
    tileCtx.fillStyle = g; tileCtx.fill(); tileCtx.restore();
  });
  const ice = tileCtx.createRadialGradient(512, 512, 0, 512, 512, 65);
  ice.addColorStop(0, "rgba(230,245,255,0.95)"); ice.addColorStop(1, "rgba(200,230,255,0)");
  tileCtx.beginPath(); tileCtx.arc(512, 512, 65, 0, Math.PI * 2);
  tileCtx.fillStyle = ice; tileCtx.fill();
  mapTexture.needsUpdate   = true;
  topMat.uniforms.tMap.value   = mapTexture;
  topMat.uniforms.hasTex.value = 1.0;
}

/* ═══════════════════════════════════════════════════════
   5.  CAMERA
═══════════════════════════════════════════════════════ */
function updateCamera() {
  const { camDist, camTheta, camPhi } = state;
  camera.position.set(
    camDist * Math.sin(camPhi) * Math.sin(camTheta),
    camDist * Math.cos(camPhi),
    camDist * Math.sin(camPhi) * Math.cos(camTheta)
  );
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();

  /* Update HUD */
  const altKm = Math.max(0, (camDist - DISC_RADIUS) * 637);
  document.getElementById("coordAlt").textContent =
    altKm > 9999
      ? (altKm / 1000).toFixed(0) + ",000 km"
      : altKm.toFixed(0) + " km";

  /* Scale bar */
  const fov    = camera.fov * Math.PI / 180;
  const kmPerPx = (altKm * 2 * Math.tan(fov / 2)) / window.innerHeight;
  const targetKm = 1000;
  const pxWidth  = Math.min(120, Math.max(40, targetKm / Math.max(kmPerPx, 1)));
  const actualKm = Math.round(kmPerPx * pxWidth / 100) * 100 || targetKm;
  document.getElementById("scaleLine").style.width  = pxWidth + "px";
  document.getElementById("scaleLabel").textContent = actualKm.toLocaleString() + " km";

  /* Ice toast when near edge */
  if (camPhi > Math.PI * 0.41 && camDist < 13) {
    showIceToast();
  }
}

/* ═══════════════════════════════════════════════════════
   6.  MOUSE / TOUCH INPUT
═══════════════════════════════════════════════════════ */
canvas.addEventListener("mousedown", e => {
  state.dragging  = true;
  state.lastMouse = { x: e.clientX, y: e.clientY };
});
window.addEventListener("mouseup", () => { state.dragging = false; });
window.addEventListener("mousemove", e => {
  if (!state.dragging) return;
  const dx = e.clientX - state.lastMouse.x;
  const dy = e.clientY - state.lastMouse.y;
  state.camTheta -= dx * 0.005;
  state.camPhi    = Math.max(0.12, Math.min(Math.PI * 0.49, state.camPhi + dy * 0.005));
  state.lastMouse = { x: e.clientX, y: e.clientY };
  updateCamera();

  /* Update coordinate HUD from raycasting */
  updateCoordsFromMouse(e.clientX, e.clientY);
});

canvas.addEventListener("wheel", e => {
  e.preventDefault();
  state.camDist = Math.max(10.5, Math.min(80, state.camDist + e.deltaY * 0.03));
  const nz = Math.min(5, Math.max(1, Math.round(22 - state.camDist)));
  if (nz !== state.mapZoom) { state.mapZoom = nz; loadDiscTexture(); }
  updateCamera();
}, { passive: false });

canvas.addEventListener("touchstart", e => {
  if (e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    state.pinchDist = Math.sqrt(dx * dx + dy * dy);
  } else {
    state.dragging  = true;
    state.lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  e.preventDefault();
}, { passive: false });

canvas.addEventListener("touchmove", e => {
  if (e.touches.length === 2 && state.pinchDist !== null) {
    const dx   = e.touches[0].clientX - e.touches[1].clientX;
    const dy   = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    state.camDist   = Math.max(10.5, Math.min(80, state.camDist + (state.pinchDist - dist) * 0.08));
    state.pinchDist = dist;
    updateCamera();
  } else if (state.dragging && e.touches.length === 1) {
    const dx = e.touches[0].clientX - state.lastMouse.x;
    const dy = e.touches[0].clientY - state.lastMouse.y;
    state.camTheta -= dx * 0.005;
    state.camPhi    = Math.max(0.12, Math.min(Math.PI * 0.49, state.camPhi + dy * 0.005));
    state.lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    updateCamera();
  }
  e.preventDefault();
}, { passive: false });
canvas.addEventListener("touchend", () => { state.dragging = false; state.pinchDist = null; });

/* Double-click → Street View */
canvas.addEventListener("dblclick", e => {
  const rect  = canvas.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width)  * 2 - 1,
    -((e.clientY - rect.top)  / rect.height) * 2 + 1
  );
  const ray  = new THREE.Raycaster();
  ray.setFromCamera(mouse, camera);
  const hits = ray.intersectObject(topMesh);
  if (hits.length > 0) {
    const [lat, lon] = uvToLatLon(hits[0].uv.x, hits[0].uv.y);
    if (lat < -60) { showIceToast(); return; }
    openStreetView(lat, lon);
    if (!state.hintShown) {
      document.getElementById("hintToast").classList.add("hidden");
      state.hintShown = true;
    }
  }
});

function updateCoordsFromMouse(cx, cy) {
  const rect  = canvas.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((cx - rect.left) / rect.width)  * 2 - 1,
    -((cy - rect.top)  / rect.height) * 2 + 1
  );
  const ray  = new THREE.Raycaster();
  ray.setFromCamera(mouse, camera);
  const hits = ray.intersectObject(topMesh);
  if (hits.length > 0) {
    const [lat, lon] = uvToLatLon(hits[0].uv.x, hits[0].uv.y);
    state.targetLat  = lat;
    state.targetLon  = lon;
    document.getElementById("coordLat").textContent =
      Math.abs(lat).toFixed(3) + "°" + (lat >= 0 ? "N" : "S");
    document.getElementById("coordLon").textContent =
      Math.abs(lon).toFixed(3) + "°" + (lon >= 0 ? "E" : "W");
  }
}

/* ═══════════════════════════════════════════════════════
   7.  UI BUTTONS
═══════════════════════════════════════════════════════ */

/* Hamburger → side panel */
document.getElementById("menuBtn").addEventListener("click", () => {
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

/* Panel nav */
document.getElementById("navDisc").addEventListener("click", () => {
  closeStreetView();
  setNavActive("navDisc");
  closePanel();
});
document.getElementById("navStreet").addEventListener("click", () => {
  openStreetView(state.targetLat, state.targetLon);
  setNavActive("navStreet");
  closePanel();
});
function setNavActive(id) {
  document.querySelectorAll(".panel-nav-item").forEach(b => b.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

/* Toggles */
function bindToggle(id, cb) {
  const el = document.getElementById(id);
  el.addEventListener("click", () => {
    el.classList.toggle("active");
    cb(el.classList.contains("active"));
  });
}
bindToggle("toggleNight", on => { state.nightMode = on; });
bindToggle("toggleWaterfall", on => {
  state.waterfallOn = on;
  waterfall.visible = on;
});
bindToggle("toggleIce", on => { wall.visible = on; });
bindToggle("toggleSatellite", on => {
  topMat.uniforms.hasTex.value = on ? 1.0 : 0.0;
});

/* Toolbar buttons */
document.getElementById("zoomIn").addEventListener("click", () => {
  state.camDist = Math.max(10.5, state.camDist - 2.5);
  updateCamera(); loadDiscTexture();
});
document.getElementById("zoomOut").addEventListener("click", () => {
  state.camDist = Math.min(80, state.camDist + 2.5);
  updateCamera(); loadDiscTexture();
});
document.getElementById("btnReset").addEventListener("click", () => {
  state.camDist  = 22;
  state.camTheta = Math.PI / 4;
  state.camPhi   = Math.PI / 3;
  updateCamera(); loadDiscTexture();
});
document.getElementById("btnCompass").addEventListener("click", () => {
  state.camTheta = Math.PI / 4;
  updateCamera();
});

/* ═══════════════════════════════════════════════════════
   8.  SEARCH
═══════════════════════════════════════════════════════ */
const searchInput   = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");

document.getElementById("searchBtn").addEventListener("click", doSearch);
searchInput.addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });

async function doSearch() {
  const q = searchInput.value.trim();
  if (!q) return;
  if (!window.MAPS_API_KEY || window.MAPS_API_KEY === "YOUR_GOOGLE_MAPS_API_KEY") {
    showFallbackSearch(q); return;
  }
  try {
    const url  = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${window.MAPS_API_KEY}`;
    const data = await fetch(url).then(r => r.json());
    if (data.results?.length) showSearchResults(data.results.slice(0, 5));
    else { searchResults.innerHTML = "<div class='result-item'><span class='result-text'>No results found.</span></div>"; searchResults.classList.add("open"); }
  } catch { /* silently fail */ }
}

/* Fallback for no-API-key demo */
const demoPlaces = [
  { name: "London, UK",          lat: 51.505,   lon: -0.09 },
  { name: "New York, USA",       lat: 40.713,   lon: -74.006 },
  { name: "Tokyo, Japan",        lat: 35.683,   lon: 139.767 },
  { name: "Sydney, Australia",   lat: -33.868,  lon: 151.209 },
  { name: "Paris, France",       lat: 48.857,   lon: 2.352 },
  { name: "Cairo, Egypt",        lat: 30.033,   lon: 31.233 },
  { name: "North Pole",          lat: 89.9,     lon: 0 },
  { name: "Antarctica Ice Wall", lat: -70,      lon: 0 },
];
function showFallbackSearch(q) {
  const filtered = demoPlaces.filter(p => p.name.toLowerCase().includes(q.toLowerCase()));
  const results  = filtered.length ? filtered : demoPlaces;
  showSearchResults(results.map(p => ({
    formatted_address: p.name,
    geometry: { location: { lat: p.lat, lng: p.lon } },
  })));
}

function showSearchResults(results) {
  searchResults.innerHTML = "";
  results.forEach(r => {
    const li  = document.createElement("div");
    li.className = "result-item";
    li.innerHTML = `
      <svg class="result-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/>
      </svg>
      <span class="result-text">${r.formatted_address}</span>`;
    li.addEventListener("click", () => {
      const { lat, lng } = r.geometry.location;
      flyTo(lat, lng);
      searchResults.classList.remove("open");
      searchInput.value = r.formatted_address;
    });
    searchResults.appendChild(li);
  });
  searchResults.classList.add("open");
}

document.addEventListener("click", e => {
  if (!e.target.closest("#searchBar")) searchResults.classList.remove("open");
});

function flyTo(lat, lon) {
  state.targetLat = lat;
  state.targetLon = lon;
  document.getElementById("coordLat").textContent = Math.abs(lat).toFixed(3) + "°" + (lat >= 0 ? "N" : "S");
  document.getElementById("coordLon").textContent = Math.abs(lon).toFixed(3) + "°" + (lon >= 0 ? "E" : "W");
  loadDiscTexture();
}

/* ═══════════════════════════════════════════════════════
   9.  STREET VIEW
═══════════════════════════════════════════════════════ */
let mapsLoaded   = false;
let streetPanorama = null;

function ensureMapsJs(cb) {
  if (mapsLoaded) { cb(); return; }
  if (!window.MAPS_API_KEY || window.MAPS_API_KEY === "YOUR_GOOGLE_MAPS_API_KEY") {
    alert("Add your Google Maps API key to use Street View."); return;
  }
  const s   = document.createElement("script");
  s.src     = `https://maps.googleapis.com/maps/api/js?key=${window.MAPS_API_KEY}&v=weekly`;
  s.async   = true;
  s.onload  = () => { mapsLoaded = true; cb(); };
  document.head.appendChild(s);
}

function openStreetView(lat, lon) {
  state.streetMode = true;
  document.getElementById("streetOverlay").classList.remove("hidden");
  document.getElementById("streetCoords").textContent =
    `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? "E" : "W"}`;
  setNavActive("navStreet");

  ensureMapsJs(() => {
    const pos = { lat, lng: lon };
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
   10. TOASTS
═══════════════════════════════════════════════════════ */
let iceToastTimer = null;
function showIceToast() {
  const el = document.getElementById("iceToast");
  el.classList.remove("hidden", "out");
  clearTimeout(iceToastTimer);
  iceToastTimer = setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.classList.add("hidden"), 350);
  }, 3500);
}

/* Hide hint after 7 seconds */
setTimeout(() => {
  const h = document.getElementById("hintToast");
  if (!h.classList.contains("hidden")) {
    h.classList.add("out");
    setTimeout(() => h.classList.add("hidden"), 350);
  }
}, 8000);

/* ═══════════════════════════════════════════════════════
   11. NIGHT TRANSITION
═══════════════════════════════════════════════════════ */
function tickNight() {
  const target  = state.nightMode ? 1 : 0;
  const current = topMat.uniforms.nightAmt.value;
  topMat.uniforms.nightAmt.value += (target - current) * 0.025;
  ambient.intensity  = 0.7  - topMat.uniforms.nightAmt.value * 0.55;
  sun.intensity      = 2.0  - topMat.uniforms.nightAmt.value * 1.9;
}

/* ═══════════════════════════════════════════════════════
   12. RENDER LOOP
═══════════════════════════════════════════════════════ */
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();
  wfMat.uniforms.time.value = t;
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

/* ═══════════════════════════════════════════════════════
   13. RESIZE
═══════════════════════════════════════════════════════ */
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ═══════════════════════════════════════════════════════
   14. INIT
═══════════════════════════════════════════════════════ */
const LOADER_MSGS = [
  "Initialising flat projection…",
  "Loading azimuthal equidistant map…",
  "Placing Antarctic ice wall…",
  "Animating waterfalls…",
  "Connecting to satellite imagery…",
  "Almost there…",
];

(async function init() {
  const fill   = document.getElementById("loaderFill");
  const status = document.getElementById("loaderStatus");
  let   pct    = 0;
  let   msgIdx = 0;

  const tick = setInterval(() => {
    pct += Math.random() * 20;
    if (pct > 90) pct = 90;
    fill.style.width = pct + "%";
    if (msgIdx < LOADER_MSGS.length - 1) status.textContent = LOADER_MSGS[++msgIdx];
  }, 300);

  drawPlaceholderDisc();
  await loadDiscTexture();

  clearInterval(tick);
  fill.style.width = "100%";
  status.textContent = "Ready.";
  await new Promise(r => setTimeout(r, 350));

  document.getElementById("loader").classList.add("out");
  setTimeout(() => { document.getElementById("loader").style.display = "none"; }, 750);

  animate();
})();
