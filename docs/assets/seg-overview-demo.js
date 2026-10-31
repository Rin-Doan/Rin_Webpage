// ============================================================================
// Segmentation -- the whole pipeline in one row of windows:
//
//   original CT -> HU windowed -> spine region -> binary mask -> instance mask
//
// It starts with just the two ends open (original CT and instance mask).
// #seg-overview-run-btn then plays the pipeline through: the instance
// window fades out and collapses, the original CT turns on its own for two
// seconds, and each following window opens in turn, two seconds after the
// previous one finished opening. Pressed again once the run is done, it
// collapses back to the starting pair.
//
// The windows themselves come from scan-viewers.js (window.__a2i2SegViewers):
//   raw, hu, spine -- Niivue viewers ({ loadCase, playBoost }), which keep
//                     spinning themselves on the shared page clock;
//   binary, instance -- { plotEl, spinner } for the two Plotly windows,
//                       whose cameras this file turns while they're on screen.
//
// Opening or closing a column changes every column's width, but nothing
// here resizes the plots: they're drawn at a fixed size and clipped by
// their frames (see scan-viewers.js), so a reveal costs no re-layout.
// ============================================================================

(function () {
  function nowMs() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  var SCAN_CLOCK_START = window.__a2i2ScanClockStart || (window.__a2i2ScanClockStart = nowMs());

  var sectionEl = document.getElementById("stage-segmentation");
  var windowEl = document.getElementById("seg-overview-window");
  var runBtn = document.getElementById("seg-overview-run-btn");
  var runLabelEl = document.getElementById("seg-overview-run-label");
  if (!sectionEl || !windowEl || !runBtn) return;

  var IDLE_DEG_PER_SEC = 360 / 26;
  var IDLE_START_AZIMUTH = 110;
  var REVEAL_MS = 420; // matches the column transitions in style.css
  var FADE_MS = 700; // .seg-overview-col.is-fading's opacity transition
  var STEP_PAUSE_MS = 2000; // turn time before each next window opens
  var prefersReducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var ORDER = ["raw", "hu", "spine", "binary", "instance"];
  var START_OPEN = { raw: true, instance: true };
  var LABELS = { idle: "Showing Segmentation", running: "Segmenting…", done: "Back to start" };

  function viewer(slot) { return (window.__a2i2SegViewers || {})[slot]; }

  var slots = {};
  Array.prototype.forEach.call(windowEl.querySelectorAll(".seg-overview-col"), function (col) {
    slots[col.getAttribute("data-slot")] = { col: col };
  });

  // Pauses the mesh turntables while the section is off screen.
  var gl = window.__a2i2Gl;
  var shown = gl ? gl.track(function () { return windowEl; }) : { shown: true };

  // ---- Columns ----------------------------------------------------------- //
  function openCount() {
    return ORDER.filter(function (slot) { return slots[slot].col.classList.contains("is-open"); }).length;
  }

  function setOpen(slot, open) {
    var col = slots[slot].col;
    col.classList.remove("is-fading");
    col.classList.toggle("is-open", open);
    windowEl.style.setProperty("--ov-n", Math.max(openCount(), 1));
  }

  function boost(slot) {
    var v = viewer(slot);
    if (!v) return;
    if (v.spinner) v.spinner.playBoost();
    else if (v.playBoost) v.playBoost();
  }

  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  // ---- Loading ----------------------------------------------------------- //
  var pendingCaseId = null;
  var sectionVisible = false;
  var ready = {}; // slot -> promise resolving once that window has this case loaded

  function loadAll() {
    if (!sectionVisible || !pendingCaseId) return;
    ["raw", "hu", "spine"].forEach(function (slot) {
      var v = viewer(slot);
      // A failed load still settles, so the run can't stall on one window
      // (scan-viewers.js logs what went wrong).
      ready[slot] = v ? v.loadCase(pendingCaseId).catch(function () {}) : Promise.resolve();
    });
  }

  // ---- Run --------------------------------------------------------------- //
  var state = "idle"; // idle -> running -> done -> idle

  function setState(next) {
    state = next;
    runBtn.disabled = next === "running";
    runBtn.setAttribute("aria-pressed", next === "done" ? "true" : "false");
    if (runLabelEl) runLabelEl.textContent = LABELS[next];
  }

  function play() {
    setState("running");
    var instanceCol = slots.instance.col;
    var fade = prefersReducedMotion ? 0 : FADE_MS;
    instanceCol.classList.add("is-fading");

    var seq = wait(fade).then(function () {
      setOpen("instance", false);
      return wait(REVEAL_MS);
    }).then(function () {
      boost("raw");
      return wait(STEP_PAUSE_MS);
    });

    ORDER.slice(1).forEach(function (slot, i) {
      var prev = ORDER[i];
      seq = seq.then(function () {
        return ready[slot] || Promise.resolve();
      }).then(function () {
        setOpen(slot, true);
        boost(prev);
        boost(slot);
        // The last window has nothing after it to wait for.
        return slot === "instance" ? null : wait(REVEAL_MS + STEP_PAUSE_MS);
      });
    });

    seq.then(function () { setState("done"); });
  }

  function reset() {
    ORDER.forEach(function (slot) { setOpen(slot, !!START_OPEN[slot]); });
    boost("raw");
    boost("instance");
    setState("idle");
  }

  runBtn.addEventListener("click", function () {
    if (state === "idle") play();
    else if (state === "done") reset();
  });

  // ---- Plotly turntable -------------------------------------------------- //
  // Same idle angle formula as every other 3D window on the page, so the
  // two mesh windows stay in phase with the three Niivue ones beside them.
  function tick(ts) {
    requestAnimationFrame(tick);
    if (!shown.shown) return;
    var elapsedSeconds = (nowMs() - SCAN_CLOCK_START) / 1000;
    var idleAzimuth = IDLE_START_AZIMUTH + (prefersReducedMotion ? 0 : elapsedSeconds * IDLE_DEG_PER_SEC);
    ["binary", "instance"].forEach(function (slot) {
      var v = viewer(slot);
      if (v && slots[slot].col.classList.contains("is-open")) v.spinner.frame(ts, idleAzimuth);
    });
  }
  requestAnimationFrame(tick);

  // ---- Wiring ------------------------------------------------------------ //
  window.addEventListener("a2i2:case-changed", function (event) {
    pendingCaseId = event.detail && event.detail.caseId;
    loadAll();
  });

  // Nothing heavy loads until the section is about to scroll into view.
  if ("IntersectionObserver" in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          sectionVisible = true;
          loadAll();
          observer.disconnect();
        }
      });
    }, { rootMargin: "200px" });
    observer.observe(sectionEl);
  } else {
    sectionVisible = true;
  }

  windowEl.style.setProperty("--ov-n", openCount());
  setState("idle");
})();
