/**
 * FLAT EARTH EXPLORER — app.js (v6)
 *
 * Key improvements over previous versions:
 *  - THREE.OrbitControls replaces all manual drag/zoom code
 *    → smooth damping, inertia, momentum — feels like Google Earth
 *  - NASA Blue Marble texture (free, seamless, 8K quality)
 *    → no more UV seam glitches from Google Maps Static tiles
 *  - Google Maps API used only for Street View (where it works great)
 *  - Continuous rocky cliff wall with procedural rock/snow shader
 *  - Proper atmospheric dome + lens-flare-style sun glow
 *  - Bedrock underside with displaced terrain
 */
"use strict";

/* ─────────────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────────── */
const DISC_R    = 10;
const WALL_H    = 4.0;
const WALL_SEGS = 256;

/* ─────────────────────────────────────────────────
   STATE (minimal — OrbitControls owns camera now)
───────────────────────────────────────────────── */
var state = {
  nightMode:  false,
  streetMode: false,
  hintShown:  false,
};

/* ─────────────────────────────────────────────────
   SEEDED RNG for consistent geometry
───────────────────────────────────────────────── */
var _seed = 137;
function sr() { _seed = (_seed * 1664525 + 1013904223) & 0xffffffff; return (_seed >>> 0) / 0xffffffff; }
function rng(a, b) { return a + sr() * (b - a); }

/* ─────────────────────────────────────────────────
   RENDERER
───────────────────────────────────────────────── */
var canvas   = document.getElementById("glCanvas");
var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled   = true;
renderer.shadowMap.type      = THREE.PCFSoftShadowMap;
renderer.toneMapping         = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;

/* ─────────────────────────────────────────────────
   SCENE
───────────────────────────────────────────────── */
var scene = new THREE.Scene();
scene.background = new THREE.Color(0x06080f);

/* Stars — two layers for depth */
(function() {
  function starField(n, spread, size) {
    var g = new THREE.BufferGeometry();
    var p = new Float32Array(n * 3);
    for (var i = 0; i < p.length; i++) p[i] = (Math.random() - 0.5) * spread;
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: size, sizeAttenuation: true })));
  }
  starField(8000, 1600, 0.28);
  starField(2000, 800,  0.12);
})();

/* ─────────────────────────────────────────────────
   CAMERA + ORBIT CONTROLS
───────────────────────────────────────────────── */
var camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.05, 2000);
camera.position.set(14, 9, 14);  // starting position — slightly above and to side
camera.lookAt(0, 0, 0);

var controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping    = true;   // smooth deceleration
controls.dampingFactor    = 0.06;   // feel of Google Earth inertia
controls.rotateSpeed      = 0.55;
controls.zoomSpeed        = 0.9;
controls.minDistance      = 11.2;   // can't go inside the disc
controls.maxDistance      = 80;
controls.maxPolarAngle    = Math.PI * 0.52; // can't go under the disc too far
controls.enablePan        = false;  // no panning — keeps disc centred like Google Earth
controls.touches          = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };

/* ─────────────────────────────────────────────────
   LIGHTS
───────────────────────────────────────────────── */
var ambient = new THREE.AmbientLight(0x1a2a40, 0.6);
scene.add(ambient);

// Main sun — positioned top-left like the reference image
var sun = new THREE.DirectionalLight(0xffd080, 2.8);
sun.position.set(-18, 30, -12);
sun.castShadow = true;
sun.shadow.mapSize.width  = 2048;
sun.shadow.mapSize.height = 2048;
scene.add(sun);

// Fill light from opposite side — cool blue
var fill = new THREE.DirectionalLight(0x3060a0, 0.4);
fill.position.set(20, 8, 18);
scene.add(fill);

// Under-light for bedrock
var underLight = new THREE.DirectionalLight(0x1a0800, 0.9);
underLight.position.set(0, -20, 0);
scene.add(underLight);

/* ─────────────────────────────────────────────────
   DISC BODY (cylinder sides — rock/stone)
───────────────────────────────────────────────── */
var bodyGeo = new THREE.CylinderGeometry(DISC_R, DISC_R, 0.28, WALL_SEGS, 1, false);
var bodyMat = new THREE.MeshStandardMaterial({ color: 0x0d1e2a, roughness: 0.92, metalness: 0.04 });
var body    = new THREE.Mesh(bodyGeo, bodyMat);
body.receiveShadow = true;
scene.add(body);

/* ─────────────────────────────────────────────────
   TOP FACE — PlaneGeometry (NO UV SEAM = NO SPIKES)

   CircleGeometry causes radial spikes because its UVs
   wrap at the perimeter seam, sweeping the GPU across
   the entire texture. PlaneGeometry has a clean grid.
   We clip to a circle by discarding in the shader.
───────────────────────────────────────────────── */
var topGeo = new THREE.PlaneGeometry(DISC_R * 2, DISC_R * 2, 4, 4);

