/* Tablet support for the bundled native PDF overlay.
 * This file is inserted before `var Na=` in main.js by scripts/embed-mobile.ps1.
 * The repository currently contains the distribution bundle rather than its
 * original source, so keep these overrides readable and narrowly scoped.
 */
(() => {
  const isMobile = !!it.Platform?.isMobile;
  if (!isMobile) return;

  vn.prototype.ensureControls = function (leaf) {
    const overlay = this.overlays.get(leaf);
    if (!overlay) return false;
    const host = leaf.view.containerEl.querySelector(".view-content") || leaf.view.containerEl;
    let controls = host.querySelector(":scope > .da-mobile-controls");
    if (!controls) {
      controls = host.ownerDocument.createElement("div");
      controls.className = "da-native-controls da-mobile-controls";
      host.appendChild(controls);
    }
    leaf.view.containerEl.querySelectorAll(".da-native-controls:not(.da-mobile-controls)").forEach(el => el.remove());
    overlay.ensureToolbarButtons(controls);
    return true;
  };

  const init = wn.prototype.init;
  wn.prototype.init = async function () {
    this.fingerDraw = !!this.plugin.conf.fingerDraw;
    this.activePointerId = null;
    this.activePointerCanvas = null;
    this.activePointerPage = null;
    this.activeTouchIdentifier = null;
    this.mobilePenPages = new WeakMap();
    this.mobileSelectionTimer = null;
    this.mobileSelectionCapturing = false;
    this.lastTouchAt = 0;
    const host = this.leaf.view.containerEl;
    host.classList.add("da-mobile-pdf-view");
    await init.call(this);
    if (this.destroyed) return;
    this.setReadMode(true);
    const root = this.contentRoot;
    this.listen(root, "touchstart", () => {
      this.lastTouchAt = Date.now();
      if (this.mobileSelectionTimer !== null) window.clearTimeout(this.mobileSelectionTimer);
      this.mobileSelectionTimer = null;
    }, { passive: true });
    this.listen(root, "touchmove", () => {
      this.lastTouchAt = Date.now();
      if (this.mobileSelectionTimer !== null) window.clearTimeout(this.mobileSelectionTimer);
      this.mobileSelectionTimer = null;
    }, { passive: true });
    this.listen(root, "touchend", event => {
      this.lastTouchAt = Date.now();
      if (event.target?.closest?.(".textLayer, .text-layer, [class*='textLayer'], [class*='text-layer']")) {
        this.scheduleMobileSelection();
      }
    }, { passive: true });
    this.listen(root.ownerDocument, "pointermove", event => {
      if (this.boxDrag && this.boxPointerId === event.pointerId) this.moveBoxPointer(event);
      if (this.activePointerId === event.pointerId && this.activePointerCanvas) {
        event.stopPropagation();
        this.onPenMove(this.activePointerCanvas, this.activePointerPage, event);
      } else if (this.tool === "eraser" && event.pointerType !== "touch" &&
                 event.target?.closest?.(".page[data-page-number]")) {
        this.positionMobileEraserCursor(event);
      }
    }, true);
    this.listen(root.ownerDocument, "pointerup", event => {
      if (this.boxDrag && this.boxPointerId === event.pointerId) {
        this.boxPointerId = null;
        this.onDocMouseUp();
      }
      if (this.activePointerId === event.pointerId && this.activePointerCanvas) {
        event.stopPropagation();
        this.onPenUp(this.activePointerCanvas, this.activePointerPage, event);
      }
    }, true);
    this.listen(root.ownerDocument, "pointercancel", event => {
      if (this.boxDrag && this.boxPointerId === event.pointerId) {
        this.boxPointerId = null;
        this.onDocMouseUp();
      }
      if (this.activePointerId === event.pointerId && this.activePointerCanvas) {
        event.stopPropagation();
        this.onPenCancel(this.activePointerCanvas, this.activePointerPage, event);
      }
    }, true);
    this.listen(root.ownerDocument, "pointerdown", event => {
      if (this.activePointerId !== null && this.activePointerCanvas &&
          !this.activePointerCanvas.parentElement?.contains(event.target)) {
        this.resetMobileInk();
      }
      if (this.widthPanel && !this.widthPanel.hidden &&
          !this.widthPanel.contains(event.target) && !this.widthButton?.contains(event.target)) {
        this.closeWidthPanel();
      }
    }, true);
    this.listen(root.ownerDocument, "keydown", event => {
      if (event.key === "Escape") this.closeWidthPanel();
    }, true);
  };

  const destroy = wn.prototype.destroy;
  wn.prototype.destroy = function () {
    if (this.mobileSelectionTimer !== null) window.clearTimeout(this.mobileSelectionTimer);
    this.mobileSelectionTimer = null;
    this.widthPanel?.remove();
    this.widthPanel = null;
    this.leaf.view.containerEl.classList.remove("da-mobile-pdf-view");
    this.leaf.view.containerEl.querySelectorAll(".da-mobile-controls").forEach(el => el.remove());
    destroy.call(this);
  };

  const mouseUp = wn.prototype.onMouseUp;
  wn.prototype.onMouseUp = function (event) {
    // Mobile browsers may synthesize mouseup after touchend. The PDF viewer
    // must wait for the system selection handles to settle first.
    if (event.sourceCapabilities?.firesTouchEvents || Date.now() - this.lastTouchAt < 1200) return;
    mouseUp.call(this, event);
  };

  wn.prototype.scheduleMobileSelection = function () {
    if (this.mobileSelectionTimer !== null) window.clearTimeout(this.mobileSelectionTimer);
    this.mobileSelectionTimer = null;
    if (this.destroyed || this.readMode || this.tool !== "select" || this.mobileSelectionCapturing) return;
    this.mobileSelectionTimer = window.setTimeout(async () => {
      this.mobileSelectionTimer = null;
      if (this.destroyed || this.readMode || this.tool !== "select" || this.pendingSel || this.mobileSelectionCapturing) return;
      const root = this.contentRoot;
      const selection = root?.ownerDocument.getSelection();
      if (!selection || selection.isCollapsed || !selection.toString().trim() || !selection.rangeCount) return;
      const anchor = selection.anchorNode?.nodeType === 1 ? selection.anchorNode : selection.anchorNode?.parentElement;
      if (!anchor || !root.contains(anchor) || !anchor.closest(".textLayer, .text-layer, [class*='textLayer'], [class*='text-layer']")) return;
      const rect = selection.getRangeAt(selection.rangeCount - 1).getBoundingClientRect();
      if (!rect || rect.width < 1 || rect.height < 1) return;
      this.mobileSelectionCapturing = true;
      try {
        await this.captureSelection(selection, rect.right, rect.bottom);
      } finally {
        this.mobileSelectionCapturing = false;
      }
    }, 800);
  };

  const toolbar = wn.prototype.ensureToolbarButtons;
  wn.prototype.ensureToolbarButtons = function (group) {
    toolbar.call(this, group);
    const widthWrap = group.querySelector(".da-native-width-wrap");
    if (!widthWrap) return;
    this.widthPanel?.remove();
    const document = group.ownerDocument;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "da-native-tool clickable-icon da-mobile-width-button";
    button.title = "调节画笔或橡皮擦粗细";
    button.setAttribute("aria-label", button.title);
    it.setIcon(button, "sliders-horizontal");
    const buttonValue = document.createElement("span");
    buttonValue.className = "da-mobile-width-button-value";
    button.appendChild(buttonValue);
    group.insertBefore(button, widthWrap);

    const panel = document.createElement("div");
    panel.className = "da-mobile-width-panel";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "调节粗细");
    const heading = document.createElement("div");
    heading.className = "da-mobile-width-heading";
    const title = document.createElement("span");
    heading.appendChild(title);
    heading.appendChild(this.widthVal);
    panel.appendChild(heading);
    const preview = document.createElement("div");
    preview.className = "da-mobile-width-stroke";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 240 48");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M18 30 C52 6 78 8 112 25 S185 46 222 17");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    preview.appendChild(svg);
    panel.appendChild(preview);
    const row = document.createElement("div");
    row.className = "da-mobile-width-row";
    const minus = document.createElement("button");
    minus.type = "button";
    minus.textContent = "−";
    minus.setAttribute("aria-label", "减小粗细");
    const plus = document.createElement("button");
    plus.type = "button";
    plus.textContent = "+";
    plus.setAttribute("aria-label", "增大粗细");
    const track = document.createElement("div");
    track.className = "da-mobile-width-track";
    const fill = document.createElement("div");
    fill.className = "da-mobile-width-fill";
    const thumb = document.createElement("div");
    thumb.className = "da-mobile-width-thumb";
    track.append(fill, thumb);
    widthWrap.appendChild(track);
    row.append(minus, widthWrap, plus);
    panel.appendChild(row);
    document.body.appendChild(panel);
    this.widthPreview?.remove();
    this.widthPanel = panel;
    this.widthButton = button;
    this.widthButtonValue = buttonValue;
    this.widthPanelTitle = title;
    this.widthStroke = path;
    this.widthSliderFill = fill;
    this.widthSliderThumb = thumb;
    button.disabled = !!this.readMode;
    const adjust = direction => {
      const step = this.tool === "eraser" ? 1 : .5;
      const min = this.tool === "eraser" ? 1 : .5;
      const size = Math.min(30, Math.max(min, Number(this.widthInput.value) + direction * step));
      this.widthInput.value = String(size);
      this.widthInput.dispatchEvent(new document.defaultView.Event("input", { bubbles: true }));
    };
    minus.addEventListener("click", () => adjust(-1));
    plus.addEventListener("click", () => adjust(1));
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (this.widthPanel.hidden) {
        this.resetMobileInk();
        this.widthPanel.hidden = false;
        this.positionWidthPanel();
      } else {
        this.closeWidthPanel();
      }
    });
    this.updateMobileWidthUi();
  };

  wn.prototype.closeWidthPanel = function () {
    if (this.widthPanel) this.widthPanel.hidden = true;
  };

  wn.prototype.positionWidthPanel = function () {
    if (!this.widthPanel || !this.widthButton) return;
    const button = this.widthButton.getBoundingClientRect();
    const viewport = this.widthButton.ownerDocument.documentElement;
    const width = this.widthPanel.offsetWidth;
    const height = this.widthPanel.offsetHeight;
    this.widthPanel.style.left = Math.max(8,
      Math.min(button.left, viewport.clientWidth - width - 8)) + "px";
    this.widthPanel.style.top = Math.max(8,
      Math.min(button.bottom + 8, viewport.clientHeight - height - 8)) + "px";
  };

  wn.prototype.updateMobileWidthUi = function (size = this.tool === "eraser" ? this.eraserSize : this.penWidth) {
    if (!this.widthPanel) return;
    this.widthPanelTitle.textContent = this.tool === "eraser" ? "橡皮擦直径" : "画笔粗细";
    this.widthButtonValue.textContent = String(size);
    this.widthStroke.setAttribute("stroke-width", String(Math.max(.7, Math.min(22, size))));
    this.widthStroke.setAttribute("stroke", "currentColor");
    const minimum = this.tool === "eraser" ? 1 : .5;
    const ratio = Math.max(0, Math.min(1, (Number(size) - minimum) / (30 - minimum)));
    if (this.widthSliderFill) this.widthSliderFill.style.width = ratio * 100 + "%";
    if (this.widthSliderThumb) this.widthSliderThumb.style.left = ratio * 100 + "%";
  };

  const syncWidthControl = wn.prototype.syncWidthControl;
  wn.prototype.syncWidthControl = function () {
    syncWidthControl.call(this);
    this.updateMobileWidthUi();
  };

  wn.prototype.updateWidthPreview = function (size) {
    if (this.widthPreview) this.widthPreview.style.display = "none";
    this.updateMobileWidthUi(size);
  };

  const syncToolbar = wn.prototype.syncToolbarState;
  wn.prototype.syncToolbarState = function () {
    syncToolbar.call(this);
    this.contentRoot?.classList.toggle("da-finger-draw", !!this.fingerDraw);
    if (this.widthButton) this.widthButton.disabled = !!this.readMode;
    if (this.readMode) this.closeWidthPanel();
    this.updateMobileWidthUi();
  };

  wn.prototype.positionMobileEraserCursor = function (event) {
    if (this.tool !== "eraser" || this.readMode || !this.eraserCursor ||
        !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    this.eraserCursor.style.left = event.clientX + "px";
    this.eraserCursor.style.top = event.clientY + "px";
    this.eraserCursor.style.display = "block";
  };

  wn.prototype.hideMobileEraserCursor = function () {
    if (this.eraserCursor) this.eraserCursor.style.display = "none";
  };

  wn.prototype.resetMobileInk = function () {
    if (this.activePointerId !== null && this.activePointerCanvas) {
      this.onPenCancel(this.activePointerCanvas, this.activePointerPage,
        { pointerId: this.activePointerId });
    }
    this.activePointerId = null;
    this.activePointerCanvas = null;
    this.activePointerPage = null;
    this.activePointerType = null;
    this.activeTouchIdentifier = null;
    this.hideMobileEraserCursor();
  };

  const bindPenEvents = wn.prototype.bindPenEvents;
  wn.prototype.bindPenEvents = function (canvas, page) {
    bindPenEvents.call(this, canvas, page);
    // PDF.js can put another layer above our canvas. Capture at the page so
    // drawing still starts when that layer is the hit-test target on iPadOS.
    const pageEl = canvas.parentElement;
    this.mobilePenPages ||= new WeakMap();
    const existing = this.mobilePenPages.get(pageEl);
    if (existing) {
      if (this.activePointerCanvas === existing.canvas) this.resetMobileInk();
      existing.canvas = canvas;
      existing.page = page;
      return;
    }
    const current = { canvas, page };
    this.mobilePenPages.set(pageEl, current);
    this.listen(pageEl, "pointerdown", event => {
      if (this.destroyed || this.readMode || (this.tool !== "pen" && this.tool !== "eraser")) return;
      if (event.pointerType === "touch" && (!this.fingerDraw || !event.isPrimary)) return;
      if (event.target.closest?.(".da-web-chapter-marker")) return;
      event.stopPropagation();
      this.onPenDown(current.canvas, current.page, event);
    }, true);
    this.listen(pageEl, "touchstart", event => {
      if (this.readMode || (this.tool !== "pen" && this.tool !== "eraser")) return;
      if (this.activePointerId !== null) {
        if (this.activePointerType === "pen" || this.fingerDraw) event.preventDefault();
        return;
      }
      const touch = event.changedTouches[0];
      if (!touch || event.touches.length !== 1 ||
          (touch.touchType !== "stylus" && !this.fingerDraw)) return;
      event.preventDefault();
      this.startTouchInk(current.canvas, current.page, touch);
    }, { passive: false, capture: true });
    this.listen(pageEl, "touchmove", event => {
      if (this.activePointerId !== null && this.activeTouchIdentifier == null &&
          (this.activePointerType === "pen" || this.fingerDraw)) event.preventDefault();
      if (this.activePointerCanvas !== current.canvas || this.activeTouchIdentifier == null) return;
      const touch = Array.from(event.changedTouches).find(item => item.identifier === this.activeTouchIdentifier);
      if (!touch) return;
      event.preventDefault();
      this.onPenMove(current.canvas, current.page, this.touchAsPointer(touch, event));
    }, { passive: false, capture: true });
    const endTouch = (event, cancel) => {
      if (this.activePointerCanvas !== current.canvas || this.activeTouchIdentifier == null) return;
      const touch = Array.from(event.changedTouches).find(item => item.identifier === this.activeTouchIdentifier);
      if (!touch) return;
      event.preventDefault();
      const pointer = this.touchAsPointer(touch, event);
      if (cancel) this.onPenCancel(current.canvas, current.page, pointer);
      else this.onPenUp(current.canvas, current.page, pointer);
      this.activeTouchIdentifier = null;
    };
    this.listen(pageEl, "touchend", event => endTouch(event, false), { passive: false, capture: true });
    this.listen(pageEl, "touchcancel", event => endTouch(event, true), { passive: false, capture: true });
  };

  wn.prototype.touchAsPointer = function (touch, event) {
    return { pointerId: -touch.identifier - 1, pointerType: "pen", isPrimary: true,
      clientX: touch.clientX, clientY: touch.clientY,
      preventDefault: () => event.preventDefault() };
  };

  wn.prototype.startTouchInk = function (canvas, page, touch) {
    const pointer = this.touchAsPointer(touch, { preventDefault() {} });
    this.activeTouchIdentifier = touch.identifier;
    this.activePointerId = pointer.pointerId;
    this.activePointerCanvas = canvas;
    this.activePointerPage = page;
    this.activePointerType = "pen";
    this.positionMobileEraserCursor(pointer);
    if (this.tool === "pen") {
      this.drawing = { idx: page, points: [this.penPoint(canvas, pointer)], canvas };
    } else if (this.doc) {
      this.eraseSession = { canvas, idx: page, pointerId: pointer.pointerId };
      this.eraseCircles = [];
      this.eraseLast = null;
      this.isErasing = true;
      this.addErasePoint(canvas, this.penPoint(canvas, pointer));
    }
  };

  const penDown = wn.prototype.onPenDown;
  wn.prototype.onPenDown = function (canvas, page, event) {
    if (this.destroyed || this.readMode || (this.tool !== "pen" && this.tool !== "eraser")) return;
    if (event.pointerType === "touch" && (!this.fingerDraw || !event.isPrimary)) return;
    if (this.activeTouchIdentifier != null) return;
    // iPadOS can omit an end event when a page or toolbar is rebuilt. A fresh
    // pointerdown must always be able to start a new stroke.
    if (this.activePointerId !== null) this.resetMobileInk();
    this.activePointerId = event.pointerId;
    this.activePointerCanvas = canvas;
    this.activePointerPage = page;
    this.activePointerType = event.pointerType;
    event.preventDefault();
    this.positionMobileEraserCursor(event);
    try {
      penDown.call(this, canvas, page, event);
    } catch (error) {
      if (!["NotFoundError", "InvalidStateError"].includes(error?.name)) throw error;
      // A PDF.js page can rerender between pointerdown and capture. Document
      // capture listeners still receive the remainder of this stroke.
      if (this.tool === "eraser" && this.doc) {
        this.eraseSession = { canvas, idx: page, pointerId: event.pointerId };
        this.eraseCircles = [];
        this.eraseLast = null;
        this.isErasing = true;
        this.addErasePoint(canvas, this.penPoint(canvas, event));
      }
    }
  };

  const penMove = wn.prototype.onPenMove;
  wn.prototype.onPenMove = function (canvas, page, event) {
    if (this.activePointerId !== event.pointerId) return;
    this.positionMobileEraserCursor(event);
    penMove.call(this, canvas, page, event);
  };

  const penUp = wn.prototype.onPenUp;
  wn.prototype.onPenUp = function (canvas, page, event) {
    if (this.activePointerId !== event.pointerId) return;
    event.preventDefault();
    if (this.drawing?.canvas === canvas && this.drawing.points.length === 1) {
      const point = this.drawing.points[0];
      this.drawing.points.push({ x: Math.min(1, point.x + .0001), y: point.y });
    }
    try {
      penUp.call(this, canvas, page, event);
    } finally {
      this.activePointerId = null;
      this.activePointerCanvas = null;
      this.activePointerPage = null;
      this.activePointerType = null;
      this.activeTouchIdentifier = null;
      this.eraseLast = null;
      this.hideMobileEraserCursor();
    }
  };

  const penCancel = wn.prototype.onPenCancel;
  wn.prototype.onPenCancel = function (canvas, page, event) {
    if (this.activePointerId !== event.pointerId) return;
    this.activePointerId = null;
    this.activePointerCanvas = null;
    this.activePointerPage = null;
    this.activePointerType = null;
    this.activeTouchIdentifier = null;
    this.hideMobileEraserCursor();
    penCancel.call(this, canvas, page, event);
  };

  const selectionChange = wn.prototype.onSelectionChange;
  wn.prototype.onSelectionChange = function () {
    const selection = this.contentRoot?.ownerDocument.getSelection();
    if (this.pendingSel) {
      if (selection && !selection.isCollapsed && selection.toString().trim() !== this.pendingSel.text) {
        this.hideSelPop(false);
      } else {
        return;
      }
    }
    if (selection && !selection.isCollapsed && selection.toString().trim()) {
      this.scheduleMobileSelection();
      return;
    }
    selectionChange.call(this);
  };

  const selectionPopup = wn.prototype.showSelPop;
  wn.prototype.showSelPop = function (...args) {
    selectionPopup.apply(this, args);
    this.positionMobilePopover();
  };
  const contextPopup = wn.prototype.showAnnotContextPop;
  wn.prototype.showAnnotContextPop = function (...args) {
    contextPopup.apply(this, args);
    this.positionMobilePopover();
  };
  wn.prototype.positionMobilePopover = function () {
    const pop = this.selPop;
    if (!pop) return;
    pop.classList.add("da-mobile-selection-pop");
    const rect = pop.getBoundingClientRect();
    const viewport = pop.ownerDocument.documentElement;
    pop.style.left = Math.max(8, Math.min(rect.left, viewport.clientWidth - rect.width - 8)) + "px";
    pop.style.top = Math.max(8, Math.min(rect.top, viewport.clientHeight - rect.height - 8)) + "px";
  };

  const buildBox = wn.prototype.buildBoxEl;
  wn.prototype.buildBoxEl = function (item, pageRect, baseX, baseY) {
    const box = buildBox.call(this, item, pageRect, baseX, baseY);
    for (const [selector, mode] of [[".da-native-box-head", "move"], [".da-native-box-resize", "resize"]]) {
      const handle = box.querySelector(selector);
      handle.addEventListener("pointerdown", event => {
        if (this.readMode || event.target.closest(".da-native-box-ref, .da-native-box-flip, .da-native-box-del")) return;
        if (this.boxDrag || !event.isPrimary) return;
        this.boxPointerId = event.pointerId;
        this.startBoxDrag(event, item.id, mode, pageRect, baseX, baseY);
        handle.setPointerCapture(event.pointerId);
      });
    }
    return box;
  };

  wn.prototype.moveBoxPointer = function (event) {
    const drag = this.boxDrag;
    const item = this.doc?.items.find(entry => entry.id === drag.id);
    const box = this.boxEls.get(drag.id);
    if (!item || !box || !this.contentRoot) return;
    const pageRect = drag.pageEl?.isConnected ? drag.pageEl.getBoundingClientRect() : drag.pageBox;
    const root = this.contentRoot.getBoundingClientRect();
    if (pageRect.width < 1 || pageRect.height < 1) return;
    const dx = (event.clientX - drag.startX) / pageRect.width;
    const dy = (event.clientY - drag.startY) / pageRect.height;
    if (drag.mode === "move") {
      item.y = Math.min(.9, Math.max(.02, drag.orig.y + dy));
    } else {
      item.w = Math.min((root.width - 16) / pageRect.width, Math.max(.02, drag.orig.w + dx));
      item.h = Math.max(.02, drag.orig.h + dy);
    }
    this.positionBoxEl(box, item, pageRect, root.left, root.top);
  };

  const positionBox = wn.prototype.positionBoxEl;
  wn.prototype.positionBoxEl = function (box, item, pageRect, baseX, baseY) {
    const root = this.contentRoot?.getBoundingClientRect();
    if (!root || root.width < 1) return positionBox.call(this, box, item, pageRect, baseX, baseY);
    const width = Math.min(Math.max(120, item.w * pageRect.width), Math.max(80, root.width - 16));
    const height = Math.max(44, item.h * pageRect.height);
    const right = (item.side || (item.x >= .5 ? "right" : "left")) === "right";
    const desired = right ? pageRect.right + 14 : pageRect.left - width - 14;
    const left = Math.min(Math.max(desired, root.left + 8), root.right - width - 8);
    const top = pageRect.top + Math.min(.9, Math.max(.02, item.y)) * pageRect.height;
    box.style.left = left - baseX + "px";
    box.style.top = top - baseY + "px";
    box.style.width = width + "px";
    box.style.height = height + "px";
  };
})();
