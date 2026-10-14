const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'mobile-pdf.js'), 'utf8');
const sharedSource = fs.readFileSync(path.join(__dirname, '..', 'pen-eraser.js'), 'utf8');

function setup(isMobile, runtimeWindow = {}) {
  class Manager {
    ensureControls() { return 'desktop'; }
  }
  class Overlay {
    onPenDown(canvas, page, event) {
      this.drawing = { canvas, idx: page, points: [this.penPoint(canvas, event)] };
      canvas.setPointerCapture(event.pointerId);
    }
    onPenMove(canvas, page, event) {
      this.penMoves = (this.penMoves || 0) + 1;
      if (this.drawing?.canvas === canvas) this.drawing.points.push(this.penPoint(canvas, event));
    }
    onPenUp() {
      if (this.eraseSession) {
        this.finishErase();
        return;
      }
      this.savedPoints = this.drawing?.points.slice();
      this.drawing = null;
    }
    onMouseUp() { this.mouseUps = (this.mouseUps || 0) + 1; }
    onDocMouseMove(event) { this.cursorPosition = [event.clientX, event.clientY]; }
    penPoint(canvas, event) { return { x: event.clientX / 100, y: event.clientY / 100 }; }
    applyEraseMask() { this.maskCount = (this.maskCount || 0) + 1; }
    redrawPenPage() { this.redrawn = true; }
    scheduleSync() {}
    scheduleLayout() {}
    finishErase() { this.finishedErase = this.eraseCircles.slice(); this.eraseSession = null; }
    ctxOf() { return { save() {}, beginPath() {}, ellipse() {}, fill() {}, restore() {} }; }
    syncToolbarState() {}
    onSelectionChange() {}
    showSelPop() {}
    showAnnotContextPop() {}
    buildBoxEl() {}
    positionBoxEl() {}
    listen(target, type, callback, options) { target.addEventListener(type, callback, options); }
  }
  const originalDown = Overlay.prototype.onPenDown;
  const context = { it: { Platform: { isMobile } }, wn: Overlay, vn: Manager,
    window: runtimeWindow, st: () => 'new-id', Qe: () => 'now', cancelAnimationFrame() {} };
  vm.runInNewContext(sharedSource, context);
  vm.runInNewContext(source, context);
  return { Overlay, Manager, originalDown };
}

function canvas() {
  return {
    width: 100, height: 100,
    listeners: {},
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); },
    setPointerCapture(id) { this.captured = id; },
    hasPointerCapture(id) { return this.captured === id; },
    releasePointerCapture() { this.captured = null; },
    getBoundingClientRect() { return { width: 100, height: 100 }; },
  };
}

function pageCanvas() {
  const page = { listeners: {},
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); },
    dispatch(type, event) { for (const callback of this.listeners[type] || []) callback(event); } };
  const target = canvas();
  target.parentElement = page;
  return { page, target };
}

function pointer(id, pointerType, x = 20, y = 20) {
  return { pointerId: id, pointerType, isPrimary: true, clientX: x, clientY: y,
    preventDefault() { this.prevented = true; } };
}

test('desktop pen drawing still uses the original handler', () => {
  const { Overlay, originalDown } = setup(false);
  assert.notEqual(Overlay.prototype.onPenDown, originalDown);
  const overlay = new Overlay();
  Object.assign(overlay, { tool: 'pen', readMode: false, destroyed: false });
  overlay.onPenDown(canvas(), 0, pointer(1, 'mouse'));
  assert.equal(overlay.drawing.points.length, 1);
});

test('tablet ignores fingers by default, accepts pen, and saves a tap', () => {
  const { Overlay } = setup(true);
  const overlay = new Overlay();
  Object.assign(overlay, { tool: 'pen', readMode: false, destroyed: false,
    activePointerId: null, fingerDraw: false });
  const target = canvas();
  overlay.onPenDown(target, 0, pointer(1, 'touch'));
  assert.equal(overlay.drawing, undefined);
  overlay.onPenDown(target, 0, pointer(2, 'pen'));
  assert.equal(target.captured, 2);
  overlay.onPenDown(target, 0, pointer(3, 'touch'));
  assert.equal(overlay.activePointerId, 2);
  overlay.onPenUp(target, 0, pointer(2, 'pen'));
  assert.equal(overlay.savedPoints.length, 2);
  assert.equal(overlay.activePointerId, null);
});

test('tablet starts pencil strokes over the PDF text layer', () => {
  const { Overlay } = setup(true);
  const overlay = new Overlay();
  Object.assign(overlay, { tool: 'pen', readMode: false, destroyed: false,
    activePointerId: null, fingerDraw: false });
  const { page, target } = pageCanvas();
  overlay.bindPenEvents(target, 0);
  const down = pointer(8, 'pen', 10, 20);
  down.target = { closest: () => null };
  down.stopPropagation = () => {};
  page.dispatch('pointerdown', down);
  assert.equal(overlay.activePointerId, 8);
  assert.equal(target.captured, 8);
  overlay.onPenMove(target, 0, pointer(8, 'pen', 40, 30));
  overlay.onPenUp(target, 0, pointer(8, 'pen', 40, 30));
  assert.equal(overlay.savedPoints.length, 2);
});