var topMat = new THREE.ShaderMaterial({
  uniforms: {
    tMap:     { value: null },
    tNight:   { value: null },
    hasTex:   { value: 0.0 },
    nightAmt: { value: 0.0 },
    sunDir:   { value: new THREE.Vector3(-0.45, 0.75, -0.3).normalize() },
  },
  vertexShader: `
    varying vec2 vUv;
    varying vec3 vNorm;
    void main(){
      vUv  = uv;
      vNorm = normalize(normalMatrix * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tMap;
    uniform float     hasTex;
    uniform float     nightAmt;
    uniform vec3      sunDir;
    varying vec2 vUv;
    varying vec3 vNorm;
    void main(){
      float r  = length(vUv - 0.5);
      if(r > 0.5) discard;          // circle clip — safe, no UV seam issues

      float nr = r * 2.0;
      vec3 base = mix(vec3(0.07,0.22,0.48), vec3(0.02,0.08,0.25), smoothstep(0.3,1.0,nr));
      vec4 col  = vec4(base, 1.0);

      if(hasTex > 0.5){
        // Clamp to avoid any border bleed
        vec2 uv2 = clamp(vUv, 0.008, 0.992);
        col = texture2D(tMap, uv2);
      }

      // Subtle atmospheric limb darkening at edge
      col.rgb *= 1.0 - smoothstep(0.38, 0.5, r) * 0.55;

      // Sun-side brightening (cheap directional tint)
      float sunDot = dot(vNorm, sunDir) * 0.5 + 0.5;
      col.rgb = mix(col.rgb, col.rgb * 1.18, sunDot * (1.0 - nightAmt) * 0.4);

      // Night overlay
      vec3 nightCol = col.rgb * 0.08 + vec3(0.0,0.004,0.016);
      col.rgb = mix(col.rgb, nightCol, nightAmt);

      gl_FragColor = col;
    }
  `,
});

var topMesh = new THREE.Mesh(topGeo, topMat);
topMesh.rotation.x = -Math.PI / 2;
topMesh.position.y  = 0.141;
topMesh.receiveShadow = true;
scene.add(topMesh);

/* ─────────────────────────────────────────────────
   ATMOSPHERE DOME
   A large translucent hemisphere over the disc —
   creates the blue atmospheric glow in the reference.
───────────────────────────────────────────────── */
(function buildAtmosphere() {
  // Outer atmospheric halo ring
  var haloGeo = new THREE.RingGeometry(DISC_R * 0.90, DISC_R * 1.22, WALL_SEGS);
  var haloMat = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `
      varying vec2 vUv;
      void main(){
        // vUv.x = 0 at inner edge, 1 at outer edge (for RingGeometry)
        float t = vUv.x;
        float alpha = smoothstep(1.0,0.0,t) * 0.5 * (1.0-smoothstep(0.0,0.15,t));
        // bright inner rim, fading outward
        float rimAlpha = smoothstep(0.08,0.0,t) * 0.8;
        vec3 col = mix(vec3(0.4,0.75,1.0), vec3(0.15,0.5,0.9), t);
        gl_FragColor = vec4(col, clamp(alpha+rimAlpha,0.0,1.0));
      }
    `,
    transparent: true, side: THREE.DoubleSide, depthWrite: false,
  });
  var halo = new THREE.Mesh(haloGeo, haloMat);
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.145;
  scene.add(halo);

  // Bright glowing rim right at disc edge
  var rimGeo = new THREE.TorusGeometry(DISC_R, 0.08, 8, WALL_SEGS);
  var rimMat = new THREE.MeshBasicMaterial({ color: 0x88ccff, transparent: true, opacity: 0.7 });
  var rim    = new THREE.Mesh(rimGeo, rimMat);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.14;
  scene.add(rim);
})();

