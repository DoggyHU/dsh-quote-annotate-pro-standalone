/**
 * 本地诊断接收端（开发期可选）。
 *
 * 插件（lib/client.js）在启动时会向 `http://127.0.0.1:47821/dsh-quote-pro` POST 一次 `/ping`
 * 探测接收端：探测不到就本次运行静默，因此**不开这个脚本插件也能正常工作**。
 *
 * 用法：
 *   node tools/diag-sink.mjs
 *   # 自定义端口 / 日志文件：
 *   DIAG_PORT=47821 DIAG_LOG=./diag-sink.log node tools/diag-sink.mjs
 *
 * 之后在 DSH 里操作插件，终端会实时打出全链路事件：
 *   module:materialized / apply:start / register:ok …       插件加载与槽位注册
 *   selection:show / selection:stage                        划词与「批注」
 *   insert:chip / insert:fallback-plaintext                 引用插入（chip 或纯文本回退）
 *   dock:rows / dock:click / jump:ok / toast                导航条与跳回原文
 *   turnTail:render                                         回合尾部按钮取文
 */
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const PORT = Number(process.env.DIAG_PORT ?? 47821)
const LOG = resolve(process.env.DIAG_LOG ?? 'diag-sink.log')

mkdirSync(dirname(LOG), { recursive: true })

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '600',
}

createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return
  }
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
    if (body.length > 200000) req.destroy()
  })
  req.on('end', () => {
    const line = `${new Date().toISOString()}\t${req.method}\t${req.url}\t${body.replace(/[\r\n]+/g, '\\n')}\n`
    try { appendFileSync(LOG, line) } catch (error) { console.error('append failed', error) }
    if (req.url !== '/ping') process.stdout.write(line)
    res.writeHead(200, { ...cors, 'Content-Type': 'text/plain' })
    res.end('ok')
  })
}).listen(PORT, '127.0.0.1', () => {
  console.log(`diag sink listening on http://127.0.0.1:${PORT}/  -> ${LOG}`)
  console.log('插件里对应的常量：const DIAG_URL = `http://127.0.0.1:${PORT}/dsh-quote-pro`')
})
