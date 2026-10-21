/**
 * 清单一致性自检（CI 用，无外部依赖）：
 *   1. package.json 必需字段与 dsh 声明；
 *   2. exports['./client'] 指向的文件存在，且 bundle 的 `id` 与包名一致；
 *   3. cordis.patch.yml 确实 insert 了本包名。
 * 用法：node tools/check-manifest.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1 }
const ok = (msg) => console.log(`✓ ${msg}`)

const pkgPath = resolve(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

if (typeof pkg.name === 'string' && pkg.name !== '') ok(`name = ${pkg.name}`)
else fail('package.json 缺少 name')

if (typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version)) ok(`version = ${pkg.version}`)
else fail('package.json 缺少合法的 version')

if (pkg.type !== 'module') fail('package.json 应为 "type": "module"')
else ok('type = module')

const clientDecl = pkg.dsh && pkg.dsh.client
if (!clientDecl) fail('缺少 dsh.client 声明')
else if (clientDecl.platform !== 'web') fail(`dsh.client.platform 应为 web，实际 ${clientDecl.platform}`)
else ok('dsh.client.platform = web')

const patchRel = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
if (!patchRel) fail('缺少 dsh.bundle.patch')
else if (!existsSync(resolve(root, patchRel))) fail(`patch 文件不存在：${patchRel}`)
else ok(`dsh.bundle.patch = ${patchRel}`)

const clientRel = pkg.exports && pkg.exports['./client']
if (!clientRel) fail("缺少 exports['./client']")
else {
  const clientPath = resolve(root, clientRel)
  if (!existsSync(clientPath)) fail(`客户端 bundle 不存在：${clientRel}`)
  else {
    const head = readFileSync(clientPath, 'utf8').slice(0, 4000)
    const idMatch = /__ModuleLoader__\s*\.\s*load\s*\(\s*\{\s*id:\s*'([^']+)'/.exec(head)
    if (!idMatch) fail(`bundle 未以 window.__ModuleLoader__.load({ id, factory }) 形式注册：${clientRel}`)
    else if (idMatch[1] !== pkg.name) fail(`bundle 注册的 id (${idMatch[1]}) 与包名 (${pkg.name}) 不一致`)
    else ok(`bundle id = ${idMatch[1]}`)
  }
}

if (patchRel && existsSync(resolve(root, patchRel))) {
  const patch = readFileSync(resolve(root, patchRel), 'utf8')
  if (patch.includes(pkg.name)) ok(`patch 引用了 ${pkg.name}`)
  else fail(`patch 未引用包名 ${pkg.name}`)
}

if (pkg.main && !existsSync(resolve(root, pkg.main))) fail(`main 不存在：${pkg.main}`)
else if (pkg.main) ok(`main = ${pkg.main}`)

console.log(process.exitCode === 1 ? '\n自检未通过' : '\n自检通过')
