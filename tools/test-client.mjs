// 客户端 bundle 的纯函数自检（不依赖浏览器 DOM / 网络）
// 运行：npm test   （node tools/test-client.mjs）
//
// 做法：给 client.js 提供最小化的 window/document/localStorage/fetch 桩，
// 捕获 window.__ModuleLoader__.load(...) 注册的工厂，再调用工厂拿到 exports，
// 然后断言 exports.__test 里的纯函数。这些函数是消息解析与编号的核心，回归风险最高。
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let captured = null
globalThis.window = {
  __ModuleLoader__: { load: (spec) => { captured = spec } },
  getSelection: () => null,
  addEventListener() {},
  removeEventListener() {},
  innerWidth: 1280,
  innerHeight: 800,
}
const fakeElement = () => ({
  style: {},
  className: '',
  textContent: '',
  dataset: {},
  classList: { add() {}, remove() {}, toggle() {} },
  setAttribute() {},
  getAttribute() { return null },
  appendChild() {},
  addEventListener() {},
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } },
})
globalThis.document = {
  createElement: fakeElement,
  createDocumentFragment: () => ({ appendChild() {} }),
  createTextNode: (t) => ({ nodeValue: t }),
  createTreeWalker: () => ({ nextNode: () => null }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
}
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.fetch = () => Promise.reject(new Error('offline (test)'))
globalThis.requestAnimationFrame = () => 0
globalThis.cancelAnimationFrame = () => {}
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.NodeFilter = { SHOW_TEXT: 4 }

// 以 data: URL 作为 ESM 加载 —— 源文件是"注册工厂"的脚本，不导出任何东西
await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(SOURCE))

assert.ok(captured, 'client.js 应调用 window.__ModuleLoader__.load(...)')
assert.equal(captured.id, 'dsh-quote-annotate-pro')
const api = captured.factory((name) => (name === 'react' ? {} : {}))
const { buildQuoteHeader, nextAnnotationNo, annotationNoOf, parseQuoteBlock, snippetOf, anchorLabelOf, roleText, docSourceLabel, pathOfFileAddress, fileNameOfPath, pathRelativeTo, docSourceOf, docProbes, buildDocNotesBatch, docNotesStore, docNotesStorageKey, noteWhereLabel } = api.__test

test('roleText / anchorLabelOf：轮次与角色文案', () => {
  assert.equal(roleText('assistant-step'), 'DSH 回复')
  assert.equal(roleText('user'), '你的消息')
  assert.equal(roleText(null, 'tool-call'), '工具调用')
  assert.equal(anchorLabelOf({ turn: 0, role: 'user' }), '第1轮 · 你的消息')
  assert.equal(anchorLabelOf({ turn: 4, kind: 'assistant-step' }), '第5轮 · DSH 回复')
  assert.equal(anchorLabelOf({}), '')
})

test('buildQuoteHeader：带编号 / 旧格式 / 空', () => {
  assert.equal(buildQuoteHeader({ turn: 4, role: 'assistant-step' }, 2), '【批注 2 · 第5轮 · DSH 回复】')
  assert.equal(buildQuoteHeader({ turn: 0, role: 'user' }), '【引用 · 第1轮 · 你的消息】')
  assert.equal(buildQuoteHeader({}, undefined), '')
})

test('nextAnnotationNo：草稿内编号（空 → 1，取最大 + 1）', () => {
  assert.equal(nextAnnotationNo(''), 1)
  assert.equal(nextAnnotationNo('你好'), 1)
  assert.equal(nextAnnotationNo('【批注 1 · 第3轮 · DSH 回复】\n原文'), 2)
  assert.equal(nextAnnotationNo('【批注 1 · 第1轮 · 你的消息】\nA\n\n批注：x\n\n【批注 3 · 第2轮 · DSH 回复】\nB'), 4)
  assert.equal(nextAnnotationNo('旧格式【引用 · 第1轮 · 你的消息】\n原文'), 1)
})

test('annotationNoOf：从位置行取编号（旧格式 → null）', () => {
  assert.equal(annotationNoOf('【批注 7 · 第3轮 · DSH 回复】'), 7)
  assert.equal(annotationNoOf('【批注 1 · 第1轮 · 你的消息（请按「Annotation 1：」格式回应）】'), 1)
  assert.equal(annotationNoOf('【引用 · 第1轮 · 你的消息】'), null)
  assert.equal(annotationNoOf(''), null)
})