test('PDF page rerender sends the next stroke to its new canvas', () => {
  const { Overlay } = setup(true);
  const overlay = new Overlay();
  Object.assign(overlay, { tool: 'pen', readMode: false, destroyed: false,
    activePointerId: null, fingerDraw: false });
  const { page, target: oldCanvas } = pageCanvas();
  overlay.bindPenEvents(oldCanvas, 0);
  const nextCanvas = canvas();
  nextCanvas.parentElement = page;
  overlay.bindPenEvents(nextCanvas, 0);
  const down = pointer(11, 'pen', 10, 20);
  down.target = { closest: () => null };
  down.stopPropagation = () => {};
  page.dispatch('pointerdown', down);
  assert.equal(page.listeners.pointerdown.length, 1);
  assert.equal(nextCanvas.captured, 11);
  assert.equal(oldCanvas.captured, undefined);
  overlay.onPenUp(nextCanvas, 0, pointer(11, 'pen'));
  assert.equal(overlay.activePointerId, null);
});

test('a missing pointerup cannot lock drawing after changing brush size', () => {
  const { Overlay } = setup(true);
  const overlay = new Overlay();
  Object.assign(overlay, { tool: 'pen', readMode: false, destroyed: false,
    activePointerId: null, fingerDraw: false });
  const target = canvas();
  overlay.onPenDown(target, 0, pointer(1, 'pen'));
  overlay.resetMobileInk();
  overlay.penWidth = 1;
  overlay.onPenDown(target, 0, pointer(1, 'pen', 40, 30));
  assert.equal(overlay.activePointerId, 1);
  assert.equal(overlay.drawing.points[0].x, .4);
});

test('iPad TouchEvents stylus fallback saves ink and leaves fingers scrolling', () => {
  const { Overlay } = setup(true);
  const overlay = new Overlay();
  Object.assign(overlay, { tool: 'pen', readMode: false, destroyed: false,
    activePointerId: null, fingerDraw: false });
  const { page, target } = pageCanvas();
  overlay.bindPenEvents(target, 0);
  const finger = { identifier: 1, touchType: 'direct', clientX: 10, clientY: 20 };
  const event = touch => ({ changedTouches: [touch], touches: [touch],
    preventDefault() { this.prevented = true; } });
  const scroll = event(finger);
  page.dispatch('touchstart', scroll);
  assert.equal(scroll.prevented, undefined);
  assert.equal(overlay.drawing, undefined);
  const pencil = { identifier: 0, touchType: 'stylus', clientX: 10, clientY: 20 };
  const start = event(pencil);
  page.dispatch('touchstart', start);
  assert.equal(start.prevented, true);
  assert.equal(overlay.activePointerId, -1);
  page.dispatch('touchmove', event({ ...pencil, clientX: 40, clientY: 30 }));
  page.dispatch('touchend', event({ ...pencil, clientX: 40, clientY: 30 }));
  assert.equal(overlay.savedPoints.length, 2);
  assert.equal(overlay.activePointerId, null);
});

test('finger drawing requires opt in and eraser captures a continuous path', () => {
  const { Overlay } = setup(true);
  const overlay = new Overlay();
  Object.assign(overlay, { tool: 'eraser', eraserSize: 12, readMode: false,
    destroyed: false, activePointerId: null, fingerDraw: true, doc: { items: [] } });
  const target = canvas();
  overlay.onPenDown(target, 0, pointer(1, 'touch', 10, 20));
  overlay.onPenMove(target, 0, pointer(1, 'touch', 90, 20));
  overlay.onPenUp(target, 0, pointer(1, 'touch', 90, 20));
  assert.ok(overlay.finishedErase.length > 2);
  assert.ok(overlay.finishedErase.at(-1).x > overlay.finishedErase[0].x);
  assert.equal(overlay.activePointerId, null);
});

test('tablet eraser outline follows the pointer throughout a drag', () => {
  const { Overlay } = setup(true);
  const overlay = new Overlay();
  Object.assign(overlay, { tool: 'eraser', eraserSize: 16, readMode: false,
    destroyed: false, activePointerId: null, fingerDraw: false,
    doc: { items: [] }, eraserCursor: { style: {} } });
  const target = canvas();
  overlay.onPenDown(target, 0, pointer(9, 'pen', 10, 20));
  assert.equal(overlay.eraserCursor.style.left, '10px');
  overlay.onPenMove(target, 0, pointer(9, 'pen', 80, 60));
  assert.equal(overlay.eraserCursor.style.left, '80px');
  assert.equal(overlay.eraserCursor.style.top, '60px');
  overlay.onPenUp(target, 0, pointer(9, 'pen', 80, 60));
  assert.equal(overlay.eraserCursor.style.display, 'none');
});

