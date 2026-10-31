// ============================================================================
// Classification -- the section's windows as one animated walkthrough.
//
// Resting on two windows (step 3's identified spine region, and the ground-
// truth fracture view), #cls-run-btn plays the classifier's pipeline:
//
//   1. the fracture view fades out and collapses;
//   2. the instance segmentation opens in its place (the same window,
//      recoloured), with the Segmentation section's reveal spin;
//   3. the spine region fades out, the layout switches to the section's
//      resting grid -- sliding the segmentation over to the far right --
//      and the seven per-level mask windows open, C1 to C7, a second apart;
//   4. the segmentation fades out and the AI figure takes its place;
//   5. level by level, each mask window gives way to that level's CT;
//   6. the CT windows fly into the AI figure one by one, fading as they go;
//   7. the AI moves to the middle and plays the Solution section's
//      "working" animation;
//   8. it fades, and the section settles into its resting state -- the
//      seven mask windows and the fracture view.
//
// Major steps are two seconds apart (STEP_PAUSE_MS), counted from when the
// previous one finished; per-level steps are one second each. Pressed again
// once done, the button returns to the two-window start.
//
// Windows: the fracture/instance window is app.js's own Plotly plot,
// recoloured and driven here; the spine region and each per-level CT turn on
// the shared page clock, zoomed to the shared physical scale (scan-scale.js)
// so a level's mask and its CT match millimetre for millimetre. The seven
// per-level masks AND their seven per-level CTs are all pre-rendered
// turntable sprites (scripts/render_turntable_sprites.mjs, each vertebra in
// its own assigned colour): fourteen live mesh viewers on top of the
// fracture/instance window and the spine region would push well past the
// ~16 WebGL contexts browsers keep alive. Unlike the CTs, each mask sprite
// is held at one fixed angle rather than turning -- at only 72 frames,
// cycling it read as a choppy step rather than a spin -- and instead gets a
// gentle CSS float (style.css) to keep it feeling alive.
// ============================================================================