test('parseQuoteBlock：新格式（原文 + 批注）', () => {
  const raw = '【批注 2 · 第5轮 · DSH 回复】\n选中的原文片段\n\n批注：这条不太对'
  const r = parseQuoteBlock(raw)
  assert.ok(r)
  assert.equal(r.no, 2)
  assert.equal(r.header, '【批注 2 · 第5轮 · DSH 回复】')
  assert.equal(r.quote, '选中的原文片段')
  assert.equal(r.comment, '这条不太对')
  assert.equal(r.before, '')
  assert.match(r.rest, /批注：这条不太对/)
})

test('parseQuoteBlock：多行原文 / 前置文本 / 旧格式', () => {
  const raw = '开头的一句话【引用 · 第2轮 · 你的消息】\n第一行\n第二行\n\n批注：补充说明\n结尾'
  const r = parseQuoteBlock(raw)
  assert.ok(r)
  assert.equal(r.no, null)
  assert.equal(r.before, '开头的一句话')
  assert.equal(r.quote, '第一行 第二行')
  assert.equal(r.comment, '补充说明')
  assert.match(r.rest, /结尾/)
})

test('parseQuoteBlock：解析不了时返回 null', () => {
  assert.equal(parseQuoteBlock('没有位置行的一段文字\n原文'), null)
  assert.equal(parseQuoteBlock('【批注 1 · 第1轮 · 你的消息】'), null)
  assert.equal(parseQuoteBlock(''), null)
})

test('snippetOf：输入框引用条只显示原文（不显示位置行/批注）', () => {
  assert.equal(snippetOf('【批注 1 · 第1轮 · 你的消息】\n选中的原文\n\n批注：这条不对'), '选中的原文')
  assert.equal(snippetOf('【引用 · 第2轮 · DSH 回复】\n> 旧格式原文'), '旧格式原文')
  assert.equal(snippetOf(''), '')
})

// ---------- 文档来源（本 fork 新增）：文件路径 / 地址解码 / 位置行 ----------

test('fileNameOfPath / pathRelativeTo：路径展示', () => {
  assert.equal(fileNameOfPath('D:\\a\\b\\测试文档.docx'), '测试文档.docx')
  assert.equal(fileNameOfPath('a/b/c.md'), 'c.md')
  assert.equal(fileNameOfPath(''), '')
  assert.equal(pathRelativeTo('D:\\ws\\sidebar-test\\测试文档.docx', 'D:\\ws'), 'sidebar-test\\测试文档.docx')
  assert.equal(pathRelativeTo('D:\\ws\\x.md', 'd:/WS/'), 'x.md')
  assert.equal(pathRelativeTo('E:\\other\\x.md', 'D:\\ws'), 'E:\\other\\x.md')
})

test('pathOfFileAddress：dsh-resource 地址解码', () => {
  assert.equal(pathOfFileAddress('dsh-resource://file/session/sess-1/docs/a%20b.md'), 'docs/a b.md')
  assert.equal(pathOfFileAddress('dsh-resource://file/absolute/D%3A/tmp/x.md'), 'D:/tmp/x.md')
  assert.equal(pathOfFileAddress('dsh-resource://file/other/x'), null)
  assert.equal(pathOfFileAddress('http://x'), null)
  assert.equal(pathOfFileAddress(undefined), null)
})

test('buildQuoteHeader：文档来源带路径与行号/页码，聊天格式不变', () => {
  const doc = { filePath: 'D:\\ws\\sidebar-test\\测试文档.docx' }
  // 测试环境拿不到会话 cwd → 按绝对路径展示
  assert.equal(buildQuoteHeader(doc, 1), '【批注 1 · 文件 · D:\\ws\\sidebar-test\\测试文档.docx】')
  assert.equal(buildQuoteHeader({ ...doc, line: 12 }, 2), '【批注 2 · 文件 · D:\\ws\\sidebar-test\\测试文档.docx:L12】')
  assert.equal(buildQuoteHeader({ ...doc, page: 3 }, 3), '【批注 3 · 文件 · D:\\ws\\sidebar-test\\测试文档.docx:p3】')
  // 聊天消息选区仍然只带轮次/角色（路径字段不参与）
  assert.equal(buildQuoteHeader({ turn: 2, role: 'user' }, 1), '【批注 1 · 第3轮 · 你的消息】')
})