test('tablet eraser outline also follows stylus TouchEvents', () => {
  const { Overlay } = setup(true);
  const overlay = new Overlay();
  Object.assign(overlay, { tool: 'eraser', eraserSize: 16, readMode: false,
    destroyed: false, activePointerId: null, fingerDraw: false,
    doc: { items: [] }, eraserCursor: { style: {} } });
  const target = canvas();
  overlay.startTouchInk(target, 0, { identifier: 3, clientX: 12, clientY: 18 });
  overlay.onPenMove(target, 0, { pointerId: -4, clientX: 75, clientY: 62,
    preventDefault() {} });
  assert.equal(overlay.eraserCursor.style.left, '75px');
  assert.equal(overlay.eraserCursor.style.top, '62px');
});

test('cancelled pointer discards the in progress mark', () => {
  const { Overlay } = setup(true);
  const overlay = new Overlay();
  Object.assign(overlay, { tool: 'pen', readMode: false, destroyed: false,
    activePointerId: null, fingerDraw: false });
  const target = canvas();
  overlay.onPenDown(target, 0, pointer(7, 'pen'));
  overlay.onPenCancel(target, 0, pointer(7, 'pen'));
  assert.equal(overlay.drawing, null);
  assert.equal(overlay.activePointerId, null);
  assert.equal(overlay.redrawn, true);
});

test('eraser uses the page height when checking portrait page strokes', () => {
  const { Overlay } = setup(true);
  const overlay = new Overlay();
  overlay.doc = { items: [{ id: 'stroke', type: 'pen', page: 1,
    points: [{ x: .5, y: .5 }, { x: .505, y: .515 }] }] };
  const changed = overlay.applyEraseToData(1, [{ x: .5, y: .5, r: .01, ry: .03 }]);
  assert.equal(changed, true);
  assert.equal(overlay.doc.items.length, 0);
});

test('desktop eraser gathers the whole drag and saves it on pointer up', () => {
  const { Overlay } = setup(false);
  const overlay = new Overlay();
  Object.assign(overlay, { tool: 'eraser', eraserSize: 12, readMode: false,
    destroyed: false, doc: { items: [] }, eraseCircles: [] });
  const target = canvas();
  overlay.onPenDown(target, 0, pointer(1, 'mouse', 10, 20));
  overlay.onPenMove(target, 0, pointer(1, 'mouse', 90, 20));
  overlay.onPenUp(target, 0, pointer(1, 'mouse', 90, 20));
  assert.ok(overlay.finishedErase.length > 2);
  assert.equal(overlay.eraseSession, null);
});

test('desktop eraser drags across PDF text layers and commits on document pointer up', () => {
  const { Overlay } = setup(false);
  const overlay = new Overlay();
  const original = { id: 'stroke', type: 'pen', page: 1, width: 2,
    points: [{ x: .1, y: .2 }, { x: .9, y: .2 }] };
  Object.assign(overlay, { tool: 'eraser', eraserSize: 12, readMode: false,
    destroyed: false, doc: { items: [original] }, eraseCircles: [] });
  overlay.finishErase = function () {
    this.finishedErase = this.eraseCircles.slice();
    this.committed = this.applyEraseToData(1, this.finishedErase);
    this.eraseSession = null;
  };
  const document = { listeners: {},
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); },
    dispatch(type, event) { for (const callback of this.listeners[type] || []) callback(event); },
  };
  const { page, target } = pageCanvas();
  target.ownerDocument = document;
  overlay.bindPenEvents(target, 0);
  const textLayer = { closest: () => null };
  const event = (type, x) => {
    const value = pointer(4, 'mouse', x, 20);
    value.button = 0;
    value.target = textLayer;
    value.stopPropagation = () => {};
    if (type === 'pointerdown') page.dispatch(type, value);
    else document.dispatch(type, value);
  };
  event('pointerdown', 10);
  assert.equal(overlay.eraseSession.pointerId, 4);
  event('pointermove', 50);
  assert.deepEqual(overlay.cursorPosition, [50, 20]);
  event('pointerup', 90);
  assert.ok(overlay.finishedErase.length > 2);
  assert.equal(overlay.committed, true);
  assert.equal(overlay.eraseSession, null);
  assert.equal(overlay.doc.items.some(item => item === original), false);
});

