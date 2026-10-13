/*!
 * The Cube
 * A 3×3 twisty puzzle for the browser, rendered with three.js (r128).
 *
 *  1. Utilities           7. Move notation
 *  2. Audio & haptics     8. Pointer & keyboard input
 *  3. Scene & lighting    9. Camera framing
 *  4. Cube model         10. Interface wiring
 *  5. Turning layers     11. Celebration
 *  6. Game flow          12. Main loop
 *
 * Coordinates: the cube is a group of 26 pieces ("cubies") placed on an
 * integer grid from -1 to 1 on each axis. +x is the right face, +y the top,
 * +z the front. A layer turn moves the pieces of one slice into a temporary
 * pivot, rotates the pivot, then puts them back and snaps them to the grid.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const app = $('app');

  /** Replaces the game with a short explanation when it can't run. */
  function showFailure(message) {
    if (message) $('fail-message').textContent = message;
    $('fail').hidden = false;
  }

  if (!window.THREE) {
    showFailure("The 3D engine didn't load. Check your connection and reload the page.");
    return;
  }

  /* ======================================================================
   * 1. Utilities
   * ==================================================================== */

  const V3 = THREE.Vector3;
  const QUARTER = Math.PI / 2;
  const DEG = Math.PI / 180;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const ease = {
    inOutCubic: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
    outCubic: (k) => 1 - Math.pow(1 - k, 3),
    // A small overshoot, so a released layer settles like real plastic.
    outBack: (k) => {
      const c1 = 1.2;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
    },
  };

  /** localStorage can throw in private mode or embedded browsers. */
  const store = {
    get(key, fallback) {
      try {
        const value = localStorage.getItem(key);
        return value === null ? fallback : value;
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try { localStorage.setItem(key, String(value)); } catch (e) { /* not persisted */ }
    },
  };

  /** 83456 → { main: "1:23", tenths: 4 } */
  function splitTime(ms) {
    const total = Math.max(0, ms);
    const seconds = Math.floor(total / 1000);
    return {
      main: Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'),
      tenths: Math.floor((total % 1000) / 100),
    };
  }

  const formatTime = (ms) => {
    const t = splitTime(ms);
    return t.main + '.' + t.tenths;
  };

  /* ======================================================================
   * 2. Audio & haptics
   *    Sounds are synthesised at runtime, so there are no files to load.
   * ==================================================================== */

  const sound = (() => {
    let ctx = null;
    let clickBuffer = null;
    let enabled = store.get('cube.sound', '1') === '1';

    /** A short plastic "tick": a noise transient over a soft low thump. */
    function createClickBuffer(ac) {
      const length = Math.floor(ac.sampleRate * 0.07);
      const buffer = ac.createBuffer(1, length, ac.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) {
        const t = i / ac.sampleRate;
        const tick = (Math.random() * 2 - 1) * Math.exp(-t * 110);
        const thump = Math.sin(2 * Math.PI * 165 * t) * Math.exp(-t * 55);
        data[i] = tick * 0.55 + thump * 0.45;
      }
      return buffer;
    }

    return {
      get enabled() { return enabled; },

      setEnabled(value) {
        enabled = value;
        store.set('cube.sound', value ? '1' : '0');
        if (value) this.unlock();
      },

      /** Browsers only allow audio after a user gesture; call from one. */
      unlock() {
        if (!ctx) {
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          if (!AudioCtx) return;
          ctx = new AudioCtx();
          clickBuffer = createClickBuffer(ctx);
        }
        if (ctx.state === 'suspended') ctx.resume();
      },

      click(volume = 1) {
        if (!enabled || !ctx) return;
        const source = ctx.createBufferSource();
        source.buffer = clickBuffer;
        source.playbackRate.value = 0.9 + Math.random() * 0.25; // avoid a machine-gun effect
        const gain = ctx.createGain();
        gain.gain.value = 0.42 * volume;
        source.connect(gain).connect(ctx.destination);
        source.start();
      },

      /** Rising four-note arpeggio for a solve. */
      chime() {
        if (!enabled || !ctx) return;
        const now = ctx.currentTime;
        [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const start = now + i * 0.09;
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0, start);
          gain.gain.linearRampToValueAtTime(0.16, start + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, start + 1.1);
          osc.connect(gain).connect(ctx.destination);
          osc.start(start);
          osc.stop(start + 1.2);
        });
      },

      haptic(ms = 8) {
        if (enabled && navigator.vibrate) navigator.vibrate(ms);
      },
    };
  })();

  /* ======================================================================
   * 3. Scene & lighting
   * ==================================================================== */

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (e) {
    showFailure();
    return;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  $('stage').appendChild(renderer.domElement);

  const canvas = renderer.domElement;
  const scene = new THREE.Scene();

  // A slightly raised camera gives a natural, tabletop perspective.
  const CAMERA_PITCH = 8 * DEG;
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 200);

  /**
   * A tiny studio for reflections: a soft grey-to-white dome with three
   * light panels. It's rendered once into an environment map so the glossy
   * stickers pick up believable highlights.
   */
  function buildEnvironment() {
    try {
      const env = new THREE.Scene();

      const dome = new THREE.SphereGeometry(30, 32, 16);
      const positions = dome.attributes.position;
      const colors = [];
      const sky = new THREE.Color(0xffffff);
      const ground = new THREE.Color(0x5a606c);
      const tint = new THREE.Color();
      for (let i = 0; i < positions.count; i++) {
        const t = clamp(positions.getY(i) / 30 * 0.5 + 0.5, 0, 1);
        tint.copy(ground).lerp(sky, Math.pow(t, 0.8));
        colors.push(tint.r, tint.g, tint.b);
      }
      dome.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      env.add(new THREE.Mesh(dome, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));

      const softbox = (w, h, x, y, z, power) => {
        const panel = new THREE.Mesh(
          new THREE.PlaneGeometry(w, h),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(power, power, power), side: THREE.DoubleSide })
        );
        panel.position.set(x, y, z);
        panel.lookAt(0, 0, 0);
        env.add(panel);
      };
      softbox(16, 8, 0, 18, 10, 3.2); // key, overhead and in front
      softbox(8, 16, -20, 4, 6, 1.6); // left strip
      softbox(8, 14, 20, 2, -6, 1.1); // right fill

      const pmrem = new THREE.PMREMGenerator(renderer);
      const texture = pmrem.fromScene(env, 0.02).texture;
      pmrem.dispose();
      return texture;
    } catch (e) {
      return null; // direct lights alone still look fine
    }
  }

  scene.environment = buildEnvironment();
  scene.add(new THREE.HemisphereLight(0xffffff, 0xa8aebb, 0.42));

  const keyLight = new THREE.DirectionalLight(0xffffff, 0.72);
  keyLight.position.set(3, 7, 5);
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0xffffff, 0.18);
  rimLight.position.set(-5, 2, -4);
  scene.add(rimLight);

  /** Soft contact shadow under the cube, drawn from a radial gradient. */
  function createContactShadow() {
    const size = 256;
    const sheet = document.createElement('canvas');
    sheet.width = sheet.height = size;
    const g = sheet.getContext('2d');
    const gradient = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(15,17,21,0.36)');
    gradient.addColorStop(0.45, 'rgba(15,17,21,0.14)');
    gradient.addColorStop(1, 'rgba(15,17,21,0)');
    g.fillStyle = gradient;
    g.fillRect(0, 0, size, size);

    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(7.5, 7.5),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sheet), transparent: true, depthWrite: false })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -2.85;
    return shadow;
  }

  scene.add(createContactShadow());

  /* ======================================================================
   * 4. Cube model
   * ==================================================================== */

  // Sticker colours (sRGB). Slightly deeper than the toy-box primaries.
  const PALETTE = {
    U: '#F4F3EE', // ivory white
    D: '#FFC52E', // warm yellow
    F: '#E0312B', // signal red
    B: '#FF7A1A', // tangerine
    R: '#1F6FEB', // cobalt blue
    L: '#16A34A', // emerald green
  };

  const FACES = [
    { normal: [1, 0, 0], color: 'R' },
    { normal: [-1, 0, 0], color: 'L' },
    { normal: [0, 1, 0], color: 'U' },
    { normal: [0, -1, 0], color: 'D' },
    { normal: [0, 0, 1], color: 'F' },
    { normal: [0, 0, -1], color: 'B' },
  ];

  const AXES = { x: new V3(1, 0, 0), y: new V3(0, 1, 0), z: new V3(0, 0, 1) };

  // Starting orientation: front, right and top faces in view.
  const HOME_VIEW = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.44, -0.72, 0, 'XYZ'));

  const PIECE_SIZE = 0.96;
  const PIECE_RADIUS = 0.085;

  /**
   * A cube with rounded edges. A subdivided box is reshaped so every vertex
   * sits on a sphere of `radius` around the nearest point of a smaller inner
   * box. Grid lines are placed so most vertices land in the curved bands.
   */
  function roundedCubeGeometry(size, radius, steps) {
    const half = size / 2;
    const inner = half - radius;
    const segments = steps * 2 + 1;
    const geometry = new THREE.BoxGeometry(size, size, size, segments, segments, segments);
    const position = geometry.attributes.position;
    const normal = geometry.attributes.normal;
    const p = new V3();
    const core = new V3();

    // Map an evenly spaced coordinate onto [-half, -inner] ∪ [inner, half]
    const remap = (value) => {
      const index = Math.round(((value / half) + 1) / 2 * segments);
      return index <= steps
        ? -inner - radius * (steps - index) / steps
        : inner + radius * (index - steps - 1) / steps;
    };

    for (let i = 0; i < position.count; i++) {
      p.set(remap(position.getX(i)), remap(position.getY(i)), remap(position.getZ(i)));
      core.set(clamp(p.x, -inner, inner), clamp(p.y, -inner, inner), clamp(p.z, -inner, inner));
      const n = p.sub(core).normalize();
      normal.setXYZ(i, n.x, n.y, n.z);
      position.setXYZ(i, core.x + n.x * radius, core.y + n.y * radius, core.z + n.z * radius);
    }
    return geometry;
  }

  /** A slightly raised sticker with bevelled, rounded corners. */
  function stickerGeometry(size, radius) {
    const h = size / 2;
    const shape = new THREE.Shape();
    shape.moveTo(-h + radius, -h);
    shape.lineTo(h - radius, -h);
    shape.quadraticCurveTo(h, -h, h, -h + radius);
    shape.lineTo(h, h - radius);
    shape.quadraticCurveTo(h, h, h - radius, h);
    shape.lineTo(-h + radius, h);
    shape.quadraticCurveTo(-h, h, -h, h - radius);
    shape.lineTo(-h, -h + radius);
    shape.quadraticCurveTo(-h, -h, -h + radius, -h);
    return new THREE.ExtrudeGeometry(shape, {
      depth: 0.006,
      bevelEnabled: true,
      bevelThickness: 0.01,
      bevelSize: 0.012,
      bevelSegments: 3,
      curveSegments: 6,
    });
  }

  const linear = (hex) => new THREE.Color(hex).convertSRGBToLinear();

  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: linear('#111216'),
    roughness: 0.5,
    metalness: 0,
    envMapIntensity: 0.28,
  });

  const stickerMaterials = {};
  for (const key in PALETTE) {
    stickerMaterials[key] = new THREE.MeshPhysicalMaterial({
      color: linear(PALETTE[key]),
      roughness: 0.36,
      metalness: 0,
      clearcoat: 0.3,
      clearcoatRoughness: 0.2,
      envMapIntensity: 0.45,
    });
  }

  const bodyGeometry = roundedCubeGeometry(PIECE_SIZE, PIECE_RADIUS, 4);
  const stickerGeo = stickerGeometry(0.78, 0.13);

  const cube = new THREE.Group();
  cube.quaternion.copy(HOME_VIEW);
  scene.add(cube);

  // Temporary parent for whichever layer is turning.
  const pivot = new THREE.Object3D();
  cube.add(pivot);

  const cubies = [];
  const stickers = [];
  const forward = new V3(0, 0, 1);

  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        if (!x && !y && !z) continue; // the hidden core

        const piece = new THREE.Group();
        piece.position.set(x, y, z);
        piece.add(new THREE.Mesh(bodyGeometry, bodyMaterial));

        for (const face of FACES) {
          const n = new V3(...face.normal);
          if (n.x * x + n.y * y + n.z * z !== 1) continue; // face points inward

          const sticker = new THREE.Mesh(stickerGeo, stickerMaterials[face.color]);
          sticker.position.copy(n).multiplyScalar(PIECE_SIZE / 2 - 0.006);
          sticker.quaternion.setFromUnitVectors(forward, n);
          sticker.userData = { normal: n, color: face.color };
          piece.add(sticker);
          stickers.push(sticker);
        }

        cube.add(piece);
        cubies.push(piece);
      }
    }
  }

  /* ======================================================================
   * 5. Turning layers
   * ==================================================================== */

  /** Moves every piece in the given slice into the pivot. */
  function grabLayer(axis, layer) {
    pivot.quaternion.identity();
    pivot.updateMatrixWorld();
    const selection = cubies.filter((c) => Math.round(c.position[axis]) === layer);
    selection.forEach((c) => pivot.attach(c));
    return selection;
  }

  const snapMatrix = new THREE.Matrix4();

  /** Returns pieces to the cube and snaps them to exact grid positions. */
  function releaseLayer(selection) {
    pivot.updateMatrixWorld();
    selection.forEach((c) => {
      cube.attach(c);
      c.position.set(Math.round(c.position.x), Math.round(c.position.y), Math.round(c.position.z));
      // Round the rotation matrix to remove floating-point drift.
      snapMatrix.makeRotationFromQuaternion(c.quaternion);
      const e = snapMatrix.elements;
      for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) e[i] = Math.round(e[i]);
      c.quaternion.setFromRotationMatrix(snapMatrix);
    });
    pivot.quaternion.identity();
  }

  /** Solved when every sticker facing the same way has the same colour. */
  function isSolved() {
    const faceColor = {};
    const n = new V3();
    for (const s of stickers) {
      n.copy(s.userData.normal).applyQuaternion(s.parent.quaternion);
      const key = Math.round(n.x) + ',' + Math.round(n.y) + ',' + Math.round(n.z);
      if (faceColor[key] === undefined) faceColor[key] = s.userData.color;
      else if (faceColor[key] !== s.userData.color) return false;
    }
    return true;
  }

  let activeTurn = null; // the layer animation in progress
  let heldLayer = null;  // the layer under the player's finger
  const moveQueue = [];  // moves waiting to animate (scrambles, buttons, guide)

  const isBusy = () => Boolean(activeTurn || heldLayer || moveQueue.length);

  /** Starts the next queued move once nothing else is turning. */
  function runNextQueued() {
    if (activeTurn || heldLayer || !moveQueue.length) return;

    const move = moveQueue.shift();
    const selection = grabLayer(move.axis, move.layer);
    const isScramble = move.source === 'scramble';

    sound.click(isScramble ? 0.35 : 1);

    activeTurn = {
      axis: move.axis,
      from: 0,
      to: move.q * QUARTER,
      start: performance.now(),
      duration: move.duration * (Math.abs(move.q) === 2 ? 1.45 : 1),
      ease: isScramble ? ease.inOutCubic : ease.outCubic,
      done() {
        releaseLayer(selection);
        if (!isScramble) commitMove(move, move.source);
        if (!moveQueue.length && state === 'scrambling') setState('ready');
      },
    };
  }

  /* ======================================================================
   * 6. Game flow
   *    title → scrambling → ready → playing → solved
   * ==================================================================== */

  let state = 'title';
  let history = [];
  let moveCount = 0;
  let startTime = 0;
  let hiddenAt = 0;
  let lastClockText = '';

  function setState(next) {
    state = next;
    app.dataset.state = next;
    if (next === 'ready') {
      renderClock(0);
      showToast('Swipe a row to turn it. The clock starts on your first move.');
    }
    updateControls();
    requestAnimationFrame(measureFraming); // the visible HUD changed size
  }

  function renderClock(ms) {
    const t = splitTime(ms);
    const text = t.main + '.' + t.tenths;
    if (text === lastClockText) return; // skip identical DOM writes
    lastClockText = text;
    $('timer').innerHTML = t.main + '<span class="clock-tenths">.' + t.tenths + '</span>';
  }

  function updateMoveCount() {
    $('moves').textContent = moveCount + (moveCount === 1 ? ' move' : ' moves');
  }

  function updateControls() {
    const live = state === 'ready' || state === 'playing';
    $('btn-undo').disabled = !live || history.length === 0;
    $('btn-new').disabled = state === 'scrambling';
  }

  /** Records a finished player move and checks for a solve. */
  function commitMove(move, source) {
    moveCount++;
    updateMoveCount();
    sound.haptic();
    if (source !== 'undo') history.push({ axis: move.axis, layer: move.layer, q: move.q });

    if (state === 'ready') {
      startTime = performance.now();
      setState('playing');
    }
    if (state === 'playing' && !isBusy() && isSolved()) completeSolve();
    updateControls();
  }

  /** Queues 24 random outer-layer turns, never repeating an axis twice in a row. */
  function scramble() {
    if (activeTurn || heldLayer) return;
    closeResult();
    moveQueue.length = 0;
    history = [];
    moveCount = 0;
    updateMoveCount();
    renderClock(0);
    setState('scrambling');

    const axes = ['x', 'y', 'z'];
    let previous = '';
    for (let i = 0; i < 24; i++) {
      let axis;
      do { axis = axes[Math.floor(Math.random() * 3)]; } while (axis === previous);
      previous = axis;
      moveQueue.push({
        axis,
        layer: Math.random() < 0.5 ? -1 : 1,
        q: [1, -1, 2][Math.floor(Math.random() * 3)],
        duration: 95,
        source: 'scramble',
      });
    }
  }

  function startGame() {
    sound.unlock();
    recenter();
    setState('scrambling');
    setTimeout(scramble, 520); // let the camera settle first
  }

  function bestTime() {
    return Number(store.get('cube.best', 0)) || 0;
  }

  function completeSolve() {
    const elapsed = performance.now() - startTime;
    setState('solved');
    renderClock(elapsed);

    const previousBest = bestTime();
    const isRecord = !previousBest || elapsed < previousBest;
    if (isRecord) store.set('cube.best', Math.round(elapsed));

    $('result-time').textContent = formatTime(elapsed);
    $('result-moves').textContent = moveCount;
    $('result-best').textContent = formatTime(isRecord ? elapsed : previousBest);
    $('result-badge').hidden = !isRecord;
    lastResult = { time: formatTime(elapsed), moves: moveCount };

    sound.chime();
    sound.haptic(40);
    if (!reducedMotion) {
      inertia.x = 0.006; // a celebratory spin that slowly winds down
      confetti.burst();
    }
    setTimeout(openResult, reducedMotion ? 200 : 900);
    updateHeroBest();
  }

  function openResult() {
    $('result').classList.add('is-open');
    $('result').setAttribute('aria-hidden', 'false');
  }

  function closeResult() {
    $('result').classList.remove('is-open');
    $('result').setAttribute('aria-hidden', 'true');
  }

  // Pause the clock while the tab is in the background.
  document.addEventListener('visibilitychange', () => {
    if (state !== 'playing') return;
    if (document.hidden) hiddenAt = performance.now();
    else if (hiddenAt) {
      startTime += performance.now() - hiddenAt;
      hiddenAt = 0;
    }
  });

  /* ======================================================================
   * 7. Move notation
   *    Letters are read relative to the current view: F is whichever face
   *    points most toward the camera, U whichever points most upward.
   * ==================================================================== */

  const DIRECTIONS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((d) => new V3(...d));

  function facesFromView() {
    const toCamera = camera.position.clone().normalize();
    const screenUp = new V3(0, 1, 0).applyQuaternion(camera.quaternion);
    const world = DIRECTIONS.map((d) => d.clone().applyQuaternion(cube.quaternion));

    let front = 0;
    world.forEach((v, i) => { if (v.dot(toCamera) > world[front].dot(toCamera)) front = i; });

    let up = -1;
    world.forEach((v, i) => {
      const perpendicular = Math.abs(DIRECTIONS[i].dot(DIRECTIONS[front])) < 0.5;
      if (perpendicular && (up < 0 || v.dot(screenUp) > world[up].dot(screenUp))) up = i;
    });

    const F = DIRECTIONS[front];
    const U = DIRECTIONS[up];
    const R = U.clone().cross(F);
    return { F, B: F.clone().negate(), U, D: U.clone().negate(), R, L: R.clone().negate() };
  }

  /** "R'" → { axis: 'x', layer: 1, q: 1 } (q = signed quarter turns about +axis) */
  function parseMove(token, faces) {
    const dir = faces[token[0]];
    if (!dir) return null;
    const index = dir.x ? 0 : dir.y ? 1 : 2;
    const sign = Math.sign(dir.getComponent(index));
    const turns = (token.includes('2') ? 2 : 1) * (token.includes("'") ? -1 : 1);
    // Clockwise, seen from the face, is a negative turn about its outward normal.
    let q = -turns * sign;
    if (q === -2) q = 2;
    return { axis: 'xyz'[index], layer: sign, q };
  }

  /** Plays a space-separated sequence such as "R U R' U'". */
  function playSequence(sequence, duration = 230) {
    if (state !== 'ready' && state !== 'playing') {
      showToast(state === 'title' ? 'Press Start to play first.' : 'One moment, still shuffling.');
      return;
    }
    sound.unlock();
    const faces = facesFromView(); // fixed for the whole sequence
    for (const token of sequence.trim().split(/\s+/)) {
      const move = parseMove(token, faces);
      if (move) moveQueue.push({ ...move, duration, source: 'player' });
    }
  }

  function undo() {
    if (isBusy() || !history.length || (state !== 'playing' && state !== 'ready')) return;
    const last = history.pop();
    moveQueue.push({ axis: last.axis, layer: last.layer, q: last.q === 2 ? 2 : -last.q, duration: 190, source: 'undo' });
  }

  /* ======================================================================
   * 8. Pointer & keyboard input
   * ==================================================================== */

  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  const DRAG_THRESHOLD = 8;   // px before a press becomes a drag
  const VIEW_SPEED = 0.0085;  // radians per px when orbiting

  let pointer = null;               // the active press
  const inertia = { x: 0, y: 0 };   // orbit velocity in rad/ms after release
  let recenterAnim = null;

  function canvasPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Projects a point in cube space to canvas pixels. */
  function toScreen(local) {
    const p = cube.localToWorld(local.clone()).project(camera);
    return { x: (p.x + 1) / 2 * canvas.clientWidth, y: (1 - p.y) / 2 * canvas.clientHeight };
  }

  /** Finds the touched point on the cube and which face it's on. */
  function pickCube(x, y) {
    pointerNdc.set(x / canvas.clientWidth * 2 - 1, -(y / canvas.clientHeight) * 2 + 1);
    raycaster.setFromCamera(pointerNdc, camera);
    const hit = raycaster.intersectObjects(cubies, true)[0];
    if (!hit) return null;
    const point = cube.worldToLocal(hit.point.clone());
    const a = [Math.abs(point.x), Math.abs(point.y), Math.abs(point.z)];
    const faceAxis = a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2;
    return { point, faceAxis, faceSign: Math.sign(point.getComponent(faceAxis)) };
  }

  const canTurn = () => (state === 'ready' || state === 'playing') && !isBusy();

  function rotateView(yaw, pitch) {
    const qYaw = new THREE.Quaternion().setFromAxisAngle(AXES.y, yaw);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(AXES.x, pitch);
    cube.quaternion.premultiply(qYaw).premultiply(qPitch).normalize();
  }

  /**
   * Decides which layer a swipe turns. Of the two directions along the
   * touched face, pick the one whose on-screen direction best matches the
   * swipe. Turning about (face normal × that direction) moves the touched
   * sticker along the swipe.
   */
  function beginLayerDrag(dx, dy) {
    const { point, faceAxis, faceSign } = pointer.hit;
    const length = Math.hypot(dx, dy);
    const origin = toScreen(point);

    let best = null;
    for (let axis = 0; axis < 3; axis++) {
      if (axis === faceAxis) continue;
      const step = new V3();
      step.setComponent(axis, 1);
      const tip = toScreen(point.clone().add(step));
      let sx = tip.x - origin.x;
      let sy = tip.y - origin.y;
      const pixelsPerUnit = Math.hypot(sx, sy) || 1;
      sx /= pixelsPerUnit;
      sy /= pixelsPerUnit;
      const alignment = (dx * sx + dy * sy) / length;
      if (!best || Math.abs(alignment) > Math.abs(best.alignment)) {
        best = { axis, sx, sy, pixelsPerUnit, alignment };
      }
    }

    const normal = new V3();
    normal.setComponent(faceAxis, faceSign);
    const along = new V3();
    along.setComponent(best.axis, 1);
    const turnAxis = normal.cross(along);

    const k = Math.abs(turnAxis.x) > 0.5 ? 0 : Math.abs(turnAxis.y) > 0.5 ? 1 : 2;
    const axis = 'xyz'[k];
    const layer = clamp(Math.round(point.getComponent(k)), -1, 1);

    heldLayer = {
      axis,
      layer,
      sign: Math.sign(turnAxis.getComponent(k)),
      sx: best.sx,
      sy: best.sy,
      scale: best.pixelsPerUnit * 1.25,
      angle: 0,
      samples: [],
      selection: grabLayer(axis, layer),
    };
    pointer.mode = 'layer';
  }

  /** Snaps a released layer to the nearest quarter turn, honouring flicks. */
  function releaseLayerDrag() {
    const held = heldLayer;
    const s = held.samples;
    let velocity = 0; // quarter turns per second
    if (s.length > 1) {
      const a = s[0];
      const b = s[s.length - 1];
      velocity = (b.angle - a.angle) / QUARTER / Math.max(1, b.t - a.t) * 1000;
    }

    const quarters = held.angle / QUARTER;
    let target = Math.round(quarters);
    if (Math.abs(velocity) > 2.2) {
      target = velocity > 0 ? Math.ceil(quarters - 0.05) : Math.floor(quarters + 0.05);
    }
    target = clamp(target, -2, 2);

    const distance = Math.abs(target * QUARTER - held.angle) / QUARTER;
    activeTurn = {
      axis: held.axis,
      from: held.angle,
      to: target * QUARTER,
      start: performance.now(),
      duration: 160 + 160 * Math.min(1, distance),
      ease: target === 0 ? ease.outCubic : ease.outBack,
      done() {
        releaseLayer(held.selection);
        heldLayer = null;
        const net = ((target % 4) + 4) % 4;
        if (net) commitMove({ axis: held.axis, layer: held.layer, q: net === 3 ? -1 : net }, 'player');
      },
    };
    if (target !== 0) sound.click();
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (pointer) return; // ignore extra fingers
    canvas.setPointerCapture(e.pointerId);
    const { x, y } = canvasPoint(e);
    inertia.x = inertia.y = 0;
    pointer = {
      id: e.pointerId,
      x0: x, y0: y,
      lastX: x, lastY: y,
      lastT: performance.now(),
      vx: 0, vy: 0,
      mode: 'pending',
      hit: canTurn() ? pickCube(x, y) : null,
    };
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointer || e.pointerId !== pointer.id) return;
    const { x, y } = canvasPoint(e);
    const now = performance.now();
    const dx = x - pointer.x0;
    const dy = y - pointer.y0;

    if (pointer.mode === 'pending' && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      if (pointer.hit && canTurn()) beginLayerDrag(dx, dy);
      else pointer.mode = 'orbit';
    }

    if (pointer.mode === 'orbit') {
      const yaw = (x - pointer.lastX) * VIEW_SPEED;
      const pitch = (y - pointer.lastY) * VIEW_SPEED;
      rotateView(yaw, pitch);
      recenterAnim = null;
      // Smoothed velocity, used for the coast after release
      const dt = Math.max(1, now - pointer.lastT);
      pointer.vx = pointer.vx * 0.6 + (yaw / dt) * 0.4;
      pointer.vy = pointer.vy * 0.6 + (pitch / dt) * 0.4;
    } else if (pointer.mode === 'layer') {
      const held = heldLayer;
      held.angle = held.sign * (dx * held.sx + dy * held.sy) / held.scale;
      pivot.setRotationFromAxisAngle(AXES[held.axis], held.angle);
      held.samples.push({ t: now, angle: held.angle });
      while (held.samples.length > 2 && now - held.samples[0].t > 100) held.samples.shift();
    }

    pointer.lastX = x;
    pointer.lastY = y;
    pointer.lastT = now;
  });

  function endPointer(e) {
    if (!pointer || e.pointerId !== pointer.id) return;
    if (pointer.mode === 'layer') {
      releaseLayerDrag();
    } else if (pointer.mode === 'orbit' && performance.now() - pointer.lastT < 80 && !reducedMotion) {
      inertia.x = pointer.vx;
      inertia.y = pointer.vy;
    }
    pointer = null;
  }

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // Keyboard: face letters turn (Shift = counter-clockwise), Ctrl/Cmd+Z undoes.
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const key = e.key.toUpperCase();

    if ((e.ctrlKey || e.metaKey) && key === 'Z') {
      e.preventDefault();
      undo();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if ('UDRLFB'.includes(key) && key.length === 1) {
      playSequence(key + (e.shiftKey ? "'" : ''), 160);
    } else if (e.key === 'Enter' && state === 'title') {
      startGame();
    } else if (e.key === 'Escape') {
      if ($('result').classList.contains('is-open')) closeResult();
      else if (app.dataset.guide === 'open') setGuide(false);
    }
  });

  /** Eases the cube back to its starting orientation. */
  function recenter() {
    inertia.x = inertia.y = 0;
    recenterAnim = { from: cube.quaternion.clone(), start: performance.now(), duration: 650 };
  }

  /* ======================================================================
   * 9. Camera framing
   *    The cube is fitted into the space the HUD leaves free, and the fit
   *    animates whenever that space changes (guide opens, pad opens...).
   * ==================================================================== */

  const CUBE_RADIUS = 2.65;
  const framing = { top: 0, bottom: 0, right: 0 };
  const framingTarget = { top: 0, bottom: 0, right: 0 };
  let framingReady = false;
  let viewport = { w: 0, h: 0 };

  function measureFraming() {
    const w = app.clientWidth;
    const h = app.clientHeight;
    const mobile = w <= 760;
    const guideOpen = app.dataset.guide === 'open';
    const drawer = $('guide');
    let top;
    let bottom;

    if (state === 'title') {
      const brand = $('brand');
      top = brand.offsetTop + brand.offsetHeight;
      bottom = h - $('hero').offsetTop;
      // On phones the open sheet covers the start buttons
      if (mobile && guideOpen) bottom = Math.max(bottom, drawer.offsetHeight);
    } else {
      const clock = $('clock');
      top = clock.offsetTop + clock.offsetHeight;
      bottom = h - $('hud-bottom').offsetTop;
      if (mobile && guideOpen) bottom += drawer.offsetHeight;
    }

    framingTarget.top = top + 10;
    framingTarget.bottom = bottom + 10;
    framingTarget.right = !mobile && guideOpen ? drawer.offsetWidth : 0;

    if (!framingReady) {
      Object.assign(framing, framingTarget);
      framingReady = true;
    }
  }

  function applyCamera() {
    const { w, h } = viewport;
    if (!w || !h) return;

    const freeH = Math.max(h * 0.28, h - framing.top - framing.bottom);
    const freeW = Math.max(w * 0.4, w - framing.right);
    const halfV = (camera.fov * DEG) / 2;
    const halfH = Math.atan(Math.tan(halfV) * camera.aspect);

    // Fill up to ~80% of the height and ~92% of the free width; leave a
    // little extra margin when the free area is cramped (phone + guide).
    const freeShare = freeH / h;
    const fitV = Math.min(0.8, freeShare * (freeShare < 0.45 ? 0.92 : 1.04));
    const fitW = 0.92 * freeW / w;
    const distance = Math.max(
      CUBE_RADIUS / (Math.tan(halfV) * fitV),
      CUBE_RADIUS / (Math.tan(halfH) * fitW)
    );

    camera.position.set(0, Math.sin(CAMERA_PITCH) * distance, Math.cos(CAMERA_PITCH) * distance);
    camera.lookAt(0, 0, 0);
    // Shift the projection so the cube centres in the free area.
    camera.setViewOffset(w, h, framing.right / 2, h / 2 - (framing.top + h - framing.bottom) / 2, w, h);
    camera.updateProjectionMatrix();
  }

  function handleResize() {
    const w = app.clientWidth;
    const h = app.clientHeight;
    if (w !== viewport.w || h !== viewport.h) {
      viewport = { w, h };
      renderer.setSize(w, h);
      camera.aspect = w / h;
    }
    measureFraming();
  }

  const resizeObserver = new ResizeObserver(handleResize);
  ['app', 'hud-top', 'hud-bottom', 'hero', 'guide'].forEach((id) => resizeObserver.observe($(id)));

  /* ======================================================================
   * 10. Interface wiring
   * ==================================================================== */

  let toastTimer = 0;
  let lastResult = null;

  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2800);
  }

  function setGuide(open) {
    app.dataset.guide = open ? 'open' : 'closed';
    $('guide').setAttribute('aria-hidden', String(!open));
    $('btn-guide').setAttribute('aria-pressed', String(open));
    $('btn-guide-label').textContent = open ? 'Hide' : 'Guide';
    store.set('cube.guide', open ? '1' : '0');
    requestAnimationFrame(measureFraming);
  }

  function setPad(open) {
    $('pad-wrap').classList.toggle('is-open', open);
    $('btn-pad').setAttribute('aria-pressed', String(open));
  }

  function renderSoundButton() {
    const on = sound.enabled;
    $('btn-sound').querySelector('use').setAttribute('href', on ? '#i-sound' : '#i-mute');
    $('btn-sound').setAttribute('aria-label', on ? 'Sound on' : 'Sound off');
  }

  function updateHeroBest() {
    const best = bestTime();
    $('hero-best').textContent = best ? 'Personal best  ' + formatTime(best) : 'Drag the cube to look around';
  }

  function share() {
    const url = location.href.split('#')[0];
    const text = lastResult
      ? 'I solved The Cube in ' + lastResult.time + ' (' + lastResult.moves + ' moves). Can you beat it?'
      : 'Can you solve The Cube?';
    if (navigator.share) {
      navigator.share({ title: 'The Cube', text, url }).catch(() => { /* dismissed */ });
    } else {
      window.open('https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(url), '_blank', 'noopener,width=620,height=560');
    }
  }

  $('btn-play').addEventListener('click', startGame);
  $('btn-learn').addEventListener('click', () => setGuide(true));
  $('btn-undo').addEventListener('click', undo);
  $('btn-new').addEventListener('click', scramble);
  $('btn-view').addEventListener('click', recenter);
  $('btn-pad').addEventListener('click', () => setPad(!$('pad-wrap').classList.contains('is-open')));
  $('btn-guide').addEventListener('click', () => setGuide(app.dataset.guide !== 'open'));
  $('btn-guide-close').addEventListener('click', () => setGuide(false));
  $('btn-again').addEventListener('click', scramble);
  $('btn-result-close').addEventListener('click', closeResult);
  $('btn-share').addEventListener('click', share);
  $('btn-sound').addEventListener('click', () => {
    sound.setEnabled(!sound.enabled);
    renderSoundButton();
    sound.click();
  });

  document.querySelectorAll('#pad [data-move]').forEach((button) => {
    button.addEventListener('click', () => playSequence(button.dataset.move, 170));
  });

  // Guide chips: show a proper prime mark, play the sequence on tap.
  document.querySelectorAll('.alg').forEach((chip) => {
    chip.textContent = chip.textContent.replace(/'/g, '′');
    if (chip.dataset.alg) chip.addEventListener('click', () => playSequence(chip.dataset.alg));
  });

  // Yellow-cross shapes for step 4 of the guide
  const CROSS_SHAPES = [['Dot', '000010000'], ['L shape', '010110000'], ['Line', '000111000'], ['Cross', '010111010']];
  $('shapes').innerHTML = CROSS_SHAPES.map(([name, cells]) =>
    '<div class="shape"><div class="shape-grid">' +
    [...cells].map((c) => '<i' + (c === '1' ? ' class="on"' : '') + '></i>').join('') +
    '</div>' + name + '</div>'
  ).join('');

  /* ======================================================================
   * 11. Celebration
   * ==================================================================== */

  const confetti = (() => {
    const surface = $('confetti');
    const g = surface.getContext('2d');
    const colors = Object.values(PALETTE);
    let pieces = [];
    let running = false;
    let last = 0;

    function burst() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      surface.width = surface.clientWidth * ratio;
      surface.height = surface.clientHeight * ratio;
      g.setTransform(ratio, 0, 0, ratio, 0, 0);

      const cx = surface.clientWidth / 2;
      const cy = surface.clientHeight * 0.45;
      for (let i = 0; i < 170; i++) {
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1;
        const speed = 0.5 + Math.random() * 0.9;
        pieces.push({
          x: cx + (Math.random() - 0.5) * 60,
          y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          w: 6 + Math.random() * 6,
          h: 4 + Math.random() * 4,
          spin: Math.random() * Math.PI,
          spinSpeed: (Math.random() - 0.5) * 0.02,
          color: colors[i % colors.length],
          age: 0,
        });
      }
      if (!running) {
        running = true;
        last = performance.now();
        requestAnimationFrame(step);
      }
    }

    // Time-based physics, so it plays the same at 60 Hz and 120 Hz.
    function step(now) {
      const dt = Math.min(32, now - last);
      last = now;
      g.clearRect(0, 0, surface.clientWidth, surface.clientHeight);

      for (const p of pieces) {
        p.age += dt;
        p.vy += 0.0016 * dt;   // gravity
        p.vx *= 1 - 0.0012 * dt; // air drag
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.spin += p.spinSpeed * dt;

        g.save();
        g.globalAlpha = clamp(1 - (p.age - 1800) / 900, 0, 1);
        g.translate(p.x, p.y);
        g.rotate(p.spin);
        g.scale(1, Math.cos(p.spin * 1.7)); // fake a tumble
        g.fillStyle = p.color;
        g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        g.restore();
      }

      pieces = pieces.filter((p) => p.age < 2700 && p.y < surface.clientHeight + 40);
      if (pieces.length) requestAnimationFrame(step);
      else {
        running = false;
        g.clearRect(0, 0, surface.clientWidth, surface.clientHeight);
      }
    }

    return { burst };
  })();

  /* ======================================================================
   * 12. Main loop
   * ==================================================================== */

  const IDLE_SPIN = 0.00022; // rad/ms on the start screen
  let previousFrame = performance.now();

  function frame(now) {
    const dt = Math.min(50, now - previousFrame);
    previousFrame = now;

    // Orientation: recenter animation, coasting after a flick, or idle spin
    if (recenterAnim) {
      const k = Math.min(1, (now - recenterAnim.start) / recenterAnim.duration);
      cube.quaternion.copy(recenterAnim.from).slerp(HOME_VIEW, ease.inOutCubic(k));
      if (k >= 1) recenterAnim = null;
    } else if (!pointer) {
      if (Math.abs(inertia.x) + Math.abs(inertia.y) > 1e-6) {
        rotateView(inertia.x * dt, inertia.y * dt);
        const decay = Math.exp(-dt / 320);
        inertia.x *= decay;
        inertia.y *= decay;
      }
      if (state === 'title' && !reducedMotion) rotateView(IDLE_SPIN * dt, 0);
    }

    // Layer animation
    if (activeTurn) {
      const k = Math.min(1, (now - activeTurn.start) / activeTurn.duration);
      const angle = activeTurn.from + (activeTurn.to - activeTurn.from) * activeTurn.ease(k);
      pivot.setRotationFromAxisAngle(AXES[activeTurn.axis], angle);
      if (k >= 1) {
        const done = activeTurn.done;
        activeTurn = null;
        done();
      }
    }
    runNextQueued();

    // Ease the framing toward its target
    const follow = 1 - Math.exp(-dt / 120);
    framing.top += (framingTarget.top - framing.top) * follow;
    framing.bottom += (framingTarget.bottom - framing.bottom) * follow;
    framing.right += (framingTarget.right - framing.right) * follow;
    applyCamera();

    if (state === 'playing') renderClock(now - startTime);

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }

  // Initial state. The start button stays disabled until everything above has run.
  $('btn-play').disabled = false;
  $('btn-play-label').textContent = 'Start to play';
  renderSoundButton();
  updateHeroBest();
  updateControls();
  if (store.get('cube.guide', '0') === '1') setGuide(true);
  handleResize();
  requestAnimationFrame(frame);
})();
