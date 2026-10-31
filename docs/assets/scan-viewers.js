// ============================================================================
// The 3D windows' shared machinery, and the Segmentation section's own
// windows built from it.
//
// Every 3D window on the page idles in the same slow turntable spin, driven
// off one shared clock (window.__a2i2ScanClockStart) so all of them land on
// the same angle at the same moment, and zooms to one shared physical scale
// (scan-scale.js). On a reveal, a window can play a one-shot "boost": an
// extra full turn plus, unless turned off, a decaying up-and-down shake.
//
// Exposed on window.__a2i2SegViewers, for seg-overview-demo.js and
// cls-demo.js:
//   raw, hu, spine    -- the Segmentation section's three Niivue windows
//                        ({ loadCase(caseId) -> Promise, playBoost() }): the
//                        original scan (HU -1000..1000), the same scan
//                        windowed to bone (HU -200..1800), and the identified
//                        spine region (docs/data/<case>/spine-region.nii.gz).
//                        They turn themselves, pausing while off screen.
//   binary, instance  -- { plotEl, spinner } for its two Plotly mesh windows
//                        (#ct-plot, #seg-mask-plot, drawn by app.js);
//                        seg-overview-demo.js turns them.
//   makeSpinner(apply, opts), makePlotSpinner(plotEl, getBox, opts)
//                     -- the turntable for any other window (cls-demo.js).
//
// Mesh plots are drawn at a fixed pixel size (app.js) and centred in their
// frame, which clips them: as a window narrows or widens during a reveal,
// the plot never has to be resized. Resizing a Plotly 3D plot re-lays it
// out and re-uploads its whole mesh to the GPU, and doing that to several
// plots mid-animation froze the page for about half a second. Instead the
// camera zooms to fit whatever part of the plot its frame shows.
//
// Drag, zoom and hover are off on every window here: the canvases and plots
// have `pointer-events: none` in style.css.
// ============================================================================