test('cancelled eraser drag restores the canvas without changing pen data', () => {
  const { Overlay } = setup(false);
  const overlay = new Overlay();
  const original = { id: 'stroke', type: 'pen', page: 1, width: 2,
    points: [{ x: .1, y: .2 }, { x: .9, y: .2 }] };
  Object.assign(overlay, { tool: 'eraser', eraserSize: 12, readMode: false,
    destroyed: false, doc: { items: [original] }, eraseCircles: [] });
  const target = canvas();
  overlay.onPenDown(target, 0, pointer(1, 'mouse', 10, 20));
  overlay.onPenMove(target, 0, pointer(1, 'mouse', 90, 20));
  overlay.onPenCancel(target, 0, pointer(1, 'mouse', 90, 20));
  assert.equal(overlay.eraseSession, null);
  assert.equal(overlay.doc.items[0], original);
  assert.equal(overlay.redrawn, true);
});

test('eraser splits a sparse stroke even when both endpoints miss the brush', () => {
  const { Overlay } = setup(false);
  const overlay = new Overlay();
  overlay.doc = { items: [{ id: 'stroke', type: 'pen', page: 1, width: 2,
    points: [{ x: 0, y: .5 }, { x: 1, y: .5 }] }] };
  const changed = overlay.applyEraseToData(1, [{ x: .5, y: .5, r: .05, ry: .05 }]);
  assert.equal(changed, true);
  assert.equal(overlay.doc.items.length, 2);
  assert.ok(overlay.doc.items[0].points.at(-1).x < .5);
  assert.ok(overlay.doc.items[1].points[0].x > .5);
});

test('tablet note boxes stay inside a narrow reading pane', () => {
  const { Overlay } = setup(true);
  const overlay = new Overlay();
  const root = { left: 0, right: 400, top: 0, width: 400, height: 700 };
  const page = { left: 20, right: 380, top: 0, width: 360, height: 600 };
  const box = { style: {} };
  const item = { id: 'note', side: 'right', x: 1.02, y: .1, w: .5, h: .1 };
  overlay.contentRoot = { getBoundingClientRect: () => root };
  overlay.doc = { items: [item] };
  overlay.boxEls = new Map([['note', box]]);
  overlay.positionBoxEl(box, item, page, 0, 0);
  assert.equal(parseFloat(box.style.left) + parseFloat(box.style.width), 392);
  overlay.boxDrag = { id: 'note', mode: 'resize', startX: 0, startY: 0,
    orig: { ...item }, pageBox: page };
  overlay.moveBoxPointer(pointer(1, 'touch', 1000, 0));
  assert.ok(item.w * page.width <= 384);
});

test('synthetic touch mouseup cannot open the selection popup early', () => {
  const { Overlay } = setup(true);
  const overlay = new Overlay();
  overlay.lastTouchAt = Date.now();
  overlay.onMouseUp({ sourceCapabilities: { firesTouchEvents: true } });
  overlay.onMouseUp({});
  assert.equal(overlay.mouseUps, undefined);
  overlay.lastTouchAt = 0;
  overlay.onMouseUp({});
  assert.equal(overlay.mouseUps, 1);
});

test('tablet selection waits for the system handles to settle', async () => {
  let timer;
  const { Overlay } = setup(true, {
    setTimeout(callback, delay) { timer = { callback, delay }; return 1; },
    clearTimeout() { timer = undefined; },
  });
  const overlay = new Overlay();
  const anchor = { closest: () => ({}) };
  const selection = {
    isCollapsed: false, anchorNode: { nodeType: 3, parentElement: anchor }, rangeCount: 1,
    toString: () => 'selected text',
    getRangeAt: () => ({ getBoundingClientRect: () => ({ right: 20, bottom: 30, width: 10, height: 10 }) }),
  };
  overlay.contentRoot = { ownerDocument: { getSelection: () => selection }, contains: () => true };
  Object.assign(overlay, { readMode: false, tool: 'select', destroyed: false,
    pendingSel: null, mobileSelectionTimer: null, mobileSelectionCapturing: false,
    async captureSelection() { this.captured = true; } });
  overlay.scheduleMobileSelection();
  assert.equal(timer.delay, 800);
  assert.equal(overlay.captured, undefined);
  await timer.callback();
  assert.equal(overlay.captured, true);
});

test('wrapped selection popup is clamped inside the tablet viewport', () => {
  const { Overlay } = setup(true);
  const overlay = new Overlay();
  const added = [];
  overlay.selPop = {
    classList: { add(value) { added.push(value); } },
    ownerDocument: { documentElement: { clientWidth: 400, clientHeight: 600 } },
    getBoundingClientRect: () => ({ left: 350, top: 580, width: 200, height: 120 }),
    style: {},
  };
  overlay.positionMobilePopover();
  assert.equal(overlay.selPop.style.left, '192px');
  assert.equal(overlay.selPop.style.top, '472px');
  assert.deepEqual(added, ['da-mobile-selection-pop']);
});
