// ============================================================================
// One shared physical scale for every 3D window in the Segmentation section,
// so a millimetre of spine is the same number of pixels in a Niivue CT window
// as in a Plotly mask window of the same size.
//
// Left alone, each library frames its own content: Niivue fits the whole
// volume box (spine plus its padding, or step 2's full 256³ crop) to the
// canvas, and Plotly fits the mesh's own extent, so the same spine came out
// at three or four different sizes side by side. Instead, every window now
// asks this file for one target scale, derived from the current case's
// spine (the extent of its vertebra meshes, set by app.js), and zooms to it:
//
//   boxOf(meshes)  -- the extent of a set of meshes; any of the functions
//                     below take one as an optional last argument in place
//                     of the whole spine's.
//   pxPerMm(w, h)  -- target scale for a w x h px window: the spine's height,
//                     and its widest horizontal extent at any turntable angle,
//                     both fit inside SPINE_FILL of the window.
//   niivueVolScale(nv, w, h)
//                  -- the volScaleMultiplier that gives that scale. Niivue's
//                     3D view is orthographic and spans 1.6 * furthestFromPivot
//                     / volScaleMultiplier mm across the window's short side.
//   plotlyEyeDistance(plotEl, phiRad, box, viewEl)
//                  -- the camera distance that gives that scale. Measured
//                     rather than derived from Plotly's internals: two points
//                     1mm apart at the scene centre are projected through the
//                     scene's own camera matrices. Perspective scale at the
//                     centre is inversely proportional to the centre's depth,
//                     and that depth (the projection's w) is the distance the
//                     camera was drawn at, so scale x depth is a constant of
//                     the scene and the window size alone. Solving from that
//                     constant -- not from the distance the caller last asked
//                     for -- matters: Plotly draws a frame or two behind the
//                     camera it's given, and mixing the two made the solve
//                     overshoot back and forth, pulsing the zoom.
//
// Each returns null until a case's meshes have arrived (or the window has no
// size yet), and callers keep their own fixed fallback zoom in that case.
// ============================================================================

(function () {
  var SPINE_FILL = 0.8;

  var box = null; // { center: [x, y, z], height, width } in mesh mm

  // Mesh-space extent of any set of meshes: the whole spine for most
  // windows, a single vertebra for the Classification section's per-level
  // windows (which pass their own box to the functions below).
  function boxOf(meshes) {
    var min = [Infinity, Infinity, Infinity];
    var max = [-Infinity, -Infinity, -Infinity];
    (meshes || []).forEach(function (mesh) {
      [mesh.x, mesh.y, mesh.z].forEach(function (values, axis) {
        if (!values) return;
        for (var i = 0; i < values.length; i++) {
          if (values[i] < min[axis]) min[axis] = values[i];
          if (values[i] > max[axis]) max[axis] = values[i];
        }
      });
    });
    if (!isFinite(min[0]) || !isFinite(min[2])) return null;
    return {
      center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
      height: max[2] - min[2], // z is "up" in the meshes (see _reorder_axes in generate_3d_viz.py)
      width: Math.hypot(max[0] - min[0], max[1] - min[1]),
    };
  }

  function setSpineBox(meshes) { box = boxOf(meshes); }

  function pxPerMm(w, h, b) {
    b = b || box;
    if (!b || !(w > 0) || !(h > 0) || !(b.height > 0) || !(b.width > 0)) return null;
    return SPINE_FILL * Math.min(w / b.width, h / b.height);
  }

  function niivueVolScale(nv, w, h) {
    var target = pxPerMm(w, h);
    if (target === null || !nv || !(nv.furthestFromPivot > 0)) return null;
    return target * 1.6 * nv.furthestFromPivot / Math.min(w, h);
  }

  // Column-major 4x4 (gl-matrix) times [x, y, z, 1].
  function xform(m, v) {
    return [0, 1, 2, 3].map(function (i) {
      return m[i] * v[0] + m[4 + i] * v[1] + m[8 + i] * v[2] + m[12 + i] * v[3];
    });
  }

  function project(cam, v) {
    return xform(cam.projection, xform(cam.view, xform(cam.model, v)));
  }

  // phiRad is the camera's orbit angle at the last rendered frame; the 1mm
  // test vector runs horizontally across the screen at that angle, so the
  // measurement doesn't change as the camera tilts up and down.
  // viewEl (optional): the element whose size the scale should fit --
  // the frame a fixed-size plot sits centred and clipped in. The plot's own
  // width still converts the measurement to pixels, since that's the size
  // it's actually drawn at.
  function plotlyEyeDistance(plotEl, phiRad, b, viewEl) {
    b = b || box;
    var scene = plotEl && plotEl._fullLayout && plotEl._fullLayout.scene && plotEl._fullLayout.scene._scene;
    var cam = scene && scene.glplot && scene.glplot.cameraParams;
    var ds = scene && scene.dataScale;
    var w = plotEl ? plotEl.clientWidth : 0;
    var h = plotEl ? plotEl.clientHeight : 0;
    var view = viewEl || plotEl;
    var target = view ? pxPerMm(view.clientWidth, view.clientHeight, b) : null;
    if (target === null || !cam || !cam.model || !ds) return null;

    var c = b.center;
    var dx = -Math.sin(phiRad), dy = Math.cos(phiRad);
    var a = project(cam, [c[0] * ds[0], c[1] * ds[1], c[2] * ds[2], 1]);
    var b = project(cam, [(c[0] + dx) * ds[0], (c[1] + dy) * ds[1], c[2] * ds[2], 1]);
    var measured = Math.abs(b[0] / b[3] - a[0] / a[3]) * w / 2; // px per mm as drawn
    var depth = a[3]; // the distance it was drawn at
    var constant = measured * depth;
    if (!(constant > 0) || !isFinite(constant)) return null;
    return constant / target;
  }

  window.__a2i2ScanScale = {
    boxOf: boxOf,
    setSpineBox: setSpineBox,
    pxPerMm: pxPerMm,
    niivueVolScale: niivueVolScale,
    plotlyEyeDistance: plotlyEyeDistance,
  };
})();