(function () {
  var NIIVUE_MODULE_URL = "https://cdn.jsdelivr.net/npm/@niivue/niivue@0.69.0/+esm";

  function nowMs() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  var SCAN_CLOCK_START = window.__a2i2ScanClockStart || (window.__a2i2ScanClockStart = nowMs());

  var BASE_ELEVATION = 10;
  var IDLE_DEG_PER_SEC = 360 / 26; // one slow full turn roughly every 26s
  var IDLE_START_AZIMUTH = 110;
  var BOOST_MS = 1500;
  // #f0f3f6, the CSS --scan-bg behind every 3D window.
  var SCAN_BACK_COLOR = [0.9412, 0.9529, 0.9647, 1];
  // Bump to bust browser caching of the scan files. gl-helpers.js shares a
  // decoded scan between windows only when their URLs match exactly, so
  // cls-demo.js's spine-region URL uses this same version.
  var DATA_VERSION = "sr7";
  var prefersReducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Plotly's camera starts at this distance (in its normalised scene units)
  // until scan-scale.js can solve for the shared scale.
  var PLOTLY_EYE_DISTANCE = 3.4;
  // Niivue azimuth -> Plotly orbit angle. The meshes and the NIfTI volumes
  // share one axis frame (see _reorder_axes / write_spine_region_volume in
  // scripts/generate_3d_viz.py), so this is purely the difference between
  // the two libraries' camera conventions.
  var PLOTLY_AZIMUTH_SIGN = -1;
  var PLOTLY_AZIMUTH_OFFSET = -90;
  var RELAYOUT_FALLBACK_MS = 66;

  var gl = window.__a2i2Gl;
  var scale = window.__a2i2ScanScale;

  function deg2rad(d) { return d * Math.PI / 180; }

  function idleAzimuthNow() {
    var elapsedSeconds = (nowMs() - SCAN_CLOCK_START) / 1000;
    return IDLE_START_AZIMUTH + (prefersReducedMotion ? 0 : elapsedSeconds * IDLE_DEG_PER_SEC);
  }

  // ---- Turntable ---------------------------------------------------------- //
  // One rotating window: holds its own one-shot boost and knows how to apply
  // an (azimuth, elevation) pair to whatever renders it. opts.shake === false
  // keeps the boost's extra turn but drops its shake.
  function makeSpinner(apply, opts) {
    var shake = !(opts && opts.shake === false);
    var boost = null;
    return {
      playBoost: function () { if (!prefersReducedMotion) boost = { startTs: null }; },
      frame: function (ts, idleAzimuth) {
        var azimuth = idleAzimuth;
        var elevation = BASE_ELEVATION;
        if (boost) {
          if (boost.startTs === null) boost.startTs = ts;
          var t = Math.min((ts - boost.startTs) / BOOST_MS, 1);
          var eased = 1 - Math.pow(1 - t, 3); // ease-out cubic settle
          azimuth = idleAzimuth + eased * 360;
          if (shake) elevation = BASE_ELEVATION + Math.sin(t * Math.PI * 11) * 16 * (1 - t);
          if (t >= 1) boost = null;
        }
        apply(azimuth, elevation);
      },
    };
  }

  function plotlyPhi(azimuth) { return deg2rad(PLOTLY_AZIMUTH_SIGN * azimuth + PLOTLY_AZIMUTH_OFFSET); }

  function plotlyEye(azimuth, elevation, distance) {
    var phi = plotlyPhi(azimuth);
    var theta = deg2rad(elevation);
    return [
      distance * Math.cos(theta) * Math.cos(phi),
      distance * Math.cos(theta) * Math.sin(phi),
      distance * Math.sin(theta),
    ];
  }

  // A Plotly window's turntable. Moves the gl3d camera directly (the scene's
  // own render loop picks the change up) rather than through
  // Plotly.relayout, which is far too heavy to call every frame; falls back
  // to a throttled relayout if Plotly's internals ever change shape. The
  // camera distance is solved each frame for the shared scale, fitted to
  // the frame the plot sits in (its parent element), not to the plot itself,
  // which may be larger and clipped. getBox (optional) returns the mesh box
  // to fit -- see scan-scale.js; omitted, it fits the whole spine.
  function makePlotSpinner(plotEl, getBox, opts) {
    var lastRelayout = 0;
    var distance = PLOTLY_EYE_DISTANCE;
    var lastPhi = null;
    return makeSpinner(function (azimuth, elevation) {
      var solved = scale && lastPhi !== null
        ? scale.plotlyEyeDistance(plotEl, lastPhi, getBox ? getBox() : null, plotEl.parentElement)
        : null;
      if (solved !== null) distance = Math.min(Math.max(solved, 1), 20);
      lastPhi = plotlyPhi(azimuth);
      var eye = plotlyEye(azimuth, elevation, distance);
      var scene = plotEl._fullLayout && plotEl._fullLayout.scene && plotEl._fullLayout.scene._scene;
      if (scene && scene.camera && typeof scene.camera.lookAt === "function") {
        scene.camera.lookAt(eye, [0, 0, 0], [0, 0, 1]);
        return;
      }
      if (!window.Plotly || !plotEl.data) return;
      var t = nowMs();
      if (t - lastRelayout < RELAYOUT_FALLBACK_MS) return;
      lastRelayout = t;
      window.Plotly.relayout(plotEl, {
        "scene.camera.eye": { x: eye[0], y: eye[1], z: eye[2] },
        "scene.camera.center": { x: 0, y: 0, z: 0 },
        "scene.camera.up": { x: 0, y: 0, z: 1 },
      });
    }, opts);
  }

  // ---- Niivue windows ---------------------------------------------------- //
  function resolveNiivueClass(mod) {
    if (typeof mod.Niivue === "function") return mod.Niivue;
    if (typeof mod.default === "function") return mod.default;
    if (mod.default && typeof mod.default.Niivue === "function") return mod.default.Niivue;
    for (var key in mod) {
      if (typeof mod[key] === "function" && /niivue/i.test(key)) return mod[key];
    }
    throw new Error("Could not find the Niivue class in the imported module");
  }

  var niivueWindows = [];

  // One Niivue window: canvas, scan URL per case, a fixed HU window, and its
  // own turntable. opts.nearest: nearest-neighbour sampling, for volumes
  // that are mostly masked-out space (the spine region -- linear sampling
  // would blend that space's zero alpha into a haze at every boundary).
  // opts.fallbackScale: zoom until the case's meshes give the shared scale.
  function makeScanViewer(canvas, urlFor, hu, opts) {
    opts = opts || {};
    var nvPromise = null;
    var activeNv = null;
    var currentCaseId = null;
    var fallbackScale = opts.fallbackScale || 0.6;
    var watcher = gl ? gl.track(function () { return canvas; }) : null;

    var spinner = makeSpinner(function (azimuth, elevation) {
      var nv = activeNv;
      var s = scale ? scale.niivueVolScale(nv, canvas.clientWidth, canvas.clientHeight) : null;
      if (s === null) s = fallbackScale;
      if (Math.abs(nv.volScaleMultiplier - s) > 1e-3) nv.volScaleMultiplier = s;
      nv.setRenderAzimuthElevation(azimuth, elevation);
    }, opts);

    function getNiivue() {
      if (!nvPromise) {
        nvPromise = import(NIIVUE_MODULE_URL).then(function (mod) {
          var NiivueClass = resolveNiivueClass(mod);
          var nv = new NiivueClass({
            isResizeCanvas: true, backColor: SCAN_BACK_COLOR, show3Dcrosshair: false,
            forceDevicePixelRatio: gl ? gl.pixelRatio() : 0,
          });
          return nv.attachToCanvas(canvas).then(function () { return nv; });
        }).then(function (nv) {
          nv.volScaleMultiplier = fallbackScale;
          if (opts.nearest && typeof nv.setInterpolation === "function") nv.setInterpolation(true);
          activeNv = nv;
          return nv;
        });
      }
      return nvPromise;
    }

    function loadCase(caseId) {
      if (!caseId || caseId === currentCaseId) return Promise.resolve();
      currentCaseId = caseId;
      return getNiivue().then(function (nv) {
        var url = urlFor(caseId);
        var load = gl ? gl.loadVolume(nv, url) : nv.loadVolumes([{ url: url, colormap: "gray" }]);
        return load.then(function () { return nv; });
      }).then(function (nv) {
        if (nv.volumes && nv.volumes[0]) {
          nv.volumes[0].cal_min = hu.min;
          nv.volumes[0].cal_max = hu.max;
        }
        nv.setSliceType(nv.sliceTypeRender);
        nv.updateGLVolume();
      }).catch(function (err) {
        console.error("scan-viewers: failed to load", urlFor(caseId), err);
        currentCaseId = null; // allow a retry if the case is picked again
        throw err;
      });
    }

    var view = {
      loadCase: loadCase,
      playBoost: function () { if (activeNv) spinner.playBoost(); },
      frame: function (ts, idleAzimuth) {
        // Off screen or not yet loaded: don't redraw a volume no one sees.
        if (!activeNv || (watcher && !watcher.shown)) return;
        spinner.frame(ts, idleAzimuth);
      },
    };
    niivueWindows.push(view);
    return view;
  }

  function tick(ts) {
    requestAnimationFrame(tick);
    var idleAzimuth = idleAzimuthNow();
    niivueWindows.forEach(function (w) { w.frame(ts, idleAzimuth); });
  }
  requestAnimationFrame(tick);

  // ---- The Segmentation section's windows -------------------------------- //
  function scanUrl(caseId) { return "data/" + caseId + "/niivue.nii.gz?v=" + DATA_VERSION; }
  function spineUrl(caseId) { return "data/" + caseId + "/spine-region.nii.gz?v=" + DATA_VERSION; }

  var viewers = window.__a2i2SegViewers || (window.__a2i2SegViewers = {});
  viewers.makeSpinner = makeSpinner;
  viewers.makePlotSpinner = makePlotSpinner;
  viewers.idleAzimuth = idleAzimuthNow;
  viewers.spineUrl = spineUrl;

  var rawCanvas = document.getElementById("seg-raw-canvas");
  var huCanvas = document.getElementById("seg-hu-canvas");
  var spineCanvas = document.getElementById("seg-spine-canvas");
  if (rawCanvas) viewers.raw = makeScanViewer(rawCanvas, scanUrl, { min: -1000, max: 1000 });
  if (huCanvas) viewers.hu = makeScanViewer(huCanvas, scanUrl, { min: -200, max: 1800 });
  if (spineCanvas) viewers.spine = makeScanViewer(spineCanvas, spineUrl, { min: -200, max: 1800 }, { nearest: true, fallbackScale: 1.0 });

  // The Model overview section's "Original CT scan" window: same scan,
  // same HU window as Segmentation's own raw viewer above, so the two
  // look identical. gl-helpers.js shares the decoded volume between them
  // (same URL), so this costs another WebGL context but not another decode.
  var modelCtCanvas = document.getElementById("model-ct-canvas");
  if (modelCtCanvas) viewers.modelCt = makeScanViewer(modelCtCanvas, scanUrl, { min: -1000, max: 1000 });

  ["binary", "instance"].forEach(function (slot) {
    var plotEl = document.getElementById(slot === "binary" ? "ct-plot" : "seg-mask-plot");
    if (plotEl) viewers[slot] = { plotEl: plotEl, spinner: makePlotSpinner(plotEl) };
  });
})();
