// Format the shipped bundle without changing its JavaScript syntax.
// Requires TypeScript (`npm install --no-save typescript`) or TYPESCRIPT_PATH.
const fs = require('node:fs');
const path = require('node:path');

let ts;
try {
  ts = require(process.env.TYPESCRIPT_PATH || 'typescript');
} catch {
  throw new Error('TypeScript formatter not found. Install typescript or set TYPESCRIPT_PATH.');
}

const file = path.resolve(__dirname, '..', 'main.js');
let original = fs.readFileSync(file, 'utf8');
let parsed = ts.createSourceFile(file, original, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
if (parsed.parseDiagnostics.length) {
  throw new Error(`Cannot format a bundle with ${parsed.parseDiagnostics.length} parse errors.`);
}

// The embedded pdf.js worker is one enormous string literal. Split its source
// representation into small literals while keeping the decoded value exact.
let workerLiteral;
function findWorker(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'yn' &&
      node.initializer && ts.isStringLiteral(node.initializer) &&
      node.initializer.text.length > 100_000) {
    workerLiteral = node.initializer;
  }
  ts.forEachChild(node, findWorker);
}
findWorker(parsed);
if (workerLiteral) {
  const start = workerLiteral.getStart(parsed);
  const end = workerLiteral.end;
  const chunks = workerLiteral.text.match(/[\s\S]{1,2048}/g) || [];
  const replacement = chunks.map(chunk => JSON.stringify(chunk)
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')).join(' +\n');
  original = original.slice(0, start) + replacement + original.slice(end);
  parsed = ts.createSourceFile(file, original, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  if (parsed.parseDiagnostics.length) throw new Error('Worker string split produced a parse error.');
}

// TypeScript's formatter keeps the original line layout. The shipped bundle
// is minified, so first add line breaks only at boundaries identified by its
// parser. No text inside a string, regex or template literal is touched.
const breaks = new Set();
function addBreak(position) {
  if (position > 0 && position < original.length &&
      original[position - 1] !== '\n' && original[position] !== '\n') {
    breaks.add(position);
  }
}
function visit(node) {
  if (ts.isStatement(node) && !ts.isBlock(node)) addBreak(node.end);
  if (ts.isClassElement(node)) addBreak(node.end);
  if (ts.isBlock(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    const open = ts.isBlock(node) ? node.getStart(parsed) : original.lastIndexOf('{', node.members.pos);
    if (open >= 0) addBreak(open + 1);
    addBreak(node.end - 1);
  }
  if (ts.isObjectLiteralExpression(node) && node.end - node.getStart(parsed) > 120) {
    addBreak(node.getStart(parsed) + 1);
    addBreak(node.end - 1);
    for (let index = 0; index < node.properties.length - 1; index++) {
      const next = node.properties[index + 1];
      const comma = original.indexOf(',', node.properties[index].end);
      if (comma >= 0 && comma < next.pos) addBreak(comma + 1);
    }
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
let source = original;
for (const position of [...breaks].sort((a, b) => b - a)) {
  source = source.slice(0, position) + '\n' + source.slice(position);
}
const host = {
  getCompilationSettings: () => ({ allowJs: true, target: ts.ScriptTarget.ES2022 }),
  getScriptFileNames: () => [file],
  getScriptVersion: () => '0',
  getScriptSnapshot: name => name === file ? ts.ScriptSnapshot.fromString(source) : undefined,
  getCurrentDirectory: () => path.dirname(file),
  getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
};
const service = ts.createLanguageService(host);
const options = {
  indentSize: 2,
  tabSize: 2,
  convertTabsToSpaces: true,
  newLineCharacter: '\n',
  insertSpaceAfterCommaDelimiter: true,
  insertSpaceAfterSemicolonInForStatements: true,
  insertSpaceBeforeAndAfterBinaryOperators: true,
  insertSpaceAfterKeywordsInControlFlowStatements: true,
  insertSpaceAfterFunctionKeywordForAnonymousFunctions: true,
  insertSpaceBeforeFunctionParenthesis: false,
  placeOpenBraceOnNewLineForFunctions: false,
  placeOpenBraceOnNewLineForControlBlocks: false,
};
const edits = service.getFormattingEditsForDocument(file, options)
  .sort((a, b) => b.span.start - a.span.start);
let result = source;
for (const edit of edits) {
  result = result.slice(0, edit.span.start) + edit.newText +
    result.slice(edit.span.start + edit.span.length);
}
result = result.split('\n').map(line => line.trimEnd()).join('\n');
result = result.replace(/\n(?:[ \t]*\n)+/g, '\n');
if (!result.startsWith('// 发布用打包文件：前部包含第三方依赖，后部为插件逻辑；变量名已由原打包器缩短。')) {
  result = '// 发布用打包文件：前部包含第三方依赖，后部为插件逻辑；变量名已由原打包器缩短。\n' + result;
}
if (!result.includes('// Bundled pdf.js worker source; keep the concatenated value intact.')) {
  result = result.replace(/\n(?:\/\/ Bundled pdf\.js worker source; keep this string intact\.\n)?(var yn = )/, '\n// Bundled pdf.js worker source; keep the concatenated value intact.\n$1');
}
if (!result.includes('// PDF 原生阅读器的批注覆盖层与插件入口。')) {
  result = result.replace(/\n(var mt = )/, '\n// PDF 原生阅读器的批注覆盖层与插件入口。\n$1');
}
fs.writeFileSync(file, result, 'utf8');
console.log(`Added ${breaks.size} structural breaks and applied ${edits.length} formatting edits to main.js.`);
