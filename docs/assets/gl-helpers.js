// ============================================================================
// Shared helpers for the page's 3D windows (Niivue scans and Plotly meshes).
//
//   track(getEl)   -- returns { shown }, kept up to date with whether getEl()'s
//                     element is on screen (its section is in or near the
//                     viewport) and not inside a hidden tab panel. Turntables
//                     skip redrawing while it's false, so a window no one can
//                     see costs nothing per frame.
//   loadVolume(nv, url)
//                  -- puts the scan at url into Niivue viewer nv, replacing
//                     whatever it showed. Each file is downloaded and decoded
//                     once and shared: several windows show the same scan
//                     (the Preprocess pair and Identify's full view all use
//                     niivue.nii.gz; four windows use spine-region.nii.gz),
//                     and each gets its own copy of the decoded voxels rather
//                     than decompressing the file again.
//   pixelRatio()   -- the device pixel ratio capped at MAX_PIXEL_RATIO, for
//                     Niivue's and Plotly's WebGL canvases.
// ============================================================================

(function () {
  // How far beyond the viewport a section still counts as on screen, as a
  // fraction of the viewport height.
  var MARGIN = 0.25;
  var POLL_MS = 500;
  // 3D views render at most at this pixel ratio. On a 2x (Retina) screen a
  // full-ratio window draws four times the pixels of a 1x one -- costly for
  // ray-cast volumes redrawn every frame -- for detail that's barely
  // visible on a rotating scan.
  var MAX_PIXEL_RATIO = 1.5;
  var VOLUME_CACHE_SIZE = 3;
  var NIIVUE_MODULE_URL = "https://cdn.jsdelivr.net/npm/@niivue/niivue@0.69.0/+esm";

  // ---- On-screen tracking ------------------------------------------------ //
  var tracked = [];

  function isShown(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest("[hidden]")) return false;
    if (el.offsetParent === null) return false; // display: none somewhere above
    var section = el.closest(".stage") || el;
    var r = section.getBoundingClientRect();
    var margin = window.innerHeight * MARGIN;
    return r.bottom > -margin && r.top < window.innerHeight + margin;
  }

  function check() {
    tracked.forEach(function (t) { t.shown = isShown(t.getEl()); });
  }

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () { scheduled = false; check(); });
  }

  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  setInterval(check, POLL_MS);

  function track(getEl) {
    var t = { getEl: getEl, shown: false };
    tracked.push(t);
    schedule();
    return t;
  }

  function pixelRatio() {
    return Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  }

  // ---- Shared scan volumes ----------------------------------------------- //
  // Most recently used last; only the last few are kept, since a decoded
  // scan holds tens of MB.
  var volumeCache = [];

  function sharedImage(NVImage, url) {
    var hit = null;
    for (var i = 0; i < volumeCache.length; i++) if (volumeCache[i].url === url) hit = volumeCache.splice(i, 1)[0];
    if (!hit) {
      hit = { url: url, promise: NVImage.loadFromUrl({ url: url, colormap: "gray" }) };
      hit.promise.catch(function () {
        volumeCache = volumeCache.filter(function (e) { return e !== hit; }); // let a failed load be retried
      });
    }
    volumeCache.push(hit);
    if (volumeCache.length > VOLUME_CACHE_SIZE) volumeCache.shift();
    return hit.promise;
  }

  function loadVolume(nv, url) {
    return import(NIIVUE_MODULE_URL).then(function (mod) {
      return sharedImage(mod.NVImage, url);
    }).then(function (image) {
      var copy = image.clone();
      copy.colormap = "gray";
      while (nv.volumes.length) nv.removeVolume(nv.volumes[0]);
      nv.addVolume(copy);
    });
  }

  window.__a2i2Gl = {
    track: track,
    loadVolume: loadVolume,
    pixelRatio: pixelRatio,
  };
})();
