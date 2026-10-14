/* Experimental website links for PDF outline chapters. The fetched HTML is
 * parsed in memory once; plugin data stores only the source URL and matches.
 */
(() => {
  const normalize = value => String(value || "").normalize("NFKC").toLocaleLowerCase()
    .replace(/[\s.,:;!?()[\]{}…—\-_\/\\|"'“”‘’、。，：；！？（）【】《》〈〉·]+/g, "");

  function httpUrl(raw) {
    try {
      const url = new URL(String(raw).trim());
      return ["https:", "http:"].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  }

  function flattenOutline(nodes, result = []) {
    for (const node of nodes || []) {
      if (node.title && node.dest) result.push({ title: node.title, dest: node.dest });
      flattenOutline(node.items, result);
    }
    return result;
  }

  function findChapterUrl(title, anchors) {
    const wanted = normalize(title);
    if (wanted.length < 3) return null;
    let best = null, bestScore = 0;
    for (const anchor of anchors) {
      const label = normalize(anchor.title);
      if (!label) continue;
      const score = label === wanted ? 3 :
        label.includes(wanted) || (wanted.includes(label) && label.length >= 4)
          ? Math.min(label.length, wanted.length) / Math.max(label.length, wanted.length)
          : 0;
      if (score > bestScore && score >= .75) {
        best = anchor.url;
        bestScore = score;
      }
    }
    return best;
  }

  wn.prototype.matchWebChapter = findChapterUrl;

  wn.prototype.getWebOutlineEntries = async function () {
    if (!this.pdfDoc) return [];
    const entries = [];
    for (const node of flattenOutline(await this.pdfDoc.getOutline())) {
      try {
        const dest = typeof node.dest === "string"
          ? await this.pdfDoc.getDestination(node.dest) : node.dest;
        if (!Array.isArray(dest)) continue;
        const page = typeof dest[0] === "number" ? dest[0] + 1
          : await this.pdfDoc.getPageIndex(dest[0]) + 1;
        if (Number.isInteger(page) && page > 0 && page <= this.pdfDoc.numPages) {
          entries.push({ title: node.title, page });
        }
      } catch (error) {
        console.warn("[PDF Annotate] skipped an outline entry", error);
      }
    }
    return entries;
  };

  wn.prototype.matchWebSource = async function (sourceUrl, entries) {
    const base = httpUrl(sourceUrl);
    if (!base) throw new Error("请填写有效的 http 或 https 网址");
    const response = await it.requestUrl({ url: base });
    const html = new DOMParser().parseFromString(response.text, "text/html");
    const anchors = Array.from(html.querySelectorAll("a[href]"), anchor => {
      try {
        const url = new URL(anchor.getAttribute("href"), base);
        if (!["http:", "https:"].includes(url.protocol) || url.origin !== new URL(base).origin) return null;
        return { title: (anchor.textContent || anchor.getAttribute("aria-label") ||
          anchor.getAttribute("title") || "").trim(), url: url.href };
      } catch { return null; }
    }).filter(Boolean);
    // No HTML, DOM tree, or unmatched site URLs are persisted.
    return entries.flatMap(entry => {
      const url = findChapterUrl(entry.title, anchors);
      return url ? [{ title: entry.title, page: entry.page, url }] : [];
    });
  };

  wn.prototype.saveWebSource = async function (source) {
    this.plugin.conf.webSources ||= {};
    this.plugin.conf.webSources[this.file.path] = {
      url: source.url,
      autoMatch: !!source.autoMatch,
      links: source.links.filter(link => httpUrl(link.url)).map(link => ({
        title: link.title, page: link.page, url: httpUrl(link.url)
      }))
    };
    await this.plugin.saveSettings();
    await this.loadWebChapters();
  };

  wn.prototype.loadWebChapters = async function () {
    const generation = this.webChapterGeneration = (this.webChapterGeneration || 0) + 1;
    this.webChapters = [];
    this.webPreviewEl?.remove();
    this.webPreviewEl = null;
    this.contentRoot?.querySelectorAll(".da-web-chapter-markers").forEach(node => node.remove());
    if (!this.plugin.conf.webPreview || !this.pdfDoc || this.destroyed) return;
    let source = this.plugin.conf.webSources?.[this.file.path];
    if (!source) return;
    if (typeof source === "string") {
      // One-time migration from the earlier setting that held only a URL.
      const entries = await this.getWebOutlineEntries();
      if (generation !== this.webChapterGeneration || this.destroyed) return;
      let links = [];
      try { links = await this.matchWebSource(source, entries); }
      catch (error) { console.warn("[PDF Annotate] legacy website matching failed", error); }
      if (generation !== this.webChapterGeneration || this.destroyed) return;
      await this.saveWebSource({ url: source, autoMatch: true, links });
      return;
    }
    this.webChapters = Array.isArray(source.links) ? source.links.filter(link =>
      link && typeof link.title === "string" && Number.isInteger(link.page) &&
      link.page > 0 && link.page <= this.pdfDoc.numPages && httpUrl(link.url)) : [];
    this.scheduleSync();
  };

  wn.prototype.openWebSourceDialog = async function () {
    if (!this.pdfDoc) return;
    const entries = await this.getWebOutlineEntries();
    if (this.destroyed) return;
    const existing = this.plugin.conf.webSources?.[this.file.path];
    const source = typeof existing === "string"
      ? { url: existing, autoMatch: true, links: [] }
      : existing || { url: "", autoMatch: true, links: [] };
    const modal = new it.Modal(this.app);
    modal.open();
    const content = modal.contentEl;
    content.empty();
    content.addClass("da-web-source-dialog");
    content.createEl("h3", { text: "网页章节链接（实验功能）" });
    content.createEl("p", { text: "输入这份 PDF 对应的网页。自动匹配只读取一次网页 HTML，保存匹配成功的章节网址。" });
    const urlInput = content.createEl("input", { attr: { type: "url", placeholder: "https://example.com/book" } });
    urlInput.value = source.url || "";
    urlInput.setAttribute("aria-label", "关联网页地址");
    const option = content.createEl("label", { cls: "da-web-source-option" });
    const autoInput = option.createEl("input", { attr: { type: "checkbox" } });
    autoInput.checked = source.autoMatch !== false;
    option.createSpan({ text: "自动按 PDF 目录标题匹配网页目录" });
    const manual = content.createDiv({ cls: "da-web-source-manual" });
    manual.createEl("p", { text: "关闭自动匹配后，可为每章手动填写网址；留空的章节不会显示或导出。" });
    const previous = new Map((source.links || []).map(link => [`${link.page}:${link.title}`, link.url]));
    const fields = entries.map(entry => {
      const row = manual.createDiv({ cls: "da-web-source-row" });
      row.createSpan({ text: `${entry.title} · 第 ${entry.page} 页` });
      const input = row.createEl("input", { attr: { type: "url", placeholder: "https://…" } });
      input.value = previous.get(`${entry.page}:${entry.title}`) || "";
      return { entry, input };
    });
    const showManual = () => manual.style.display = autoInput.checked ? "none" : "";
    autoInput.addEventListener("change", showManual);
    showManual();
    const status = content.createEl("p", { cls: "da-web-source-status" });
    if (!entries.length) status.textContent = "这份 PDF 没有可用目录，无法建立章节链接。";
    else if (source.links?.length) status.textContent = `已保存 ${source.links.length} 个章节网址。`;
    const actions = content.createDiv({ cls: "da-web-source-actions" });
    const save = actions.createEl("button", { text: "保存" });
    save.addClass("mod-cta");
    save.addEventListener("click", async () => {
      const url = httpUrl(urlInput.value);
      if (!url) { status.textContent = "请填写有效的 http 或 https 网页地址。"; return; }
      if (!entries.length) return;
      save.disabled = true;
      try {
        let links;
        if (autoInput.checked) {
          status.textContent = "正在读取网页目录并匹配…";
          links = await this.matchWebSource(url, entries);
        } else {
          links = [];
          for (const { entry, input } of fields) {
            if (!input.value.trim()) continue;
            const chapterUrl = httpUrl(input.value);
            if (!chapterUrl) throw new Error(`「${entry.title}」的网址无效`);
            links.push({ ...entry, url: chapterUrl });
          }
        }
        await this.saveWebSource({ url, autoMatch: autoInput.checked, links });
        new it.Notice(`已保存 ${links.length} 个章节网址`);
        modal.close();
      } catch (error) {
        status.textContent = `保存失败：${error.message || error}`;
      } finally { save.disabled = false; }
    });
    const clear = actions.createEl("button", { text: "清除关联" });
    clear.addEventListener("click", async () => {
      delete this.plugin.conf.webSources?.[this.file.path];
      await this.plugin.saveSettings();
      await this.loadWebChapters();
      modal.close();
    });
  };

  function titlePosition(layer, title) {
    const wanted = normalize(title);
    const spans = Array.from(layer.querySelectorAll("span"));
    for (let i = 0; i < spans.length; i++) {
      let found = "";
      for (let j = i; j < Math.min(i + 12, spans.length); j++) {
        found += normalize(spans[j].textContent);
        if (found === wanted || (found.includes(wanted) && found.length < wanted.length * 1.4)) {
          return spans[j].getBoundingClientRect();
        }
        if (found.length > wanted.length * 1.5) break;
      }
    }
    return null;
  }

  wn.prototype.placeWebChapterMarkers = function (pageIndex, pageEl) {
    const existing = pageEl.querySelector(":scope > .da-web-chapter-markers");
    const chapters = this.webChapters?.filter(entry => entry.page === pageIndex + 1) || [];
    if (!chapters.length) { existing?.remove(); return; }
    const layer = this.findTextLayer(pageEl);
    if (!layer) return;
    const pageRect = pageEl.getBoundingClientRect();
    const signature = JSON.stringify(chapters) + `:${pageRect.width}:${pageRect.height}`;
    if (existing?.dataset.signature === signature) return;
    existing?.remove();
    const markerLayer = pageEl.ownerDocument.createElement("div");
    markerLayer.className = "da-web-chapter-markers";
    markerLayer.dataset.signature = signature;
    for (const chapter of chapters) {
      const rect = titlePosition(layer, chapter.title);
      if (!rect) continue;
      const button = pageEl.ownerDocument.createElement("button");
      button.type = "button";
      button.className = "da-web-chapter-marker";
      button.style.left = Math.min(pageRect.width - 30, Math.max(4, rect.right - pageRect.left + 8)) + "px";
      button.style.top = Math.max(2, rect.top - pageRect.top) + "px";
      button.title = `预览网页章节：${chapter.title}`;
      button.setAttribute("aria-label", button.title);
      it.setIcon(button, "external-link");
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        this.showWebChapterPreview(chapter, button);
      });
      markerLayer.appendChild(button);
    }
    if (markerLayer.childElementCount) pageEl.appendChild(markerLayer);
  };

  wn.prototype.showWebChapterPreview = function (chapter, button) {
    this.webPreviewEl?.remove();
    const doc = button.ownerDocument;
    const panel = doc.createElement("div");
    panel.className = "da-web-preview";
    const header = doc.createElement("div");
    header.className = "da-web-preview-header";
    const title = doc.createElement("span");
    title.textContent = chapter.title;
    const external = doc.createElement("a");
    external.href = chapter.url;
    external.target = "_blank";
    external.rel = "noopener noreferrer";
    external.textContent = "在浏览器打开";
    const expand = doc.createElement("button");
    expand.type = "button";
    expand.textContent = "放大";
    expand.addEventListener("click", () => {
      panel.classList.toggle("is-expanded");
      expand.textContent = panel.classList.contains("is-expanded") ? "缩小" : "放大";
    });
    const close = doc.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "关闭网页预览");
    close.addEventListener("click", () => { panel.remove(); this.webPreviewEl = null; });
    header.append(title, external, expand, close);
    const iframe = doc.createElement("iframe");
    iframe.src = chapter.url;
    iframe.title = `网页预览：${chapter.title}`;
    iframe.setAttribute("sandbox", "allow-same-origin allow-scripts allow-forms allow-popups");
    panel.append(header, iframe);
    doc.body.appendChild(panel);
    const rect = button.getBoundingClientRect();
    panel.style.left = Math.max(8, Math.min(rect.right + 8, doc.documentElement.clientWidth - panel.offsetWidth - 8)) + "px";
    panel.style.top = Math.max(8, Math.min(rect.top, doc.documentElement.clientHeight - panel.offsetHeight - 8)) + "px";
    this.webPreviewEl = panel;
  };

  wn.prototype.syncWebSourceButton = function () {
    const group = this.group;
    if (!group) return;
    if (!this.plugin.conf.webPreview) {
      this.webSourceBtn?.remove();
      this.webSourceBtn = null;
      return;
    }
    if (this.webSourceBtn?.isConnected) return;
    const button = group.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "da-native-tool clickable-icon da-web-source-tool";
    button.title = "网页章节链接（实验功能）";
    button.setAttribute("aria-label", button.title);
    it.setIcon(button, "globe-2");
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      void this.openWebSourceDialog();
    });
    group.appendChild(button);
    this.webSourceBtn = button;
  };

  const ensureToolbarButtons = wn.prototype.ensureToolbarButtons;
  wn.prototype.ensureToolbarButtons = function (group) {
    ensureToolbarButtons.call(this, group);
    this.syncWebSourceButton();
  };
  const init = wn.prototype.init;
  wn.prototype.init = async function () {
    await init.call(this);
    if (!this.destroyed) void this.loadWebChapters();
  };
  const syncPage = wn.prototype.syncPage;
  wn.prototype.syncPage = async function (index, pageEl) {
    await syncPage.call(this, index, pageEl);
    if (!this.destroyed && pageEl.isConnected) this.placeWebChapterMarkers(index, pageEl);
  };
  const destroy = wn.prototype.destroy;
  wn.prototype.destroy = function () {
    this.webChapterGeneration = (this.webChapterGeneration || 0) + 1;
    this.webPreviewEl?.remove();
    this.webPreviewEl = null;
    this.contentRoot?.querySelectorAll(".da-web-chapter-markers").forEach(node => node.remove());
    destroy.call(this);
  };
})();
