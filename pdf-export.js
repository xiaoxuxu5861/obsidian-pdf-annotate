/* Export against the original PDF. Source pages stay vector/searchable;
 * markup and ink are native, removable PDF annotations. Text note cards are
 * drawn in an added right margin, leaving the original page content intact.
 */
(() => {
  const { PDFDocument, PDFHexString, PDFString, PDFName, rgb, StandardFonts } = DaPdfLib;
  const round = value => Number(value.toFixed(3));

  function pdfColor(value) {
    let hex = String(value || "#ffd54a").replace("#", "");
    if (hex.length === 3) hex = Array.from(hex, c => c + c).join("");
    if (!/^[0-9a-f]{6}$/i.test(hex)) hex = "ffd54a";
    return [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
  }

  function safeUrl(raw) {
    try {
      const url = new URL(raw);
      return ["https:", "http:"].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  }

  function pdfPoint(viewport, x, y, page) {
    if (viewport?.convertToPdfPoint) return viewport.convertToPdfPoint(x * viewport.width, y * viewport.height);
    const box = page.getCropBox();
    return [box.x + x * box.width, box.y + (1 - y) * box.height];
  }

  function pdfRect(viewport, rect, page) {
    const points = [
      pdfPoint(viewport, rect.x, rect.y, page),
      pdfPoint(viewport, rect.x + rect.w, rect.y, page),
      pdfPoint(viewport, rect.x, rect.y + rect.h, page),
      pdfPoint(viewport, rect.x + rect.w, rect.y + rect.h, page)
    ];
    const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
    return { points, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  }

  function addAnnotation(document, page, dictionary) {
    const ref = document.context.register(document.context.obj(dictionary));
    page.node.addAnnot(ref);
    return ref;
  }

  function appearance(document, bounds, color, alpha, drawing) {
    const width = Math.max(.1, bounds[2] - bounds[0]);
    const height = Math.max(.1, bounds[3] - bounds[1]);
    const [r, g, b] = color.map(round);
    const stream = document.context.flateStream(
      `q /GS1 gs ${r} ${g} ${b} ${drawing}\nQ\n`, {
        Type: "XObject", Subtype: "Form", FormType: 1,
        BBox: [0, 0, width, height],
        Resources: { ExtGState: { GS1: { Type: "ExtGState", ca: alpha, CA: alpha,
          BM: alpha < 1 ? "Multiply" : "Normal" } } }
      }
    );
    return document.context.register(stream);
  }

  function addTextMark(document, page, item, viewport) {
    const type = { highlight: "Highlight", underline: "Underline", strike: "StrikeOut" }[item.type];
    if (!type) return;
    const color = pdfColor(item.color);
    let segment = 0;
    for (const rect of item.rects || []) {
      if (!rect || rect.w <= 0 || rect.h <= 0) continue;
      const { points, box } = pdfRect(viewport, rect, page);
      if (box[2] - box[0] < .1 || box[3] - box[1] < .1) continue;
      const [tl, tr, bl, br] = points;
      const quad = [...tl, ...tr, ...bl, ...br].map(round);
      const w = box[2] - box[0], h = box[3] - box[1];
      const drawing = type === "Highlight"
        ? `rg 0 0 ${round(w)} ${round(h)} re f`
        : `RG ${round(Math.max(.75, Math.min(2, h * .08)))} w 0 ${round(type === "Underline" ? 1 : h / 2)} m ${round(w)} ${round(type === "Underline" ? 1 : h / 2)} l S`;
      const ap = appearance(document, box, color, type === "Highlight" ? .42 : 1, drawing);
      addAnnotation(document, page, {
        Type: "Annot", Subtype: type, Rect: box.map(round), QuadPoints: quad,
        C: color.map(round), CA: type === "Highlight" ? .42 : 1,
        F: 4, AP: { N: ap },
        NM: PDFString.of(`${item.id || "mark"}-${segment++}`),
        Contents: PDFHexString.fromText(String(item.text || ""))
      });
    }
  }

  function addInk(document, page, item, viewport) {
    if (!Array.isArray(item.points) || item.points.length < 2) return;
    const points = item.points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
      .map(p => pdfPoint(viewport, p.x, p.y, page));
    if (points.length < 2) return;
    const color = pdfColor(item.color || "#000000");
    const stroke = Math.max(.4, (Number(item.width) || 1) *
      (viewport?.width || page.getWidth()) / 700);
    const margin = stroke / 2 + 2;
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    const box = [Math.min(...xs) - margin, Math.min(...ys) - margin,
      Math.max(...xs) + margin, Math.max(...ys) + margin];
    const local = points.map(p => [round(p[0] - box[0]), round(p[1] - box[1])]);
    const path = `${round(stroke)} w 1 J 1 j ${local[0][0]} ${local[0][1]} m ` +
      local.slice(1).map(p => `${p[0]} ${p[1]} l`).join(" ") + " S";
    const ap = appearance(document, box, color, 1, `RG ${path}`);
    addAnnotation(document, page, {
      Type: "Annot", Subtype: "Ink", Rect: box.map(round),
      InkList: [points.flat().map(round)], BS: { W: round(stroke), S: "S" },
      C: color.map(round), F: 4, AP: { N: ap },
      NM: PDFString.of(String(item.id || "")),
      Contents: PDFHexString.fromText("Handwritten annotation")
    });
  }

  function wrapLines(ctx, value, width) {
    const lines = [];
    for (const paragraph of String(value || "").split(/\r?\n/)) {
      let line = "";
      for (const char of paragraph) {
        if (line && ctx.measureText(line + char).width > width) {
          lines.push(line);
          line = "";
        }
        line += char;
      }
      lines.push(line);
    }
    return lines;
  }

  async function noteImage(text, width, maxHeight, ownerDocument) {
    const scale = 2.5;
    const canvas = ownerDocument.createElement("canvas");
    const ctx = canvas.getContext("2d");
    ctx.font = "14px sans-serif";
    const lines = wrapLines(ctx, text, width - 24);
    const maxLines = Math.max(1, Math.floor((maxHeight - 46) / 19));
    if (lines.length > maxLines) {
      lines.length = maxLines;
      lines[maxLines - 1] += "…";
    }
    const height = Math.max(68, 46 + lines.length * 19);
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    ctx.scale(scale, scale);
    ctx.fillStyle = "#fff9df";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#c79b36";
    ctx.lineWidth = 1;
    ctx.strokeRect(.5, .5, width - 1, height - 1);
    ctx.fillStyle = "#efd785";
    ctx.fillRect(0, 0, width, 30);
    ctx.fillStyle = "#382c1e";
    ctx.font = "bold 14px sans-serif";
    ctx.fillText("批注", 12, 20);
    ctx.font = "14px sans-serif";
    lines.forEach((line, index) => ctx.fillText(line, 12, 50 + index * 19));
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("无法绘制文字批注");
    return { bytes: new Uint8Array(await blob.arrayBuffer()), height };
  }

  async function addSideNotes(document, page, notes, ownerDocument) {
    if (!notes.length) return;
    const media = page.getMediaBox(), crop = page.getCropBox();
    const width = Math.max(160, Math.min(300, crop.width * .43));
    const cardWidth = width - 24;
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    const entries = [];
    for (const note of notes.sort((a, b) => (a.y || 0) - (b.y || 0))) {
      if (note.text?.trim()) entries.push({ note,
        image: await noteImage(note.text, cardWidth,
          Math.max(32, crop.height - 24), ownerDocument) });
    }
    let column = 0;
    let nextTop = 12;
    for (const entry of entries) {
      const { note, image } = entry;
      const drawHeight = Math.min(image.height, Math.max(32, crop.height - 24));
      let top = Math.max(nextTop, Math.min((Number(note.y) || .05) * crop.height,
        crop.height - drawHeight - 10));
      if (top + drawHeight > crop.height - 10) {
        column++;
        nextTop = 12;
        top = nextTop;
      }
      entry.column = column;
      entry.top = top;
      entry.drawHeight = drawHeight;
      nextTop = top + drawHeight + 8;
    }
    if (rotation === 0 && entries.length) {
      const extra = width * (column + 1);
      page.setMediaBox(media.x, media.y, media.width + extra, media.height);
      page.setCropBox(crop.x, crop.y, crop.width + extra, crop.height);
    }
    for (const { note, image: imageData, column: cardColumn, top, drawHeight } of entries) {
      if (rotation === 0) {
        const image = await document.embedPng(imageData.bytes);
        page.drawImage(image, { x: crop.x + crop.width + cardColumn * width + 12,
          y: crop.y + crop.height - top - drawHeight,
          width: cardWidth, height: drawHeight });
      }
      // The full text also travels as a standard PDF note. Readers can open it
      // even if a long card is clipped or the source page is rotated.
      const markerX = rotation === 0 ? crop.x + crop.width + (cardColumn + 1) * width - 25 :
        crop.x + crop.width - 25;
      const markerY = crop.y + crop.height - Math.min(top + 24, crop.height - 20);
      addAnnotation(document, page, {
        Type: "Annot", Subtype: "Text",
        Rect: [markerX, markerY, markerX + 18, markerY + 18].map(round),
        Contents: PDFHexString.fromText(note.text),
        Name: "Comment", F: 4
      });
    }
  }

  const normalize = value => String(value || "").normalize("NFKC").toLocaleLowerCase()
    .replace(/[\s.,:;!?()[\]{}…—\-_\/\\|"'“”‘’、。，：；！？（）【】《》〈〉·]+/g, "");

  function webRect(items, viewport, title, fallback) {
    const wanted = normalize(title);
    if (wanted) for (let i = 0; i < items.length; i++) {
      let found = "";
      for (let j = i; j < Math.min(i + 12, items.length); j++) {
        found += normalize(items[j].str);
        if (found === wanted || (found.includes(wanted) && found.length < wanted.length * 1.4)) {
          const first = items[i], last = items[j];
          const start = viewport.convertToViewportPoint(first.transform[4], first.transform[5]);
          const end = viewport.convertToViewportPoint(last.transform[4], last.transform[5]);
          const height = Math.max(12, Number(first.height) || 12);
          return { x: Math.max(0, start[0]) / viewport.width,
            y: Math.max(0, start[1] - height) / viewport.height,
            w: Math.min(viewport.width, Math.max(36, end[0] + (last.width || 24) - start[0] + 24)) / viewport.width,
            h: Math.min(viewport.height, height + 8) / viewport.height };
        }
        if (found.length > wanted.length * 1.5) break;
      }
    }
    return { x: .75, y: Math.min(.9, .04 + fallback * .045), w: .2, h: .035 };
  }

  async function addWebLinks(document, page, links, viewport, textItems, font) {
    for (let index = 0; index < links.length; index++) {
      const link = links[index], url = safeUrl(link.url);
      if (!url) continue;
      const rect = webRect(textItems, viewport, link.title, index);
      const box = pdfRect(viewport, rect, page).box;
      addAnnotation(document, page, {
        Type: "Annot", Subtype: "Link", Rect: box.map(round),
        Border: [0, 0, 0], A: { S: "URI", URI: PDFString.of(url) }
      });
      page.drawText("WEB", { x: box[2] - 24, y: box[1] + 3,
        size: 8, font, color: rgb(.04, .38, .85) });
    }
  }

  async function buildVectorPdf(original, items, chapterLinks, pageViews, ownerDocument) {
    const document = await PDFDocument.load(original, { updateMetadata: false });
    const pages = document.getPages();
    let webFont = null;
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index], number = index + 1;
      const marks = items.filter(item => item.page === number &&
        ["highlight", "underline", "strike", "pen"].includes(item.type));
      const notes = items.filter(item => item.page === number && item.type === "box" && item.text?.trim());
      const links = chapterLinks.filter(link => link.page === number && safeUrl(link.url));
      if (!marks.length && !notes.length && !links.length) continue;
      const view = pageViews[index];
      const viewport = view?.viewport;
      for (const mark of marks) {
        if (mark.type === "pen") addInk(document, page, mark, viewport);
        else addTextMark(document, page, mark, viewport);
      }
      if (links.length) {
        webFont ||= await document.embedFont(StandardFonts.Helvetica);
        await addWebLinks(document, page, links, viewport, view?.textItems || [], webFont);
      }
      if (notes.length) await addSideNotes(document, page, notes, ownerDocument);
    }
    return document.save();
  }

  wn.prototype.buildVectorPdf = buildVectorPdf;

  wn.prototype.exportAnnotatedPdf = async function () {
    if (this.exportingPdf || !this.pdfDoc || !this.doc) return;
    this.exportingPdf = true;
    if (this.exportBtn) this.exportBtn.disabled = true;
    try {
      new it.Notice("正在导出 PDF，请稍等…", 4000);
      const website = this.plugin.conf.webPreview && this.plugin.conf.webSources?.[this.file.path];
      const chapterLinks = Array.isArray(website?.links) ? website.links : [];
      const activePages = new Set(this.doc.items.map(item => item.page));
      chapterLinks.forEach(link => activePages.add(link.page));
      const pageViews = [];
      for (const number of activePages) {
        if (!Number.isInteger(number) || number < 1 || number > this.pdfDoc.numPages) continue;
        const page = await this.pdfDoc.getPage(number);
        pageViews[number - 1] = { viewport: page.getViewport({ scale: 1 }),
          textItems: chapterLinks.some(link => link.page === number)
            ? (await page.getTextContent()).items.filter(item => item.str) : [] };
      }
      const source = await this.plugin.app.vault.readBinary(this.file);
      const bytes = await buildVectorPdf(source, this.doc.items, chapterLinks,
        pageViews, this.contentRoot.ownerDocument);
      const vault = this.plugin.app.vault;
      const base = this.file.path.replace(/\.pdf$/i, "");
      let path = `${base}-annotated.pdf`, suffix = 2;
      while (vault.getAbstractFileByPath(path)) path = `${base}-annotated-${suffix++}.pdf`;
      await vault.createBinary(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      new it.Notice(`已导出：${path}`);
    } catch (error) {
      console.error("[PDF Annotate] vector export failed", error);
      new it.Notice(`导出失败：${error.message || error}`);
    } finally {
      this.exportingPdf = false;
      if (this.exportBtn) this.exportBtn.disabled = false;
    }
  };

  wn.prototype.syncExportButton = function () {
    const group = this.group;
    if (!group) return;
    if (!this.plugin.conf.exportPdf) {
      this.exportBtn?.remove();
      this.exportBtn = null;
      return;
    }
    if (this.exportBtn?.isConnected) return;
    const button = group.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "da-native-tool clickable-icon da-export-pdf";
    button.title = "导出保留原文清晰度的批注 PDF";
    button.setAttribute("aria-label", button.title);
    it.setIcon(button, "share-2");
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      void this.exportAnnotatedPdf();
    });
    group.insertBefore(button, this.modeBtn?.nextSibling || group.firstChild);
    this.exportBtn = button;
  };

  const ensureToolbarButtons = wn.prototype.ensureToolbarButtons;
  wn.prototype.ensureToolbarButtons = function (group) {
    ensureToolbarButtons.call(this, group);
    this.syncExportButton();
  };
})();