test('docSourceLabel：无路径/无行号时退回旧形态', () => {
  assert.equal(docSourceLabel({}), '')
  assert.equal(docSourceLabel({ filePath: '' }), '')
  assert.equal(docSourceLabel({ filePath: 'D:\\ws\\a.md', line: 0 }), 'D:\\ws\\a.md')
})

test('parseQuoteBlock：文件来源的位置行同样可解析（原文/批注不受影响）', () => {
  const raw = '【批注 1 · 文件 · sidebar-test\\测试文档.docx】\n用于测试 better-sidebar 对 Word 文档的预览效果。\n\n批注：测试1 来自哪？'
  const r = parseQuoteBlock(raw)
  assert.ok(r)
  assert.equal(r.no, 1)
  assert.equal(r.quote, '用于测试 better-sidebar 对 Word 文档的预览效果。')
  assert.equal(r.comment, '测试1 来自哪？')
})

// ---------- 文档来源判定（最小 DOM 桩）：聊天选区不得产生文件来源 ----------

function matchesSelector(el, selector) {
  const part = String(selector || '').trim()
  const withValue = /^\[([\w-]+)="([^"]*)"\]$/.exec(part)
  if (withValue) return el.attrs != null && el.attrs[withValue[1]] === withValue[2]
  const presence = /^\[([\w-]+)\]$/.exec(part)
  if (presence) return el.attrs != null && Object.prototype.hasOwnProperty.call(el.attrs, presence[1])
  return false
}

function makeEl(attrs = {}, parent = null) {
  const el = {
    attrs,
    parentElement: parent,
    isConnected: true,
    contains(other) {
      let cur = other
      while (cur) {
        if (cur === el) return true
        cur = cur.parentElement
      }
      return false
    },
    closest(selector) {
      let cur = el
      while (cur) {
        for (const one of String(selector).split(',')) {
          if (matchesSelector(cur, one)) return cur
        }
        cur = cur.parentElement
      }
      return null
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null
    },
  }
  return el
}

test('docSourceOf：聊天选区 → null；预览选区 → 探针路径 / 地址兜底 / 行号', () => {
  // 1) 聊天消息选区：祖先链里没有任何预览容器 → 不产生文件来源
  const chatRow = makeEl({ 'data-chat-anchor-key': 'k1' })
  const chatText = makeEl({}, chatRow)
  assert.equal(docSourceOf(chatText), null)

  // 2) 文档预览：探针在头部、选区在正文，共同祖先是预览根 → 取探针登记的路径 + 行号
  const previewRoot = makeEl({ 'data-slot': 'sidebar.right.tab.document' }, document.body)
  const header = makeEl({}, previewRoot)
  const probeNode = makeEl({ 'data-dshq-doc-path': 'D:\\ws\\a.docx' }, header)
  const body = makeEl({}, previewRoot)
  const lineEl = makeEl({ 'data-textpreview-line': '12' }, body)
  const anchorEl = makeEl({}, lineEl)
  const entry = { node: probeNode, path: 'D:\\ws\\a.docx' }
  docProbes.add(entry)
  try {
    assert.deepEqual(docSourceOf(anchorEl), { path: 'D:\\ws\\a.docx', line: 12, page: null })
  } finally {
    docProbes.delete(entry)
  }

  // 3) 文本类兜底：没有探针时用 data-textpreview-url 的资源地址解码
  const textRoot = makeEl({ 'data-textpreview-url': 'dsh-resource://file/session/s1/docs/a%20b.md' }, document.body)
  const textEl = makeEl({}, textRoot)
  assert.equal(docSourceOf(textEl).path, 'docs/a b.md')
})


// ---------- 文件批注列表（本 fork 新增）：收集 → 展开/删除 → 全部发送 ----------

test('noteWhereLabel：页码优先、行号其次、都没有就不显示', () => {
  assert.equal(noteWhereLabel({ page: 3 }), '第3页')
  assert.equal(noteWhereLabel({ page: 0, line: 12 }), '第12行')
  assert.equal(noteWhereLabel({}), '')
  assert.equal(noteWhereLabel({ page: null, line: null }), '')
})

