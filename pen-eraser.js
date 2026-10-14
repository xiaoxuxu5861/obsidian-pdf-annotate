/* Shared PDF pen/eraser pointer handling. Embedded into main.js before the
 * tablet-specific overrides. Coordinates in annotation data are normalized to
 * the page; brush sizes are measured in CSS pixels.
 */
(() => {
  wn.prototype.bindPenEvents = function (canvas, page) {
    canvas.addEventListener("pointerdown", event => this.onPenDown(canvas, page, event));
    canvas.addEventListener("pointermove", event => this.onPenMove(canvas, page, event));
    canvas.addEventListener("pointerup", event => this.onPenUp(canvas, page, event));
    canvas.addEventListener("pointercancel", event => this.onPenCancel(canvas, page, event));
  };

  const penDown = wn.prototype.onPenDown;
  wn.prototype.onPenDown = function (canvas, page, event) {
    if (this.destroyed || this.readMode) return;
    if (this.tool !== "eraser") return penDown.call(this, canvas, page, event);
    if (this.eraseSession || !this.doc) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    this.eraseSession = { canvas, idx: page, pointerId: event.pointerId };
    this.eraseCircles = [];
    this.eraseLast = null;
    this.isErasing = true;
    this.addErasePoint(canvas, this.penPoint(canvas, event));
  };

  wn.prototype.addErasePoint = function (canvas, point) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const radius = this.eraserSize / 2;
    const previous = this.eraseLast;
    const distance = previous
      ? Math.hypot((point.x - previous.x) * rect.width, (point.y - previous.y) * rect.height)
      : 0;
    const steps = previous ? Math.max(1, Math.ceil(distance / Math.max(2, radius / 2))) : 1;
    for (let i = 1; i <= steps; i++) {
      const x = previous ? previous.x + (point.x - previous.x) * i / steps : point.x;
      const y = previous ? previous.y + (point.y - previous.y) * i / steps : point.y;
      this.eraseCircles.push({ x, y, r: radius / rect.width, ry: radius / rect.height });
      this.applyEraseMask(canvas, x, y);
    }
    this.eraseLast = point;
  };

  const penMove = wn.prototype.onPenMove;
  wn.prototype.onPenMove = function (canvas, page, event) {
    if (this.eraseSession?.canvas === canvas) {
      if (this.eraseSession.pointerId !== event.pointerId) return;
      event.preventDefault();
      this.addErasePoint(canvas, this.penPoint(canvas, event));
      return;
    }
    penMove.call(this, canvas, page, event);
  };

  const penUp = wn.prototype.onPenUp;
  wn.prototype.onPenUp = function (canvas, page, event) {
    if (this.eraseSession?.canvas === canvas && this.eraseSession.pointerId === event.pointerId) {
      this.addErasePoint(canvas, this.penPoint(canvas, event));
    }
    penUp.call(this, canvas, page);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };

  wn.prototype.onPenCancel = function (canvas, page, event) {
    if (this.eraseSession?.pointerId !== event.pointerId &&
        (!this.drawing || this.drawing.canvas !== canvas)) return;
    this.drawing = null;
    this.eraseSession = null;
    this.eraseCircles = [];
    this.eraseLast = null;
    this.erasePending = null;
    this.isErasing = false;
    this.syncQueuedDuringErase = false;
    this.layoutQueuedDuringErase = false;
    if (this.eraseRaf) cancelAnimationFrame(this.eraseRaf);
    this.eraseRaf = 0;
    this.redrawPenPage(canvas, page);
    this.scheduleSync();
    this.scheduleLayout();
  };

  wn.prototype.applyEraseMask = function (canvas, x, y) {
    const ctx = this.ctxOf(canvas);
    const rect = canvas.getBoundingClientRect();
    if (!ctx || rect.width < 1 || rect.height < 1) return;
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.ellipse(x * canvas.width, y * canvas.height,
      Math.max(1, this.eraserSize * canvas.width / rect.width / 2),
      Math.max(1, this.eraserSize * canvas.height / rect.height / 2),
      0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  // Subtract the brush circles from every line segment. This also handles a
  // long segment crossing the eraser when neither stored endpoint is inside it.
  wn.prototype.applyEraseToData = function (page, circles) {
    if (!this.doc || !circles.length) return false;
    let changed = false;
    for (const stroke of this.doc.items.filter(item => item.type === "pen" && item.page === page)) {
      if (stroke.points.length < 2) continue;
      const parts = [];
      let active = null;
      let hitStroke = false;
      const interpolate = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      for (let i = 1; i < stroke.points.length; i++) {
        const a = stroke.points[i - 1], b = stroke.points[i];
        const erased = [];
        for (const circle of circles) {
          const inkRadiusX = (stroke.width || 1) / 1400;
          const rx = circle.r + inkRadiusX;
          const ry = (circle.ry || circle.r) + inkRadiusX * ((circle.ry || circle.r) / circle.r);
          const px = (a.x - circle.x) / rx, py = (a.y - circle.y) / ry;
          const dx = (b.x - a.x) / rx, dy = (b.y - a.y) / ry;
          const qa = dx * dx + dy * dy;
          if (qa < 1e-12) {
            if (px * px + py * py <= 1) erased.push([0, 1]);
            continue;
          }
          const qb = 2 * (px * dx + py * dy);
          const qc = px * px + py * py - 1;
          const discriminant = qb * qb - 4 * qa * qc;
          if (discriminant < 0) continue;
          const root = Math.sqrt(discriminant);
          const start = Math.max(0, (-qb - root) / (2 * qa));
          const end = Math.min(1, (-qb + root) / (2 * qa));
          if (end > start) erased.push([start, end]);
        }
        erased.sort((left, right) => left[0] - right[0]);
        const merged = [];
        for (const interval of erased) {
          const last = merged[merged.length - 1];
          if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
          else merged.push(interval.slice());
        }
        if (merged.length) hitStroke = true;
        const keep = (start, end) => {
          if (end - start < 1e-6) return;
          if (!active || start > 1e-6) {
            active = [interpolate(a, b, start)];
            parts.push(active);
          }
          active.push(interpolate(a, b, end));
        };
        let from = 0;
        for (const [start, end] of merged) {
          keep(from, start);
          active = null;
          from = Math.max(from, end);
        }
        keep(from, 1);
        if (from >= 1 - 1e-6) active = null;
      }
      if (!hitStroke) continue;
      this.doc.items = this.doc.items.filter(item => item.id !== stroke.id);
      parts.filter(part => part.length >= 2).forEach((part, index) => {
        this.doc.items.push({ ...stroke, id: index ? st() : stroke.id, modified: Qe(), points: part });
      });
      changed = true;
    }
    return changed;
  };
})();
