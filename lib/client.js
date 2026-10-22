// dsh-quote-annotate-pro —— Client 半区（浏览器）
// Fork of dsh-quote-annotate v0.1.1 (MIT, wangwei-wade) —— 增强：精确锚点 / 可观测性
// 上游 bundle 形态保留：window.__ModuleLoader__ 工厂式 CJS
//
// ⚠️ 开发注意（踩过的坑，改装饰逻辑前必读）
//   1) 装饰（把"【引用 · 第N轮 · 角色】+ 原文"重排成紧凑块）**绝不能破坏用户当前选区**：
//      一旦替换了用户正在划词的文本节点，range.getBoundingClientRect() 会退化成"贴文档原点"的矩形，
//      用它算出的位置正好是 left≈12/top≈8 —— 批注编辑框就跑到窗口左上角（0.2.8 的现象）。
//      因此：① 扫描时用 selectionTouches(row) 跳过用户正在划词的那条消息；
//            ② 编辑框定位一律走 anchorRect()：优先**当前活着的选区** → 校验过的旧矩形 → 视口底部居中。
//   2) 装饰必须是"幂等 + 只加样式类/包一层隐藏元素"，且判定要看**内容**（是否还有未接管的位置行），
//      不能只看 data-* 标记 —— 宿主会重排气泡内容，标记会骗人。
//   3) 所有装饰都要 try/catch 且不抛到 React 渲染路径上；观察者回调里同步执行（先于绘制）才不会闪。
window.__ModuleLoader__.load({
  id: 'dsh-quote-annotate-pro',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    let React = require('react')

    // ============ 诊断通道（开发期；探测不到本地接收端就本次运行静默） ============
    // 想彻底关闭：把 DIAG_ENABLED 改成 false（或注释掉 sendReport 的 fetch）。
    const DIAG_ENABLED = true
    const DIAG_URL = 'http://127.0.0.1:47821/dsh-quote-pro'
    let diagReady = null // null=探测中 true=可用 false=不可用
    const diagQueue = []
    function sendReport(text) {
      try {
        if (typeof fetch === 'function') {
          Promise.resolve(fetch(DIAG_URL, { method: 'POST', body: text, keepalive: true })).catch(() => {})
        }
      } catch (e) { /* ignore */ }
    }
    function report(tag, detail) {
      try {
        let text
        if (detail === undefined) text = tag
        else if (typeof detail === 'string') text = tag + ' ' + detail
        else {
          try { text = tag + ' ' + JSON.stringify(detail) } catch (e) { text = tag + ' <unserializable>' }
        }
        console.log('[quote-pro]', text)
        if (!DIAG_ENABLED || diagReady === false) return
        if (diagReady === null) {
          diagQueue.push(text)
          if (diagQueue.length > 60) diagQueue.shift()
          return
        }
        sendReport(text)
      } catch (e) { /* diagnostics must never throw */ }
    }
    if (DIAG_ENABLED && typeof fetch === 'function') {
      const pingOnce = () => {
        try {
          fetch(DIAG_URL + '/ping', { method: 'POST', body: 'ping' }).then(() => {
            if (diagReady === true) return
            diagReady = true
            const pending = diagQueue.splice(0)
            for (const text of pending) sendReport(text)
          }).catch(() => { diagReady = false })
        } catch (e) { diagReady = false }
      }
      pingOnce()
      // 接收端比页面晚启动也来得及：未就绪时每 5 秒重试探测；
      // 就绪后仍然每 20 秒心跳一次 —— 接收端中途挂掉（例如诊断进程被杀）也能自愈，不用刷新页面。
      try {
        let tick = 0
        const retryTimer = setInterval(() => {
          tick += 1
          if (diagReady !== true || tick % 4 === 0) pingOnce()
        }, 5000)
        // Node（自检脚本里 import 本模块）不会自己退出 → 解除引用；浏览器里返回的是数字，跳过
        if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref()
      } catch (e) { /* ignore */ }
    } else {
      diagReady = false
    }
    report('module:materialized', { id: 'dsh-quote-annotate-pro' })

    // ============ 引用锚点文案：让模型知道"这指的是哪一处" ============
    // role/kind 取自 DOM 的 data-chat-flow-kind，turn 取自 data-chat-turn（与 TurnLocation.turn 同源，0 基）
    function roleText(role, kind) {
      const k = role || kind
      if (k === 'user') return '你的消息'
      if (k === 'assistant-step' || k === 'assistant') return 'DSH 回复'
      if (k === 'tool-call') return '工具调用'
      if (k === 'steering') return '插话'
      if (k === 'turn-tail') return '回合结算'
      if (k === 'question-reply') return '你的答复'
      if (k === 'command' || k === 'command-input') return '命令'
      return k ? '消息(' + k + ')' : ''
    }
    function anchorLabelOf(item) {
      const parts = []
      if (item && typeof item.turn === 'number' && Number.isFinite(item.turn)) parts.push('第' + (item.turn + 1) + '轮')
      const role = roleText(item && item.role, item && item.kind)
      if (role !== '') parts.push(role)
      return parts.join(' · ')
    }
    /** 引用块首行：模型据此确定"这是第几处批注、哪一轮、谁说的（或来自哪个文件）"。 */
    function buildQuoteHeader(item, no) {
      const label = anchorLabelOf(item)
      const doc = docSourceLabel(item)
      const numbered = typeof no === 'number' && Number.isFinite(no) && no > 0
      const parts = [numbered ? '批注 ' + no : '引用']
      if (label !== '') parts.push(label)
      // 文档预览选区没有消息行锚点，位置行改带「文件 · <路径>[:L行|:p页]」
      if (doc !== '') {
        parts.push('文件')
        parts.push(doc)
      }
      // 老格式（无编号且无位置信息）保持空串，避免出现只有「【引用】」的块
      if (parts.length === 1 && parts[0] === '引用') return ''
      return '【' + parts.join(' · ') + '】'
    }
    /** 批注编号：同一条消息内从 1 开始；删掉中间某条不会重号（取现有最大号 + 1）。 */
    function nextAnnotationNo(draft) {
      let max = 0
      try {
        const text = String(draft || '')
        const re = /【批注\s*(\d+)/g
        let m
        while ((m = re.exec(text)) !== null) {
          const n = Number(m[1])
          if (Number.isFinite(n) && n > max) max = n
        }
      } catch (e) { /* ignore */ }
      return max + 1
    }
    /** 位置行（兼容旧格式「【引用 · …】」与新格式「【批注 N · …】」；中间分隔符可能是 " · "） */
    const QUOTE_HEADER_RE = /【(?:引用|批注)[^\n】]*】/
    /** 从位置行里取批注编号（旧格式「【引用 · …】」没有编号，返回 null） */
    function annotationNoOf(headerText) {
      const m = /^【批注\s*(\d+)/.exec(String(headerText || ''))
      if (!m) return null
      const n = Number(m[1])
      return Number.isFinite(n) && n > 0 ? n : null
    }
    /**
     * 把「位置行 + 原文（空行）批注：…」拆成结构化块 —— 纯函数，单测与渲染共用：
     *   { before, header, no, quote, comment, rest }
     * 解析不了（没有位置行/没有原文）返回 null。
     */
    function parseQuoteBlock(raw) {
      const text = String(raw || '')
      const m = QUOTE_HEADER_RE.exec(text)
      if (!m) return null
      const after = text.slice(m.index + m[0].length)
      const nl = after.indexOf('\n')
      if (nl < 0) return null
      const lines = after.slice(nl + 1).split('\n')
      // 引用正文 = 位置行之后、直到空行之前的连续非空行（兼容旧格式的 "> " 前缀）
      const quote = []
      let i = 0
      for (; i < lines.length; i++) {
        if (lines[i].trim() === '') break
        quote.push(lines[i].replace(/^>\s?/, ''))
      }
      if (quote.length === 0) return null
      const rest = lines.slice(i).join('\n')
      let comment = ''
      const cm = /(?:^|\n)\s*批注[:：]\s*([^\n]*)/.exec(rest)
      if (cm) comment = cm[1].trim()
      return {
        before: text.slice(0, m.index),
        header: m[0],
        no: annotationNoOf(m[0]),
        quote: quote.join(' '),
        comment,
        rest,
      }
    }

    // ============ 锚点持久化：刷新后 chip 仍能跳回原文 ============
    // key: dsh-quote-pro:ref:<sessionId> -> { <ref>: { anchorKey, body, label, at } }
    const STORE_PREFIX = 'dsh-quote-pro:ref:'
    function loadRefMap(sessionId) {
      try {
        const raw = localStorage.getItem(STORE_PREFIX + sessionId)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch (e) { return null }
    }
    function saveRef(sessionId, ref, info) {
      try {
        const map = loadRefMap(sessionId) || {}
        map[ref] = { anchorKey: info.anchorKey || null, body: info.body || '', label: info.label || '', at: Date.now() }
        const keys = Object.keys(map)
        if (keys.length > 60) {
          keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0))
          for (const k of keys.slice(0, keys.length - 60)) delete map[k]
        }
        localStorage.setItem(STORE_PREFIX + sessionId, JSON.stringify(map))
      } catch (e) { /* 存储不可用不影响主流程 */ }
    }
    function hydrateRefs(sessionId) {
      const map = loadRefMap(sessionId)
      if (!map) return 0
      let n = 0
      for (const ref of Object.keys(map)) {
        if (refTargets.has(ref)) continue
        const info = map[ref] || {}
        refTargets.set(ref, { sessionId, anchorKey: info.anchorKey || null, body: info.body || '', label: info.label || '', restored: true })
        n += 1
      }
      if (n > 0) report('refs:hydrated', { sessionId: String(sessionId).slice(0, 8), count: n })
      return n
    }
    // 每次页面运行使用独立前缀，避免刷新后新 ref 与历史 ref 撞号
    const REF_RUN = Math.random().toString(36).slice(2, 6)


    // ============ chip 插入：走官方 session 事件（本版本 shell.insertReference 由它驱动） ============
    // 注意：这里必须直接对传入的 Cordis 上下文调用 .emit —— 写成 ctx.ctx 会触发
    // 「cannot get property "ctx" without inject」守卫错误（本插件未声明该 inject）。
    function emitInsertReference(emitCtx, input, before, reference) {
      if (!emitCtx || typeof emitCtx.emit !== 'function') return false
      if (!before || before.draftRev === undefined) return false
      try {
        emitCtx.emit('slash/input-insert-reference', {
          reference,
          span: { draftRev: before.draftRev, start: (before.draft || '').length, end: (before.draft || '').length },
        })
      } catch (e) {
        report('emit:throw', String((e && e.stack) || (e && e.message) || e))
        return false
      }
      const after = input.state.getSnapshot()
      return after.draftRev !== before.draftRev
    }

    // ============ 模块级状态 ============
    let rootCtx = null
    let currentSessionId = null
    let refSeq = 0
    let pipelineAvailable = null // null=未知 false=不可用 true=可用
    // 引用 source 的注册函数（懒加载 + 重试）：服务晚就绪、HMR 重载后仍能恢复 chip 插入
    let ensureQuoteSource = null
    // ref -> { sessionId, anchorKey, body, label } 用于点击 chip 跳回原文 / 悬停显示原文
    const refTargets = new Map()
    // ref -> { body, clipboardText } 提交时经 codec 序列化
    const refCodecs = new Map()
    // 输入框引用装饰的"立即执行"钩子：插入后马上贴样式，避免先露出旧样子再变（用户反馈的瞬间闪烁）
    let composerDecorateNow = null
    // 诊断用：最近一次插入引用的时刻（毫秒），用于测"装饰相对插入晚了多久"
    let lastInsertAt = 0

    // 页面内反馈 toast（点击 chip 时显示结果）
    const toastStore = {
      text: '',
      pos: null, // { left, top }
      ok: false,
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        this.listeners.forEach((fn) => fn())
      },
      show(text, pos, ok) {
        this.text = text
        this.pos = pos
        this.ok = !!ok
        this.emit()
      },
      hide() {
        if (!this.text) return
        this.text = ''
        this.pos = null
        this.emit()
      },
    }

    function useToast() {
      const [, force] = React.useState(0)
      React.useEffect(() => toastStore.subscribe(() => force((v) => v + 1)), [])
      return toastStore
    }

    // ============ 选区浮动小气泡 store ============
    const selectionStore = {
      visible: false,
      text: '',
      rect: null,
      anchorKey: null,
      filePath: null, // 文档预览选区：来源文件（绝对路径）
      line: null, // 文本类预览：选区起始行号
      page: null, // PDF/Office 预览：页码
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        this.listeners.forEach((fn) => fn())
      },
      show(info) {
        this.visible = true
        this.text = info.text
        this.rect = info.rect
        this.anchorKey = info.anchorKey || null
        // 位置信息必须一起存：否则 stage() 读到的 turn/kind 恒为 null，引用块首行就空了
        this.turn = typeof info.turn === 'number' && Number.isFinite(info.turn) ? info.turn : null
        this.kind = info.kind || null
        // 文档来源（聊天消息选区恒为 null）
        this.filePath = typeof info.filePath === 'string' && info.filePath !== '' ? info.filePath : null
        this.line = typeof info.line === 'number' && Number.isFinite(info.line) ? info.line : null
        this.page = typeof info.page === 'number' && Number.isFinite(info.page) ? info.page : null
        this.emit()
      },
      hide() {
        if (!this.visible) return
        this.visible = false
        this.emit()
      },
    }

    function useSelection() {
      const [, force] = React.useState(0)
      React.useEffect(() => selectionStore.subscribe(() => force((v) => v + 1)), [])
      return selectionStore
    }

    // ============ 悬浮批注编辑框 store（单条，锚定在对应文字附近） ============
    const editorStore = {
      item: null, // { sessionId, label, text, anchorKey }
      rect: null,
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        this.listeners.forEach((fn) => fn())
      },
      open(item, rect) {
        this.item = item
        this.rect = rect
        this.emit()
      },
      close() {
        if (!this.item) return
        this.item = null
        this.rect = null
        this.emit()
      },
    }

    function useEditor() {
      const [, force] = React.useState(0)
      React.useEffect(() => editorStore.subscribe(() => force((v) => v + 1)), [])
      return editorStore
    }

    // ============ 引用悬停提示 store ============
    const tooltipStore = {
      visible: false,
      text: '',
      label: '',
      rect: null,
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        this.listeners.forEach((fn) => fn())
      },
      show(info) {
        this.visible = true
        this.text = info.text
        this.label = info.label
        this.rect = info.rect
        this.emit()
      },
      hide() {
        if (!this.visible) return
        this.visible = false
        this.emit()
      },
    }

    function useTooltip() {
      const [, force] = React.useState(0)
      React.useEffect(() => tooltipStore.subscribe(() => force((v) => v + 1)), [])
      return tooltipStore
    }

    // ============ 样式注入（静态包环境：直接操作 document） ============
    function insertStyleSheet(css) {
      const tag = document.createElement('style')
      tag.textContent = css
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    // ============ 文本工具 ============
    function textBlocksToText(blocks, kindField, typeValue) {
      const parts = []
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b && b[kindField] === typeValue && typeof b.text === 'string' && b.text.trim() !== '') {
            parts.push(b.text.trim())
          }
        }
      }
      return parts.join('\n\n')
    }

    function clipText(text, max) {
      if (text.length <= max) return text
      return text.slice(0, max) + '\n…（已截断）'
    }

    const MAX_QUOTE = 1500
    const MAX_SELECTION = 2000

    // ============ 文档来源（第二类锚点）：侧栏预览里划词时带上文件路径 ============
    // 聊天消息的锚点是 data-chat-anchor-key（消息行），轮次/角色也来自消息行；
    // 文档预览里没有消息行，选区的"来源"只能是文件本身 —— 因此把文件路径写进引用块位置行，
    // 让模型知道原文出自哪个文件（以及文本类的行号 / PDF·Office 的页码）。
    //
    // 路径来源优先级：
    //   ① 预览头部探针（`sidebar.right.tab.document.actions` 槽的 owner prop `absolutePath`，
    //      覆盖 docx / pdf / xlsx / 图片 / md / code 全部渲染器）；
    //   ② 文本类预览根节点自带的 `data-textpreview-url`（`dsh-resource://` 地址，本地解码）。
    // 两者都拿不到时（旧版本没有该槽、侧栏被第三方接管等）path 为 null，
    // 位置行退回旧的「【批注 N】」形态 —— 不报错、不阻塞、不影响聊天批注。
    const DOC_PATH_STYLE = 'relative' // 'relative'：工作区内显示相对会话 cwd 的路径；'absolute'：一律绝对路径
    const docProbes = new Set() // { node, path }

    function fileNameOfPath(p) {
      const s = String(p || '')
      const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
      return i < 0 ? s : s.slice(i + 1)
    }

    /** dsh-resource://file/session/<sessionId>/<path> | …/absolute/<path> → 本地路径（仅解码，不保证存在） */
    function pathOfFileAddress(address) {
      try {
        const prefix = 'dsh-resource://file/'
        if (typeof address !== 'string' || address.indexOf(prefix) !== 0) return null
        const segments = address.slice(prefix.length).split('/')
        const scope = segments[0]
        const tail = scope === 'session' ? segments.slice(2) : scope === 'absolute' ? segments.slice(1) : null
        if (!tail) return null
        const path = tail.map((segment) => {
          try { return decodeURIComponent(segment) } catch (e) { return segment }
        }).join('/')
        return path === '' ? null : path
      } catch (e) { return null }
    }

    function sessionCwd(sessionId) {
      try {
        const sessions = rootCtx ? rootCtx.get('sessions') : undefined
        const list = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list.getSnapshot() : undefined
        const row = list && list.byId && sessionId ? list.byId[sessionId] : undefined
        return row && typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : null
      } catch (e) { return null }
    }

    /** 纯函数：把 target 相对 root 化（Windows 分隔符；不在 root 下则原样返回） */
    function pathRelativeTo(target, root) {
      if (!target || !root) return target
      try {
        const normalize = (s) => String(s).replace(/\//g, '\\').replace(/\\+$/, '')
        const t = normalize(target)
        const r = normalize(root)
        if (t.toLowerCase() === r.toLowerCase()) return fileNameOfPath(t)
        if (t.toLowerCase().indexOf((r + '\\').toLowerCase()) === 0) return t.slice(r.length + 1)
      } catch (e) { /* ignore */ }
      return target
    }

    /** 模型/用户看到的路径：工作区内给相对 cwd 的路径（默认），工作区外保持绝对路径 */
    function displayPathOf(path) {
      if (!path) return ''
      if (DOC_PATH_STYLE !== 'relative') return path
      try {
        const cwd = sessionCwd(currentSessionId)
        if (!cwd) return path
        return pathRelativeTo(path, cwd)
      } catch (e) { /* ignore */ }
      return path
    }

    /** 文档来源的位置行片段：相对/绝对路径 + 行号（文本类）或页码（PDF/Office） */
    function docSourceLabel(item) {
      const path = item && item.filePath
      if (!path) return ''
      let out = displayPathOf(path)
      if (typeof item.line === 'number' && Number.isFinite(item.line) && item.line > 0) out += ':L' + item.line
      else if (typeof item.page === 'number' && Number.isFinite(item.page) && item.page > 0) out += ':p' + item.page
      return out
    }

    /**
     * 选区是否落在文档预览里；是则返回 { path, line, page }，否则 null。
     * 判定顺序：先看探针（不依赖任何 data-* 命名，`absolutePath` 命中即算预览），
     * 再退回预览容器的 DOM 标记；聊天消息选区两者都不命中，直接返回 null —— 聊天批注完全不受影响。
     */
    function docSourceOf(anchorEl) {
      if (!anchorEl || typeof anchorEl.closest !== 'function') return null
      let path = null
      try {
        // 探针节点在预览头部，选区在预览正文：向上找到同时包含两者的祖先，即同一 tab
        for (const probe of docProbes) {
          const node = probe && probe.node
          if (!node || !node.isConnected) continue
          let el = node.parentElement || node
          while (el && el !== document.body) {
            if (typeof el.contains === 'function' && el.contains(anchorEl)) { path = probe.path; break }
            el = el.parentElement
          }
          if (path) break
        }
      } catch (e) { path = null }
      let inPreview = path !== null
      if (!inPreview) {
        try {
          inPreview = !!(anchorEl.closest('[data-slot="sidebar.right.tab.document"]') ||
            anchorEl.closest('[data-textpreview-url]') ||
            anchorEl.closest('[data-pdf-preview]') ||
            anchorEl.closest('[data-pdf-page]'))
        } catch (e) { inPreview = false }
      }
      if (!inPreview) return null
      try {
        // 兜底：文本类预览的根节点自带资源地址（探针没覆盖时）
        if (!path) {
          const urlEl = anchorEl.closest('[data-textpreview-url]')
          if (urlEl) path = pathOfFileAddress(urlEl.getAttribute('data-textpreview-url'))
        }
      } catch (e) { path = null }
      let line = null
      let page = null
      try {
        const lineEl = anchorEl.closest('[data-textpreview-line]')
        if (lineEl) {
          const n = Number(lineEl.getAttribute('data-textpreview-line'))
          if (Number.isFinite(n) && n > 0) line = n
        }
        const pageEl = anchorEl.closest('[data-pdf-page]')
        if (pageEl) {
          const n = Number(pageEl.getAttribute('data-pdf-page'))
          if (Number.isFinite(n) && n > 0) page = n
        }
      } catch (e) { /* ignore */ }
      return { path: path || null, line, page }
    }

    // ============ 文件批注列表（docx / pdf / xlsx 等"不可编辑预览"专用） ============
    // 可编辑预览（milkdown / sidebar-editor、聊天输入框）在 selectionchange 阶段就被忽略了，
    // 所以能走到这里的文档选区都来自不可编辑的官方预览。
    // 这些选区不立即写输入框，而是按「会话 + 文件绝对路径」攒在列表里：
    //   预览头部「批注 · N」按钮 → 面板（单条展开 / 删除 / 清空）→「全部发送」一次性插入输入框。
    // 数据存 localStorage，刷新/切 tab 不丢；聊天消息选区仍然走原来的"立即插入"。
    const DOC_NOTES_PREFIX = 'dsh-quote-pro:doc-notes:'
    const MAX_DOC_NOTES = 200

    function docNotesStorageKey(sessionId, path) {
      return String(sessionId || '') + '|' + String(path || '')
    }

    function loadDocNotes(key) {
      try {
        const raw = localStorage.getItem(DOC_NOTES_PREFIX + key)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        const notes = []
        for (const item of parsed) {
          if (!item || typeof item.quote !== 'string' || item.quote === '') continue
          notes.push({
            id: typeof item.id === 'string' && item.id !== '' ? item.id : 'n' + Math.random().toString(36).slice(2, 10),
            quote: item.quote,
            comment: typeof item.comment === 'string' ? item.comment : '',
            line: typeof item.line === 'number' && Number.isFinite(item.line) ? item.line : null,
            page: typeof item.page === 'number' && Number.isFinite(item.page) ? item.page : null,
            at: typeof item.at === 'number' ? item.at : 0,
          })
        }
        return notes
      } catch (e) { return [] }
    }

    function saveDocNotes(key, notes) {
      try {
        if (!Array.isArray(notes) || notes.length === 0) localStorage.removeItem(DOC_NOTES_PREFIX + key)
        else localStorage.setItem(DOC_NOTES_PREFIX + key, JSON.stringify(notes))
      } catch (e) { /* 存储不可用不影响主流程 */ }
    }

    const docNotesStore = {
      map: new Map(), // key -> notes[]
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        for (const fn of this.listeners) {
          try { fn() } catch (e) { /* ignore */ }
        }
      },
      get(sessionId, path) {
        const key = docNotesStorageKey(sessionId, path)
        let notes = this.map.get(key)
        if (notes === undefined) {
          notes = loadDocNotes(key)
          this.map.set(key, notes)
        }
        return notes
      },
      snapshot(sessionId, path) {
        return this.get(sessionId, path).slice()
      },
      add(sessionId, path, note) {
        const notes = this.get(sessionId, path)
        const record = {
          id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          quote: String((note && note.quote) || ''),
          comment: String((note && note.comment) || ''),
          line: note && typeof note.line === 'number' && Number.isFinite(note.line) ? note.line : null,
          page: note && typeof note.page === 'number' && Number.isFinite(note.page) ? note.page : null,
          at: Date.now(),
        }
        notes.push(record)
        if (notes.length > MAX_DOC_NOTES) notes.splice(0, notes.length - MAX_DOC_NOTES)
        saveDocNotes(docNotesStorageKey(sessionId, path), notes)
        this.emit()
        return record
      },
      remove(sessionId, path, id) {
        const notes = this.get(sessionId, path)
        const index = notes.findIndex((item) => item && item.id === id)
        if (index < 0) return false
        notes.splice(index, 1)
        saveDocNotes(docNotesStorageKey(sessionId, path), notes)
        this.emit()
        return true
      },
      /** 编辑一条批注（目前只改评语；quote 是原文快照，不允许改） */
      update(sessionId, path, id, patch) {
        const notes = this.get(sessionId, path)
        const note = notes.find((item) => item && item.id === id)
        if (!note) return false
        if (patch && typeof patch.comment === 'string') note.comment = patch.comment
        saveDocNotes(docNotesStorageKey(sessionId, path), notes)
        this.emit()
        return true
      },
      clear(sessionId, path) {
        const notes = this.get(sessionId, path)
        const count = notes.length
        if (count === 0) return 0
        notes.splice(0, notes.length)
        saveDocNotes(docNotesStorageKey(sessionId, path), notes)
        this.emit()
        return count
      },
    }

    /** 文档预览探针的挂载/卸载通知（用于底部批注条跟随当前打开的预览 tab） */
    const docPreviewStore = {
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        for (const fn of this.listeners) {
          try { fn() } catch (e) { /* ignore */ }
        }
      },
    }

    // 底部批注条的状态诊断（只在状态变化时上报一次，便于排"浮条没出现"）
    let lastDocBarReport = ''

    /**
     * 把一批文件批注格式化成"一次性发送"的文本（纯函数，单测覆盖）。
     * 沿用现有位置行协议：每条一个【批注 N · 文件 · <路径>[:p页|:L行]】块，
     * 第一条内嵌回复格式指令 —— 模型侧与回复侧 Annotation N 芯片都不需要改动。
     */
    function buildDocNotesBatch(notes, options) {
      const list = Array.isArray(notes) ? notes : []
      const path = options && options.path ? options.path : ''
      const startNo = options && typeof options.startNo === 'number' && Number.isFinite(options.startNo) && options.startNo > 0
        ? Math.floor(options.startNo)
        : 1
      const blocks = []
      let no = startNo - 1
      for (const note of list) {
        if (!note || typeof note.quote !== 'string' || note.quote.trim() === '') continue
        no += 1
        let header = buildQuoteHeader({ filePath: path, line: note.line, page: note.page }, no)
        if (no === 1 && header !== '') {
          header = header.replace(/】$/, '（请按「Annotation 1：」「Annotation 2：」…格式逐条回应我的批注）】')
        }
        const comment = String(note.comment || '').trim()
        const commentLine = comment === '' ? '' : '\n\n批注：' + comment
        blocks.push((header === '' ? '' : header + '\n') + note.quote.trim() + commentLine)
      }
      return blocks.join('\n\n')
    }

    /** 解析当前会话的输入框句柄（文件批注"全部发送"与普通插入共用） */
    function resolveComposerInput(sessionId) {
      try {
        const conversation = rootCtx ? rootCtx.get('conversation') : undefined
        const sessions = rootCtx ? rootCtx.get('sessions') : undefined
        if (!conversation || !conversation.input || !sessions) return { error: 'conversation/sessions 服务不可用' }
        const sid = sessionId || resolveSessionId()
        if (!sid) return { error: '拿不到当前会话，请在对话区里点一下再重试' }
        const binding = sessions.binding(sid)
        if (!binding) return { error: '会话不可用' }
        return { sessionId: sid, input: conversation.input.for(binding.ctx) }
      } catch (e) {
        return { error: String((e && e.message) || e) }
      }
    }

    /** 把一段文本追加到输入框草稿（保留已有内容，末尾对齐成空行分隔） */
    function appendDraftText(input, body) {
      const snapshot = input.state.getSnapshot()
      const base = (snapshot.draft || '').replace(/[\s\u00A0]+$/, '')
      const nextDraft = base === '' ? body : base + '\n\n' + body
      input.setDraft(nextDraft)
      try { if (typeof composerDecorateNow === 'function') composerDecorateNow() } catch (e) { /* ignore */ }
      return nextDraft
    }

    // 从 Chat 快照中提取某一轮的用户提问文本与最终 AI 回答文本。
    // 本版本（0.2.0-rc.1）的真实形状：
    //   snapshot.nodes 是 Map（不是数组）、身份字段是 anchorSeq（不是 seq）、
    //   user 文本在 node.data.content[{type:'text'}]、assistant-step 在 node.data.blocks[{kind:'text'}]。
    function extractTurnTexts(chat, turnLoc) {
      const empty = { userText: '', assistantText: '' }
      try {
        if (!chat || !turnLoc || typeof turnLoc.turn !== 'number') return empty
        const turn = turnLoc.turn
        const endSeq = turnLoc.end ? turnLoc.end.seq : Number.POSITIVE_INFINITY
        let prevEnd = 0
        if (chat.turnEnds && typeof chat.turnEnds.forEach === 'function') {
          chat.turnEnds.forEach((seq, t) => {
            if (typeof t === 'number' && typeof seq === 'number' && t < turn && seq > prevEnd) prevEnd = seq
          })
        }
        const nodes = chat.nodes
        if (!nodes) return empty
        const userParts = []
        let assistantText = ''
        let assistantSeq = -1
        const visit = (node) => {
          if (!node || typeof node.anchorSeq !== 'number') return
          if (node.anchorSeq <= prevEnd || node.anchorSeq > endSeq) return
          const data = node.data || {}
          if (node.kind === 'user' || node.kind === 'steering') {
            const text = textBlocksToText(data.content, 'type', 'text')
            if (text !== '') userParts.push(text)
          } else if (node.kind === 'assistant-step') {
            if (typeof data.turn === 'number' && data.turn !== turn) return
            if (node.anchorSeq > assistantSeq) {
              const text = textBlocksToText(data.blocks, 'kind', 'text')
              if (text !== '') {
                assistantSeq = node.anchorSeq
                assistantText = text
              }
            }
          }
        }
        const keys = chat.locations && typeof chat.locations.getTurn === 'function' ? chat.locations.getTurn(turn) : null
        if (Array.isArray(keys) && typeof nodes.get === 'function') {
          for (const key of keys) visit(nodes.get(key))
        } else if (typeof nodes.forEach === 'function') {
          nodes.forEach(visit)
        }
        return { userText: userParts.join('\n\n'), assistantText }
      } catch (e) {
        report('turnTail:extract-throw', String((e && e.message) || e))
        return empty
      }
    }

    // 解析某一轮里指定类型消息行的 DOM 锚点 key（= ChatNode.key，即 data-chat-anchor-key）
    function anchorKeyFor(chat, turn, kind, closingSeq) {
      try {
        if (!chat || !chat.locations || !chat.nodes) return null
        const keys = chat.locations.getTurn(turn) || []
        let fallback = null
        let prefer = null
        for (const key of keys) {
          const node = chat.nodes.get(key)
          if (!node || node.kind !== kind) continue
          fallback = key
          if (kind === 'user') return key
          if (kind === 'assistant-step') {
            const finalSeq = node.data && node.data.finalNode ? node.data.finalNode.seq : undefined
            if (typeof closingSeq === 'number' && finalSeq === closingSeq) prefer = key
          }
        }
        return prefer || fallback
      } catch (e) {
        return null
      }
    }

    // ============ 跳转与提示（模块级：dock 导航条与旧 chip 处理共用） ============
    let notifyTimer = null
    function notify(text, pos, ok) {
      try {
        report('toast', (ok ? 'ok | ' : 'err | ') + text)
        toastStore.show(text, pos, ok)
        if (notifyTimer) clearTimeout(notifyTimer)
        notifyTimer = setTimeout(() => toastStore.hide(), 2600)
      } catch (e) { /* ignore */ }
    }
    /** 跳到某个锚点行并高亮它。opts.silent=true 时不弹成功提示（高亮本身就是反馈）。 */
    function jumpToAnchorKey(anchorKey, pos, opts) {
      if (!anchorKey) return false
      let row = null
      for (const r of document.querySelectorAll('[data-chat-anchor-key]')) {
        if (r.getAttribute('data-chat-anchor-key') === anchorKey) { row = r; break }
      }
      if (!row) {
        notify('跳转失败：原文不在当前页面（可能切了会话或还没加载）', pos, false)
        report('jump:miss', { anchorKey })
        return false
      }
      row.scrollIntoView({ block: 'center', behavior: 'smooth' })
      row.classList.add('dshq-flash')
      setTimeout(() => row.classList.remove('dshq-flash'), 1600)
      if (!(opts && opts.silent)) notify('已跳转到原文 ✓', pos, true)
      report('jump:ok', { anchorKey })
      return true
    }
    /** 按 ref 跳回原文：优先用锚点键，退化到按引用正文反查。 */
    function jumpToRef(ref, pos, opts) {
      const info = refTargets.get(ref)
      if (!info) {
        notify('跳转失败：找不到该引用（可能已发送或已删除）', pos, false)
        return false
      }
      let anchorKey = info.anchorKey || null
      if (!anchorKey && info.body) {
        const probe = String(info.body)
          .split('\n')
          .map((line) => line.replace(/^【(?:引用|批注)[^\n]*】\s*/, '').replace(/^> ?/, ''))
          .join('\n')
          .trim()
          .slice(0, 24)
        for (const r of document.querySelectorAll('[data-chat-anchor-key]')) {
          if (probe && r.textContent && r.textContent.indexOf(probe) !== -1) {
            anchorKey = r.getAttribute('data-chat-anchor-key')
            break
          }
        }
      }
      if (!anchorKey) {
        notify('跳转失败：没有定位键（选中时未识别到消息行）', pos, false)
        return false
      }
      return jumpToAnchorKey(anchorKey, pos, opts)
    }
    /**
     * 按引用正文片段跳回原文（输入框里紧凑引用块点击时用）：
     * 输入框里的引用是纯文本，没有 ref/anchorKey，因此用正文片段在消息行里反查。
     */
    function jumpByQuoteText(text, pos) {
      const probe = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 24)
      if (probe === '') return false
      for (const r of document.querySelectorAll('[data-chat-anchor-key]')) {
        const t = String(r.textContent || '').replace(/\s+/g, ' ')
        if (t.indexOf(probe) !== -1) {
          r.scrollIntoView({ block: 'center', behavior: 'smooth' })
          r.classList.add('dshq-flash')
          setTimeout(() => r.classList.remove('dshq-flash'), 1600)
          report('cmp:jump', { anchorKey: r.getAttribute('data-chat-anchor-key') })
          return true
        }
      }
      notify('跳转失败：原文不在当前页面（可能切了会话或还没加载）', pos, false)
      return false
    }

    /**
     * 按 chip 的 title（= 我们插入时写入的 label）反查 ref。
     * 本版本 chip 没有 data-* 属性，但 ReferenceChip 会把 label 渲染成 title，
     * 因此 title 是最可靠的 DOM 侧标识，不必按 CSS 类猜顺序。
     */
    function refByLabel(label) {
      if (typeof label !== 'string' || label === '') return null
      const wanted = label.trim()
      // 同名的 chip label 可能出现多次（每条消息的编号都从 1 开始）——
      // refTargets 按插入顺序排列，取最后一个命中项（最近插入的那条）
      let found = null
      for (const [ref, info] of refTargets) {
        if (info && typeof info.label === 'string' && info.label.trim() === wanted) found = ref
      }
      if (found !== null) return found
      // 退化：只按 `引用#N` 前缀匹配（label 可能被截断显示）
      const short = wanted.split('·')[0].trim()
      if (short.startsWith('引用#')) {
        for (const [ref, info] of refTargets) {
          if (info && typeof info.label === 'string' && info.label.trim().startsWith(short)) return ref
        }
      }
      return null
    }

    // 按 occurrenceId 解析引用（chip 点击跳转 / 悬停提示共用）
    function resolveOccurrence(occId) {
      try {
        const conversation = rootCtx ? rootCtx.get('conversation') : undefined
        const sessions = rootCtx ? rootCtx.get('sessions') : undefined
        if (!conversation || !conversation.input || !sessions) return null
        const trySession = (sessionId) => {
          if (!sessionId) return null
          const binding = sessions.binding(sessionId)
          if (!binding) return null
          const input = conversation.input.for(binding.ctx)
          const occurrences = input.state.getSnapshot().occurrences || []
          const found = occurrences.find((o) => o.occurrenceId === occId) || null
          // 刷新后 ref → 锚点映射从 localStorage 复原（上游此映射仅存内存，刷新即失效）
          if (found && found.source === 'quote-ref' && !refTargets.has(found.ref)) hydrateRefs(sessionId)
          return found
        }
        let occ = trySession(currentSessionId)
        if (!occ) {
          for (const refKey of refTargets.keys()) {
            const info = refTargets.get(refKey)
            if (!info || !info.sessionId) continue
            occ = trySession(info.sessionId)
            if (occ) break
          }
        }
        if (!occ || occ.source !== 'quote-ref') return null
        return { occ, info: refTargets.get(occ.ref) }
      } catch (e) {
        return null
      }
    }

    // ============ 链条目选择器：仅在已结束且无交付文件的回合挂载 ============
    function selectTurnQuote(owner) {
      if (!owner || !owner.turn || !owner.turn.end) return null
      const delivered = owner.turn.data ? owner.turn.data.get('deliverables') : undefined
      if (delivered && Array.isArray(delivered.produced) && delivered.produced.length > 0) return null
      return { turn: owner.turn.turn }
    }

    function rectOf(e) {
      try {
        const r = e.currentTarget.getBoundingClientRect()
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      } catch (err) {
        return null
      }
    }

    // ============ 组件一：回合尾部的引用按钮（点击直接打开悬浮编辑框） ============
    const TurnQuoteActions = (props) => {
      // 本版本该轮文本在 Chat 快照里（useChat），不在 session 快照里；
      // 且 nodes 是 Map、身份字段是 anchorSeq —— 上游按数组 + seq 读，永远取空，所以按钮不出现。
      const chat = typeof props.useChat === 'function' ? props.useChat((s) => s) : undefined
      const texts = React.useMemo(() => extractTurnTexts(chat, props.turn), [chat, props.turn])
      if (props.turn && !turnTailReported.has(props.turn.turn)) {
        turnTailReported.add(props.turn.turn)
        try {
          report('turnTail:render', {
            turn: props.turn.turn,
            hasChat: !!chat,
            nodeCount: chat && chat.nodes && typeof chat.nodes.size === 'number' ? chat.nodes.size : null,
            userChars: texts.userText.length,
            assistantChars: texts.assistantText.length,
            userAnchor: anchorKeyFor(chat, props.turn.turn, 'user', props.seq) || null,
            assistantAnchor: anchorKeyFor(chat, props.turn.turn, 'assistant-step', props.seq) || null,
          })
        } catch (e) { /* ignore */ }
      }
      const open = (e, role, label, text) => {
        noteSession(props.sessionId, 'turnTail')
        const anchorKey = anchorKeyFor(chat, props.turn.turn, role, props.seq)
        editorStore.open({ sessionId: props.sessionId, label, text, anchorKey, turn: props.turn.turn, kind: role === 'user' ? 'user' : 'assistant-step' }, rectOf(e))
      }
      const buttons = []
      if (texts.userText) {
        buttons.push(React.createElement('button', {
          key: 'user',
          type: 'button',
          className: 'dshq-btn',
          onClick: (e) => open(e, 'user', '引用提问 · 第 ' + (props.turn.turn + 1) + ' 轮', clipText(texts.userText, MAX_QUOTE)),
        }, '引用提问'))
      }
      if (texts.assistantText) {
        buttons.push(React.createElement('button', {
          key: 'assistant',
          type: 'button',
          className: 'dshq-btn',
          onClick: (e) => open(e, 'assistant', '引用回答 · 第 ' + (props.turn.turn + 1) + ' 轮', clipText(texts.assistantText, MAX_QUOTE)),
        }, '引用回答'))
      }
      if (buttons.length === 0) return null
      return React.createElement('div', { className: 'dshq-tail' }, buttons)
    }

    // ============ 当前会话解析 ============
    // 重要：本版本（0.1.6+）的会话列表快照没有 current 字段，读 s.current 恒为 undefined。
    // 可靠来源是「会话作用域槽位」回填的 sessionId（root 作用域的 shell.overlay 拿不到它），
    // 其次才是右侧栏 mounted 席位。
    let toolbarPropsReported = false
    let insertProbeDone = false
    const turnTailReported = new Set()
    /**
     * 零副作用插入探针：用过期 draftRev 发一次 insert-reference 事件。
     * shell.insertReference 会先做 CAS（span.draftRev !== rev → return false），
     * 因此不会改动草稿，但能验证"上下文可用 + 监听器会被派发"这条通路。
     */
    function probeInsertPath(sessionId) {
      if (insertProbeDone) return
      insertProbeDone = true
      try {
        const conversation = rootCtx ? rootCtx.get('conversation') : undefined
        const sessions = rootCtx ? rootCtx.get('sessions') : undefined
        const binding = sessions ? sessions.binding(sessionId) : undefined
        if (!conversation || !conversation.input || !binding) {
          report('probe:emit-skip', 'no conversation/binding')
          return
        }
        const input = conversation.input.for(binding.ctx)
        let emitCtx = binding.ctx
        let isScope = false
        try {
          if (typeof sessions.scope === 'function') {
            const scoped = sessions.scope(sessionId)
            if (scoped) { emitCtx = scoped; isScope = true }
          }
        } catch (e) { report('probe:scope-throw', String((e && e.message) || e)) }
        emitCtx.emit('slash/input-insert-reference', {
          reference: { source: 'quote-ref', ref: 'probe-noop', label: 'probe', clipboardText: 'probe' },
          span: { draftRev: -1, start: 0, end: 0 },
        })
        report('probe:emit-ok', { viaScope: isScope, draftRev: input.state.getSnapshot().draftRev })
      } catch (e) {
        report('probe:emit-throw', String((e && e.message) || e))
      }
    }
    function noteSession(id, via) {
      if (typeof id !== 'string' || id === '') return null
      if (currentSessionId !== id) {
        currentSessionId = id
        report('session:resolved', { id: id.slice(0, 8), via })
        setTimeout(() => { try { probeInsertPath(id) } catch (e) { /* ignore */ } }, 0)
      }
      return id
    }
    function resolveSessionId() {
      if (typeof currentSessionId === 'string' && currentSessionId !== '') return currentSessionId
      try {
        const sr = rootCtx ? rootCtx.get('sidebarRight') : undefined
        const snap = sr && sr.mounted && typeof sr.mounted.getSnapshot === 'function' ? sr.mounted.getSnapshot() : undefined
        if (noteSession(snap, 'sidebarRight.mounted')) return currentSessionId
      } catch (e) {
        report('session:sidebarRight-throw', String((e && e.message) || e))
      }
      return currentSessionId || null
    }

    // 会话作用域探针：注册进 conversation.input.dock —— 它在屏即代表该会话正在被查看
    const SessionProbe = (props) => {
      try { noteSession(props && props.sessionId, 'dock-probe') } catch (e) { /* ignore */ }
      return null
    }

    // ============ 组件二：鼠标选区浮动小气泡（点击「批注」打开悬浮编辑框） ============
    const SelectionToolbar = (props) => {
      const sel = useSelection()
      // 本版本会话列表快照没有 current 字段（读取恒为 undefined），
      // 所以这里只把 props 里可能存在的 sessionId 当线索，真正的来源是会话作用域探针。
      if (!toolbarPropsReported) {
        toolbarPropsReported = true
        try {
          report('env:overlay-props', {
            keys: Object.keys(props || {}),
            hasSessionId: typeof (props && props.sessionId) === 'string',
            hasUseSession: typeof (props && props.useSession) === 'function',
            hasUseSessions: typeof (props && props.useSessions) === 'function',
          })
        } catch (e) { /* ignore */ }
      }
      if (typeof props.sessionId === 'string' && props.sessionId !== '') currentSessionId = props.sessionId
      if (!sel.visible || !sel.rect) return null
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      // 气泡宽度随文字增长：估算 = 每字约13px + 按钮与留白约76px，封顶384px
      const est = Math.min(384, Math.max(120, sel.text.length * 13 + 76))
      const center = sel.rect.left + (sel.rect.right - sel.rect.left) / 2
      const left = Math.max(12, Math.min(center - est / 2, vw - est - 12))
      const top = sel.rect.top - 42 >= 8 ? sel.rect.top - 42 : sel.rect.bottom + 8
      const finish = () => {
        try {
          const s = window.getSelection()
          if (s && s.removeAllRanges) s.removeAllRanges()
        } catch (e) { /* ignore */ }
        selectionStore.hide()
      }
      const stage = () => {
        // 关键修复：不再要求"已解析到会话"才打开编辑框；解析不到也照常进入编辑，
        // 真正的会话在插入时再解析，避免整条链路因为拿不到 sessionId 而静默失效。
        const sid = resolveSessionId()
        const anchorLabel = anchorLabelOf({ turn: sel.turn, kind: sel.kind })
        const filePath = sel.filePath || null
        const line = typeof sel.line === 'number' ? sel.line : null
        const page = typeof sel.page === 'number' ? sel.page : null
        // 文档来源：编辑框标题显示「文件批注 · 文件名 · 第N页/行」；聊天来源保持「第N轮 · 角色」
        const docLabel = filePath ? docSourceLabel({ filePath, line, page }) : ''
        let openLabel = anchorLabel
        if (docLabel !== '') {
          let where = ''
          if (typeof page === 'number' && page > 0) where = ' · 第' + page + '页'
          else if (typeof line === 'number' && line > 0) where = ' · 第' + line + '行'
          openLabel = '文件批注 · ' + fileNameOfPath(filePath) + where
        }
        report('selection:stage', {
          anchorKey: sel.anchorKey || null,
          turn: typeof sel.turn === 'number' ? sel.turn : null,
          kind: sel.kind || null,
          sessionId: sid ? String(sid).slice(0, 8) : null,
          file: filePath ? fileNameOfPath(filePath) : null,
        })
        editorStore.open({
          sessionId: sid || null,
          label: openLabel === '' ? '选中文字' : '选中 · ' + openLabel,
          text: clipText(sel.text, MAX_SELECTION),
          anchorKey: sel.anchorKey,
          turn: sel.turn,
          kind: sel.kind,
          filePath,
          line,
          page,
        }, anchorRect(sel.rect))
        try {
          const r = anchorRect(sel.rect)
          report('editor:anchor', { src: r.__dshq === 'fallback' ? 'fallback' : (liveSelectionRect() ? 'live' : 'stored'), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right - r.left), Math.round(r.bottom - r.top)] })
        } catch (e) { /* ignore */ }
        finish()
      }
      return React.createElement('div', { className: 'dshq-toolbar', style: { left, top } },
        React.createElement('span', { className: 'dshq-toolbar-preview' }, sel.text),
        React.createElement('button', {
          type: 'button',
          className: 'dshq-btn dshq-primary dshq-bubble-cta',
          onMouseDown: (e) => e.preventDefault(),
          onClick: stage,
        }, '批注'),
        React.createElement('button', {
          type: 'button',
          className: 'dshq-btn dshq-close',
          onMouseDown: (e) => e.preventDefault(),
          onClick: finish,
        }, '✕'),
      )
    }

    // ============ 组件三：悬浮批注编辑框（评论输入框元素永久驻留，复用时输入法上下文不重建） ============
    /**
     * 选区矩形兜底。矩形失效（节点被装饰/重渲染替换后 getBoundingClientRect 会返回"文档原点附近"的退化矩形）
     * 时，直接用它会算出 left≈12 / top≈8 —— 编辑框就跑到窗口左上角（用户反馈的现象）。
     * 取值优先级：**当前还活着的选区** → 存下来的矩形（且看着正常）→ 视口底部居中。
     */
    function liveSelectionRect() {
      try {
        const s = typeof window !== 'undefined' ? window.getSelection() : null
        if (!s || s.rangeCount === 0 || s.isCollapsed) return null
        const r = s.getRangeAt(0).getBoundingClientRect()
        return plausibleRect(r) ? r : null
      } catch (e) { return null }
    }
    /** 排除"贴文档原点"的退化矩形：那是选区失效后的典型产物 */
    function plausibleRect(r) {
      if (!r) return false
      if (!(Number.isFinite(r.left) && Number.isFinite(r.top) && Number.isFinite(r.right) && Number.isFinite(r.bottom))) return false
      const w = r.right - r.left
      const h = r.bottom - r.top
      if (!(w > 0 || h > 0)) return false
      if (r.left < 24 && r.top < 24) return false           // 原点附近 → 视为失效
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      const vh = typeof window !== 'undefined' ? window.innerHeight : 768
      if (r.left > vw || r.top > vh) return false
      return true
    }
    function bottomCenterRect() {
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      const vh = typeof window !== 'undefined' ? window.innerHeight : 768
      const left = Math.max(12, Math.round(vw / 2 - 140))
      const top = Math.max(12, Math.round(vh - 200))
      return { left, right: left + 280, top, bottom: top + 24, width: 280, height: 24, __dshq: 'fallback' }
    }
    function anchorRect(stored) {
      const live = liveSelectionRect()
      if (live) return live
      if (plausibleRect(stored)) return stored
      return bottomCenterRect()
    }
    function safeRect(rect) {
      return anchorRect(rect)
    }

    const AnnotationEditor = () => {
      const state = useEditor()
      const inputRef = React.useRef(null)
      const [comment, setComment] = React.useState('')
      const [status, setStatus] = React.useState(null)
      React.useEffect(() => {
        setComment('')
        setStatus(null)
        if (state.item && inputRef.current) {
          // 同一元素重复聚焦：输入法记住的语言模式得以保留
          inputRef.current.focus()
        }
      }, [state.item])
      const open = !!(state.item && state.rect)
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      const vh = typeof window !== 'undefined' ? window.innerHeight : 768
      const item = state.item
      // 文档预览（docx/pdf/xlsx 等不可编辑预览）走"文件批注列表"，聊天消息仍走"立即插入"
      const docMode = !!(item && item.filePath)
      const rect = open ? anchorRect(state.rect) : null
      if (rect && rect.__dshq === 'fallback') {
        try { report('editor:anchor', { src: 'fallback' }) } catch (e) { /* ignore */ }
      }
      let left = -9999
      let top = -9999
      let w = 200
      if (open && rect) {
        // 宽度：默认约 10 字（120px），随评论输入变宽，封顶 340px
        const quoteW = Math.min(220, item.text.length * 12 + 16)
        const inputW = Math.min(300, Math.max(140, comment.length * 13 + 44))
        w = Math.max(120, Math.min(340, Math.max(quoteW, inputW)))
        const center = rect.left + (rect.right - rect.left) / 2
        left = Math.max(12, Math.min(center - w / 2, vw - w - 12))
        const estH = 200
        top = rect.bottom + 8 + estH <= vh - 8 ? rect.bottom + 8 : Math.max(8, rect.top - estH - 8)
      }
      const insert = () => {
        if (!open || !item) return
        try {
          const c = (comment || '').trim()
          // 文档预览（不可编辑预览）的批注：不写输入框，先进「文件批注列表」，
          // 由预览头部「批注 · N」面板统一查看 / 删除 / 一次性发送。
          if (item.filePath) {
            const sessionId = item.sessionId || resolveSessionId()
            if (!sessionId) {
              setStatus({ ok: false, text: '加入失败：拿不到当前会话，请在对话区点一下再重试' })
              return
            }
            docNotesStore.add(sessionId, item.filePath, {
              quote: item.text,
              comment: c,
              line: item.line,
              page: item.page,
            })
            const count = docNotesStore.get(sessionId, item.filePath).length
            report('doc-notes:add', { file: fileNameOfPath(item.filePath), count })
            setStatus({ ok: true, text: '已加入文件批注（' + count + ' 条），点头部「批注 · ' + count + '」统一发送' })
            setTimeout(() => { try { editorStore.close() } catch (e) { /* ignore */ } }, 900)
            return
          }
          const conversation = rootCtx ? rootCtx.get('conversation') : undefined
          const sessions = rootCtx ? rootCtx.get('sessions') : undefined
          if (!conversation || !conversation.input || !sessions) {
            setStatus({ ok: false, text: '写入输入框失败：conversation/sessions 服务不可用' })
            return
          }
          const sessionId = item.sessionId || resolveSessionId()
          if (!sessionId) {
            report('insert:no-session', {})
            setStatus({ ok: false, text: '写入失败：拿不到当前会话，请在对话区里点一下再重试' })
            return
          }
          const binding = sessions.binding(sessionId)
          if (!binding) {
            report('insert:no-binding', { sessionId: String(sessionId).slice(0, 8) })
            setStatus({ ok: false, text: '写入输入框失败：会话不可用' })
            return
          }
          const input = conversation.input.for(binding.ctx)
          const st = input.state.getSnapshot()
          // 编号：同一条消息内从 1 开始（删掉中间某条也不会重号）
          const no = nextAnnotationNo(st.draft)
          let header = buildQuoteHeader(item, no)
          // 首条批注的头部内嵌"回复格式"指令：头部在界面上被隐藏，但模型看得到
          if (no === 1 && header !== '') {
            header = header.replace(/】$/, '（请按「Annotation 1：」「Annotation 2：」…格式逐条回应我的批注）】')
          }
          // 引用正文不加 "> " 前缀（前缀会在编辑器里露出一截符号）；
          // 评语写进正文（空行 + 「批注：」前缀）：发送后整条消息自带"原文 + 评语"，回复侧才能对上号
          const commentLine = c === '' ? '' : '\n\n批注：' + c
          const quoteBody = header === '' ? item.text + commentLine : header + '\n' + item.text + commentLine
          const base = (st.draft || '').replace(/[\s\u00A0]+$/, '')
          // 直接写入**纯文本**（不再用 chip/occurrence）：输入框里由装饰折叠成紧凑引用块，
          // 与发送后的消息观感完全一致（用户明确要求"输入框里直接显示原文，不要 @批注 芯片"）。
          // 位置行保留在文本里给模型用，界面上由插件渲染时隐藏。
          const nextDraft = base === '' ? quoteBody : base + '\n\n' + quoteBody
          input.setDraft(nextDraft)
          report('insert:plaintext', {
            header,
            draftLen: nextDraft.length,
            bodyLen: quoteBody.length,
            pipeline: pipelineAvailable,
          })
          // 立刻给刚插入的内容贴样式，避免"先露出旧样子、稍后才变紧凑"的闪烁
          lastInsertAt = (typeof performance !== 'undefined' ? performance.now() : Date.now())
          try { if (typeof composerDecorateNow === 'function') composerDecorateNow() } catch (e) { /* ignore */ }
          setStatus({
            ok: true,
            text: '已插入引用 ✓' + (item.filePath
              ? '（来源：' + fileNameOfPath(item.filePath) + '）'
              : (item.anchorKey ? '（点输入框里的引用块可回原文）' : '（未定位到消息行，可能无法跳回）')),
          })
          editorStore.close()
        } catch (e) {
          setStatus({ ok: false, text: '插入失败：' + (e && e.message ? e.message : String(e)) })
          report('insert:throw', String((e && e.stack) || (e && e.message) || e))
          console.error('[quote-pro] 插入失败', e)
        }
      }
      const hint = docMode
        ? '加入后可在预览头部「批注 · N」里展开 / 删除，或一次性发送到输入框'
        : '插入后输入框里会显示紧凑引用块，点它可跳回原文'
      return React.createElement('div', {
        className: open ? 'dshq-editor' : 'dshq-editor dshq-editor-hidden',
        style: { left, top, width: w },
      },
        React.createElement('div', { className: 'dshq-editor-label' }, open ? item.label : ''),
        React.createElement('div', { className: 'dshq-editor-quote' }, open ? item.text : ''),
        React.createElement('input', {
          ref: inputRef,
          className: 'dshq-editor-input',
          value: comment,
          placeholder: '输入评论…',
          onChange: (e) => setComment(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter') insert()
            if (e.key === 'Escape') editorStore.close()
          },
        }),
        status && open ? React.createElement('div', { className: status.ok ? 'dshq-editor-status dshq-ok' : 'dshq-editor-status dshq-err' }, status.text) : (open ? React.createElement('div', { className: 'dshq-editor-hint' }, hint) : null),
        React.createElement('div', { className: 'dshq-editor-actions' },
          React.createElement('button', { type: 'button', className: 'dshq-btn dshq-primary', onClick: insert }, docMode ? '加入批注列表' : '插入输入框'),
          React.createElement('button', { type: 'button', className: 'dshq-btn', onClick: () => editorStore.close() }, '✕'),
        ),
      )
    }

    // ============ 组件四：引用悬停提示（显示当时选中的文字） ============
    const QuoteTooltip = () => {
      const t = useTooltip()
      if (!t.visible || !t.rect) return null
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      const vh = typeof window !== 'undefined' ? window.innerHeight : 768
      const w = Math.min(340, Math.max(180, Math.min(t.text.length, 60) * 11 + 48))
      const estH = Math.min(200, 56 + Math.ceil(Math.min(t.text.length, 400) / 22) * 15)
      const center = t.rect.left + (t.rect.right - t.rect.left) / 2
      const left = Math.max(8, Math.min(center - w / 2, vw - w - 8))
      let top = t.rect.top - estH - 8
      if (top < 8) top = Math.min(vh - estH - 8, t.rect.bottom + 8)
      return React.createElement('div', { className: 'dshq-tip', style: { left, top, width: w } },
        React.createElement('div', { className: 'dshq-tip-label' }, t.label),
        React.createElement('div', { className: 'dshq-tip-quote' }, t.text),
      )
    }

    // ============ 组件五：点击 chip 的反馈 toast（shell.overlay 条目） ============
    const FeedbackToast = () => {
      const t = useToast()
      if (!t.text || !t.pos) return null
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      const left = Math.max(12, Math.min(t.pos.left - 80, vw - 180))
      return React.createElement('div', {
        className: t.ok ? 'dshq-toast dshq-toast-ok' : 'dshq-toast dshq-toast-err',
        style: { left, top: t.pos.top + 18 },
      }, t.text)
    }

    // ============ 文件批注：订阅工具 ============
    function useDocNotesVersion() {
      const [, force] = React.useState(0)
      React.useEffect(() => docNotesStore.subscribe(() => force((v) => v + 1)), [])
      return docNotesStore
    }

    function useDocPreviewVersion() {
      const [, force] = React.useState(0)
      React.useEffect(() => docPreviewStore.subscribe(() => force((v) => v + 1)), [])
      return docPreviewStore
    }

    function noteWhereLabel(note) {
      if (note && typeof note.page === 'number' && note.page > 0) return '第' + note.page + '页'
      if (note && typeof note.line === 'number' && note.line > 0) return '第' + note.line + '行'
      return ''
    }

    // ============ 组件七：文档预览来源探针 ============
    // `sidebar.right.tab.document.actions` 是 documentpreview 声明的 list 槽，
    // 渲染时 owner prop 带当前文档的 `absolutePath`（官方 open-in-app 也注册在这里）。
    // 这里只做登记：把「探针节点 → 文件路径 / 会话」放进 docProbes，划词时用 DOM 包含关系
    // 把选区和文件对上；挂载/卸载时通知底部批注条跟随当前预览 tab。
    let docProbePropsReported = false
    const DocPathProbe = (props) => {
      if (!docProbePropsReported) {
        docProbePropsReported = true
        try { report('doc-probe:props', { keys: Object.keys(props || {}) }) } catch (e) { /* ignore */ }
      }
      const raw = props && (
        (typeof props.absolutePath === 'string' && props.absolutePath) ||
        (props.owner && typeof props.owner.absolutePath === 'string' && props.owner.absolutePath) ||
        (props.tabInfo && typeof props.tabInfo.absolutePath === 'string' && props.tabInfo.absolutePath) ||
        ''
      )
      const path = raw !== '' ? raw : null
      const slotSessionId = props && typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : null
      const probeRef = React.useRef(null)
      React.useLayoutEffect(() => {
        const node = probeRef.current
        if (!node) return undefined
        const entry = { node, path, sessionId: slotSessionId }
        docProbes.add(entry)
        if (path) report('doc-probe:mounted', { file: fileNameOfPath(path) })
        docPreviewStore.emit()
        return () => {
          docProbes.delete(entry)
          docPreviewStore.emit()
        }
      }, [path, slotSessionId])
      return React.createElement('span', {
        ref: probeRef,
        'data-dshq-doc-path': path || '',
        style: { display: 'none' },
      })
    }

    // 预览正文的几种标记：官方 documentpreview 的 slot 包裹层，以及正文渲染器自带属性。
    // 用集合而非单一选择器 —— 换个渲染器（PDF / 文本页 / 图片）也能找到同一个预览根。
    const PREVIEW_ROOT_MARKERS = '[data-slot="sidebar.right.tab.document"], [data-textpreview-body], [data-textpreview-url], [data-textpreview-state], [data-pdf-preview], [data-pdf-page]'

    function findPreviewRoot(node) {
      try {
        let el = node && node.parentElement
        while (el && el !== document.body) {
          if (typeof el.querySelector === 'function' && el.querySelector(PREVIEW_ROOT_MARKERS)) return el
          el = el.parentElement
        }
      } catch (e) { /* ignore */ }
      return null
    }

    /** 当前可见的文档预览（多个 tab 时取最后一个可见的） */
    function activeDocPreview() {
      let best = null
      for (const probe of docProbes) {
        if (!probe || !probe.path || !probe.node || !probe.node.isConnected) continue
        const root = findPreviewRoot(probe.node)
        if (!root) continue
        const rect = root.getBoundingClientRect()
        if (!rect || rect.width < 60 || rect.height < 60) continue
        try {
          const style = window.getComputedStyle(root)
          if (style.visibility === 'hidden' || style.display === 'none') continue
        } catch (e) { /* ignore */ }
        best = { path: probe.path, sessionId: probe.sessionId || null, root, rect }
      }
      return best
    }

    // ============ 组件八：底部文件批注条（半透明浮层） ============
    // 当前文档预览里有批注时，在预览底部浮出一条：
    //   `批注 · N` + 展开/收起 + 全部发送 + 全部删除。
    // 展开后在上方浮出列表（单条可展开原文 / 删除）；全部删除后批注清空、这条自动消失。
    const DocNotesBar = () => {
      useDocNotesVersion()
      useDocPreviewVersion()
      const [, force] = React.useState(0)
      const [expandedKey, setExpandedKey] = React.useState(null)
      const [openQuoteId, setOpenQuoteId] = React.useState(null)
      const [editingId, setEditingId] = React.useState(null)
      const [editText, setEditText] = React.useState('')
      const barRef = React.useRef(null)
      const panelRef = React.useRef(null)
      // 跟随预览滚动 / 窗口尺寸 / 文档 tab 切换重新定位
      React.useEffect(() => {
        let raf = 0
        const bump = () => {
          if (raf) return
          raf = requestAnimationFrame(() => { raf = 0; force((v) => v + 1) })
        }
        const timer = setInterval(bump, 700)
        document.addEventListener('scroll', bump, true)
        window.addEventListener('resize', bump)
        return () => {
          clearInterval(timer)
          document.removeEventListener('scroll', bump, true)
          window.removeEventListener('resize', bump)
          if (raf) cancelAnimationFrame(raf)
        }
      }, [])
      const active = activeDocPreview()
      const sessionId = (active && active.sessionId) || resolveSessionId()
      const path = active ? active.path : null
      const notes = active && sessionId ? docNotesStore.get(sessionId, path) : []
      const count = notes.length
      // 状态诊断：浮条没出现时，看是"没找到预览根"还是"批注 key 对不上"
      React.useEffect(() => {
        try {
          const resolved = resolveSessionId()
          const signature = [path || '', count, String(sessionId || ''), String(active && active.sessionId || ''), String(resolved || '')].join('|')
          if (signature === lastDocBarReport) return
          lastDocBarReport = signature
          const storedKeys = []
          try {
            if (typeof localStorage !== 'undefined' && typeof localStorage.length === 'number') {
              for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i)
                if (typeof key === 'string' && key.indexOf(DOC_NOTES_PREFIX) === 0) storedKeys.push(key.slice(DOC_NOTES_PREFIX.length))
              }
            }
          } catch (e) { /* ignore */ }
          report('doc-bar:state', {
            file: path ? fileNameOfPath(path) : null,
            count,
            resolvedCount: resolved && path ? docNotesStore.get(resolved, path).length : null,
            sessionId: String(sessionId || '').slice(0, 14),
            probeSessionId: String(active && active.sessionId || '').slice(0, 14),
            resolvedSessionId: String(resolved || '').slice(0, 14),
            storedKeys: storedKeys.slice(0, 8),
          })
        } catch (e) { /* ignore */ }
      }, [path, count, sessionId, active && active.sessionId])
      // 切换文件时收起列表 / 收起单条展开 / 取消编辑
      React.useEffect(() => {
        setEditingId(null)
        setEditText('')
      }, [path])
      React.useEffect(() => {
        if (expandedKey && expandedKey !== path) {
          setExpandedKey(null)
          setOpenQuoteId(null)
        }
      }, [path, expandedKey])
      // 展开后：点浮条 / 列表以外的地方（或按 Esc）自动收起，不用再去找「收起」按钮
      React.useEffect(() => {
        if (!path || expandedKey !== path) return undefined
        const collapse = () => {
          setExpandedKey(null)
          setOpenQuoteId(null)
          setEditingId(null)
          setEditText('')
        }
        const onDown = (e) => {
          try {
            const target = e.target
            const inBar = barRef.current && target instanceof Node && barRef.current.contains(target)
            const inPanel = panelRef.current && target instanceof Node && panelRef.current.contains(target)
            if (inBar || inPanel) return
          } catch (err) { /* ignore */ }
          collapse()
        }
        const onKey = (e) => {
          if (e.key !== 'Escape') return
          // 行内编辑时 Esc 交给输入框自己"取消编辑"，不收起整个列表
          if (editingId) return
          collapse()
        }
        document.addEventListener('pointerdown', onDown, true)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('pointerdown', onDown, true)
          document.removeEventListener('keydown', onKey)
        }
      }, [path, expandedKey, editingId])
      if (!active || !sessionId || !path || count === 0) return null
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      const vh = typeof window !== 'undefined' ? window.innerHeight : 768
      const rect = active.rect
      const barWidth = Math.max(280, Math.min(rect.width - 16, 620, vw - 24))
      const barLeft = Math.max(8, Math.min(rect.left + (rect.width - barWidth) / 2, vw - barWidth - 8))
      const barTop = Math.max(8, Math.min(rect.bottom - 52, vh - 52))
      const expanded = expandedKey === path
      const panelMaxH = Math.max(120, Math.min(340, barTop - 24))
      const panelTop = Math.max(8, barTop - panelMaxH - 8)
      const pos = { left: barLeft + barWidth / 2, top: barTop }
      const sendAll = () => {
        const composer = resolveComposerInput(sessionId)
        if (composer.error) {
          report('doc-notes:send-all-fail', composer.error)
          notify('发送失败：' + composer.error, pos, false)
          return
        }
        // 编号接着输入框里已有的【批注 N】往下排，避免与既有引用块撞号
        let startNo = 1
        try { startNo = nextAnnotationNo(composer.input.state.getSnapshot().draft || '') } catch (e) { startNo = 1 }
        const body = buildDocNotesBatch(notes, { path, startNo })
        if (body === '') return
        try {
          const nextDraft = appendDraftText(composer.input, body)
          lastInsertAt = (typeof performance !== 'undefined' ? performance.now() : Date.now())
          report('doc-notes:send-all', { file: fileNameOfPath(path), count: notes.length, startNo, draftLen: nextDraft.length })
        } catch (e) {
          report('doc-notes:send-all-throw', String((e && e.stack) || (e && e.message) || e))
          notify('发送失败：' + String((e && e.message) || e), pos, false)
          return
        }
        notify('已将 ' + notes.length + ' 条文件批注插入输入框', pos, true)
      }
      const clearAll = () => {
        const removed = docNotesStore.clear(sessionId, path)
        report('doc-notes:clear', { file: fileNameOfPath(path), count: removed })
        setOpenQuoteId(null)
        setExpandedKey(null)
        setEditingId(null)
        setEditText('')
      }
      const toggleExpanded = () => {
        setExpandedKey(expanded ? null : path)
        setOpenQuoteId(null)
        setEditingId(null)
        setEditText('')
        report('doc-notes:toggle', { file: fileNameOfPath(path), count, expanded: !expanded })
      }
      const startEdit = (note) => {
        setEditingId(note.id)
        setEditText(String(note.comment || ''))
        setOpenQuoteId(note.id)
        report('doc-notes:edit-start', { file: fileNameOfPath(path), id: String(note.id).slice(0, 8) })
      }
      const cancelEdit = () => {
        setEditingId(null)
        setEditText('')
      }
      const saveEdit = (note) => {
        const text = String(editText || '').trim()
        const ok = docNotesStore.update(sessionId, path, note.id, { comment: text })
        if (ok) report('doc-notes:edit', { file: fileNameOfPath(path), id: String(note.id).slice(0, 8), chars: text.length })
        setEditingId(null)
        setEditText('')
      }
      const rows = notes.map((note) => {
        const open = openQuoteId === note.id
        const editing = editingId === note.id
        const where = noteWhereLabel(note)
        return React.createElement('div', { className: 'dshq-doc-note' + (editing ? ' dshq-doc-note-editing' : ''), key: note.id },
          React.createElement('div', { className: 'dshq-doc-note-head' },
            where !== '' ? React.createElement('span', { className: 'dshq-doc-note-where' }, where) : null,
            React.createElement('span', {
              className: 'dshq-doc-note-quote' + (open ? ' dshq-doc-note-quote-open' : ''),
              role: 'button',
              tabIndex: 0,
              title: open ? '收起原文' : '展开原文',
              onClick: () => setOpenQuoteId(open ? null : note.id),
              onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') setOpenQuoteId(open ? null : note.id) },
            }, note.quote),
          ),
          editing ? React.createElement('div', { className: 'dshq-doc-note-editbox' },
            React.createElement('textarea', {
              className: 'dshq-doc-note-input',
              value: editText,
              rows: 3,
              placeholder: '写批注…',
              autoFocus: true,
              onChange: (e) => setEditText(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(note) }
                if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
              },
            }),
            React.createElement('div', { className: 'dshq-doc-note-edit-actions' },
              React.createElement('button', { type: 'button', className: 'dshq-btn dshq-primary', onClick: () => saveEdit(note) }, '保存'),
              React.createElement('button', { type: 'button', className: 'dshq-btn', onClick: cancelEdit }, '取消'),
            ),
          ) : (open && note.comment ? React.createElement('div', { className: 'dshq-doc-note-comment' }, '批注：' + note.comment) : null),
          React.createElement('div', { className: 'dshq-doc-note-actions' },
            editing ? null : React.createElement('button', {
              type: 'button',
              className: 'dshq-btn dshq-doc-note-edit',
              onClick: (e) => { e.stopPropagation(); startEdit(note) },
            }, '编辑'),
            editing ? null : React.createElement('button', {
              type: 'button',
              className: 'dshq-btn dshq-doc-note-del',
              onClick: (e) => {
                e.stopPropagation()
                docNotesStore.remove(sessionId, path, note.id)
                setOpenQuoteId(null)
              },
            }, '删除'),
          ),
        )
      })
      return React.createElement(React.Fragment, null,
        expanded ? React.createElement('div', {
          ref: panelRef,
          className: 'dshq-doc-bar-panel',
          style: { left: barLeft, width: barWidth, top: panelTop, maxHeight: panelMaxH },
        },
          React.createElement('div', { className: 'dshq-doc-panel-path', title: path }, fileNameOfPath(path)),
          React.createElement('div', { className: 'dshq-doc-panel-list' }, rows),
        ) : null,
        React.createElement('div', {
          ref: barRef,
          className: 'dshq-doc-bar',
          style: { left: barLeft, top: barTop, width: barWidth },
        },
          React.createElement('span', { className: 'dshq-doc-bar-count' }, '批注 · ' + count),
          React.createElement('span', { className: 'dshq-doc-bar-spacer' }),
          React.createElement('button', { type: 'button', className: 'dshq-btn dshq-doc-bar-btn', onClick: toggleExpanded }, expanded ? '收起' : '展开'),
          React.createElement('button', { type: 'button', className: 'dshq-btn dshq-doc-bar-btn dshq-doc-bar-send', onClick: sendAll }, '全部发送'),
          React.createElement('button', { type: 'button', className: 'dshq-btn dshq-doc-bar-btn dshq-doc-bar-del', onClick: clearAll }, '全部删除'),
        ),
      )
    }

    // ============ 样式（主题令牌自适应明暗） ============
    // ============ 组件六：输入框上方的引用块（紧凑样式；点击可跳回原文，但不显式提示） ============
    // 本版本输入框里的引用 chip 没有 data 属性（只有 CSS 类），DOM 无法反查 occurrence；
    // 因此这里直接读官方输入状态的 occurrences（source === 'quote-ref'）来渲染。
    // 展示的是**原文片段本身**（不再显示「引用#N · 第N轮 · 角色」这类标签），保持输入区干净；
    // 定位能力保留：点一下就跳回原文并高亮，只是不做任何可见的"跳转"提示。
    const SNIPPET_MAX = 90
    const snippetOf = (body) => {
      const raw = String(body || '')
        .split('\n')
        .filter((line) => line.trim() !== '' && !/^【(?:引用|批注)/.test(line.trim()) && !/^批注[:：]/.test(line.trim()))
        .map((line) => line.replace(/^>\s?/, ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      return raw.length > SNIPPET_MAX ? raw.slice(0, SNIPPET_MAX) + '…' : raw
    }

    const QuoteBlock = ({ item }) => {
      const onJump = (e) => {
        try {
          const r = e.currentTarget.getBoundingClientRect()
          report('dock:click', { ref: String(item.ref), anchorKey: item.anchorKey || null })
          jumpToRef(item.ref, { left: r.left + 16, top: r.top }, { silent: true })
        } catch (err) { /* ignore */ }
      }
      return React.createElement('div', {
        className: 'dshq-quote-block',
        onClick: onJump,
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') onJump(e) },
        role: 'button',
        tabIndex: 0,
        title: '点击跳回原文',
      }, React.createElement('span', { className: 'dshq-quote-block-text' }, item.snippet || '引用'))
    }

    const QuoteDock = (props) => {
      // 槽位作用域是 session，正常会带 sessionId；拿不到时退回模块级解析结果
      const sessionId = (props && typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : null) || resolveSessionId() || null
      const [rows, setRows] = React.useState([])
      React.useEffect(() => {
        if (!sessionId) { setRows([]); return undefined }
        let input = null
        try {
          const conversation = rootCtx ? rootCtx.get('conversation') : undefined
          const sessions = rootCtx ? rootCtx.get('sessions') : undefined
          const binding = sessions ? sessions.binding(sessionId) : undefined
          input = conversation && conversation.input && binding ? conversation.input.for(binding.ctx) : null
        } catch (e) {
          report('dock:input-throw', String((e && e.message) || e))
        }
        if (!input || !input.state) return undefined
        const read = () => {
          try {
            const snap = input.state.getSnapshot()
            const occurrences = (snap && snap.occurrences) || []
            const next = []
            for (const occ of occurrences) {
              if (!occ || occ.source !== 'quote-ref') continue
              const info = refTargets.get(occ.ref)
              next.push({
                ref: occ.ref,
                anchorKey: (info && info.anchorKey) || null,
                snippet: snippetOf(info && info.body),
              })
            }
            setRows(next)
            if (next.length > 0) report('dock:rows', { count: next.length })
          } catch (e) { /* ignore */ }
        }
        read()
        let off
        let timer = null
        try {
          if (typeof input.state.subscribe === 'function') off = input.state.subscribe(read)
          else timer = setInterval(read, 800)
        } catch (e) { timer = setInterval(read, 800) }
        return () => {
          try { if (typeof off === 'function') off() } catch (e) { /* ignore */ }
          if (timer !== null) clearInterval(timer)
        }
      }, [sessionId])
      if (!sessionId || rows.length === 0) return null
      const children = []
      for (const row of rows) children.push(React.createElement(QuoteBlock, { key: row.ref, item: row }))
      return React.createElement('div', { className: 'dshq-dock' }, children)
    }

    const css = `
.dshq-tail{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap;margin-left:2px}
.dshq-btn{appearance:none;background:transparent;border:1px solid transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1.4;padding:2px 8px;border-radius:6px;cursor:pointer;transition:background .12s ease,color .12s ease}
.dshq-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dshq-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.dshq-primary:hover{background:var(--dsw-alias-brand-primary);color:#fff;opacity:.9}
.dshq-toolbar{position:fixed;display:flex;align-items:center;gap:4px;min-width:10em;width:max-content;max-width:min(32em,calc(100vw - 24px));font-size:12px;padding:3px 7px;border-radius:999px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 4px 14px rgba(0,0,0,.14);pointer-events:auto;box-sizing:border-box}
.dshq-toolbar-preview{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshq-bubble-cta{flex:none;padding:1px 8px;border-radius:999px}
.dshq-close{flex:none;padding:1px 5px;opacity:.7}
.dshq-editor{position:fixed;display:flex;flex-direction:column;gap:5px;box-sizing:border-box;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 8px 24px rgba(0,0,0,.18);pointer-events:auto;font-size:12px}
.dshq-editor-hidden{opacity:0;pointer-events:none}
.dshq-editor-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshq-editor-quote{margin:0;padding:3px 8px;border-left:3px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:96px;overflow:auto}
.dshq-editor-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:4px 8px}
.dshq-editor-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dshq-editor-hint{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.8}
.dshq-editor-status{font-size:11px;line-height:1.5}
.dshq-editor-status.dshq-ok{color:var(--dsw-alias-state-success-primary)}
.dshq-editor-status.dshq-err{color:var(--dsw-alias-state-error-primary)}
.dshq-editor-actions{display:flex;justify-content:flex-end;gap:6px}
.dshq-tip{position:fixed;display:flex;flex-direction:column;gap:4px;box-sizing:border-box;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 6px 18px rgba(0,0,0,.18);pointer-events:none;z-index:2147483000;font-size:12px}
.dshq-tip-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshq-tip-quote{margin:0;padding:3px 8px;border-left:3px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto;font-size:11px}
.dshq-flash{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:4px;border-radius:8px}
.dshq-toast{position:fixed;max-width:240px;padding:5px 9px;border-radius:8px;font-size:11px;line-height:1.5;box-shadow:0 4px 14px rgba(0,0,0,.18);pointer-events:none;z-index:2147483000}
.dshq-toast-ok{background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-primary)}
.dshq-toast-err{background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
/* 根因：textarea（透明文字、absolute、inset:0）渲染在 backdrop 之后，整层盖住 chip。
   给 chip 提升 z-index 使其浮到 textarea 之上，点击才能落到 chip 上。 */
[data-occurrence]{pointer-events:auto;cursor:pointer;position:relative;z-index:1}
/* 引用块：贴在输入框卡片上沿（点一下跳回原文，不显示任何"跳转"提示） */
.dshq-dock{display:flex;flex-direction:column;gap:4px;padding:0 6px;margin:6px 0 -2px;min-width:0;box-sizing:border-box}
.dshq-quote-block{display:flex;align-items:center;min-width:0;max-width:100%;box-sizing:border-box;padding:6px 10px;border-radius:12px 12px 4px 4px;background:var(--dsw-alias-bg-layer-2);background:color-mix(in oklab,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer;transition:background .12s ease,color .12s ease}
.dshq-quote-block:hover{color:var(--dsw-alias-label-primary)}
.dshq-quote-block-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 已发送消息里的引用：隐藏位置标签，只显示紧凑的原文块（点击可跳回原文，无可见引导） */
.dshq-sent-header{display:none}
.dshq-sent-quote{display:block;margin:3px 0;padding:6px 10px;border-radius:8px;background:rgba(127,127,127,.10);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;cursor:pointer;overflow:hidden;transition:background .12s ease,color .12s ease}
.dshq-sent-quote:hover{color:var(--dsw-alias-label-primary)}
.dshq-sent-quote-text{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;word-break:break-word}
/* 输入框里的引用：隐藏位置行，正文显示为紧凑块（输入框与消息观感一致） */
.dshq-cmp-header{display:none !important}
/* 光标停在位置行里时临时显示（否则打字看不见字）；必须排在上一行之后才能覆盖 !important */
.dshq-cmp-header-active{display:block !important;opacity:.55}
.dshq-cmp-quote{background:rgba(127,127,127,.10);border-radius:8px;padding:2px 10px;margin:2px 0;cursor:pointer}
.dshq-cmp-quote:hover{background:rgba(127,127,127,.16)}
.dshq-cmp-quote-first{margin-top:4px}
.dshq-cmp-quote-last{margin-bottom:4px}
/* 回复里的「Annotation N」芯片：悬浮看原文+评语，点击跳回原文 */
.dshq-anno-chip{display:inline-flex;align-items:center;margin:0 2px;padding:0 7px;border-radius:999px;background:rgba(127,127,127,.12);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;cursor:pointer;vertical-align:baseline;user-select:none;white-space:nowrap}
.dshq-anno-chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}
/* 文件批注：预览头部的计数入口 + 面板（docx / pdf / xlsx 等不可编辑预览） */
.dshq-doc-bar{position:fixed;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:40px;padding:4px 10px;border-radius:999px;background:color-mix(in oklab,var(--dsw-alias-bg-overlay) 72%,transparent);-webkit-backdrop-filter:blur(12px) saturate(1.2);backdrop-filter:blur(12px) saturate(1.2);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 8px 24px rgba(0,0,0,.16);z-index:2147483000;font-size:12px;color:var(--dsw-alias-label-primary);pointer-events:auto}
.dshq-doc-bar-count{font-weight:600;white-space:nowrap}
.dshq-doc-bar-spacer{flex:auto}
.dshq-doc-bar-btn{padding:1px 8px;border-radius:999px;border:1px solid transparent;white-space:nowrap}
.dshq-doc-bar-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dshq-doc-bar-send{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dshq-doc-bar-send:hover{background:var(--dsw-alias-brand-primary);color:#fff}
.dshq-doc-bar-del:hover{background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-state-error-primary)}
.dshq-doc-bar-panel{position:fixed;display:flex;flex-direction:column;gap:6px;box-sizing:border-box;padding:10px;border-radius:12px;background:color-mix(in oklab,var(--dsw-alias-bg-overlay) 82%,transparent);-webkit-backdrop-filter:blur(14px) saturate(1.2);backdrop-filter:blur(14px) saturate(1.2);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 12px 32px rgba(0,0,0,.2);z-index:2147483000;overflow:auto;pointer-events:auto;font-size:12px;color:var(--dsw-alias-label-primary)}
.dshq-doc-panel-path{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshq-doc-panel-list{display:flex;flex-direction:column;gap:6px;margin:2px 0}
.dshq-doc-note{display:flex;flex-direction:column;gap:4px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.dshq-doc-note-head{display:flex;align-items:baseline;gap:6px;min-width:0}
.dshq-doc-note-where{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshq-doc-note-quote{flex:auto;min-width:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.dshq-doc-note-quote:hover{color:var(--dsw-alias-label-primary)}
.dshq-doc-note-quote-open{white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto;cursor:pointer;color:var(--dsw-alias-label-primary)}
.dshq-doc-note-comment{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}
.dshq-doc-note-actions{display:flex;justify-content:flex-end;gap:4px}
.dshq-doc-note-editing{border-color:var(--dsw-alias-brand-primary)}
.dshq-doc-note-edit{padding:0 6px;font-size:11px;opacity:.8}
.dshq-doc-note-edit:hover{opacity:1;color:var(--dsw-alias-brand-primary)}
.dshq-doc-note-editbox{display:flex;flex-direction:column;gap:4px}
.dshq-doc-note-input{width:100%;box-sizing:border-box;resize:vertical;min-height:52px;max-height:160px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.5;padding:4px 8px}
.dshq-doc-note-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dshq-doc-note-edit-actions{display:flex;justify-content:flex-end;gap:6px}
.dshq-doc-note-del{padding:0 6px;font-size:11px;opacity:.75}
.dshq-doc-note-del:hover{opacity:1;color:var(--dsw-alias-state-error-primary)}
`

    // ============ 插件主体 ============
    function apply(ctx) {
      rootCtx = ctx
      report('apply:start')
      try {
        const names = ['slots', 'inputTriggers', 'conversation', 'sessions', 'sidebarRight', 'uiSession', 'layout', 'uiWorkspace', 'workspaces', 'chat']
        const have = {}
        for (const n of names) {
          try { have[n] = ctx.get(n) !== undefined } catch (e) { have[n] = 'throw' }
        }
        report('env:services', have)
      } catch (e) { /* ignore */ }
      let slots
      try { slots = ctx.get('slots') } catch (e) { report('apply:slots-throw', String((e && e.message) || e)) }
      report('apply:slots', slots === undefined ? 'undefined' : typeof slots)
      if (slots === undefined) return
      try {
        ctx.effect(() => insertStyleSheet(css), 'dsh-quote-annotate-pro: styles')
      } catch (e) {
        report('apply:styles-throw', String((e && e.stack) || (e && e.message) || e))
      }
      // 注册引用 source（提交时把占位符序列化为引用正文；空候选分组不渲染，不污染 @ 菜单）
      let inputTriggers
      try { inputTriggers = ctx.get('inputTriggers') } catch (e) { report('apply:inputTriggers-throw', String((e && e.message) || e)) }
      pipelineAvailable = !!(inputTriggers && typeof inputTriggers.registerSource === 'function')
      report('apply:pipeline', {
        available: pipelineAvailable,
        hasInsertReference: !!(inputTriggers && typeof inputTriggers.insertReference === 'function'),
      })
      // 注册机：幂等、可重试。宿主服务可能晚于插件就绪（或 HMR 重载后旧注册仍在），
      // 一次性判定会让整页退化成"纯文本回退"，因此这里允许后续再次调用。
      let quoteSourceRegistered = false
      ensureQuoteSource = () => {
        if (quoteSourceRegistered) return true
        let triggers = inputTriggers
        if (!triggers) {
          try { triggers = ctx.get('inputTriggers') } catch (e) { triggers = undefined }
        }
        if (!triggers || typeof triggers.registerSource !== 'function') {
          pipelineAvailable = false
          return false
        }
        try {
          ctx.effect(() => triggers.registerSource({
            trigger: '@',
            name: 'quote-ref',
            order: 100,
            candidates: async () => [],
            onPick: () => undefined,
            codec: {
              clipboardText: (ref) => (refCodecs.get(ref) ? refCodecs.get(ref).clipboardText : ''),
              serialize: (ref) => Promise.resolve(refCodecs.get(ref) ? refCodecs.get(ref).body : ''),
            },
          }), 'dsh-quote-annotate-pro: quote-ref source')
          quoteSourceRegistered = true
          pipelineAvailable = true
          report('register:quote-ref-source', 'ok')
          return true
        } catch (e) {
          const msg = String((e && e.stack) || (e && e.message) || e)
          // 已注册（HMR 重载后宿主保留旧注册）不算失败：序列化仍会路由到当前模块的 codec
          if (/already|duplicate|exist|注册/i.test(msg)) {
            quoteSourceRegistered = true
            pipelineAvailable = true
            report('register:quote-ref-source', 'already')
            return true
          }
          pipelineAvailable = false
          report('register:quote-ref-source', 'throw ' + msg)
          return false
        }
      }
      if (!ensureQuoteSource()) {
        // 退避重试：最多 20 次、间隔 500ms（约 10s），把启动时序造成的退化救回来
        try {
          ctx.effect(() => {
            let tries = 0
            let timer = null
            const tick = () => {
              timer = null
              if (quoteSourceRegistered || tries >= 20) return
              tries += 1
              if (!ensureQuoteSource()) timer = setTimeout(tick, 500)
            }
            timer = setTimeout(tick, 500)
            report('register:quote-ref-source', 'retry-scheduled')
            return () => { if (timer !== null) clearTimeout(timer) }
          }, 'dsh-quote-annotate-pro: quote-ref retry')
        } catch (e) { /* ignore */ }
      }
      // 全局监听（选区气泡 / chip 点击跳转 / chip 悬停提示；ctx.effect 保证卸载时全部清理）
      try {
        ctx.effect(() => {
        let raf = 0
        let toastTimer = null
        let hideTimer = null
        const onKey = (e) => {
          if (e.key === 'Escape') {
            selectionStore.hide()
            toastStore.hide()
            tooltipStore.hide()
          }
        }
        const showToast = (text, pos, ok) => notify(text, pos, ok)
        const cancelHide = () => {
          if (hideTimer) {
            clearTimeout(hideTimer)
            hideTimer = null
          }
        }
        const scheduleHide = () => {
          if (hideTimer) return
          hideTimer = setTimeout(() => {
            hideTimer = null
            selectionStore.hide()
          }, 150)
        }
        const onScroll = () => {
          schedule()
          tooltipStore.hide()
        }
        // 用 pointerdown 捕获（比 click 更早，且不受 click 阶段任何 stopPropagation 影响）
        const onChipPress = (e) => {
          try {
            tooltipStore.hide()
            const pos = { left: e.clientX, top: e.clientY }
            const el = e.target && e.target.closest ? e.target.closest('[data-occurrence]') : null
            if (el) {
              const occId = Number(el.getAttribute('data-occurrence'))
              if (!Number.isFinite(occId)) return
              const found = resolveOccurrence(occId)
              if (!found) {
                notify('跳转失败：找不到该引用（可能已发送或被删除）', pos, false)
                return
              }
              report('chip:click', { via: 'occurrence', ref: String(found.occ.ref) })
              jumpToRef(found.occ.ref, pos)
              return
            }
            // 本版本输入框 chip 无 data-occurrence，但带 title=<label>：按 title 反查并跳转
            const titled = e.target && e.target.closest ? e.target.closest('[title]') : null
            if (!titled) return
            const title = titled.getAttribute('title')
            const ref = refByLabel(title)
            if (!ref) return
            report('chip:click', { via: 'title', ref: String(ref), title: String(title).slice(0, 40) })
            jumpToRef(ref, pos)
          } catch (err) {
            notify('跳转出错：' + (err && err.message ? err.message : String(err)), { left: e.clientX, top: e.clientY }, false)
            report('chip:click-throw', String((err && err.message) || err))
          }
        }
        // 悬停 chip：显示当时选中的文字
        const onChipOver = (e) => {
          try {
            const el = e.target && e.target.closest ? e.target.closest('[data-occurrence]') : null
            if (!el) {
              tooltipStore.hide()
              return
            }
            const occId = Number(el.getAttribute('data-occurrence'))
            if (!Number.isFinite(occId)) {
              tooltipStore.hide()
              return
            }
            const found = resolveOccurrence(occId)
            if (!found || !found.info || !found.info.body) {
              tooltipStore.hide()
              return
            }
            const r = el.getBoundingClientRect()
            tooltipStore.show({
              text: (found.info.body || '').replace(/^> /gm, '').trim(),
              label: found.info.label || '引用',
              rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
            })
          } catch (err) { /* ignore */ }
        }
        const onChipOut = (e) => {
          try {
            const el = e.target && e.target.closest ? e.target.closest('[data-occurrence]') : null
            if (!el) return
            const next = e.relatedTarget
            if (next && next.closest && next.closest('[data-occurrence]')) return
            tooltipStore.hide()
          } catch (err) { /* ignore */ }
        }
        const compute = () => {
          raf = 0
          try {
            const sel = window.getSelection()
            if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
              // 选区消失：延迟隐藏，避免流式渲染抖动导致气泡闪没
              scheduleHide()
              return
            }
            const text = (sel.toString() || '').trim()
            if (!text) {
              scheduleHide()
              return
            }
            const range = sel.getRangeAt(0)
            const node = range.commonAncestorContainer
            const host = node && node.nodeType === 1 ? node : (node ? node.parentElement : null)
            if (host && host.closest('textarea, input, [contenteditable="true"]')) {
              scheduleHide()
              return
            }
            const rect = range.getBoundingClientRect()
            if (!rect || (rect.width === 0 && rect.height === 0)) {
              scheduleHide()
              return
            }
            // 选区滚出视口（自动滚动场景）才隐藏；仍在视口内则跟随重定位
            const vh = typeof window !== 'undefined' ? window.innerHeight : 768
            if (rect.bottom < -8 || rect.top > vh + 8) {
              scheduleHide()
              return
            }
            cancelHide()
            const anchor = sel.anchorNode && sel.anchorNode.nodeType === 1 ? sel.anchorNode : (sel.anchorNode ? sel.anchorNode.parentElement : null)
            let anchorKey = null
            let turn
            let kind = null
            if (anchor) {
              const row = anchor.closest('[data-chat-anchor-key]')
              if (row) {
                anchorKey = row.getAttribute('data-chat-anchor-key')
                // 位置信息：轮次 + 该行种类（用于给模型标注"这是哪一处"）
                const rawTurn = row.getAttribute('data-chat-turn')
                if (rawTurn !== null && rawTurn !== '' && Number.isFinite(Number(rawTurn))) turn = Number(rawTurn)
                kind = row.getAttribute('data-chat-flow-kind') || null
              }
            }
            // 文档预览选区：没有消息行锚点，取文件路径（取不到就是 null，行为与旧版一致）
            const doc = !anchorKey && anchor ? docSourceOf(anchor) : null
            report('selection:show', {
              chars: text.length,
              anchorKey,
              turn,
              kind,
              file: doc && doc.path ? fileNameOfPath(doc.path) : null,
              line: doc ? doc.line : null,
              page: doc ? doc.page : null,
            })
            selectionStore.show({
              text: clipText(text, MAX_SELECTION),
              rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
              anchorKey,
              turn,
              kind,
              filePath: doc ? doc.path : null,
              line: doc ? doc.line : null,
              page: doc ? doc.page : null,
            })
          } catch (e) {
            scheduleHide()
          }
        }
        const schedule = () => {
          if (!raf) raf = requestAnimationFrame(compute)
        }
        document.addEventListener('selectionchange', schedule)
        // 滚动/缩放不再盲目隐藏：重新计算选区位置，跟随重定位（执行任务自动滚动时气泡不消失）
        document.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onScroll)
        document.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onChipPress, true)
        document.addEventListener('pointerover', onChipOver, true)
        document.addEventListener('pointerout', onChipOut, true)
        return () => {
          document.removeEventListener('selectionchange', schedule)
          document.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onScroll)
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('pointerdown', onChipPress, true)
          document.removeEventListener('pointerover', onChipOver, true)
          document.removeEventListener('pointerout', onChipOut, true)
          if (raf) cancelAnimationFrame(raf)
          if (hideTimer) clearTimeout(hideTimer)
          if (toastTimer) clearTimeout(toastTimer)
        }
        }, 'dsh-quote-annotate-pro: global listeners')
      } catch (e) {
        report('apply:listeners-throw', String((e && e.stack) || (e && e.message) || e))
      }

      // ============ 已发送消息里的引用：把「【引用 · 第N轮 · 角色】+ > 原文」变成紧凑块 ============
      // 目标（用户要求）：对话页面里不再显示"第几轮/谁说的"这类位置标签，只留一个紧凑的原文块；
      // 点击该块可跳回原文并高亮；**消息本体文本不变**，模型仍然拿得到完整的位置信息。
      try {
        ctx.effect(() => {
          let timer = null
          let observer = null
          const jumpByText = (text, pos) => {
            const probe = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 24)
            if (probe === '') return
            for (const r of document.querySelectorAll('[data-chat-anchor-key]')) {
              const t = String(r.textContent || '').replace(/\s+/g, ' ')
              if (t.indexOf(probe) !== -1) {
                r.scrollIntoView({ block: 'center', behavior: 'smooth' })
                r.classList.add('dshq-flash')
                setTimeout(() => r.classList.remove('dshq-flash'), 1600)
                report('sent:jump', { anchorKey: r.getAttribute('data-chat-anchor-key') })
                return
              }
            }
            notify('跳转失败：原文不在当前页面', pos, false)
          }
          const buildBlock = (quoteText) => {
            const wrap = document.createElement('div')
            wrap.className = 'dshq-sent-quote'
            wrap.setAttribute('role', 'button')
            wrap.setAttribute('title', '点击跳回原文')
            const span = document.createElement('span')
            span.className = 'dshq-sent-quote-text'
            span.textContent = quoteText
            wrap.appendChild(span)
            wrap.addEventListener('click', (ev) => {
              const r = wrap.getBoundingClientRect()
              jumpByText(quoteText, { left: r.left + 16, top: r.top })
              if (ev && ev.stopPropagation) ev.stopPropagation()
            })
            return wrap
          }
          /** 用户当前选区是否落在这个行里（是则暂缓装饰，别动 DOM 把选区搞失效） */
          const selectionTouches = (row) => {
            try {
              const s = typeof window !== 'undefined' ? window.getSelection() : null
              if (!s || s.rangeCount === 0 || s.isCollapsed) return false
              for (let i = 0; i < s.rangeCount; i++) {
                const r = s.getRangeAt(i)
                const a = r.startContainer
                const b = r.endContainer
                if ((a && row.contains(a)) || (b && row.contains(b))) return true
              }
            } catch (e) { /* ignore */ }
            return false
          }
          /** 把承载「位置行 + 原文（+ 批注：…）」的文本节点拆成：隐藏头部 + 紧凑引用块 + 其余文本 */
          const transformTextNode = (node) => {
            const raw = node.nodeValue || ''
            const parsed = parseQuoteBlock(raw)
            if (!parsed) return false
            const frag = document.createDocumentFragment()
            if (parsed.before !== '') frag.appendChild(document.createTextNode(parsed.before))
            const hidden = document.createElement('span')
            hidden.className = 'dshq-sent-header'
            hidden.textContent = parsed.header   // 位置信息仍留在 DOM（只是不显示）
            frag.appendChild(hidden)
            const block = buildBlock(parsed.quote)
            // 回复侧「Annotation N」芯片靠这几项 dataset 对上号
            if (parsed.no !== null) block.setAttribute('data-dshq-no', String(parsed.no))
            block.setAttribute('data-dshq-quote', parsed.quote)
            if (parsed.comment !== '') block.setAttribute('data-dshq-comment', parsed.comment)
            frag.appendChild(block)
            if (parsed.rest.trim() !== '') frag.appendChild(document.createTextNode(parsed.rest))
            node.parentNode.replaceChild(frag, node)
            report('sent:decorated', { chars: parsed.quote.length, no: parsed.no })
            return true
          }
          // ---- 回复侧「Annotation N：」→ 批注芯片（悬浮显示原文+评语，点击跳回原文） ----
          const ANNO_TOKEN_RE = /Annotation\s*(\d+)\s*[:：]/g
          /** 取"离这条回复最近的那条用户消息"里的批注数据（编号 → 原文/评语） */
          const annotationMapBefore = (row) => {
            const map = new Map()
            try {
              const all = document.querySelectorAll('[data-chat-flow-kind]')
              const idx = Array.prototype.indexOf.call(all, row)
              for (let i = idx - 1; i >= 0; i--) {
                const r = all[i]
                if (r.getAttribute('data-chat-flow-kind') !== 'user') continue
                const blocks = r.querySelectorAll('.dshq-sent-quote[data-dshq-no]')
                for (const b of blocks) {
                  const no = Number(b.getAttribute('data-dshq-no'))
                  if (!Number.isFinite(no)) continue
                  map.set(no, {
                    quote: b.getAttribute('data-dshq-quote') || '',
                    comment: b.getAttribute('data-dshq-comment') || '',
                  })
                }
                break
              }
            } catch (e) { /* ignore */ }
            return map
          }
          const buildAnnoChip = (no, ann) => {
            const chip = document.createElement('span')
            chip.className = 'dshq-anno-chip'
            chip.setAttribute('role', 'button')
            chip.setAttribute('tabindex', '0')
            chip.textContent = '批注 ' + no
            chip.title = ann.comment !== '' ? '批注 ' + no + '：' + ann.comment : '批注 ' + no
            chip.addEventListener('click', (ev) => {
              const r = chip.getBoundingClientRect()
              jumpByText(ann.quote, { left: r.left + 16, top: r.top })
              if (ev && ev.stopPropagation) ev.stopPropagation()
            })
            chip.addEventListener('mouseenter', () => {
              const r = chip.getBoundingClientRect()
              const text = '原文：' + ann.quote + (ann.comment !== '' ? '\n\n批注：' + ann.comment : '')
              tooltipStore.show({ text, label: '批注 ' + no, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } })
            })
            chip.addEventListener('mouseleave', () => { tooltipStore.hide() })
            return chip
          }
          /** 把一个文本节点里的「Annotation N：」替换成芯片（同一节点可能有多处） */
          const transformReplyNode = (node, map) => {
            const raw = node.nodeValue || ''
            if (raw.indexOf('Annotation') < 0) return false
            ANNO_TOKEN_RE.lastIndex = 0
            const parts = []
            let last = 0
            let m
            let any = false
            while ((m = ANNO_TOKEN_RE.exec(raw)) !== null) {
              const no = Number(m[1])
              const ann = map.get(no)
              if (!ann || ann.quote === '') continue
              parts.push(raw.slice(last, m.index))
              parts.push(buildAnnoChip(no, ann))
              last = m.index + m[0].length
              any = true
            }
            if (!any) return false
            parts.push(raw.slice(last))
            const frag = document.createDocumentFragment()
            for (const p of parts) {
              if (typeof p === 'string') { if (p !== '') frag.appendChild(document.createTextNode(p)) }
              else frag.appendChild(p)
            }
            node.parentNode.replaceChild(frag, node)
            return true
          }
          const decorateReplies = () => {
            try {
              for (const row of document.querySelectorAll('[data-chat-flow-kind="assistant-step"], [data-chat-flow-kind="assistant"]')) {
                if (row.dataset && row.dataset.dshqAnnoDone === '1') continue
                // 流式输出中不动 DOM（还没定稿）
                if (row.hasAttribute('data-streaming') || row.querySelector('[data-streaming]')) continue
                if (selectionTouches(row)) continue
                const map = annotationMapBefore(row)
                if (map.size === 0) { if (row.dataset) row.dataset.dshqAnnoDone = '1'; continue }
                let walker
                try { walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, null) } catch (e) { continue }
                const targets = []
                let n = walker.nextNode()
                while (n) {
                  const parent = n.parentElement
                  const managed = parent && typeof parent.closest === 'function'
                    ? parent.closest('.dshq-anno-chip') : null
                  if (!managed && (n.nodeValue || '').indexOf('Annotation') >= 0) targets.push(n)
                  n = walker.nextNode()
                }
                let done = false
                for (const t of targets) { try { if (transformReplyNode(t, map)) done = true } catch (e) { /* ignore */ } }
                if (row.dataset) row.dataset.dshqAnnoDone = '1'
                if (done) report('reply:chips', { row: String(row.getAttribute('data-chat-anchor-key') || '').slice(0, 12) })
              }
            } catch (e) { report('reply:scan-throw', String((e && e.message) || e)) }
          }
          const scan = () => {
            timer = null
            try {              for (const row of document.querySelectorAll(USER_ROW_SEL)) {
                const kind = row.getAttribute('data-chat-flow-kind')
                if (kind && kind !== 'user') continue
                // 用户正在这条消息里划词时**不要动它的 DOM**：替换文本节点会让选区失效，
                // 选区矩形随即变成全 0，批注气泡/编辑框就会定位到左上角（用户反馈过）。
                if (selectionTouches(row)) continue
                let walker
                try { walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, null) } catch (e) { continue }
                const targets = []
                let n = walker.nextNode()
                while (n) {
                  const parent = n.parentElement
                  // 已经装饰过的部分（隐藏的位置行 / 紧凑引用块）不再重复处理
                  const managed = parent && typeof parent.closest === 'function'
                    ? parent.closest('.dshq-sent-header, .dshq-sent-quote') : null
                  if (!managed && QUOTE_HEADER_RE.test(n.nodeValue || '')) targets.push(n)
                  n = walker.nextNode()
                }
                if (targets.length === 0) continue
                let done = false
                for (const t of targets) { try { if (transformTextNode(t)) done = true } catch (e) { /* ignore */ } }
                if (done && row.dataset) row.dataset.dshqSent = '1'
              }
              decorateReplies()
            } catch (e) { report('sent:scan-throw', String((e && e.message) || e)) }
          }
          const schedule = () => { if (timer === null) timer = setTimeout(scan, 300) }
          // 消息从输入框进入对话区时，首帧先画出的是原始文本（含"【引用 · …】"位置行），
          // 300ms 防抖会让它闪一下。MutationObserver 回调在下一次绘制前执行，
          // 因此只要这次变动牵扯到"还没装饰过的用户消息行"就同步扫一次，首帧即完成隐藏；
          // 其余情况（例如助手流式输出）仍走防抖，不增加扫描开销。
          // 用户消息行有两副面孔：正式行带 anchor 属性；但实测"刚发出去"的那一下，
          // 宿主先渲染出 <div class="cJsG2q_userRow">（还没有 data-chat-anchor-key），
          // 等属性挂上才轮得到插件 —— 那段空窗就是用户看到的闪。两类都按用户行处理。
          const USER_ROW_SEL = '[data-chat-anchor-key][data-chat-flow-kind="user"], [class*="userRow" i]'
          const asElement = (node) => (node && node.nodeType === 1 ? node : (node && node.parentElement) || null)
          // 行里是否还存在"没被插件接管过的"位置行文本。
          // 宿主会在渲染后重排/替换气泡内容（实测发送后约 120ms 会有一次），
          // 那时我们贴好的隐藏 span 会被换回原始文本 —— 用内容判断而不是用标记判断，
          // 才能在重渲染的同一帧里立刻补装饰。
          const rowHasRawHeader = (row) => {
            try {
              const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, null)
              let n = walker.nextNode()
              while (n) {
                const parent = n.parentElement
                const managed = parent && typeof parent.closest === 'function'
                  ? parent.closest('.dshq-sent-header, .dshq-sent-quote') : null
                if (!managed && QUOTE_HEADER_RE.test(n.nodeValue || '')) return true
                n = walker.nextNode()
              }
              return false
            } catch (e) { return false }
          }
          const touchesPendingUserRow = (node) => {
            const el = asElement(node)
            if (!el || typeof el.closest !== 'function') return false
            const row = el.closest(USER_ROW_SEL)
            // ① 变动落在用户消息行内部（含行自身）：只要还能找到未接管的位置行就立刻扫
            if (row) {
              const kind = row.getAttribute('data-chat-flow-kind')
              if (kind && kind !== 'user') return false
              return rowHasRawHeader(row)
            }
            // ② 新增的子树里带着这样的用户消息行（宿主可能整块替换容器）
            if (typeof el.querySelector === 'function') {
              try {
                for (const r of el.querySelectorAll(USER_ROW_SEL)) {
                  const kind = r.getAttribute('data-chat-flow-kind')
                  if (kind && kind !== 'user') continue
                  if (rowHasRawHeader(r)) return true
                }
              } catch (e) { /* ignore */ }
            }
            return false
          }
          const onMutations = (records) => {
            let urgent = false
            try {
              for (const r of records) {
                const cands = [r.target]
                const added = r.addedNodes
                if (added) { for (const n of added) cands.push(n) }
                for (const c of cands) {
                  if (!urgent && touchesPendingUserRow(c)) urgent = true
                }
              }
              if (urgent) scan()
            } catch (e) { /* ignore */ }
            schedule()
          }
          scan()
          try {
            observer = new MutationObserver(onMutations)
            observer.observe(document.body, {
              childList: true,
              subtree: true,
              characterData: true,
              attributes: true,
              attributeFilter: ['data-chat-anchor-key', 'data-chat-flow-kind'],
            })
          } catch (e) { report('sent:observer-throw', String((e && e.message) || e)) }
          return () => {
            if (timer !== null) clearTimeout(timer)
            if (observer) { try { observer.disconnect() } catch (e) { /* ignore */ } }
          }
        }, 'dsh-quote-annotate-pro: sent quote decoration')
      } catch (e) {
        report('apply:sent-decor-throw', String((e && e.message) || e))
      }

      // ============ 输入框里的引用：隐藏位置行 + 紧凑块（与消息里的渲染保持一致） ============
      // 只给编辑器的行元素加 class，**不改动编辑器文本** → 发送出去的内容不变（模型仍拿到位置信息）。
      // 编辑器重渲染会丢掉 class，因此用 MutationObserver 重新贴上。
      try {
        ctx.effect(() => {
          let observer = null
          // 位置行：`【引用 · 第N轮 · DSH 回复】` 或 `【批注 N · 第N轮 · DSH 回复（…）】`
          const HEADER_RE = /^【(?:引用|批注)[^\n]*】$/
          const isBlockEl = (el) => !!el && el.nodeType === 1 && /^(DIV|P|LI)$/.test(el.tagName)
          /**
           * 编辑器根下的"行元素"：通常是 <div>/<p>；个别宿主会再包一层容器。
           * 逐层向下展开"含块级子元素"的容器（最多 4 层），叶子层就是真正的行。
           * （早期版本只在"单容器且子元素 >1"时展开一层，单行草稿时会把整个容器当成一行处理）
           */
          const lineElements = (ed) => {
            let cur = [ed]
            for (let depth = 0; depth < 4; depth++) {
              const next = []
              let descended = false
              for (const el of cur) {
                const blocks = Array.from(el.children || []).filter(isBlockEl)
                if (blocks.length > 0) { descended = true; for (const b of blocks) next.push(b) } else next.push(el)
              }
              if (!descended) return cur
              cur = next
            }
            return cur
          }
          // 光标所在行：装饰时不能把光标那行藏起来，否则用户打字"看不见字"
          const caretLineOf = (ed, lines) => {
            try {
              const sel = window.getSelection()
              if (!sel || sel.rangeCount === 0 || !sel.anchorNode) return null
              let el = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement
              while (el && el !== ed) {
                if (lines.indexOf(el) !== -1) return el
                el = el.parentElement
              }
            } catch (e) { /* ignore */ }
            return null
          }
          /**
           * 把输入框里的正文"装饰"成紧凑块：
           * - 位置行 → `.dshq-cmp-header`（display:none，界面上看不到，但文本仍然在 → 发送后模型拿得到）
           * - 位置行后面紧跟的引用正文行 → `.dshq-cmp-quote`（浅色块；首行/末行分别圆角）
           * 一条消息里可以有多条批注，所以这里按"状态机"逐行扫描，遇到空行即结束当前块，
           * 然后继续扫后面的块（早期版本遇到第一个空行就 break，导致第二条批注不再装饰）。
           *
           * 关键：**完整对账**（既加类、也删类）。Lexical 会复用行 DOM，删掉位置行文字后新打的字
           * 若落回同一个行元素，残留的 `.dshq-cmp-header` 会让新文字看不见（用户反馈"输入框无法显示字"）。
           */
          const decorate = () => {
            try {
              for (const ed of document.querySelectorAll('[contenteditable="true"]')) {
                const lines = lineElements(ed)
                const headerSet = new Set()
                const quoteMap = new Map()
                let block = null
                const flush = () => {
                  if (block && block.length > 0) {
                    block.forEach((el, i) => quoteMap.set(el, { first: i === 0, last: i === block.length - 1 }))
                  }
                  block = null
                }
                for (const el of lines) {
                  const t = String(el.textContent || '').trim()
                  const single = t !== '' && t.indexOf('\n') === -1
                  if (single && HEADER_RE.test(t)) { flush(); headerSet.add(el); block = []; continue }
                  if (!block) continue
                  if (t === '' || !single) { flush(); continue }
                  block.push(el)
                }
                flush()
                // 兜底：如果整段内容都是位置行（用户把正文删光了），并且光标就在里面，
                // 不隐藏任何行 —— 否则输入框看起来是空的，用户会以为"打不出字"。
                try {
                  const focused = ed === document.activeElement || ed.contains(document.activeElement)
                  if (focused && lines.length > 0 && headerSet.size === lines.length) headerSet.clear()
                } catch (e) { /* ignore */ }
                const caret = caretLineOf(ed, lines)
                let changed = 0
                for (const el of lines) {
                  const cls = el.classList
                  const isHeader = headerSet.has(el)
                  const isActive = isHeader && el === caret
                  if (isHeader && !isActive) {
                    if (!cls.contains('dshq-cmp-header')) { cls.add('dshq-cmp-header'); changed++ }
                  } else if (cls.contains('dshq-cmp-header')) { cls.remove('dshq-cmp-header'); changed++ }
                  if (isActive) {
                    if (!cls.contains('dshq-cmp-header-active')) { cls.add('dshq-cmp-header-active'); changed++ }
                  } else if (cls.contains('dshq-cmp-header-active')) { cls.remove('dshq-cmp-header-active'); changed++ }
                  const q = quoteMap.get(el)
                  if (q) {
                    if (!cls.contains('dshq-cmp-quote')) changed++
                    cls.add('dshq-cmp-quote')
                    cls.toggle('dshq-cmp-quote-first', q.first)
                    cls.toggle('dshq-cmp-quote-last', q.last)
                  } else if (cls.contains('dshq-cmp-quote')) {
                    cls.remove('dshq-cmp-quote')
                    cls.remove('dshq-cmp-quote-first')
                    cls.remove('dshq-cmp-quote-last')
                    changed++
                  }
                }
                if (changed > 0) report('cmp:decorated', { changed })
              }
            } catch (e) { report('cmp:scan-throw', String((e && e.message) || e)) }
          }
          // 关键：MutationObserver 回调在**下一次绘制之前**执行 —— 因此在这里同步装饰即可消除
          // "先露出完整引用块、稍后才变紧凑"的闪烁（之前用 setTimeout(40ms) 期间已经画了一帧）。
          // decorate() 只在缺少 class 时改动 DOM，不会形成观察循环。
          decorate()
          composerDecorateNow = decorate
          try {
            observer = new MutationObserver(() => { decorate() })
            observer.observe(document.body, { childList: true, subtree: true, characterData: true })
          } catch (e) { report('cmp:observer-throw', String((e && e.message) || e)) }
          // 光标进出位置行时立即更新（光标在位置行里时临时显示该行，避免"打字看不见"）
          const onSelectionChange = () => { try { decorate() } catch (e) { /* ignore */ } }
          try { document.addEventListener('selectionchange', onSelectionChange) } catch (e) { /* ignore */ }
          // 点击输入框里的引用块 → 跳回原文并高亮（与消息侧一致；不依赖 chip，纯文本反查）
          const onCmpClick = (ev) => {
            try {
              const tgt = ev && ev.target
              const el = tgt && typeof tgt.closest === 'function' ? tgt.closest('.dshq-cmp-quote') : null
              if (!el) return
              if (!(el.closest && el.closest('[contenteditable="true"]'))) return
              const text = String(el.textContent || '').trim()
              if (text === '') return
              const r = el.getBoundingClientRect()
              jumpByQuoteText(text, { left: r.left + 16, top: r.top })
            } catch (e) { /* ignore */ }
          }
          try { document.addEventListener('click', onCmpClick, true) } catch (e) { /* ignore */ }
          return () => {
            if (composerDecorateNow === decorate) composerDecorateNow = null
            if (observer) { try { observer.disconnect() } catch (e) { /* ignore */ } }
            try { document.removeEventListener('selectionchange', onSelectionChange) } catch (e) { /* ignore */ }
            try { document.removeEventListener('click', onCmpClick, true) } catch (e) { /* ignore */ }
          }
        }, 'dsh-quote-annotate-pro: composer quote decoration')
      } catch (e) {
        report('apply:cmp-decor-throw', String((e && e.message) || e))
      }
      const tryRegister = (tag, fn) => {
        try { fn(); report('register:ok', tag); return true } catch (e) {
          report('register:throw', tag + ' :: ' + String((e && e.stack) || (e && e.message) || e))
          return false
        }
      }
      // 注意：conversation.chat.turnTail 自 0.1.6-alpha.2 起是 list 槽（不是 chain），
      // 注册参数必须是 { name, id, order }；上游用的 { select, priority } 在本版本会抛错，
      // 且它排在 4 个 overlay 注册之前 —— 一旦抛错就导致整个插件"静默失效"。
      tryRegister('dock:session-probe', () => slots.inject('conversation.input.dock', () => slots.register(
        { name: 'conversation.input.dock', id: 'quote-pro-session-probe', order: 1 },
        SessionProbe,
      )))
      // 引用块回到「输入框卡片上沿」的 dock 槽位（官方说明：Full-width entries above the composer card），
      // 用样式把它做成"贴在输入框上沿"的样子 —— DSH 没有"卡片内部、文字上方"的静态槽位：
      //   conversation.input.overlay 是浮动弹层（放的是 slash-menu / command-popup 这类），
      //   conversation.input.attachments 是官方草稿附件栏（single，占用会顶掉官方附件 UI，不能碰）。
      tryRegister('dock:quote-nav', () => slots.inject('conversation.input.dock', () => slots.register(
        { name: 'conversation.input.dock', id: 'quote-pro-quote-block', order: 2 },
        QuoteDock,
      )))
      tryRegister('turnTail', () => slots.inject('conversation.chat.turnTail', () => slots.register(
        { name: 'conversation.chat.turnTail', id: 'quote-turn-actions', order: 10 },
        TurnQuoteActions,
      )))
      tryRegister('overlay:toolbar', () => slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'quote-pro-selection-toolbar', order: 100 },
        SelectionToolbar,
      )))
      tryRegister('overlay:editor', () => slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'quote-pro-annotation-editor', order: 101 },
        AnnotationEditor,
      )))
      tryRegister('overlay:tooltip', () => slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'quote-pro-tooltip', order: 103 },
        QuoteTooltip,
      )))
      tryRegister('overlay:toast', () => slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'quote-pro-feedback-toast', order: 102 },
        FeedbackToast,
      )))
      // 底部文件批注条（docx/pdf/xlsx 等不可编辑预览里攒了批注时浮出）
      tryRegister('overlay:doc-notes', () => slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'quote-pro-doc-notes-bar', order: 104 },
        DocNotesBar,
      )))
      // 文档预览来源探针：注册在现有 UI 之后，且单独 try/catch ——
      // 槽位不存在时只是拿不到文件路径，绝不影响上面的 overlay 注册（避免"一个槽抛错全插件静默"）。
      tryRegister('slot:doc-path-probe', () => slots.inject('sidebar.right.tab.document.actions', () => slots.register(
        { name: 'sidebar.right.tab.document.actions', id: 'quote-pro-doc-path-probe', order: 200 },
        DocPathProbe,
      )))
      report('apply:done', { pipelineAvailable })
    }

    // Cordis 客户端插件：声明依赖让 apply 在 slots 服务就绪后才执行
    // （上游缺少这一行，slots 未就绪时 apply 第 534 行静默 return → 全插件失效）
    exports.name = 'dsh-quote-annotate-pro'
    exports.inject = ['slots']
    exports.apply = apply
    // 纯函数自检出口：tools/test-client.mjs 在 Node 里直接断言（宿主只读取 name/inject/apply）
    exports.__test = { roleText, anchorLabelOf, buildQuoteHeader, nextAnnotationNo, annotationNoOf, parseQuoteBlock, snippetOf, docSourceLabel, pathOfFileAddress, fileNameOfPath, pathRelativeTo, docSourceOf, docProbes, buildDocNotesBatch, docNotesStore, docNotesStorageKey, noteWhereLabel }
    return module.exports
  },
})