test('docNotesStorageKey：按会话 + 文件路径隔离', () => {
  assert.equal(docNotesStorageKey('s1', 'D:\\ws\\a.pdf'), 's1|D:\\ws\\a.pdf')
  assert.notEqual(docNotesStorageKey('s1', 'D:\\ws\\a.pdf'), docNotesStorageKey('s2', 'D:\\ws\\a.pdf'))
  assert.notEqual(docNotesStorageKey('s1', 'D:\\ws\\a.pdf'), docNotesStorageKey('s1', 'D:\\ws\\b.pdf'))
})

test('docNotesStore：添加 / 快照 / 删除 / 清空（跨文件隔离）', () => {
  const sid = 'test-session'
  const a = 'D:\\ws\\a.pdf'
  const b = 'D:\\ws\\b.docx'
  docNotesStore.clear(sid, a)
  docNotesStore.clear(sid, b)
  const first = docNotesStore.add(sid, a, { quote: '原文一', comment: '意见一', page: 2 })
  const second = docNotesStore.add(sid, a, { quote: '原文二', comment: '', line: 7 })
  assert.equal(docNotesStore.get(sid, a).length, 2)
  assert.equal(docNotesStore.get(sid, b).length, 0)
  assert.equal(first.quote, '原文一')
  assert.equal(second.line, 7)
  assert.deepEqual(docNotesStore.get(sid, a).map((n) => n.quote), ['原文一', '原文二'])
  assert.equal(docNotesStore.remove(sid, a, first.id), true)
  assert.deepEqual(docNotesStore.get(sid, a).map((n) => n.quote), ['原文二'])
  assert.equal(docNotesStore.clear(sid, a), 1)
  assert.equal(docNotesStore.get(sid, a).length, 0)
  assert.equal(docNotesStore.remove(sid, a, 'missing'), false)
})

test('buildDocNotesBatch：一次性发送的文本格式（编号 / 路径 / 页码行号 / 首条指令）', () => {
  const path = 'D:\\ws\\sidebar-test\\测试文档.pdf'
  const text = buildDocNotesBatch([
    { quote: '第一段原文', comment: '这条不对', page: 2 },
    { quote: '第二段原文', comment: '', line: 12 },
  ], { path })
  const expected = '【批注 1 · 文件 · ' + path + ':p2（请按「Annotation 1：」「Annotation 2：」…格式逐条回应我的批注）】'
    + '\n第一段原文\n\n批注：这条不对'
    + '\n\n【批注 2 · 文件 · ' + path + ':L12】\n第二段原文'
  assert.equal(text, expected)
  // 只处理有原文的条目；空列表返回空串
  assert.equal(buildDocNotesBatch([{ quote: '   ', comment: 'x' }], { path }), '')
  assert.equal(buildDocNotesBatch([], { path }), '')
  assert.equal(buildDocNotesBatch(null, { path }), '')
})

test('buildDocNotesBatch：第一条才有回复格式指令，且聊天来源不受影响', () => {
  const text = buildDocNotesBatch([
    { quote: 'A', comment: 'a' },
    { quote: 'B', comment: 'b' },
  ], { path: 'D:\\ws\\a.docx' })
  assert.equal((text.match(/请按「Annotation 1：」/g) || []).length, 1)
  assert.equal(text.indexOf('【批注 1 · 文件 · '), 0)
  assert.equal(text.includes('【批注 2 · 文件 · D:\\ws\\a.docx】'), true)
})

test('buildDocNotesBatch：startNo 接着输入框里已有编号（且不再插回复指令）', () => {
  const text = buildDocNotesBatch([{ quote: 'A', comment: '' }], { path: 'D:\\ws\\a.pdf', startNo: 4 })
  assert.equal(text.startsWith('【批注 4 · 文件 · D:\\ws\\a.pdf】'), true)
  assert.equal(text.includes('请按「Annotation 1：」'), false)
})

test('docNotesStore.update：编辑评语（保留原文；缺失 id 返回 false）', () => {
  const sid = 'test-edit-session'
  const path = 'D:\\ws\\edit.pdf'
  docNotesStore.clear(sid, path)
  const note = docNotesStore.add(sid, path, { quote: '原文', comment: '旧意见', page: 1 })
  assert.equal(docNotesStore.update(sid, path, note.id, { comment: '新意见' }), true)
  const after = docNotesStore.get(sid, path)[0]
  assert.equal(after.quote, '原文')
  assert.equal(after.comment, '新意见')
  assert.equal(docNotesStore.update(sid, path, 'missing', { comment: 'x' }), false)
})