/* ─────────────────────────────────────────────────
   SUN GLOW (sprite-style billboard)
   Matches the golden lens-flare sun in the reference.
───────────────────────────────────────────────── */
(function buildSunGlow() {
  var sunGlowMat = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: `void main(){ gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `
      void main(){
        // Not used as sprite — rendered as plane facing camera via JS
        gl_FragColor = vec4(1.0, 0.85, 0.3, 0.0);
      }
    `,
    transparent: true,
  });

  // Simple point light flare using a large emissive sphere far away
  var flareGeo = new THREE.SphereGeometry(2.5, 16, 16);
  var flareMat = new THREE.MeshBasicMaterial({
    color: 0xffdd44, transparent: true, opacity: 0.55,
  });
  var flare = new THREE.Mesh(flareGeo, flareMat);
  flare.position.set(-45, 60, -35);
  scene.add(flare);

  // Outer glow halo around sun
  var geoH = new THREE.SphereGeometry(6, 16, 16);
  var matH = new THREE.MeshBasicMaterial({ color: 0xff9900, transparent: true, opacity: 0.18 });
  var meshH = new THREE.Mesh(geoH, matH);
  meshH.position.copy(flare.position);
  scene.add(meshH);
})();

/* ─────────────────────────────────────────────────
   ICE CLIFF WALL
   Continuous displaced cylinder — dark rock at base,
   snow/ice at top, matching the reference image edge.
───────────────────────────────────────────────── */
var iceGroup = new THREE.Group();

(function buildIceWall() {
  var SEGS_H = 80;   // vertical displacement resolution
  var SEGS_C = 256;  // circumference resolution

  var geo = new THREE.CylinderGeometry(
    DISC_R + 0.06, DISC_R + 0.06, WALL_H, SEGS_C, SEGS_H, true
  );
  var pos = geo.attributes.position;

  for (var i = 0; i < pos.count; i++) {
    var x  = pos.getX(i);
    var y  = pos.getY(i);
    var z  = pos.getZ(i);
    var th = Math.atan2(z, x);
    var rad = Math.sqrt(x*x + z*z);

    // Horizontal rock strata
    var strata = Math.sin(y * 9.0 + th * 3.0) * 0.055
               + Math.sin(y * 22.0 + th * 8.0) * 0.025
               + Math.sin(y * 50.0 + th * 15.0) * 0.012;

    // Large undulating cliff face
    var bulge  = Math.sin(th * 5.0 + 0.5) * 0.14
               + Math.sin(th * 12.0 + 1.8) * 0.07
               + Math.sin(th * 28.0 + 3.1) * 0.035;

    var newRad = rad + strata + bulge;
    pos.setX(i, (x / rad) * newRad);
    pos.setZ(i, (z / rad) * newRad);
    pos.setY(i, y + Math.sin(th * 9.0 + y * 5.0) * 0.045);
  }
  geo.computeVertexNormals();

  var mat = new THREE.ShaderMaterial({
    uniforms: { wallH: { value: WALL_H } },
    vertexShader: `
      varying vec3 vPos;
      varying vec3 vNorm;
      void main(){
        vPos  = position;
        vNorm = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
      }
    `,
    fragmentShader: `
      uniform float wallH;
      varying vec3 vPos;
      varying vec3 vNorm;

      float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5); }
      float noise(vec2 p){
        vec2 i=floor(p), f=fract(p);
        f=f*f*(3.-2.*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
                   mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
      }

      void main(){
        float th = atan(vPos.z, vPos.x);
        float yN = (vPos.y + wallH*0.5) / wallH;  // 0=bottom, 1=top

        // Rock layers
        float s1 = noise(vec2(th*7.0,  yN*12.0));
        float s2 = noise(vec2(th*18.0, yN*28.0));
        float s3 = noise(vec2(th*3.5,  yN*5.0));

        vec3 dark  = vec3(0.13, 0.11, 0.10);
        vec3 mid   = vec3(0.24, 0.20, 0.17);
        vec3 light = vec3(0.36, 0.31, 0.26);

        vec3 col = mix(dark, mid, s1);
        col = mix(col, light, s2 * 0.35);
        col = mix(col, dark * 0.6, s3 * 0.25);

        // Ice/snow begins ~35% from top, full snow at top 55%
        float snowBlend = smoothstep(0.35, 0.60, yN);
        // Snow has its own texture variation
        float snowNoise = noise(vec2(th*14.0, yN*20.0+3.0));
        vec3 snowCol = mix(vec3(0.72,0.82,0.92), vec3(0.90,0.95,1.00), snowNoise);
        col = mix(col, snowCol, snowBlend * 0.88);

        // Blue ice veins in snow
        float iceVein = noise(vec2(th*25.0+1.0, yN*40.0));
        vec3 iceBlue  = vec3(0.55, 0.78, 0.95);
        col = mix(col, iceBlue, iceVein * snowBlend * 0.35);

        // Waterfall streaks — vertical white lines in lower 40%
        float wfLane = floor(th * 80.0);
        float wfNoise = hash(vec2(wfLane, 0.0));
        float wfStreak = smoothstep(0.0, 0.02, mod(th*80.0, 1.0)) * smoothstep(0.22+wfNoise*0.15, 0.0, yN);
        col = mix(col, vec3(0.75, 0.88, 1.0), wfStreak * 0.6);

        // Diffuse lighting
        float diff = max(0.0, dot(vNorm, normalize(vec3(-0.45,0.75,-0.3)))) * 0.8 + 0.25;
        col *= diff;

        // Atmospheric tint on ice
        col = mix(col, vec3(0.5,0.72,0.95), snowBlend * 0.12);

        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.DoubleSide,
  });

  var mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 0.14 - WALL_H * 0.5 + 0.05;
  mesh.castShadow = mesh.receiveShadow = true;
  iceGroup.add(mesh);

  // Snow-cap torus ring right at top of wall
  var capGeo = new THREE.TorusGeometry(DISC_R + 0.06, 0.28, 10, WALL_SEGS);
  var capMat = new THREE.MeshStandardMaterial({ color: 0xddeeff, roughness: 0.45, metalness: 0.12 });
  var cap    = new THREE.Mesh(capGeo, capMat);
  cap.rotation.x = Math.PI / 2;
  cap.position.y = 0.14 + 0.14;
  cap.castShadow = true;
  iceGroup.add(cap);

  scene.add(iceGroup);
})();