(function () {
  function nowMs() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  var SCAN_CLOCK_START = window.__a2i2ScanClockStart || (window.__a2i2ScanClockStart = nowMs());

  var sectionEl = document.getElementById("stage-classification");
  var stageEl = document.getElementById("cls-stage");
  var spineWinEl = document.getElementById("cls-spine");
  var spineCanvas = document.getElementById("cls-spine-niivue-canvas");
  var rightWinEl = document.getElementById("cls-right");
  var rightLabelEl = document.getElementById("cls-right-label");
  var rightPlotEl = document.getElementById("cls-mask-plot");
  var aiEl = document.getElementById("cls-ai");
  var runBtn = document.getElementById("cls-run-btn");
  var runLabelEl = document.getElementById("cls-run-label");
  var statusEl = document.getElementById("cls-status");
  var viewers = window.__a2i2SegViewers || {};
  if (!sectionEl || !stageEl || !rightPlotEl || !aiEl || !runBtn || !viewers.makeSpinner || !viewers.makePlotSpinner) return;

  var LEVELS = 7;
  var cells = [];
  for (var i = 0; i < LEVELS; i++) {
    cells.push({
      cellEl: document.getElementById("cls-vert-cell-" + i),
      plotEl: document.getElementById("cls-vert-plot-" + i),
      ctEl: document.getElementById("cls-vert-ct-" + i),
    });
  }

  var IDLE_DEG_PER_SEC = 360 / 26;
  var IDLE_START_AZIMUTH = 110;
  var FADE_MS = 700; // .cls-spine/.cls-right opacity transition
  var MOVE_MS = 700; // --cls-move, the column width transitions
  var LEVEL_MS = 1000; // each per-level step
  var STEP_PAUSE_MS = 2000; // between major steps
  var FLY_MOVE_MS = 450; // a vertebra window's trip to the AI figure -- halved: was 900
  var FLY_FADE_MS = 200; // ...and its fade once it's there -- halved: was 400
  var AI_MOVE_MS = 1000; // .cls-ai position transition
  var PREDICT_MS = 3000;
  var FRACTURE_COLOR = "#C0392B"; // app.js's FRACTURE_HIGHLIGHT_COLOR
  var NEUTRAL_COLOR = "#cfc8bb"; // app.js's GROUND_TRUTH_NEUTRAL_COLOR
  var RIGHT_LABELS = { fracture: "Ground truth — fracture status", instance: "Instance segmentation" };
  var LABELS = { idle: "Classification", running: "Classifying…", done: "Back to start" };
  var STATUS = {
    idle: statusEl ? statusEl.textContent : "",
    instance: "Segmenting the spine region into individual vertebrae…",
    levels: "Isolating each vertebra, C1 to C7…",
    ai: "Handing the vertebrae to the classifier…",
    ct: "Cutting out each level's CT…",
    send: "Sending each level to the classifier…",
    predict: "Predicting each level's fracture status…",
    done: "Done: red = vertebra flagged as fractured. Visualisation only — drag and zoom are turned off here.",
  };
  var prefersReducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var scale = window.__a2i2ScanScale;

  // ---- Turntable sprites ------------------------------------------------- //
  // Drawn onto a canvas: the frame at or before the current angle, then the
  // next one over it, faded in by how far the angle has got towards it.
  // A canvas rather than CSS background offsets into the sprite sheet: those
  // land on fractional pixels that round differently at every 5° step, and
  // the browser drops to coarse filtering while it rescales a 6000px sheet
  // every frame -- together they made the image visibly shake. drawImage
  // takes an exact source square and scales it smoothly.
  var SCAN_BG = "#f0f3f6"; // --scan-bg

  function makeTurntable(el) {
    var canvas = document.createElement("canvas");
    el.appendChild(canvas);
    var ctx = canvas.getContext("2d");
    var sprite = null; // { url, size, pxPerMm, frames, cols, step }
    var img = null;
    var last = "";

    return {
      set: function (next) {
        sprite = next;
        img = null;
        last = "";
        ctx.fillStyle = SCAN_BG;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (!next) return;
        var loading = new Image();
        loading.onload = function () { if (sprite === next) { img = loading; last = ""; } };
        loading.src = next.url;
      },
      render: function (azimuth, targetPxPerMm) {
        if (!sprite || !img) return;
        var dpr = window.devicePixelRatio || 1;
        var w = Math.round(el.clientWidth * dpr);
        var h = Math.round(el.clientHeight * dpr);
        if (!w || !h) return;
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; last = ""; }
        var size = sprite.size * (targetPxPerMm ? targetPxPerMm / sprite.pxPerMm : 1) * dpr;
        var t = ((azimuth / sprite.step) % sprite.frames + sprite.frames) % sprite.frames;
        var key = size.toFixed(2) + "|" + t.toFixed(3);
        if (key === last) return;
        last = key;
        var f0 = Math.floor(t);
        var f1 = (f0 + 1) % sprite.frames;
        var x = (w - size) / 2;
        var y = (h - size) / 2;
        var s = sprite.size;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.globalAlpha = 1;
        ctx.fillStyle = SCAN_BG;
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, (f0 % sprite.cols) * s, Math.floor(f0 / sprite.cols) * s, s, s, x, y, size, size);
        ctx.globalAlpha = t - f0;
        ctx.drawImage(img, (f1 % sprite.cols) * s, Math.floor(f1 / sprite.cols) * s, s, s, x, y, size, size);
        ctx.globalAlpha = 1;
      },
    };
  }

  var boxes = new Array(LEVELS).fill(null);

  function targetFor(el, box) {
    return scale ? scale.pxPerMm(el.clientWidth, el.clientHeight, box || undefined) : null;
  }

  // No shake on reveal in this section, just the extra turn.
  var NO_SHAKE = { shake: false };

  // ---- Spine region: a live Niivue viewer -------------------------------- //
  // The same volume, settings and scale as the Segmentation section's
  // identified-region window, so the two look and move identically.
  var NIIVUE_MODULE_URL = "https://cdn.jsdelivr.net/npm/@niivue/niivue@0.69.0/+esm";
  var SPINE_URL_VERSION = "sr7"; // scan-viewers.js's DATA_VERSION -- same file, shared decode
  var SPINE_WINDOW = { min: -200, max: 1800 };
  var SPINE_FALLBACK_SCALE = 1.0;
  var gl = window.__a2i2Gl;
  var spine = { nvPromise: null, nv: null, caseId: null };

  function resolveNiivueClass(mod) {
    if (typeof mod.Niivue === "function") return mod.Niivue;
    if (typeof mod.default === "function") return mod.default;
    if (mod.default && typeof mod.default.Niivue === "function") return mod.default.Niivue;
    for (var key in mod) {
      if (typeof mod[key] === "function" && /niivue/i.test(key)) return mod[key];
    }
    throw new Error("Could not find the Niivue class in the imported module");
  }

  function spineNiivue() {
    if (!spine.nvPromise) {
      spine.nvPromise = import(NIIVUE_MODULE_URL).then(function (mod) {
        var NiivueClass = resolveNiivueClass(mod);
        // #f0f3f6, the --scan-bg every 3D window uses.
        var nv = new NiivueClass({ isResizeCanvas: true, backColor: [0.9412, 0.9529, 0.9647, 1], show3Dcrosshair: false, forceDevicePixelRatio: gl ? gl.pixelRatio() : 0 });
        return nv.attachToCanvas(spineCanvas).then(function () { return nv; });
      }).then(function (nv) {
        // Nearest-neighbour: most of this volume is masked-out space (see
        // scan-viewers.js).
        if (typeof nv.setInterpolation === "function") nv.setInterpolation(true);
        spine.nv = nv;
        return nv;
      });
    }
    return spine.nvPromise;
  }

  function spineDoLoad(caseId) {
    if (!caseId || caseId === spine.caseId) return;
    spine.caseId = caseId;
    spineNiivue().then(function (nv) {
      var url = "data/" + caseId + "/spine-region.nii.gz?v=" + SPINE_URL_VERSION;
      return (gl ? gl.loadVolume(nv, url) : nv.loadVolumes([{ url: url, colormap: "gray" }])).then(function () { return nv; });
    }).then(function (nv) {
      if (nv.volumes && nv.volumes[0]) {
        nv.volumes[0].cal_min = SPINE_WINDOW.min;
        nv.volumes[0].cal_max = SPINE_WINDOW.max;
      }
      nv.setSliceType(nv.sliceTypeRender);
      nv.updateGLVolume();
    }).catch(function (err) {
      console.error("cls-demo: failed to load spine region", caseId, err);
      spine.caseId = null;
    });
  }

  // Pauses its turntable while hidden (the section's grid layout hides it).
  var spineWatcher = gl ? gl.track(function () { return spineCanvas; }) : null;

  var spineSpinner = viewers.makeSpinner(function (azimuth, elevation) {
    var nv = spine.nv;
    if (!nv || (spineWatcher && !spineWatcher.shown)) return;
    var s = scale ? scale.niivueVolScale(nv, spineCanvas.clientWidth, spineCanvas.clientHeight) : null;
    if (s === null) s = SPINE_FALLBACK_SCALE;
    if (Math.abs(nv.volScaleMultiplier - s) > 1e-3) nv.volScaleMultiplier = s;
    nv.setRenderAzimuthElevation(azimuth, elevation);
  }, NO_SHAKE);
  var rightSpinner = viewers.makePlotSpinner(rightPlotEl, null, NO_SHAKE);
  cells.forEach(function (c, n) {
    c.tt = makeTurntable(c.ctEl);
    c.ctSpinner = viewers.makeSpinner(function (azimuth) { c.tt.render(azimuth, targetFor(c.ctEl, boxes[n])); }, NO_SHAKE);
    // Held at one fixed angle rather than turning (see the tick loop below)
    // -- a CSS float (.cls-vert-mask in style.css) keeps it feeling alive.
    c.maskTt = makeTurntable(c.plotEl);
  });

  // ---- Case data --------------------------------------------------------- //
  var caseData = null;
  var rightMode = "fracture";

  function rightColors(mode) {
    if (!caseData || !caseData.mask_meshes) return null;
    var fractured = caseData.fractured_labels || [];
    return caseData.mask_meshes.map(function (m) {
      if (mode === "instance") return m.color;
      return fractured.indexOf(m.label) !== -1 ? FRACTURE_COLOR : NEUTRAL_COLOR;
    });
  }

  function setRightMode(mode) {
    rightMode = mode;
    if (rightLabelEl) rightLabelEl.textContent = RIGHT_LABELS[mode];
    var colors = rightColors(mode);
    if (colors && window.Plotly && rightPlotEl.data) window.Plotly.restyle(rightPlotEl, { color: colors });
  }

  function loadSprites(caseId) {
    var base = "data/" + caseId + "/";
    fetch(base + "turntable.json").then(function (res) {
      if (!res.ok) throw new Error("turntable.json " + res.status);
      return res.json();
    }).then(function (meta) {
      if (!caseData || caseData.case_id !== caseId) return; // a newer case won
      function sprite(name) {
        var s = meta.sprites[name];
        return s ? { url: base + s.file, size: s.size, pxPerMm: s.pxPerMm, frames: meta.frames, cols: meta.cols, step: meta.azimuthStep } : null;
      }
      cells.forEach(function (c, n) {
        var mesh = caseData.mask_meshes && caseData.mask_meshes[n];
        c.tt.set(mesh ? sprite("vertebra-" + mesh.label) : null);
        c.maskTt.set(mesh ? sprite("mask-vertebra-" + mesh.label) : null);
      });
    }).catch(function (err) {
      console.warn("cls-demo: no turntable sprites for", caseId, err);
      cells.forEach(function (c) { c.tt.set(null); c.maskTt.set(null); });
    });
  }

  window.addEventListener("a2i2:case-data", function (event) {
    caseData = event.detail && event.detail.data;
    if (!caseData) return;
    boxes = cells.map(function (c, n) {
      var mesh = caseData.mask_meshes && caseData.mask_meshes[n];
      return mesh && scale ? scale.boxOf([mesh]) : null;
    });
    // app.js has just redrawn the plot in fracture colours.
    if (rightMode !== "fracture") setRightMode(rightMode);
    loadSprites(caseData.case_id);
    spineDoLoad(caseData.case_id);
  });

  // ---- Layout helpers ---------------------------------------------------- //
  // No plot resizing anywhere here: app.js draws these plots at a fixed
  // size, centred and clipped by their frames, so the layout can change
  // under them without a re-layout (see scan-viewers.js for why).

  function cellVisible(c) { return c.cellEl && !c.cellEl.hidden; }

  var aiPlace = null; // "right" | "middle" | null

  function placeAi(where) {
    aiPlace = where;
    var stageRect = stageEl.getBoundingClientRect();
    if (where === "middle") {
      aiEl.style.left = (stageRect.width / 2) + "px";
      aiEl.style.top = (stageRect.height / 2) + "px";
      aiEl.style.width = Math.min(stageRect.width * 0.42, 440) + "px";
      return;
    }
    var frame = rightWinEl.querySelector(".cls-frame").getBoundingClientRect();
    aiEl.style.left = (frame.left - stageRect.left + frame.width / 2) + "px";
    aiEl.style.top = (frame.top - stageRect.top + frame.height / 2) + "px";
    aiEl.style.width = Math.min(frame.width * 0.9, 380) + "px";
  }

  window.addEventListener("resize", function () {
    if (aiPlace) placeAi(aiPlace);
  });

  // Snaps an element back to its resting style without playing the
  // transition back (used to un-fly the CT layers on reset).
  function snap(el, fn) {
    var prev = el.style.transition;
    el.style.transition = "none";
    fn();
    void el.offsetWidth;
    el.style.transition = prev;
  }

  function resetCt(c) {
    snap(c.ctEl, function () { c.ctEl.classList.remove("is-shown"); });
  }

  // Puts a vertebra window (label and all) back in its grid slot after a
  // flight, hidden, so the caller can fade it back in.
  function landCell(c) {
    snap(c.cellEl, function () {
      c.cellEl.classList.remove("is-flying");
      c.cellEl.style.transform = "";
      c.cellEl.style.opacity = "0";
    });
    c.cellEl.style.transition = ""; // back to the stylesheet's fade timings
  }

  // The whole window -- label, frame, CT -- travels to the AI figure fully
  // visible, and only fades once it's arrived.
  function flyToAi(c, wait) {
    var from = c.cellEl.querySelector(".cls-cell-frame").getBoundingClientRect();
    var to = aiEl.getBoundingClientRect();
    var dx = (to.left + to.width / 2) - (from.left + from.width / 2);
    var dy = (to.top + to.height / 2) - (from.top + from.height / 2);
    c.cellEl.classList.add("is-flying");
    c.cellEl.style.transition = "transform " + FLY_MOVE_MS + "ms var(--ease-in-out)";
    c.cellEl.style.transform = "translate(" + dx + "px, " + dy + "px) scale(.45)";
    return wait(FLY_MOVE_MS).then(function () {
      c.cellEl.style.transition = "transform " + FLY_FADE_MS + "ms var(--ease-in), opacity " + FLY_FADE_MS + "ms var(--ease-in)";
      c.cellEl.style.transform = "translate(" + dx + "px, " + dy + "px) scale(.2)";
      c.cellEl.style.opacity = "0";
      return wait(FLY_FADE_MS);
    });
  }

  // ---- Run --------------------------------------------------------------- //
  var state = "idle";
  var runToken = 0;

  function setState(next) {
    state = next;
    runBtn.disabled = next === "running";
    runBtn.setAttribute("aria-pressed", next === "done" ? "true" : "false");
    if (runLabelEl) runLabelEl.textContent = LABELS[next];
  }

  function status(key) { if (statusEl) statusEl.textContent = STATUS[key]; }

  // Resolves after ms, or never if the run has been reset in the meantime
  // (so a stale run just stops where it is).
  function waitFor(token, ms) {
    return new Promise(function (resolve) {
      setTimeout(function () { if (token === runToken) resolve(); }, prefersReducedMotion ? Math.min(ms, 50) : ms);
    });
  }

  function showIntro() {
    runToken++;
    stageEl.classList.remove("is-grid");
    spineWinEl.classList.remove("is-faded");
    rightWinEl.classList.remove("is-faded", "is-collapsed");
    setRightMode("fracture");
    cells.forEach(function (c) {
      landCell(c);
      c.cellEl.style.opacity = "";
      c.cellEl.classList.add("is-pending");
      c.plotEl.classList.remove("is-faded");
      resetCt(c);
    });
    aiEl.classList.remove("is-visible", "is-active");
    aiPlace = null;
    status("idle");
    setState("idle");
  }

  function play() {
    var token = ++runToken;
    var wait = function (ms) { return waitFor(token, ms); };
    var visible = cells.filter(cellVisible);
    setState("running");

    // 1. Fracture view fades out, then collapses.
    rightWinEl.classList.add("is-faded");
    wait(FADE_MS).then(function () {
      rightWinEl.classList.add("is-collapsed");
      // Recolour while it's hidden: a restyle re-uploads the mesh, which
      // would stall the reveal if done as the window opens.
      setRightMode("instance");
      return wait(MOVE_MS + STEP_PAUSE_MS);
    }).then(function () {
      // 2. Instance segmentation opens to the right of the spine region.
      status("instance");
      rightWinEl.classList.remove("is-collapsed", "is-faded");
      spineSpinner.playBoost();
      rightSpinner.playBoost();
      return wait(MOVE_MS + STEP_PAUSE_MS);
    }).then(function () {
      // 3. Spine region fades; grid layout slides the segmentation right.
      spineWinEl.classList.add("is-faded");
      return wait(FADE_MS);
    }).then(function () {
      status("levels");
      stageEl.classList.add("is-grid");
      return wait(MOVE_MS);
    }).then(function () {
      var seq = Promise.resolve();
      visible.forEach(function (c) {
        seq = seq.then(function () {
          c.cellEl.classList.remove("is-pending");
          return wait(LEVEL_MS);
        });
      });
      return seq;
    }).then(function () {
      return wait(STEP_PAUSE_MS);
    }).then(function () {
      // 4. Segmentation gives way to the AI figure.
      status("ai");
      rightWinEl.classList.add("is-faded");
      placeAi("right");
      aiEl.classList.add("is-visible");
      return wait(FADE_MS + STEP_PAUSE_MS);
    }).then(function () {
      // 5. Each level's mask gives way to its CT.
      status("ct");
      var seq = Promise.resolve();
      visible.forEach(function (c) {
        seq = seq.then(function () {
          c.plotEl.classList.add("is-faded");
          return wait(LEVEL_MS / 2);
        }).then(function () {
          c.ctEl.classList.add("is-shown");
          c.ctSpinner.playBoost();
          return wait(LEVEL_MS / 2);
        });
      });
      return seq;
    }).then(function () {
      return wait(STEP_PAUSE_MS);
    }).then(function () {
      // 6. The CT windows fly into the AI figure one at a time, C1 first:
      //    each arrives, fades, and only then does the next set off.
      status("send");
      var seq = Promise.resolve();
      visible.forEach(function (c) {
        seq = seq.then(function () { return flyToAi(c, wait); });
      });
      return seq;
    }).then(function () {
      return wait(STEP_PAUSE_MS);
    }).then(function () {
      // 7. AI to the middle, then predicts.
      status("predict");
      placeAi("middle");
      return wait(AI_MOVE_MS);
    }).then(function () {
      aiEl.classList.add("is-active");
      setRightMode("fracture"); // hidden behind the AI's turn, not at the reveal
      return wait(PREDICT_MS);
    }).then(function () {
      aiEl.classList.remove("is-active");
      return wait(STEP_PAUSE_MS);
    }).then(function () {
      // 8. Resting state: masks and fracture view, all turning.
      aiEl.classList.remove("is-visible");
      return wait(FADE_MS);
    }).then(function () {
      aiPlace = null;
      rightWinEl.classList.remove("is-faded");
      rightSpinner.playBoost();
      visible.forEach(function (c) {
        landCell(c);
        resetCt(c);
        c.plotEl.classList.remove("is-faded");
        c.cellEl.style.opacity = ""; // fades the mask window back in
      });
      status("done");
      setState("done");
    });
  }

  runBtn.addEventListener("click", function () {
    if (state === "idle") play();
    else if (state === "done") showIntro();
  });

  // ---- Turntable --------------------------------------------------------- //
  // Same idle angle as every other 3D window on the page. Paused while the
  // section is off screen: a live Plotly scene redrawing every frame, plus
  // fourteen sprite canvases, is too much to spend on something nobody can see.
  var sectionVisible = false;

  function tick(ts) {
    requestAnimationFrame(tick);
    if (!sectionVisible) return;
    var elapsedSeconds = (nowMs() - SCAN_CLOCK_START) / 1000;
    var idleAzimuth = IDLE_START_AZIMUTH + (prefersReducedMotion ? 0 : elapsedSeconds * IDLE_DEG_PER_SEC);
    var grid = stageEl.classList.contains("is-grid");
    if (!grid) spineSpinner.frame(ts, idleAzimuth);
    if (!rightWinEl.classList.contains("is-collapsed")) rightSpinner.frame(ts, idleAzimuth);
    if (!grid) return;
    cells.forEach(function (c, n) {
      if (!cellVisible(c) || c.cellEl.classList.contains("is-pending")) return;
      // Fixed angle, not the shared idle clock: see c.maskTt above.
      if (!c.plotEl.classList.contains("is-faded")) c.maskTt.render(IDLE_START_AZIMUTH, targetFor(c.plotEl, boxes[n]));
      if (c.ctEl.classList.contains("is-shown")) c.ctSpinner.frame(ts, idleAzimuth);
    });
  }
  requestAnimationFrame(tick);

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) { sectionVisible = entry.isIntersecting; });
    }, { rootMargin: "100px" }).observe(sectionEl);
  } else {
    sectionVisible = true;
  }

  // The AI figure is the Solution section's, cloned with its ids renamed
  // (-cls) so the page never has two elements with the same id.
  var aiSource = document.querySelector("#solution-ai svg");
  if (aiSource) aiEl.innerHTML = aiSource.outerHTML.replace(/inject-244/g, "inject-244-cls");

  showIntro();
})();
