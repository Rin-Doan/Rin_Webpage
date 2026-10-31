(function () {
  "use strict";

  // ======================================================================
  // Shared easing / tween helpers, used by the hero and Problem-stage
  // animations below.
  // ======================================================================
  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp01(n) { return Math.max(0, Math.min(1, n)); }
  function easeOutQuad(t) { return 1 - (1 - t) * (1 - t); }
  function easeInOutQuad(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

  // ======================================================================
  // Case viewer: fetches the manifest + per-case JSON and renders every
  // Plotly view (CT scan, segmentation mask, per-vertebra classification,
  // burst-fracture). This logic is
  // unchanged from the original single-page demo -- only the surrounding
  // chrome (sidebar -> topbar case switcher, case-panel -> stage sections)
  // is new.
  // ======================================================================

  var caseSwitchEl = document.getElementById("case-switch");
  var caseLabelEl = document.getElementById("case-label-text");

  var ctPlotEl = document.getElementById("ct-plot");
  var segMaskPlotEl = document.getElementById("seg-mask-plot");

  var CLS_VERTEBRA_SLOTS = 7;
  var clsVertCellEls = [];
  var clsVertLabelEls = [];
  for (var clsI = 0; clsI < CLS_VERTEBRA_SLOTS; clsI++) {
    clsVertCellEls.push(document.getElementById("cls-vert-cell-" + clsI));
    clsVertLabelEls.push(document.getElementById("cls-vert-label-" + clsI));
  }
  var clsMaskPlotEl = document.getElementById("cls-mask-plot");
  var clsNoMaskHintEl = document.getElementById("cls-no-mask-hint");
  var clsGridEl = document.getElementById("cls-vertebra-grid");

  var burstDualWindowEl = document.getElementById("burst-dual-window");
  var burstNoFractureHintEl = document.getElementById("burst-no-fracture-hint");
  var burstLevelSelectEl = document.getElementById("burst-level-select");
  var burstPlotEl = document.getElementById("burst-3d-plot");
  var burstCcpImageEl = document.getElementById("burst-ccp-image");

  var manifest = null;
  var activeCaseId = null;
  var cache = {};        // case_id -> fetched JSON payload, once loaded
  var requestToken = 0;  // guards against a slow, stale fetch overwriting a newer click

  function fetchJSON(url) {
    // "no-store" rather than the default caching: these per-case JSON
    // files (and the manifest) carry no version query string the way
    // assets/style.css and assets/app.js now do, so without this the
    // browser's own HTTP cache can keep serving an old case file -- with
    // a stale colour, opacity, or mesh -- even after the page itself has
    // reloaded fresh. This forces every load to actually re-fetch.
    return fetch(url, { cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error("Failed to load " + url + " (" + res.status + ")");
      return res.json();
    });
  }

  // plotGlPixelRatio: render the WebGL scene at a capped pixel ratio (see
  // gl-helpers.js) rather than Plotly's default of 2 on every screen.
  function plotConfig(extra) {
    var config = { displaylogo: false, responsive: true, displayModeBar: false,
      plotGlPixelRatio: window.__a2i2Gl ? window.__a2i2Gl.pixelRatio() : 2 };
    return Object.assign(config, extra || {});
  }

  // ---- CT scan section: a Plotly binary mask view -- every vertebra mesh
  //      recoloured to one flat colour (BINARY_MASK_COLOR) rather than its
  //      own SEG_COLORS shade, so this reads as "bone present here or
  //      not", not a per-level classification. -------------------------- //
  var BINARY_MASK_COLOR = "#cfc8bb";

  function binaryMaskTrace(mesh) {
    return Object.assign({}, mesh, { color: BINARY_MASK_COLOR });
  }

  function renderCtPlot(data) {
    if (!data.has_mask) return;
    var binaryMeshes = data.mask_meshes.map(binaryMaskTrace);
    Plotly.react(ctPlotEl, binaryMeshes, scanSceneLayout(), SCAN_PLOT_CONFIG);
  }

  function maskSceneLayout() {
    return {
      paper_bgcolor: "#f0f3f6", plot_bgcolor: "#f0f3f6",
      margin: { l: 0, r: 0, t: 10, b: 0 }, showlegend: false,
      scene: {
        aspectmode: "data", bgcolor: "#f0f3f6",
        xaxis: { visible: false },
        yaxis: { visible: false },
        zaxis: { visible: false },
        camera: { eye: { x: 1.4, y: 1.1, z: 1.3 }, up: { x: 0, y: 0, z: 1 } },
      },
    };
  }

  // The Segmentation section's binary/instance plots sit in a row with
  // Niivue windows, so they share their background and have every
  // interaction turned off -- the camera is driven by scan-viewers.js's
  // turntable instead of the mouse.
  var SCAN_PLOT_BG = "#f0f3f6"; // matches the CSS --scan-bg
  var SCAN_PLOT_CONFIG = plotConfig({ scrollZoom: false, doubleClick: false, responsive: false });

  // The animated 3D plots (Segmentation's two, Classification's eight) are
  // drawn at a fixed pixel size -- at least as big as the largest frame they
  // ever sit in -- and centred in that frame, which clips them (style.css).
  // Their windows widen and narrow as columns open and close; a fixed size
  // means a plot never has to be resized, which for a Plotly 3D scene means
  // re-laying it out and re-uploading its whole mesh: doing that during a
  // reveal froze the page for about half a second. The camera zooms to fit
  // whatever the frame shows instead (scan-viewers.js).
  var FIXED_PLOT_SIZE = {
    seg: { width: 360, height: 440 },       // Segmentation columns: at most 360 x 440
    clsRight: { width: 500, height: 472 },  // Classification's right-hand window, either layout
  };
  var FIXED_PLOT_CONFIG_EXTRA = { responsive: false };

  function fixedSize(layout, size) {
    layout.autosize = false;
    layout.width = size.width;
    layout.height = size.height;
    return layout;
  }

  function scanSceneLayout() {
    var layout = fixedSize(maskSceneLayout(), FIXED_PLOT_SIZE.seg);
    layout.paper_bgcolor = layout.plot_bgcolor = layout.scene.bgcolor = SCAN_PLOT_BG;
    layout.margin = { l: 0, r: 0, t: 0, b: 0 };
    layout.hovermode = false;
    layout.dragmode = false;
    layout.scene.dragmode = false;
    layout.scene.hovermode = false;
    return layout;
  }

  function renderMaskPlot(data) {
    if (!data.has_mask) return;
    Plotly.react(segMaskPlotEl, data.mask_meshes, scanSceneLayout(), SCAN_PLOT_CONFIG);
  }

  function smallVertebraSceneLayout() {
    return {
      paper_bgcolor: "#f0f3f6", plot_bgcolor: "#f0f3f6",
      margin: { l: 0, r: 0, t: 0, b: 0 }, showlegend: false,
      scene: {
        aspectmode: "data", bgcolor: "#f0f3f6",
        xaxis: { visible: false }, yaxis: { visible: false }, zaxis: { visible: false },
        camera: { eye: { x: 1.4, y: 1.1, z: 1.3 }, up: { x: 0, y: 0, z: 1 } },
      },
    };
  }

  var FRACTURE_HIGHLIGHT_COLOR = "#C0392B";
  var GROUND_TRUTH_NEUTRAL_COLOR = "#cfc8bb";

  function groundTruthTrace(mesh, fracturedLabels) {
    var isFractured = !!fracturedLabels && fracturedLabels.indexOf(mesh.label) !== -1;
    return Object.assign({}, mesh, {
      color: isFractured ? FRACTURE_HIGHLIGHT_COLOR : GROUND_TRUTH_NEUTRAL_COLOR,
    });
  }

  function renderClassificationSection(data) {
    var hasVertebrae = !!data.has_mask && data.mask_meshes && data.mask_meshes.length > 0;
    clsGridEl.hidden = !hasVertebrae;
    clsNoMaskHintEl.hidden = hasVertebrae;

    // The per-level mask itself is no longer drawn here: it's a
    // pre-rendered turntable sprite now (cls-demo.js's loadSprites,
    // scripts/render_turntable_sprites.mjs), the same as the per-level CT
    // beside it, so this just names and shows/hides each cell.
    for (var i = 0; i < CLS_VERTEBRA_SLOTS; i++) {
      var mesh = hasVertebrae ? data.mask_meshes[i] : null;
      if (mesh) {
        clsVertCellEls[i].hidden = false;
        clsVertLabelEls[i].textContent = mesh.name || ("Vertebra " + (i + 1));
      } else {
        clsVertCellEls[i].hidden = true;
      }
    }

    if (hasVertebrae) {
      var groundTruthMeshes = data.mask_meshes.map(function (m) {
        return groundTruthTrace(m, data.fractured_labels);
      });
      Plotly.react(clsMaskPlotEl, groundTruthMeshes, fixedSize(maskSceneLayout(), FIXED_PLOT_SIZE.clsRight), plotConfig(FIXED_PLOT_CONFIG_EXTRA));
    }
  }

  function vertebraLevelName(label) {
    return "C" + label;
  }

  function meshByLabel(data, label) {
    if (!data.mask_meshes) return null;
    for (var i = 0; i < data.mask_meshes.length; i++) {
      if (data.mask_meshes[i].label === label) return data.mask_meshes[i];
    }
    return null;
  }

  function burstCcpImageUrl(caseId, label) {
    return "data/" + caseId + "/burst_fracture/" + vertebraLevelName(label) + ".png";
  }

  // Turns burst-3d-plot the same way the Classification section's ground-
  // truth window (cls-mask-plot) turns -- one shared idle turntable, driven
  // off the shared page clock (scan-viewers.js). burstBox is the extent of
  // just the three vertebrae currently shown, so the zoom fits them instead
  // of the whole spine.
  var burstSpinner = null;
  var burstBox = null;

  function ensureBurstSpinner() {
    if (burstSpinner) return burstSpinner;
    var viewers = window.__a2i2SegViewers;
    if (!viewers || !viewers.makePlotSpinner) return null;
    burstSpinner = viewers.makePlotSpinner(burstPlotEl, function () { return burstBox; });
    return burstSpinner;
  }

  function burstTick(ts) {
    requestAnimationFrame(burstTick);
    if (burstDualWindowEl.hidden) return;
    var viewers = window.__a2i2SegViewers;
    var spinner = ensureBurstSpinner();
    if (!viewers || !spinner) return;
    spinner.frame(ts, viewers.idleAzimuth());
  }
  requestAnimationFrame(burstTick);

  function showBurstLevel(data, label) {
    var traces = [];
    [label - 1, label, label + 1].forEach(function (l) {
      var mesh = meshByLabel(data, l);
      if (!mesh) return;
      traces.push(l === label ? Object.assign({}, mesh, { color: FRACTURE_HIGHLIGHT_COLOR }) : mesh);
    });
    Plotly.react(burstPlotEl, traces, smallVertebraSceneLayout(), plotConfig({ scrollZoom: false, doubleClick: false }));
    burstBox = window.__a2i2ScanScale ? window.__a2i2ScanScale.boxOf(traces) : null;
    burstCcpImageEl.src = burstCcpImageUrl(data.case_id, label);
    burstCcpImageEl.alt = "Burst fracture canal compromise at " + vertebraLevelName(label);
  }

  function renderBurstFractureSection(data) {
    var levels = (data.fractured_labels || []).slice().sort(function (a, b) { return a - b; });
    var hasFractures = !!data.has_mask && levels.length > 0;
    burstDualWindowEl.hidden = !hasFractures;
    burstNoFractureHintEl.hidden = hasFractures;
    if (!hasFractures) return;

    burstLevelSelectEl.innerHTML = "";
    levels.forEach(function (label) {
      var opt = document.createElement("option");
      opt.value = String(label);
      opt.textContent = vertebraLevelName(label);
      burstLevelSelectEl.appendChild(opt);
    });
    burstLevelSelectEl.value = String(levels[0]);
    showBurstLevel(data, levels[0]);
  }

  burstLevelSelectEl.addEventListener("change", function () {
    var data = activeCaseId ? cache[activeCaseId] : null;
    if (data) showBurstLevel(data, Number(burstLevelSelectEl.value));
  });

  // ======================================================================
  // Model overview: a static, four-window summary of the whole pipeline --
  // original CT -> instance segmentation -> fracture vertebra -> triage --
  // sitting before the detailed per-stage sections below it. No run
  // button: every window just shows this case's result and keeps turning,
  // the same resting state the later sections settle into. The triage
  // window reuses the exact composition of the Triage section's own
  // burst-3d-plot (the first flagged level, centred, flanked by its
  // neighbours); the other two reuse the Segmentation/Classification
  // sections' own colourings (instance-segmentation and ground-truth).
  // ======================================================================
  var modelSegPlotEl = document.getElementById("model-seg-plot");
  var modelFracturePlotEl = document.getElementById("model-fracture-plot");
  var modelTriagePlotEl = document.getElementById("model-triage-plot");
  var modelSectionEl = document.getElementById("stage-model");
  var modelTriageBox = null;

  function renderModelPipeline(data) {
    if (!data.has_mask) return;
    var nonInteractiveConfig = plotConfig({ scrollZoom: false, doubleClick: false });

    if (modelSegPlotEl) {
      Plotly.react(modelSegPlotEl, data.mask_meshes, maskSceneLayout(), nonInteractiveConfig);
    }
    if (modelFracturePlotEl) {
      var groundTruthMeshes = data.mask_meshes.map(function (m) {
        return groundTruthTrace(m, data.fractured_labels);
      });
      Plotly.react(modelFracturePlotEl, groundTruthMeshes, maskSceneLayout(), nonInteractiveConfig);
    }
    if (modelTriagePlotEl) {
      var levels = (data.fractured_labels || []).slice().sort(function (a, b) { return a - b; });
      var traces;
      if (levels.length > 0) {
        var label = levels[0];
        traces = [];
        [label - 1, label, label + 1].forEach(function (l) {
          var mesh = meshByLabel(data, l);
          if (!mesh) return;
          traces.push(l === label ? Object.assign({}, mesh, { color: FRACTURE_HIGHLIGHT_COLOR }) : mesh);
        });
      } else {
        // No fracture in this case: show the whole spine instead of an
        // empty window (unlike the Triage section, this one has no hint
        // text slot of its own to swap in).
        traces = data.mask_meshes.map(function (m) { return groundTruthTrace(m, []); });
      }
      Plotly.react(modelTriagePlotEl, traces, smallVertebraSceneLayout(), nonInteractiveConfig);
      modelTriageBox = window.__a2i2ScanScale ? window.__a2i2ScanScale.boxOf(traces) : null;
    }
  }

  // The raw-CT Niivue window (scan-viewers.js's viewers.modelCt) only loads
  // once the section is close to view -- the same lazy pattern
  // seg-overview-demo.js uses for its own Niivue windows.
  var modelPendingCaseId = null;
  var modelSectionVisible = false;

  function loadModelCt() {
    if (!modelSectionVisible || !modelPendingCaseId) return;
    var viewers = window.__a2i2SegViewers;
    var v = viewers && viewers.modelCt;
    if (v) v.loadCase(modelPendingCaseId).catch(function () {});
  }
  window.addEventListener("a2i2:case-changed", function (event) {
    modelPendingCaseId = event.detail && event.detail.caseId;
    loadModelCt();
  });
  if (modelSectionEl && "IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        modelSectionVisible = entry.isIntersecting;
        if (modelSectionVisible) loadModelCt();
      });
    }, { rootMargin: "200px" }).observe(modelSectionEl);
  } else {
    modelSectionVisible = true;
  }

  // Turns the three Plotly windows on the shared page clock, same as every
  // other mesh window on the page; paused while the section is off screen.
  var modelSegSpinner = null;
  var modelFractureSpinner = null;
  var modelTriageSpinner = null;

  function ensureModelSpinners() {
    var viewers = window.__a2i2SegViewers;
    if (!viewers || !viewers.makePlotSpinner) return null;
    if (!modelSegSpinner && modelSegPlotEl) modelSegSpinner = viewers.makePlotSpinner(modelSegPlotEl);
    if (!modelFractureSpinner && modelFracturePlotEl) modelFractureSpinner = viewers.makePlotSpinner(modelFracturePlotEl);
    if (!modelTriageSpinner && modelTriagePlotEl) {
      modelTriageSpinner = viewers.makePlotSpinner(modelTriagePlotEl, function () { return modelTriageBox; });
    }
    return viewers;
  }

  function modelTick(ts) {
    requestAnimationFrame(modelTick);
    if (!modelSectionVisible) return;
    var viewers = ensureModelSpinners();
    if (!viewers) return;
    var idleAzimuth = viewers.idleAzimuth();
    if (modelSegSpinner) modelSegSpinner.frame(ts, idleAzimuth);
    if (modelFractureSpinner) modelFractureSpinner.frame(ts, idleAzimuth);
    if (modelTriageSpinner) modelTriageSpinner.frame(ts, idleAzimuth);
  }
  requestAnimationFrame(modelTick);

  // ---- Selecting a case: fetches that case's data (unless already
  //      cached) and updates the stage sections in place. No navigation,
  //      no case-panel to show/hide any more -- the stage sections are
  //      always part of the page. --------------------------------------- //

  function selectCase(caseId) {
    if (caseId === activeCaseId) return;

    var myToken = ++requestToken;
    activeCaseId = caseId;
    if (caseSwitchEl) caseSwitchEl.value = caseId;

    // Let other, independent scripts on the page (the Segmentation and
    // Classification demos) know the selected case changed, without
    // this file needing to know anything about them.
    window.dispatchEvent(new CustomEvent("a2i2:case-changed", { detail: { caseId: caseId } }));

    var meta = manifest.cases.find(function (c) { return c.case_id === caseId; });
    var idx = manifest.cases.indexOf(meta) + 1;
    var num = String(idx).padStart(2, "0");
    if (caseLabelEl) caseLabelEl.textContent = "Case " + num + " — loading…";

    if (cache[caseId]) {
      applyCaseData(cache[caseId], num);
      return;
    }

    fetchJSON("data/" + caseId + ".json")
      .then(function (data) {
        cache[caseId] = data;
        if (myToken !== requestToken) return; // a newer pick already won
        applyCaseData(data, num);
      })
      .catch(function (err) {
        if (myToken !== requestToken) return;
        if (caseLabelEl) caseLabelEl.textContent = "Case " + num + " — failed to load";
        console.error(err);
      });
  }

  function applyCaseData(data, num) {
    if (caseLabelEl) caseLabelEl.textContent = "Case " + num + " · " + (data.description || data.case_id);
    // Every 3D window in the Segmentation section zooms to this case's
    // spine size (see scan-scale.js), so set it before anything renders.
    if (window.__a2i2ScanScale) window.__a2i2ScanScale.setSpineBox(data.has_mask ? data.mask_meshes : null);
    renderCtPlot(data);
    renderMaskPlot(data);
    renderModelPipeline(data);
    renderClassificationSection(data);
    renderBurstFractureSection(data);
    // For cls-demo.js, which recolours and animates the Classification
    // plots drawn above and needs this case's meshes and fracture labels.
    window.dispatchEvent(new CustomEvent("a2i2:case-data", { detail: { data: data } }));
  }

  if (caseSwitchEl) {
    caseSwitchEl.addEventListener("change", function () {
      selectCase(caseSwitchEl.value);
    });
  }

  // ======================================================================
  // Scroll-stage navigation: five sections (intro, problem, segmentation,
  // classification, triage); the topbar fades in and highlights the
  // current part once the page has scrolled past the hero.
  // ======================================================================

  var stageEls = Array.prototype.slice.call(document.querySelectorAll(".stage"));
  var topbarEl = document.querySelector(".topbar");
  var topbarPartEls = Array.prototype.slice.call(document.querySelectorAll(".topbar-part-link"));

  // The page is split into two parts -- Overview (intro/problem/solution) and
  // Models (segmentation/classification/triage) -- each stage belongs to one,
  // and the topbar's Overview/Models switcher highlights whichever part is
  // currently in view.
  var STAGE_PART = {
    "stage-intro": "overview",
    "stage-problem": "overview",
    "stage-solution": "overview",
    "stage-model": "models",
    "stage-segmentation": "models",
    "stage-classification": "models",
    "stage-triage": "models"
  };

  document.querySelectorAll("[data-stage-target]").forEach(function (el) {
    el.addEventListener("click", function () {
      var targetId = el.getAttribute("data-stage-target");
      var target = document.getElementById(targetId);
      if (target) target.scrollIntoView({ behavior: "smooth" });
    });
  });

  function updateActiveStageFromScroll() {
    var viewportCenter = window.innerHeight / 2;
    var current = stageEls[0];
    var bestDistance = Infinity;
    stageEls.forEach(function (stage) {
      var rect = stage.getBoundingClientRect();
      var stageCenter = rect.top + rect.height / 2;
      var distance = Math.abs(stageCenter - viewportCenter);
      if (distance < bestDistance) {
        bestDistance = distance;
        current = stage;
      }
    });
    var currentId = current.id;
    var currentPart = STAGE_PART[currentId];
    topbarPartEls.forEach(function (link) {
      link.classList.toggle("active", link.getAttribute("data-part") === currentPart);
    });
    if (topbarEl) {
      topbarEl.classList.toggle("is-visible", currentId !== "stage-intro" || window.scrollY > window.innerHeight * 0.6);
    }
  }

  // ======================================================================
  // Hero: a collage of five clinical photographs replaces the old
  // CT-scanner illustration. Four of the five are buttons wired to a
  // stage (generically, via the [data-stage-target] listener above); as
  // the hero scrolls past, the whole collage rises as one group (each
  // window's --scroll-rise, see style.css) while the picture inside each
  // window also drifts upward at its own depth (its data-depth attribute,
  // a touch more for the nearer-feeling ones), and the title block rises
  // and fades slightly with it -- the same "track scroll distance
  // directly, no pinned runway" approach the old patient illustration
  // used, so scrolling back up undoes all of it for free: p is recomputed
  // from the live scroll position every frame, not played once.
  // ======================================================================

  var heroPinEl = document.querySelector(".hero-pin");
  var heroPhotoEls = Array.prototype.slice.call(document.querySelectorAll(".hero-photo"));
  var heroParallaxEls = Array.prototype.slice.call(document.querySelectorAll(".hero-photo-parallax"));
  var heroSlotEls = Array.prototype.slice.call(document.querySelectorAll(".hero-photo-slot"));
  var heroTextEl = document.querySelector(".hero-text");
  var heroScrollCueEl = document.querySelector(".stage-intro .scroll-cue");
  var prefersReducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Each photo's window (not just the picture inside it) idles on its own
  // slow drift whenever the page is still; the instant the user scrolls,
  // every one of those is paused in place -- so the idle tilt never
  // fights the depth-parallax below -- and they quietly resume a moment
  // after scrolling stops.
  var heroScrollStopTimer = null;
  function markHeroScrolling() {
    if (prefersReducedMotion) return;
    heroPhotoEls.forEach(function (el) { el.style.animationPlayState = "paused"; });
    if (heroScrollStopTimer) clearTimeout(heroScrollStopTimer);
    heroScrollStopTimer = setTimeout(function () {
      heroPhotoEls.forEach(function (el) { el.style.animationPlayState = "running"; });
    }, 220);
  }
  window.addEventListener("scroll", markHeroScrolling, { passive: true });

  var HERO_PARALLAX_RANGE = 110; // px of drift at depth 1 across the full hero scroll
  // The whole collage rises together as the hero scrolls past -- each
  // window's own --scroll-rise custom property (style.css), composed with
  // its static tilt so the two never clobber each other -- almost uniform
  // (HERO_WINDOW_RISE_SPREAD only adds a little per-depth variation) so the
  // five windows read as one group leaving together, the way the title
  // leaves with them. Scrolling back up runs this in reverse for free: p is
  // recomputed from scroll position every frame, never played as a one-shot.
  var HERO_WINDOW_RISE = 120;        // px every window rises by, at full hero scroll
  var HERO_WINDOW_RISE_SPREAD = 50;  // + up to this much more, by depth
  var HERO_TITLE_RISE = 40;          // px the title block rises by, at full hero scroll
  var HERO_TITLE_FADE = 0.6;         // how much the title fades by, at full hero scroll

  // Each photo's window enters on a staggered CSS animation (heroPhotoIn
  // in style.css). While that's live, the browser gives it priority over
  // any `animation`/`transform` set from here -- so once it finishes, we
  // hand the element's `animation` straight to its idle wiggle (heroWiggle,
  // timed per element via its own data-wiggle-duration/-delay) rather than
  // just clearing it, so the window keeps drifting instead of going
  // still. Scroll-depth parallax stays separate, driven on the
  // .hero-photo-parallax child by applyHeroProgress below.
  heroPhotoEls.forEach(function (el) {
    el.addEventListener("animationend", function () {
      el.style.opacity = "1";
      if (prefersReducedMotion) {
        el.style.animation = "none";
        return;
      }
      var duration = el.getAttribute("data-wiggle-duration") || "8s";
      var delay = el.getAttribute("data-wiggle-delay") || "0s";
      el.style.animation = "heroWiggle " + duration + " var(--ease-in-out) " + delay + " infinite";
    }, { once: true });
  });

  function applyHeroProgress(p) {
    if (!prefersReducedMotion) {
      heroParallaxEls.forEach(function (el) {
        var depth = parseFloat(el.getAttribute("data-depth")) || 0;
        el.style.transform = "translateY(" + (-p * depth * HERO_PARALLAX_RANGE).toFixed(1) + "px)";
      });
      heroSlotEls.forEach(function (slot) {
        var parallaxChild = slot.querySelector(".hero-photo-parallax");
        var depth = parallaxChild ? (parseFloat(parallaxChild.getAttribute("data-depth")) || 0) : 0;
        var rise = HERO_WINDOW_RISE + depth * HERO_WINDOW_RISE_SPREAD;
        slot.style.setProperty("--scroll-rise", (-p * rise).toFixed(1) + "px");
      });
      if (heroTextEl) {
        heroTextEl.style.transform = "translateY(" + (-p * HERO_TITLE_RISE).toFixed(1) + "px)";
        heroTextEl.style.opacity = String(1 - p * HERO_TITLE_FADE);
      }
    }
    if (heroScrollCueEl) heroScrollCueEl.style.opacity = String(clamp01(1 - p * 3));
  }

  var heroRAFQueued = false;
  function onScrollOrResize() {
    if (heroRAFQueued) return;
    heroRAFQueued = true;
    requestAnimationFrame(function () {
      heroRAFQueued = false;
      updateActiveStageFromScroll();
      if (heroPinEl) {
        var heroRect = heroPinEl.getBoundingClientRect();
        var heroProgress = heroRect.height > 0 ? (0 - heroRect.top) / heroRect.height : 0;
        applyHeroProgress(clamp01(heroProgress));
      }
    });
  }
  window.addEventListener("scroll", onScrollOrResize, { passive: true });
  window.addEventListener("resize", onScrollOrResize);
  onScrollOrResize();

  // ======================================================================
  // Problem stage: a self-contained "window" that plays a fixed sequence
  // -- six CT scans arrive scattered, assemble into a row one at a time
  // (left-to-right arrival filling the row from the right), then stack up
  // in that same order (not by severity), then are handed to the
  // radiologist. Loops on repeat once scrolled into view; replayable from
  // its footer button.
  // ======================================================================

  var problemScanEls = Array.prototype.slice.call(document.querySelectorAll(".problem-scan"));
  var problemDoctorEl = document.getElementById("problem-doctor");
  var problemCaptionEl = document.getElementById("problem-caption");
  var problemReplayBtn = document.getElementById("problem-replay-btn");
  var problemWindowEl = document.querySelector(".problem-window");
  var problemScannerEl = document.getElementById("problem-scanner");
  var problemScannerPatientEl = document.getElementById("problem-scanner-patient");
  var problemScannerSharpFadeEl = document.getElementById("problem-scanner-sharp-fade");
  var problemScannerBlurBandFadeEl = document.getElementById("problem-scanner-blur-band-fade");

  // ---- Opening beat (every loop): the patient is pushed into the
  //      scanner -- the same hero illustration and mask-dissolve, reused
  //      at a smaller size inside this window. As the slide finishes, the
  //      whole illustration (patient, machine and doctor alike) blurs
  //      out as one, covering a cut to the returned scan, which pops out
  //      oversized, holds there a moment, then slowly shrinks back down
  //      into its normal spot at the far right of the scatter (the last
  //      card, the one that already sits furthest right once scattered).
  //      After that the scatter/row/stack/handoff sequence below runs
  //      exactly as it did before this intro was added, just shifted
  //      later. -----
  var SCANNER_PHASE = [0, 2000];    // patient slides into the scanner
  var BLUR_PHASE = [1500, 2000];    // near the end of the slide, everything blurs out together
  var REVEAL_PHASE = [2000, 3400];  // the returned scan pops out of the blur and zooms in (slow, 1400ms)
  var HOLD_PHASE = [3400, 3900];    // it holds at that oversized reveal for a beat
  var SHRINK_PHASE = [3900, 5100];  // then zooms back down to its regular scatter size/position (1200ms)
  var PROBLEM_INTRO_OFFSET = SHRINK_PHASE[1];

  var SCANNER_PATIENT_TRAVEL_X = 100;
  var SCANNER_FADE_DELAY = 0.5;
  var SCANNER_FADE_START_X = 950;
  var SCANNER_FADE_END_X = 430;
  // The body disappears outright once it crosses this threshold line (it
  // sweeps from SCANNER_FADE_START_X down to SCANNER_FADE_END_X as the
  // patient enters), but not with a hard pixel edge: a narrow band just
  // ahead of it -- BAND_WIDTH wide -- shows a blurred copy instead, so
  // that sliver goes soft-focus for a moment before it's gone. FEATHER is
  // just a tiny antialiasing overlap between the sharp/blurred/gone
  // zones, not a visible design width.
  var SCANNER_BAND_WIDTH = 6;
  var SCANNER_EDGE_FEATHER = 0.75;
  var SCANNER_BLUR_MAX = 14; // px of CSS blur, at full strength, over the whole mini-scanner illustration

  // Approximate canvas-% position of the scanner's tunnel mouth, where the
  // emerging scan starts its flight from (the mini scanner SVG is centred
  // in the canvas at 62% width, viewBox 750x500).
  var SCANNER_EXIT_X = 59;
  var SCANNER_EXIT_Y = 45;
  var EMERGE_CARD_INDEX = 5;  // the card that already sits furthest right once scattered
  var SCANNER_REVEAL_SCALE = 2.3; // how large the returned scan gets at the peak of its reveal

  function applyScannerIntro(ms) {
    var scannerT = clamp01(ms / SCANNER_PHASE[1]);

    if (problemScannerPatientEl) {
      problemScannerPatientEl.setAttribute("transform", "translate(" + (SCANNER_PATIENT_TRAVEL_X * scannerT) + ",0)");
      var fadeT = clamp01((scannerT - SCANNER_FADE_DELAY) / (1 - SCANNER_FADE_DELAY));
      var threshold = lerp(SCANNER_FADE_START_X, SCANNER_FADE_END_X, fadeT);
      var bandStart = threshold - SCANNER_BAND_WIDTH;
      if (problemScannerSharpFadeEl) {
        problemScannerSharpFadeEl.setAttribute("x1", String(bandStart - SCANNER_EDGE_FEATHER));
        problemScannerSharpFadeEl.setAttribute("x2", String(bandStart));
      }
      if (problemScannerBlurBandFadeEl) {
        problemScannerBlurBandFadeEl.setAttribute("x1", String(bandStart - SCANNER_EDGE_FEATHER));
        problemScannerBlurBandFadeEl.setAttribute("x2", String(threshold + SCANNER_EDGE_FEATHER));
      }
    }

    // Whole-scene blur: patient, scanner machine and doctor all live in
    // the one illustration (#problem-scanner), so a single CSS blur on
    // that container softens all three together as the slide wraps up,
    // standing in for a cut to the reveal below rather than jumping to
    // it outright.
    var blurT = clamp01((ms - BLUR_PHASE[0]) / (BLUR_PHASE[1] - BLUR_PHASE[0]));
    var revealT = easeInOutQuad(clamp01((ms - REVEAL_PHASE[0]) / (REVEAL_PHASE[1] - REVEAL_PHASE[0])));
    var shrinkT = easeInOutQuad(clamp01((ms - SHRINK_PHASE[0]) / (SHRINK_PHASE[1] - SHRINK_PHASE[0])));

    if (problemScannerEl) {
      problemScannerEl.style.filter = prefersReducedMotion ? "none" : "blur(" + (SCANNER_BLUR_MAX * blurT).toFixed(1) + "px)";
      // The blurred scanner scene stays put as the backdrop through the
      // whole reveal + hold -- it's only once the scan starts shrinking
      // away that the background crossfades over to the other scans.
      var scannerVisible = ms < SHRINK_PHASE[1];
      problemScannerEl.style.opacity = scannerVisible ? String(clamp01(1 - shrinkT * 1.4)) : "0";
    }

    problemScanEls.forEach(function (el, i) {
      if (i === EMERGE_CARD_INDEX) {
        // The returned scan: invisible through the blur, then pops out
        // oversized at the tunnel mouth (a deliberate, slow "here's the
        // result" zoom-in), holds there, then slowly shrinks back down
        // to its normal card size while travelling out to its scatter
        // slot, landing exactly where the ordering sequence expects it.
        var sx = parseFloat(el.getAttribute("data-sx"));
        var sy = parseFloat(el.getAttribute("data-sy"));
        var srot = parseFloat(el.getAttribute("data-srot"));

        var scale, opacity;
        if (shrinkT > 0) {
          scale = lerp(SCANNER_REVEAL_SCALE, 1, shrinkT);
          opacity = 1;
        } else {
          scale = lerp(SCANNER_REVEAL_SCALE * 0.35, SCANNER_REVEAL_SCALE, revealT);
          opacity = revealT;
        }

        el.style.left = lerp(SCANNER_EXIT_X, sx, shrinkT).toFixed(2) + "%";
        el.style.top = lerp(SCANNER_EXIT_Y, sy, shrinkT).toFixed(2) + "%";
        el.style.transform = "rotate(" + (srot * shrinkT).toFixed(1) + "deg) scale(" + scale.toFixed(2) + ")";
        el.style.opacity = String(opacity);
      } else {
        // The other five stay hidden while the scanner scene is still the
        // backdrop (through the reveal + hold), then fade in together as
        // the main scan shrinks away -- the background crossfading from
        // "the scanner" to "the other scans" exactly as it zooms out.
        el.style.opacity = String(shrinkT);
      }
    });

    if (problemCaptionEl) {
      var text = ms < REVEAL_PHASE[0]
        ? "A scan is acquired…"
        : "…and joins the back of the queue.";
      if (problemCaptionEl.textContent !== text) problemCaptionEl.textContent = text;
    }
  }

  // Timeline, in three staggered phases rather than one uniform tween:
  //  1) Row assembly   - cards leave their scattered spots one at a time,
  //     in arrival order (index 0 first). Index 0 ("leftmost" on arrival)
  //     takes the rightmost row slot; each next card takes the slot just
  //     to its left, so the row fills from the right.
  //  2) Stack assembly - cards leave the row one at a time in REVERSE
  //     (rightmost row slot, i.e. index 0, leaves last), so index 0 ends
  //     up on top of the stack - the row's rightmost card on top.
  //  3) Handoff        - the whole stack converges on the doctor together.
  var PROBLEM_CARD_COUNT = 6;
  var PROBLEM_ROW_STAGGER = 220;
  var PROBLEM_ROW_MOVE = 480;
  var PROBLEM_ROW_HOLD = 420;
  var PROBLEM_STACK_STAGGER = 220;
  var PROBLEM_STACK_MOVE = 480;
  var PROBLEM_STACK_HOLD_MS = 500;
  var PROBLEM_HANDOFF_MOVE = 900;
  var PROBLEM_END_HOLD_MS = 1300;

  var PROBLEM_ROW_PHASE_START = 0;
  var PROBLEM_ROW_PHASE_END = PROBLEM_ROW_PHASE_START + (PROBLEM_CARD_COUNT - 1) * PROBLEM_ROW_STAGGER + PROBLEM_ROW_MOVE;
  var PROBLEM_STACK_PHASE_START = PROBLEM_ROW_PHASE_END + PROBLEM_ROW_HOLD;
  var PROBLEM_STACK_PHASE_END = PROBLEM_STACK_PHASE_START + (PROBLEM_CARD_COUNT - 1) * PROBLEM_STACK_STAGGER + PROBLEM_STACK_MOVE;
  var PROBLEM_TO_HANDOFF = [PROBLEM_STACK_PHASE_END + PROBLEM_STACK_HOLD_MS, PROBLEM_STACK_PHASE_END + PROBLEM_STACK_HOLD_MS + PROBLEM_HANDOFF_MOVE];
  var PROBLEM_END_HOLD = [PROBLEM_TO_HANDOFF[1], PROBLEM_TO_HANDOFF[1] + PROBLEM_END_HOLD_MS];
  var PROBLEM_LOOP_PAUSE = 900;
  var PROBLEM_TOTAL_DURATION = PROBLEM_INTRO_OFFSET + PROBLEM_END_HOLD[1];

  var PROBLEM_CAPTIONS = [
    { at: 0, text: "Six scans arrive in no particular order." },
    { at: PROBLEM_STACK_PHASE_START, text: "They're stacked in the order they arrived — not by how severe the injury is." },
    { at: PROBLEM_TO_HANDOFF[0], text: "Only then are they handed to the radiologist, one at a time." },
  ];

  function cardRowT(ms, i) {
    var start = PROBLEM_ROW_PHASE_START + i * PROBLEM_ROW_STAGGER;
    return easeInOutQuad(clamp01((ms - start) / PROBLEM_ROW_MOVE));
  }
  function cardStackT(ms, i) {
    var start = PROBLEM_STACK_PHASE_START + (PROBLEM_CARD_COUNT - 1 - i) * PROBLEM_STACK_STAGGER;
    return easeInOutQuad(clamp01((ms - start) / PROBLEM_STACK_MOVE));
  }
  function segmentT(ms, range) {
    return easeInOutQuad(clamp01((ms - range[0]) / (range[1] - range[0])));
  }

  function applyProblemMainFrame(ms) {
    var toHandoffT = ms < PROBLEM_TO_HANDOFF[0] ? 0 : segmentT(ms, PROBLEM_TO_HANDOFF);

    problemScanEls.forEach(function (el, i) {
      var sx = parseFloat(el.getAttribute("data-sx"));
      var sy = parseFloat(el.getAttribute("data-sy"));
      var srot = parseFloat(el.getAttribute("data-srot"));
      var rx = parseFloat(el.getAttribute("data-rx"));
      var ry = parseFloat(el.getAttribute("data-ry"));
      var mx = parseFloat(el.getAttribute("data-mx"));
      var my = parseFloat(el.getAttribute("data-my"));
      var ex = parseFloat(el.getAttribute("data-ex"));
      var ey = parseFloat(el.getAttribute("data-ey"));

      var rowT = cardRowT(ms, i);
      var x = lerp(sx, rx, rowT);
      var y = lerp(sy, ry, rowT);
      var rot = lerp(srot, 0, rowT);

      var stackT = cardStackT(ms, i);
      if (stackT > 0) {
        x = lerp(rx, mx, stackT);
        y = lerp(ry, my, stackT);
      }

      var scale = 1;
      var opacity = 1;

      if (toHandoffT > 0) {
        // They end up in a small stack next to the doctor and stay there
        // -- no more fading away once handed off.
        x = lerp(mx, ex, toHandoffT);
        y = lerp(my, ey, toHandoffT);
        scale = lerp(1, 0.55, toHandoffT);
      }

      // Once they've reached the doctor, the two urgent (red) scans get a
      // restless "notice me" motion -- bobbing upward and shaking side to
      // side -- even though they're stuck at the back of the stack. Fades
      // in smoothly as each one finishes arriving.
      if (toHandoffT > 0 && el.querySelector(".problem-scan-tag-red")) {
        var urgency = easeOutQuad(toHandoffT);
        var tShake = ms - PROBLEM_TO_HANDOFF[1];
        y -= 2.4 * urgency * (0.5 + 0.5 * Math.sin(tShake / 210));
        rot += 4 * urgency * Math.sin(tShake / 95);
      }

      el.style.left = x.toFixed(2) + "%";
      el.style.top = y.toFixed(2) + "%";
      el.style.transform = "rotate(" + rot.toFixed(1) + "deg) scale(" + scale.toFixed(2) + ")";
      el.style.opacity = String(opacity);
    });

    if (problemDoctorEl) {
      // Right-anchored in CSS now (not centred), so the transform only
      // needs the entrance lift/scale -- no more translateX(-50%).
      var entrance = easeOutQuad(toHandoffT);
      problemDoctorEl.style.opacity = String(entrance);
      problemDoctorEl.style.transform = "translateY(" + lerp(16, 0, entrance) + "px) scale(" + lerp(0.92, 1, entrance).toFixed(3) + ")";
    }

    if (problemCaptionEl) {
      var text = PROBLEM_CAPTIONS[0].text;
      for (var ci = 0; ci < PROBLEM_CAPTIONS.length; ci++) {
        if (ms >= PROBLEM_CAPTIONS[ci].at) text = PROBLEM_CAPTIONS[ci].text;
      }
      if (problemCaptionEl.textContent !== text) problemCaptionEl.textContent = text;
    }
  }

  function applyProblemFrame(ms) {
    if (ms < PROBLEM_INTRO_OFFSET) {
      // Main frame first, at its rest (scatter) state, then the intro
      // overrides card position/opacity on top of it -- applying these in
      // the other order would let the main frame's full-opacity scatter
      // state clobber the emerge animation.
      applyProblemMainFrame(0);
      applyScannerIntro(ms);
    } else {
      if (problemScannerEl) problemScannerEl.style.opacity = "0";
      applyProblemMainFrame(ms - PROBLEM_INTRO_OFFSET);
    }
  }
  applyProblemFrame(0);

  var problemRAF = null;
  var problemLoopTimer = null;
  function stopProblemSequence() {
    if (problemRAF) { cancelAnimationFrame(problemRAF); problemRAF = null; }
    if (problemLoopTimer) { clearTimeout(problemLoopTimer); problemLoopTimer = null; }
  }
  function playProblemSequence() {
    stopProblemSequence();
    var startTime = null;
    function frame(now) {
      if (startTime === null) startTime = now;
      var ms = now - startTime;
      applyProblemFrame(Math.min(ms, PROBLEM_TOTAL_DURATION));
      if (ms < PROBLEM_TOTAL_DURATION) {
        problemRAF = requestAnimationFrame(frame);
      } else {
        problemRAF = null;
        problemLoopTimer = setTimeout(playProblemSequence, PROBLEM_LOOP_PAUSE);
      }
    }
    problemRAF = requestAnimationFrame(frame);
  }

  if (problemReplayBtn) {
    problemReplayBtn.addEventListener("click", playProblemSequence);
  }

  if (problemWindowEl && "IntersectionObserver" in window) {
    var problemObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          playProblemSequence();
          problemObserver.disconnect();
        }
      });
    }, { threshold: 0.4 });
    problemObserver.observe(problemWindowEl);
  }

  // ======================================================================
  // Boot: fetch the (tiny) manifest, then load case 05 straight away.
  // The case switcher UI is disabled for now (see index.html), so the
  // dropdown-population step below is commented out and a fixed case
  // index is used instead of always picking manifest.cases[0].
  // ======================================================================

  var DEFAULT_CASE_INDEX = 4; // Case 05

  fetchJSON("data/manifest.json").then(function (data) {
    manifest = data;
    // if (caseSwitchEl) {
    //   caseSwitchEl.innerHTML = "";
    //   manifest.cases.forEach(function (c, idx) {
    //     var opt = document.createElement("option");
    //     opt.value = c.case_id;
    //     opt.textContent = "Case " + String(idx + 1).padStart(2, "0");
    //     caseSwitchEl.appendChild(opt);
    //   });
    // }
    if (manifest.cases.length > 0) {
      var defaultCase = manifest.cases[DEFAULT_CASE_INDEX] || manifest.cases[0];
      selectCase(defaultCase.case_id);
    }
  }).catch(function (err) {
    if (caseLabelEl) caseLabelEl.textContent = "Could not load case list: " + err.message;
  });

  // ======================================================================
  // Solution stage: AI appears -> scans arrive -> AI checks -> AI sorts the
  // scans into one row (green..yellow..red, red furthest right), with the
  // Brain/Charts/Character groups animating energetically throughout the
  // sort -> zoom out (AI shrinks to the left and stays there; doctor fades
  // in on the right -- the row itself does NOT move or re-pack here) ->
  // scans fly straight from their row slot to the doctor, most severe
  // first, landing on the same row the Problem stage hands its scans off
  // to. Pure CSS-transition driven: each phase just mutates classes/inline
  // left-top-transform and lets the .solution-* transition rules in
  // style.css animate between states.
  // ======================================================================

  var solutionCanvasEl = document.getElementById("solution-canvas");
  var solutionAiEl = document.getElementById("solution-ai");
  var solutionDoctorEl = document.getElementById("solution-doctor");
  var solutionCaptionEl = document.getElementById("solution-caption");
  var solutionReplayBtn = document.getElementById("solution-replay-btn");
  var solutionWindowEl = solutionCanvasEl ? solutionCanvasEl.closest(".solution-window") : null;
  var solutionScanEls = solutionCanvasEl
    ? Array.prototype.slice.call(solutionCanvasEl.querySelectorAll(".solution-scan"))
    : [];
  // Severity priority order: all reds, then all yellows, then all greens --
  // used to stagger both the sort-into-row and the hand-off-to-doctor beats.
  var SEVERITY_ORDER = { red: 0, yellow: 1, green: 2 };
  var solutionScanOrder = solutionScanEls.slice().sort(function (a, b) {
    return SEVERITY_ORDER[a.getAttribute("data-severity")] - SEVERITY_ORDER[b.getAttribute("data-severity")];
  });

  var SOLUTION_CAPTIONS = {
    start: "The AI model is coming online.",
    arriving: "Six scans arrive from the scanner.",
    checking: "AI verifies image quality on every scan.",
    sorting: "AI ranks severity — red, then yellow, then green.",
    queued: "Queued by severity — most urgent on the right.",
    zooming: "Zooming out — the doctor is ready.",
    sending: "Sending prioritized cases to the doctor, most severe first.",
    done: "Doctor receives every case already in the right order.",
  };

  function setSolutionScanStyle(el, leftPct, topPct, rotDeg, scale, opacity) {
    el.style.left = leftPct + "%";
    el.style.top = topPct + "%";
    el.style.transform = "rotate(" + rotDeg + "deg) scale(" + scale + ")";
    if (opacity !== undefined) el.style.opacity = String(opacity);
  }

  function solutionResetScans() {
    if (solutionAiEl) solutionAiEl.classList.add("no-anim");
    if (solutionDoctorEl) solutionDoctorEl.classList.add("no-anim");
    solutionScanEls.forEach(function (el, idx) {
      el.classList.add("no-anim");
      el.classList.remove("is-noticed");
      setSolutionScanStyle(
        el,
        parseFloat(el.getAttribute("data-sx")),
        parseFloat(el.getAttribute("data-sy")),
        parseFloat(el.getAttribute("data-srot")),
        1,
        0
      );
      el.style.zIndex = 10 + idx;
    });
    // force reflow so the "no-anim" jump is applied before we re-enable
    // transitions on the next tick.
    if (solutionCanvasEl) void solutionCanvasEl.offsetWidth;
    requestAnimationFrame(function () {
      solutionScanEls.forEach(function (el) { el.classList.remove("no-anim"); });
      if (solutionAiEl) solutionAiEl.classList.remove("no-anim");
      if (solutionDoctorEl) solutionDoctorEl.classList.remove("no-anim");
    });
  }

  var solutionTimers = [];
  function solutionAfter(ms, fn) {
    solutionTimers.push(setTimeout(fn, ms));
  }
  function stopSolutionSequence() {
    solutionTimers.forEach(function (id) { clearTimeout(id); });
    solutionTimers = [];
  }

  function setSolutionCaption(text) {
    if (solutionCaptionEl && solutionCaptionEl.textContent !== text) {
      solutionCaptionEl.textContent = text;
    }
  }

  function playSolutionSequence() {
    stopSolutionSequence();
    if (!solutionCanvasEl || !solutionAiEl) return;

    solutionCanvasEl.classList.remove("is-checking", "is-zoomed");
    solutionAiEl.classList.remove("is-visible", "is-active");
    solutionResetScans();
    setSolutionCaption(SOLUTION_CAPTIONS.start);

    // -- AI appears (~1s), idle brain/chart float starts automatically --
    solutionAfter(80, function () {
      solutionAiEl.classList.add("is-visible");
    });

    // -- Scans arrive, kept clear of the AI's bounding box and the edges -
    var SCANS_IN = 1000;
    solutionAfter(SCANS_IN, function () {
      setSolutionCaption(SOLUTION_CAPTIONS.arriving);
      solutionScanEls.forEach(function (el) {
        setSolutionScanStyle(
          el,
          parseFloat(el.getAttribute("data-sx")),
          parseFloat(el.getAttribute("data-sy")),
          parseFloat(el.getAttribute("data-srot")),
          1,
          1
        );
      });
    });

    // -- AI check ---------------------------------------------------------
    var CHECK_START = SCANS_IN + 700;
    solutionAfter(CHECK_START, function () {
      solutionCanvasEl.classList.add("is-checking");
      setSolutionCaption(SOLUTION_CAPTIONS.checking);
    });
    var CHECK_END = CHECK_START + 1400;
    solutionAfter(CHECK_END, function () {
      solutionCanvasEl.classList.remove("is-checking");
      setSolutionCaption(SOLUTION_CAPTIONS.sorting);
    });

    // -- AI sorts into one row: green..yellow..red, red furthest right --
    // (kept left of x=57% so it never sits under the doctor's reveal spot)
    var SORT_START = CHECK_END + 100;
    var SORT_STAGGER = 320;
    solutionAfter(SORT_START, function () {
      solutionAiEl.classList.add("is-active");
    });
    solutionScanOrder.forEach(function (el, i) {
      solutionAfter(SORT_START + i * SORT_STAGGER, function () {
        setSolutionScanStyle(
          el,
          parseFloat(el.getAttribute("data-px")),
          parseFloat(el.getAttribute("data-py")),
          0,
          1,
          1
        );
      });
    });
    var sortEnd = SORT_START + (solutionScanOrder.length - 1) * SORT_STAGGER + 600;
    solutionAfter(sortEnd, function () {
      setSolutionCaption(SOLUTION_CAPTIONS.queued);
    });

    // -- Zoom out: AI shrinks to the left, doctor appears, and the scan
    // row moves over to the left with it (same alignment/order, just
    // re-centred within the left half of the window) and scales down
    // to match -- a single, cohesive "zoom out", not a re-order.
    var ZOOM_START = sortEnd + 700;
    var ZOOM_SCALE = 0.6;
    solutionAfter(ZOOM_START, function () {
      solutionAiEl.classList.remove("is-active");
      solutionCanvasEl.classList.add("is-zoomed");
      setSolutionCaption(SOLUTION_CAPTIONS.zooming);
      solutionScanEls.forEach(function (el) {
        setSolutionScanStyle(
          el,
          parseFloat(el.getAttribute("data-zx")),
          parseFloat(el.getAttribute("data-zy")),
          0,
          ZOOM_SCALE,
          1
        );
      });
    });

    // -- Hand-off: scans fly straight from the row to the doctor ---------
    // (uses the same (x, 58) row the Problem stage hands its scans off to)
    // Order AND destination both follow current row position: whichever
    // scan sits furthest to the right goes first, and lands at the
    // furthest-right slot on the doctor's side -- so the left-to-right
    // order of the final pile matches the left-to-right order of the row,
    // regardless of severity colour.
    var solutionHandoffOrder = solutionScanEls.slice().sort(function (a, b) {
      return parseFloat(b.getAttribute("data-zx")) - parseFloat(a.getAttribute("data-zx"));
    });
    var HANDOFF_XS = [45, 40, 35, 30, 25, 20];
    var HANDOFF_Y = 58;
    var HANDOFF_START = ZOOM_START + 1100;
    var HANDOFF_STAGGER = 300;
    solutionAfter(HANDOFF_START, function () {
      setSolutionCaption(SOLUTION_CAPTIONS.sending);
    });
    solutionHandoffOrder.forEach(function (el, i) {
      var hx = HANDOFF_XS[i] !== undefined ? HANDOFF_XS[i] : parseFloat(el.getAttribute("data-hx"));
      var hy = HANDOFF_Y;
      solutionAfter(HANDOFF_START + i * HANDOFF_STAGGER, function () {
        setSolutionScanStyle(el, hx, hy, 0, 0.45, 1);
      });
    });
    var handoffEnd = HANDOFF_START + (solutionHandoffOrder.length - 1) * HANDOFF_STAGGER + 600;
    solutionAfter(handoffEnd, function () {
      setSolutionCaption(SOLUTION_CAPTIONS.done);
    });

    // -- Once everyone has arrived, call out each severity in turn: the
    // two reds bob/wiggle then settle back to their resting spot, then
    // the two yellows do the same, then the two greens.
    var NOTICE_DURATION = 1100;
    var NOTICE_GAP = 500;
    var NOTICE_START = handoffEnd + 500;
    function noticeGroup(color, startDelay) {
      solutionAfter(startDelay, function () {
        solutionScanEls.forEach(function (el) {
          if (el.getAttribute("data-severity") === color) el.classList.add("is-noticed");
        });
      });
      solutionAfter(startDelay + NOTICE_DURATION, function () {
        solutionScanEls.forEach(function (el) {
          if (el.getAttribute("data-severity") === color) el.classList.remove("is-noticed");
        });
      });
    }
    noticeGroup("red", NOTICE_START);
    noticeGroup("yellow", NOTICE_START + (NOTICE_DURATION + NOTICE_GAP));
    noticeGroup("green", NOTICE_START + 2 * (NOTICE_DURATION + NOTICE_GAP));
    var noticeEnd = NOTICE_START + 3 * (NOTICE_DURATION + NOTICE_GAP);

    // -- Hold, then loop --------------------------------------------------
    var LOOP_PAUSE = 1600;
    solutionAfter(noticeEnd + LOOP_PAUSE, function () {
      playSolutionSequence();
    });
  }

  if (solutionReplayBtn) solutionReplayBtn.addEventListener("click", playSolutionSequence);

  if (solutionWindowEl && "IntersectionObserver" in window) {
    var solutionObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          playSolutionSequence();
          solutionObserver.disconnect();
        }
      });
    }, { threshold: 0.4 });
    solutionObserver.observe(solutionWindowEl);
  } else if (solutionCanvasEl) {
    solutionResetScans();
  }

})();