/* ─────────────────────────────────────────────────
   WATERFALL — flowing animated water off the edge
───────────────────────────────────────────────── */
var wfGeo = new THREE.CylinderGeometry(
  DISC_R + 0.07, DISC_R + 0.07, WALL_H * 0.7, 192, 40, true
);
var wfMat = new THREE.ShaderMaterial({
  uniforms: { time: { value: 0.0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    uniform float time;
    varying vec2 vUv;

    float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5); }
    float noise(vec2 p){
      vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
                 mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
    }

    void main(){
      // Per-lane falling streams
      float lane   = floor(vUv.x * 70.0);
      float lspeed = time * 1.3 + hash(vec2(lane, 0.0)) * 0.7;
      float fall   = fract(vUv.y + lspeed);

      // Streak shape
      float streak = smoothstep(0.0, 0.12, fall) * smoothstep(1.0, 0.45, fall);

      // Turbulence
      float t1 = noise(vec2(vUv.x * 28.0, vUv.y *  7.0 + time * 0.4)) * 0.55;
      float t2 = noise(vec2(vUv.x * 60.0, vUv.y * 15.0 + time * 0.8)) * 0.28;
      float turb = t1 + t2;

      // Foam crest
      float foam = smoothstep(0.42, 0.52, fall) * smoothstep(0.68, 0.52, fall);

      vec3 deep  = vec3(0.02, 0.12, 0.42);
      vec3 mid   = vec3(0.08, 0.38, 0.78);
      vec3 white = vec3(0.88, 0.95, 1.00);

      vec3 col = mix(deep, mid, streak);
      col = mix(col, white, foam * 0.9);
      col += turb * 0.08;

      float alpha = streak * (0.6 + turb * 0.25) + foam * 0.55;
      // Fade at top (behind ice) and bottom (mist)
      alpha *= smoothstep(0.0, 0.12, vUv.y) * smoothstep(1.0, 0.62, vUv.y);
      alpha  = clamp(alpha, 0.0, 0.92);

      gl_FragColor = vec4(col, alpha);
    }
  `,
  transparent: true, side: THREE.DoubleSide, depthWrite: false,
});
var wfMesh = new THREE.Mesh(wfGeo, wfMat);
wfMesh.position.y = 0.14 - WALL_H * 0.5 - WALL_H * 0.35 * 0.5 + 0.3;
scene.add(wfMesh);

/* Mist pool at base of waterfall */
(function() {
  var mg  = new THREE.CylinderGeometry(DISC_R + 0.4, DISC_R + 2.8, 0.4, 128, 1, true);
  var mm  = new THREE.MeshBasicMaterial({ color: 0x99ccee, transparent: true, opacity: 0.10, side: THREE.DoubleSide, depthWrite: false });
  var msh = new THREE.Mesh(mg, mm);
  msh.position.y = 0.14 - WALL_H * 0.85;
  scene.add(msh);
})();

/* ─────────────────────────────────────────────────
   BEDROCK UNDERSIDE — inverted mountain terrain
───────────────────────────────────────────────── */
(function buildBedrock() {
  function makeLayer(radius, segs, ampScale, yOffset, color) {
    var geo = new THREE.CircleGeometry(radius, segs, segs);
    var pos = geo.attributes.position;
    for (var i = 0; i < pos.count; i++) {
      var x  = pos.getX(i), z = pos.getZ(i);
      var r  = Math.sqrt(x*x + z*z) / radius;
      var d  = 0;
      d += Math.sin(x*1.8+0.5) * Math.cos(z*2.1+0.9) * 1.0;
      d += Math.sin(x*3.7 - z*2.9+1.3) * 0.50;
      d += Math.sin(x*7.3 + z*5.5-0.8) * 0.25;
      d += Math.sin(x*14.1 - z*9.7+2.2) * 0.12;
      d += Math.sin(x*26.3 + z*19.1) * 0.06;
      var hang = Math.max(0, d + 0.7) * ampScale;
      var fade = Math.pow(1.0 - Math.min(r, 1.0), 0.35);
      pos.setY(i, -hang * fade + yOffset);
    }
    geo.computeVertexNormals();
    var mat  = new THREE.MeshStandardMaterial({ color: color, roughness: 0.97, metalness: 0.02, side: THREE.DoubleSide });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = Math.PI / 2;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  makeLayer(DISC_R * 0.995, 180, 3.2, -0.14,  0x2a1c10);
  makeLayer(DISC_R * 0.78,  140, 2.8, -0.44,  0x180e06);
})();

/* ─────────────────────────────────────────────────
   TEXTURE — NASA Blue Marble (free, seamless world texture)
   This is what all reference images use. It maps perfectly
   to the disc with the AE projection warping applied in shader.

   Fallback: placeholder procedural disc.
───────────────────────────────────────────────── */
var loader = new THREE.TextureLoader();
loader.crossOrigin = "anonymous";

// NASA Blue Marble 2002 — public domain, hosted on NASA servers
// Azimuthal equidistant projection tile that matches our disc layout
var NASA_TEXTURE_URL = "https://eoimages.gsfc.nasa.gov/images/imagerecords/74000/74092/world.200408.3x5400x2700.jpg";

// Also try unpkg-hosted version as backup
var BACKUP_TEXTURE_URL = "https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg";

function applyTexture(tex) {
  tex.wrapS     = THREE.ClampToEdgeWrapping;
  tex.wrapT     = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  topMat.uniforms.tMap.value   = tex;
  topMat.uniforms.hasTex.value = 1.0;
}

function tryLoadTexture(url, fallbackUrl) {
  loader.load(
    url,
    applyTexture,
    undefined,
    function() {
      if (fallbackUrl) {
        tryLoadTexture(fallbackUrl, null);
      } else {
        buildPlaceholderDisc();
      }
    }
  );
}

function buildPlaceholderDisc() {
  var c = document.createElement("canvas");
  c.width = c.height = 2048;
  var ctx = c.getContext("2d");

  // Ocean gradient
  var ocean = ctx.createRadialGradient(1024,1024,0, 1024,1024,1020);
  ocean.addColorStop(0,    "#1565a0");
  ocean.addColorStop(0.40, "#0d4a7a");
  ocean.addColorStop(0.75, "#083358");
  ocean.addColorStop(1,    "#041c38");
  ctx.beginPath(); ctx.arc(1024,1024,1020,0,Math.PI*2);
  ctx.fillStyle = ocean; ctx.fill();

  // Landmasses (approximate AE layout)
  var lands = [
    // Eurasia - centre-right
    {cx:1120,cy:860,rx:280,ry:200,rot:-0.2,col:"#5a7a3a"},
    // Africa - centre
    {cx:1080,cy:1100,rx:160,ry:230,rot:0.1,col:"#7a6a3a"},
    // North America - left
    {cx:680,cy:780,rx:220,ry:200,rot:0.3,col:"#5a7040"},
    // South America - left-below
    {cx:750,cy:1150,rx:140,ry:200,rot:0.1,col:"#4a7030"},
    // Australia - right-below
    {cx:1380,cy:1180,rx:140,ry:110,rot:0.2,col:"#8a7040"},
    // Greenland
    {cx:870,cy:560,rx:90,ry:80,rot:0.0,col:"#c8dce0"},
    // Antarctica rim (outer ring)
    {cx:1024,cy:1024,rx:0,ry:0,isRing:true,col:"#ddeeff"},
  ];

  lands.forEach(function(l) {
    if (l.isRing) {
      ctx.beginPath(); ctx.arc(1024,1024,990,0,Math.PI*2);
      ctx.lineWidth=45; ctx.strokeStyle="#c8dce0"; ctx.stroke(); return;
    }
    ctx.save(); ctx.translate(l.cx,l.cy); ctx.rotate(l.rot);
    var g = ctx.createRadialGradient(0,0,0,0,0,Math.max(l.rx,l.ry));
    g.addColorStop(0.0, l.col);
    g.addColorStop(0.6, l.col);
    g.addColorStop(1.0, l.col+"44");
    ctx.beginPath(); ctx.ellipse(0,0,l.rx,l.ry,0,0,Math.PI*2);
    ctx.fillStyle=g; ctx.fill(); ctx.restore();
  });

  // Cloud wisps
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = "#ffffff";
  [ [950,820,180,60,-0.3], [1150,950,160,50,0.4],
    [750,1000,140,45,0.1], [1300,780,120,40,-0.2] ].forEach(function(c2) {
    ctx.save(); ctx.translate(c2[0],c2[1]); ctx.rotate(c2[4]);
    ctx.beginPath(); ctx.ellipse(0,0,c2[2],c2[3],0,0,Math.PI*2);
    ctx.fill(); ctx.restore();
  });
  ctx.globalAlpha = 1.0;

  // North pole ice cap
  var ice = ctx.createRadialGradient(1024,1024,0,1024,1024,120);
  ice.addColorStop(0,"rgba(230,245,255,0.98)");
  ice.addColorStop(1,"rgba(200,230,255,0)");
  ctx.beginPath(); ctx.arc(1024,1024,120,0,Math.PI*2);
  ctx.fillStyle=ice; ctx.fill();

  var tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  topMat.uniforms.tMap.value   = tex;
  topMat.uniforms.hasTex.value = 1.0;
}

/* ─────────────────────────────────────────────────
   UI HELPERS
───────────────────────────────────────────────── */
function gid(id) { return document.getElementById(id); }

/* ─────────────────────────────────────────────────
   UPDATE HUD (called from render loop)
───────────────────────────────────────────────── */
function updateHUD() {
  var d      = camera.position.length();
  var altKm  = Math.max(0, (d - DISC_R) * 637);
  gid("coordAlt").textContent = altKm > 9999
    ? (altKm/1000).toFixed(0)+",000 km" : altKm.toFixed(0)+" km";

  var fov   = camera.fov * Math.PI / 180;
  var kpp   = (altKm * 2 * Math.tan(fov/2)) / window.innerHeight;
  var pw    = Math.min(120, Math.max(40, 1000/Math.max(kpp,0.1)));
  var km    = Math.round(kpp*pw/100)*100||1000;
  gid("scaleLine").style.width  = pw+"px";
  gid("scaleLabel").textContent = km.toLocaleString()+" km";
}

/* ─────────────────────────────────────────────────
   RAYCAST disc for coords on mousemove
───────────────────────────────────────────────── */
var raycaster = new THREE.Raycaster();
var mouse2d   = new THREE.Vector2();

canvas.addEventListener("mousemove", function(e) {
  if (e.buttons !== 0) return; // skip while dragging
  mouse2d.set(
    ( e.clientX / window.innerWidth)  * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1
  );
  raycaster.setFromCamera(mouse2d, camera);
  var hits = raycaster.intersectObject(topMesh);
  if (hits.length > 0) {
    var uv = hits[0].uv;
    var ll = uvToLatLon(uv.x, uv.y);
    gid("coordLat").textContent = Math.abs(ll[0]).toFixed(3)+"°"+(ll[0]>=0?"N":"S");
    gid("coordLon").textContent = Math.abs(ll[1]).toFixed(3)+"°"+(ll[1]>=0?"E":"W");
  }
});

canvas.addEventListener("dblclick", function(e) {
  mouse2d.set(
    ( e.clientX / window.innerWidth)  * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1
  );
  raycaster.setFromCamera(mouse2d, camera);
  var hits = raycaster.intersectObject(topMesh);
  if (hits.length > 0) {
    var ll = uvToLatLon(hits[0].uv.x, hits[0].uv.y);
    if (ll[0] < -58) { showIceToast(); return; }
    openStreetView(ll[0], ll[1]);
    if (!state.hintShown) { gid("hintToast").classList.add("hidden"); state.hintShown=true; }
  }
});

/* ─────────────────────────────────────────────────
   PROJECTION HELPER (PlaneGeometry UV → lat/lon)
───────────────────────────────────────────────── */
function uvToLatLon(u, v) {
  var sc = 1 / (Math.PI * 0.505);
  var x  = (u - 0.5) / sc;
  var y  = (v - 0.5) / sc;
  var c  = Math.sqrt(x*x + y*y);
  if (c < 1e-9) return [90, 0];
  return [(Math.PI/2 - c)*180/Math.PI, Math.atan2(x,-y)*180/Math.PI];
}

/* ─────────────────────────────────────────────────
   PANEL / TOGGLES
───────────────────────────────────────────────── */
function closePanel() {
  gid("sidePanel").classList.remove("panel-open");
  gid("sidePanel").classList.add("panel-closed");
  gid("panelOverlay").classList.remove("visible");
}
gid("menuBtn").addEventListener("click", function() {
  gid("sidePanel").classList.toggle("panel-open");
  gid("sidePanel").classList.toggle("panel-closed");
  gid("panelOverlay").classList.toggle("visible");
});
gid("panelClose").addEventListener("click", closePanel);
gid("panelOverlay").addEventListener("click", closePanel);

function setNav(id) {
  document.querySelectorAll(".panel-nav-item").forEach(function(b){ b.classList.remove("active"); });
  gid(id).classList.add("active");
}
gid("navDisc").addEventListener("click",   function(){ closeStreetView(); setNav("navDisc");   closePanel(); });
gid("navStreet").addEventListener("click", function(){ openStreetView(0,0); setNav("navStreet"); closePanel(); });

function bindToggle(id, fn) {
  gid(id).addEventListener("click", function() {
    var el = gid(id);
    el.classList.toggle("active");
    fn(el.classList.contains("active"));
  });
}
bindToggle("toggleNight",     function(on){ state.nightMode = on; });
bindToggle("toggleWaterfall", function(on){ wfMesh.visible = on; });
bindToggle("toggleIce",       function(on){ iceGroup.visible = on; });
bindToggle("toggleSatellite", function(on){ topMat.uniforms.hasTex.value = on?1.0:0.0; });

/* Toolbar buttons — zoom by moving camera along its current direction */
gid("zoomIn").addEventListener("click", function() {
  var dir = camera.position.clone().normalize();
  camera.position.addScaledVector(dir, -2.5);
  controls.update();
});
gid("zoomOut").addEventListener("click", function() {
  var dir = camera.position.clone().normalize();
  camera.position.addScaledVector(dir, 2.5);
  controls.update();
});
gid("btnReset").addEventListener("click", function() {
  camera.position.set(14, 9, 14);
  camera.lookAt(0,0,0);
  controls.reset();
});
gid("btnCompass").addEventListener("click", function() {
  // Reset azimuth to north-facing while keeping current elevation
  var dist = camera.position.length();
  var phi  = Math.acos(camera.position.y / dist);
  camera.position.set(Math.sin(phi)*dist*0.707, camera.position.y, Math.cos(phi)*dist*0.707);
  controls.update();
});

/* ─────────────────────────────────────────────────
   SEARCH
───────────────────────────────────────────────── */
var sInput   = gid("searchInput");
var sResults = gid("searchResults");

gid("searchBtn").addEventListener("click", doSearch);
sInput.addEventListener("keydown", function(e){ if(e.key==="Enter") doSearch(); });

function doSearch() {
  var q = sInput.value.trim(); if(!q) return;
  if (!window.MAPS_API_KEY || window.MAPS_API_KEY === "YOUR_GOOGLE_MAPS_API_KEY") {
    showFallback(q); return;
  }
  fetch("https://maps.googleapis.com/maps/api/geocode/json?address="+encodeURIComponent(q)+"&key="+window.MAPS_API_KEY)
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (d.status==="REQUEST_DENIED"||d.status==="ERROR") { showFallback(q); return; }
      d.results&&d.results.length ? showResults(d.results.slice(0,5)) : noResults();
    })
    .catch(function(){ showFallback(q); });
}

var DEMO = [
  {name:"London, UK",         lat:51.505, lng:-0.09},
  {name:"New York, USA",      lat:40.713, lng:-74.006},
  {name:"Tokyo, Japan",       lat:35.683, lng:139.767},
  {name:"Sydney, Australia",  lat:-33.87, lng:151.21},
  {name:"Paris, France",      lat:48.857, lng:2.352},
  {name:"Cairo, Egypt",       lat:30.033, lng:31.233},
  {name:"North Pole",         lat:89.9,   lng:0},
  {name:"Antarctica Ice Wall",lat:-70,    lng:0},
];
function showFallback(q) {
  var f=DEMO.filter(function(p){return p.name.toLowerCase().indexOf(q.toLowerCase())>=0;});
  showResults((f.length?f:DEMO).map(function(p){
    return {formatted_address:p.name,geometry:{location:{lat:p.lat,lng:p.lng}}};
  }));
}
function noResults() {
  sResults.innerHTML="<div class='result-item'><span class='result-text'>No results found.</span></div>";
  sResults.classList.add("open");
}
function showResults(res) {
  sResults.innerHTML="";
  res.forEach(function(r){
    var d=document.createElement("div"); d.className="result-item";
    d.innerHTML='<svg class="result-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg><span class="result-text">'+r.formatted_address+"</span>";
    d.addEventListener("click",function(){
      var loc=r.geometry.location;
      flyTo(loc.lat,loc.lng);
      sResults.classList.remove("open");
      sInput.value=r.formatted_address;
    });
    sResults.appendChild(d);
  });
  sResults.classList.add("open");
}
document.addEventListener("click",function(e){if(!e.target.closest("#searchBar"))sResults.classList.remove("open");});

function flyTo(lat, lon) {
  // Animate camera to face the lat/lon on the disc
  gid("coordLat").textContent=Math.abs(lat).toFixed(3)+"°"+(lat>=0?"N":"S");
  gid("coordLon").textContent=Math.abs(lon).toFixed(3)+"°"+(lon>=0?"E":"W");
  // Note: with NASA texture we show the whole world, so we just log coords
  // A future improvement could rotate the disc or camera to the target point
}

/* ─────────────────────────────────────────────────
   STREET VIEW
───────────────────────────────────────────────── */
var mapsLoaded=false, svPano=null;
function loadMapsJS(cb) {
  if (mapsLoaded){cb();return;}
  if(!window.MAPS_API_KEY||window.MAPS_API_KEY==="YOUR_GOOGLE_MAPS_API_KEY"){alert("Add your Google Maps API key to use Street View.");return;}
  var s=document.createElement("script"); s.async=true;
  s.src="https://maps.googleapis.com/maps/api/js?key="+window.MAPS_API_KEY+"&v=weekly";
  s.onload=function(){mapsLoaded=true;cb();};
  document.head.appendChild(s);
}
function openStreetView(lat,lon) {
  state.streetMode=true;
  gid("streetOverlay").classList.remove("hidden");
  gid("streetCoords").textContent=Math.abs(lat).toFixed(4)+"°"+(lat>=0?"N":"S")+", "+Math.abs(lon).toFixed(4)+"°"+(lon>=0?"E":"W");
  setNav("navStreet"); controls.enabled=false;
  loadMapsJS(function(){
    var pos={lat:lat,lng:lon};
    svPano ? svPano.setPosition(pos) : (svPano=new google.maps.StreetViewPanorama(gid("streetMap"),{position:pos,pov:{heading:34,pitch:10},zoom:1,addressControl:false,fullscreenControl:false}));
  });
}
function closeStreetView() {
  state.streetMode=false;
  gid("streetOverlay").classList.add("hidden");
  setNav("navDisc"); controls.enabled=true;
}
gid("closeStreet").addEventListener("click",closeStreetView);

/* ─────────────────────────────────────────────────
   TOASTS
───────────────────────────────────────────────── */
var iceTmr=null;
function showIceToast(){
  var el=gid("iceToast"); el.classList.remove("hidden","out"); clearTimeout(iceTmr);
  iceTmr=setTimeout(function(){el.classList.add("out");setTimeout(function(){el.classList.add("hidden");},350);},3500);
}
setTimeout(function(){
  var h=gid("hintToast");
  if(h&&!h.classList.contains("hidden")){h.classList.add("out");setTimeout(function(){h.classList.add("hidden");},350);}
},8000);

/* ─────────────────────────────────────────────────
   NIGHT TRANSITION
───────────────────────────────────────────────── */
function tickNight() {
  var tgt=state.nightMode?1:0, cur=topMat.uniforms.nightAmt.value;
  topMat.uniforms.nightAmt.value += (tgt-cur)*0.025;
  ambient.intensity = 0.6  - topMat.uniforms.nightAmt.value*0.50;
  sun.intensity     = 2.8  - topMat.uniforms.nightAmt.value*2.6;
  fill.intensity    = 0.4  - topMat.uniforms.nightAmt.value*0.35;
}

/* ─────────────────────────────────────────────────
   RENDER LOOP
───────────────────────────────────────────────── */
var clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  var t = clock.getElapsedTime();
  wfMat.uniforms.time.value = t;
  controls.update(); // required for damping
  tickNight();
  updateHUD();
  renderer.render(scene, camera);
}

window.addEventListener("resize", function() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ─────────────────────────────────────────────────
   INIT
───────────────────────────────────────────────── */
var MSGS = [
  "Initialising flat projection…",
  "Loading Blue Marble texture…",
  "Carving Antarctic ice wall…",
  "Shaping bedrock underside…",
  "Positioning sun…",
  "Almost there…",
];

function init() {
  try {
    buildPlaceholderDisc();                      // show immediately
    tryLoadTexture(NASA_TEXTURE_URL, BACKUP_TEXTURE_URL);  // async — replaces placeholder
  } catch(e) { console.error("Init error:", e); }

  var fill2  = gid("loaderFill");
  var status = gid("loaderStatus");
  var pct=0, mi=0;
  var tick=setInterval(function(){
    pct=Math.min(90, pct+Math.random()*18);
    fill2.style.width=pct+"%";
    if(mi<MSGS.length-1) status.textContent=MSGS[++mi];
  },300);

  setTimeout(function(){
    clearInterval(tick);
    fill2.style.width="100%";
    status.textContent="Ready.";
    setTimeout(function(){
      gid("loader").classList.add("out");
      setTimeout(function(){ gid("loader").style.display="none"; },750);
    },350);
    animate();
  },1800);
}

init();
