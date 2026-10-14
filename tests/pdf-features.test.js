const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PDFLib = require('../vendor/pdf-lib.min.js');

function feature(file, globals = {}) {
  class Overlay {}
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  vm.runInNewContext(source, { wn: Overlay, DaPdfLib: PDFLib,
    TextEncoder, Uint8Array, URL, console, it: {}, ...globals });
  return new Overlay();
}

test('distribution bundle initializes the embedded PDF library', () => {
  const bundle = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = bundle.indexOf('/* BEGIN pdf-lib 1.17.1 MIT */');
  const end = bundle.indexOf('/* END pdf-lib 1.17.1 MIT */', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.runInNewContext(bundle.slice(start, end) + ';globalThis.pdfDocument = DaPdfLib.PDFDocument;', context);
  assert.equal(typeof context.pdfDocument.create, 'function');
});

test('vector export preserves source text and adds native highlight, ink, note and link', async () => {
  const original = await PDFLib.PDFDocument.create();
  const font = await original.embedFont(PDFLib.StandardFonts.Helvetica);
  original.addPage([200, 300]).drawText('Searchable original text', {
    x: 20, y: 260, font, size: 12 });
  original.addPage([200, 300]).drawText('Untouched second page', {
    x: 20, y: 260, font, size: 12 });
  const source = await original.save();
  const overlay = feature('pdf-export.js');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL5YQAAAABJRU5ErkJggg==', 'base64');
  const ownerDocument = { createElement: () => ({
    getContext: () => ({ font: '', measureText: text => ({ width: text.length * 7 }),
      scale() {}, fillRect() {}, strokeRect() {}, fillText() {} }),
    toBlob: resolve => resolve(new Blob([png], { type: 'image/png' }))
  }) };
  const viewport = { width: 200, height: 300,
    convertToPdfPoint: (x, y) => [x, 300 - y],
    convertToViewportPoint: (x, y) => [x, 300 - y] };
  const result = await overlay.buildVectorPdf(source, [
    { type: 'highlight', page: 1, id: 'h1', color: '#ffff00',
      rects: [{ x: .1, y: .1, w: .3, h: .05 }] },
    { type: 'pen', page: 1, id: 'p1', color: '#0000ff', width: 2,
      points: [{ x: .2, y: .3 }, { x: .4, y: .4 }] },
    { type: 'box', page: 1, id: 'b1', text: 'Side note', y: .2 }
  ], [{ title: 'Chapter', page: 1, url: 'https://example.com/chapter' }],
  [{ viewport, textItems: [] }], ownerDocument);
  if (process.env.PDF_EXPORT_QA_PATH) fs.writeFileSync(process.env.PDF_EXPORT_QA_PATH, result);
  const reader = await PDFLib.PDFDocument.load(result);
  assert.equal(reader.getPageCount(), 2);
  assert.equal(reader.getPage(0).getWidth(), 360);
  assert.equal(reader.getPage(1).getWidth(), 200);
  const annots = reader.getPage(0).node.Annots();
  assert.equal(annots.size(), 4);
  const names = Array.from({ length: annots.size() }, (_, index) =>
    reader.context.lookup(annots.get(index)).get(PDFLib.PDFName.of('Subtype')).toString());
  assert.deepEqual(names.sort(), ['/Highlight', '/Ink', '/Link', '/Text']);
  assert.equal(reader.getPage(1).node.Annots().size(), 0);
});

test('several side notes flow into another margin column instead of clipping', async () => {
  const original = await PDFLib.PDFDocument.create();
  original.addPage([200, 300]);
  const overlay = feature('pdf-export.js');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL5YQAAAABJRU5ErkJggg==', 'base64');
  const ownerDocument = { createElement: () => ({
    getContext: () => ({ font: '', measureText: text => ({ width: text.length * 7 }),
      scale() {}, fillRect() {}, strokeRect() {}, fillText() {} }),
    toBlob: resolve => resolve(new Blob([png], { type: 'image/png' }))
  }) };
  const notes = Array.from({ length: 5 }, (_, index) => ({
    type: 'box', page: 1, id: String(index), text: `Note ${index + 1}`, y: .05 + index * .02
  }));
  const output = await overlay.buildVectorPdf(await original.save(), notes, [], [], ownerDocument);
  const reader = await PDFLib.PDFDocument.load(output);
  assert.equal(reader.getPage(0).getWidth(), 520);
  assert.equal(reader.getPage(0).node.Annots().size(), 5);
});

test('website chapter matching keeps only successful titles', () => {
  const overlay = feature('web-chapters.js');
  const anchors = [
    { title: '第 一 章：方法', url: 'https://example.com/chapter-1' },
    { title: '第二章 结果', url: 'https://example.com/chapter-2' },
  ];
  assert.equal(overlay.matchWebChapter('第一章 方法', anchors),
    'https://example.com/chapter-1');
  assert.equal(overlay.matchWebChapter('第三章 讨论', anchors), null);
});

test('automatic matching requests HTML once and returns only matched URLs', async () => {
  let requests = 0;
  const anchors = [
    { getAttribute: key => key === 'href' ? '/chapter-1' : null, textContent: '第一章 方法' },
    { getAttribute: key => key === 'href' ? '/other' : null, textContent: '关于我们' },
  ];
  class Parser { parseFromString() { return { querySelectorAll: () => anchors }; } }
  const overlay = feature('web-chapters.js', { DOMParser: Parser,
    it: { requestUrl: async () => { requests++; return { text: '<html>...</html>' }; } } });
  const links = await overlay.matchWebSource('https://example.com/book', [
    { title: '第一章 方法', page: 2 }, { title: '第二章 结果', page: 5 }
  ]);
  assert.equal(requests, 1);
  assert.equal(links.length, 1);
  assert.equal(links[0].url, 'https://example.com/chapter-1');
});
