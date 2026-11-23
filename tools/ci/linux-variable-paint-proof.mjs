import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = process.env.PROOF_ROOT
const version = process.env.PROOF_VERSION
assert(root && ['0.16.0', '0.17.0'].includes(version))
const tools = join(root, 'tools', 'node_modules')
const evidence = join(root, 'evidence')
const documents = join(root, 'documents')
const appPath = join(root, 'squashfs-root', 'AppRun')
const discovery = join(root, 'runtime', 'mcp.json')
const cli = join(tools, '.bin', 'openpencil')
const env = {
  ...process.env,
  GDK_BACKEND: 'x11',
  LIBGL_ALWAYS_SOFTWARE: '1',
  OPENPENCIL_MCP_DISCOVERY_PATH: discovery,
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_CACHE_HOME: join(root, 'cache'),
  XDG_DATA_HOME: join(root, 'data'),
  XDG_STATE_HOME: join(root, 'state'),
  PATH: `${join(tools, '.bin')}:${process.env.PATH}`
}
const report = { version, archiveSha256: process.env.PROOF_SHA, stage: 'setup' }
await Promise.all([evidence, documents, join(root, 'runtime')].map(dir => mkdir(dir, { recursive: true })))

const options = { cwd: documents, env, timeout: 12_000, maxBuffer: 12 * 1024 * 1024 }
const targetColor = '#E5336B'
const white = '#FFFFFF'
const stage = value => {
  report.stage = value
  console.log(value)
}
const command = async (...args) => (await exec(cli, args, options)).stdout
const tool = async (name, input, target, ...flags) => {
  const result = JSON.parse(await command('tool', 'call', name, ...(target ? [target] : []),
    '--args', JSON.stringify(input), '--json', ...flags))
  assert(!result.error, result.error)
  return result
}
const findFill = svg => /<rect\b[^>]*\bfill="([^"]+)"/.exec(svg)?.[1].toUpperCase()

async function draw(target, name) {
  const write = target ? ['--write'] : []
  const collection = await tool('create_collection', { name: 'Synthetic colors' }, target, ...write)
  const createdVariable = await tool('create_variable', {
    name, type: 'COLOR', collection_id: collection.id, value: targetColor
  }, target, ...write)
  const createdRectangle = await tool('create_shape', {
    type: 'RECTANGLE', x: 0, y: 0, width: 200, height: 200, name: 'Synthetic rectangle'
  }, target, ...write)
  // 0.16 rewrites new node IDs when the headless CLI persists an edit.
  const rectangle = target
    ? (await tool('get_page_tree', {}, target)).children.find(node => node.name === 'Synthetic rectangle')
    : createdRectangle
  const variable = target
    ? (await tool('list_variables', { type: 'COLOR' }, target)).variables.find(item => item.name === name)
    : createdVariable
  assert(rectangle?.id && variable?.id, 'Automation returned IDs')
  await tool('set_fill', { id: rectangle.id, color: white }, target, ...write)
  const input = { node_id: rectangle.id, field: 'fills/0/color', variable_id: variable.id }
  const getFill = async () => findFill((await tool('export_svg', { ids: [rectangle.id] }, target)).svg)
  return { getFill, bind: () => tool('bind_variable', input, target, ...write), input }
}

async function screen(caption) {
  const { stdout: bytes } = await exec('import', ['-window', 'root', '-depth', '8', 'rgb:-'], {
    ...options, encoding: 'buffer'
  })
  assert.equal(bytes.length, 1280 * 864 * 3)
  let count = 0
  for (let offset = 0; offset < bytes.length; offset += 3) {
    if (Math.abs(bytes[offset] - 229) <= 2 && Math.abs(bytes[offset + 1] - 51) <= 2 &&
        Math.abs(bytes[offset + 2] - 107) <= 2) count++
  }
  if (caption) await exec('import', ['-window', 'root', join(evidence, `${caption}.png`)], options)
  return count
}

async function ready(app) {
  for (let attempt = 0; attempt < 40; attempt++) {
    assert.equal(app.exitCode, null, 'AppImage exited before opening a document')
    const logs = await command('documents', 'list', '--json').catch(() => null)
    if (logs) {
      const data = JSON.parse(logs)
      const docs = Array.isArray(data) ? data : data.documents
      if (docs?.some(doc => doc.active && /^desktop-fixture(?:\.fig)?$/i.test(doc.name))) return
    }
    await delay(750)
  }
  throw new Error('Matching released CLI could not see an open AppImage document')
}

let app
let appLog = ''
try {
  const installed = {}
  for (const name of ['cli', 'mcp']) {
    const packageJson = join(tools, '@open-pencil', name, 'package.json')
    installed[name] = JSON.parse(await readFile(packageJson, 'utf8')).version
    assert.equal(installed[name], version)
  }
  report.installed = installed
  const pen = join(documents, 'synthetic.pen')
  const fig = join(documents, 'desktop-fixture.fig')
  const headlessFig = join(documents, 'headless-fixture.fig')
  await writeFile(pen, '{"version":"2.8","children":[]}\n')
  for (const destination of [fig, headlessFig]) {
    await command('eval', pen, '--code', 'return 0', '--output', destination, '--quiet')
    assert.equal((await readFile(destination)).subarray(0, 4).toString('hex'), '504b0304')
  }
  stage('headless control')
  const headless = await draw(headlessFig, 'color/smoke')
  report.headless = { before: await headless.getFill() }
  const stored = await headless.bind()
  assert.equal(stored.variable_id, headless.input.variable_id)
  report.headless.after = await headless.getFill()
  assert.equal(report.headless.before, white)
  assert.equal(report.headless.after, targetColor)

  stage('wait for actual AppImage and its MCP bridge')
  app = spawn(appPath, [fig], { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  app.on('error', error => { appLog = error.message })
  for (const stream of [app.stdout, app.stderr]) stream.on('data', bytes => {
    appLog = (appLog + bytes.toString()).slice(-6000)
  })
  await ready(app)
  stage('live MCP tool roundtrip')
  const live = await draw(undefined, 'color/smoke')
  const x11Windows = await exec('xdotool', ['search', '--onlyvisible', '--name', 'OpenPencil|desktop-fixture'], options).catch(() => null)
  if (x11Windows) {
    const window = x11Windows.stdout.trim().split('\n').at(-1)
    await exec('xdotool', ['windowfocus', window, 'key', 'shift+1'], options).catch(() => undefined)
  }
  await delay(500)
  report.live = { before: await live.getFill(), pixelsBefore: await screen('before') }
  assert.equal(report.live.before, white)
  const binding = await live.bind()
  assert.equal(binding.variable_id, live.input.variable_id)
  report.live.binding = binding
  report.live.after = await live.getFill()
  await delay(550)
  report.live.pixelsAfter = await screen('after')
  if (report.live.after === white) report.verdict = 'stored-binding-still-white-in-export'
  else if (report.live.after === targetColor && report.live.pixelsAfter > report.live.pixelsBefore + 500) {
    report.verdict = 'bound-color-in-live-export-and-native-display'
  } else if (report.live.after === targetColor) report.verdict = 'live-export-correct-display-unverified'
  else throw new Error(`Unexpected SVG fill ${report.live.after}`)
  stage('complete')
} catch (error) {
  report.error = String(error.message).split('\n').slice(0, 6).join('\n')
  report.verdict = 'inconclusive'
  console.error(report.error)
  // The app may log runtime paths; retain only whether it emitted data.
  console.error('AppImage emitted startup output:', appLog.length > 0)
  process.exitCode = 1
} finally {
  app?.kill()
  await writeFile(join(evidence, 'result.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report))
}
