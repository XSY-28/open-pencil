import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = process.env.PROOF_ROOT
const version = process.env.PROOF_VERSION
assert.ok(root && ['0.16.0', '0.17.0'].includes(version))
const tools = join(root, 'tools', 'node_modules')
const evidence = join(root, 'evidence')
const documents = join(root, 'documents')
const appPath = join(root, 'squashfs-root', 'AppRun')
const runtime = join(root, 'runtime')
const discovery = join(runtime, 'openpencil', 'mcp.json')
const cli = join(tools, '.bin', 'openpencil')
const env = {
  ...process.env,
  GDK_BACKEND: 'x11',
  LIBGL_ALWAYS_SOFTWARE: '1',
  XDG_RUNTIME_DIR: runtime,
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_CACHE_HOME: join(root, 'cache'),
  XDG_DATA_HOME: join(root, 'data'),
  XDG_STATE_HOME: join(root, 'state'),
  PATH: `${join(tools, '.bin')}:${process.env.PATH}`
}
const report = { version, archiveSha256: process.env.PROOF_SHA, stage: 'setup' }
await Promise.all(
  [evidence, documents, runtime].map((dir) => mkdir(dir, { mode: 0o700, recursive: true }))
)

const options = { cwd: documents, env, timeout: 12_000, maxBuffer: 12 * 1024 * 1024 }
const cliOptions = { ...options, env: { ...env, OPENPENCIL_MCP_DISCOVERY_PATH: discovery } }
const targetColor = '#E5336B'
const white = '#FFFFFF'
const stage = (value) => {
  report.stage = value
  process.stdout.write(value + '\n')
}
const command = async (...args) => (await exec(cli, args, cliOptions)).stdout
const tool = async (name, input, target, ...flags) => {
  const result = JSON.parse(
    await command(
      'tool',
      'call',
      name,
      ...(target ? [target] : []),
      '--args',
      JSON.stringify(input),
      '--json',
      ...flags
    )
  )
  assert.ok(!result.error, result.error)
  return result
}
const findFill = (svg) => /<rect\b[^>]*\bfill="([^"]+)"/.exec(svg)?.[1].toUpperCase()

async function draw(target, name) {
  const write = target ? ['--write'] : []
  const collection = await tool('create_collection', { name: 'Synthetic colors' }, target, ...write)
  const createdVariable = await tool(
    'create_variable',
    {
      name,
      type: 'COLOR',
      collection_id: collection.id,
      value: targetColor
    },
    target,
    ...write
  )
  const createdRectangle = await tool(
    'create_shape',
    {
      type: 'RECTANGLE',
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      name: 'Synthetic rectangle'
    },
    target,
    ...write
  )
  // 0.16 rewrites new node IDs when the headless CLI persists an edit.
  const rectangle = target
    ? (await tool('get_page_tree', {}, target)).children.find(
        (node) => node.name === 'Synthetic rectangle'
      )
    : createdRectangle
  const variable = target
    ? (await tool('list_variables', { type: 'COLOR' }, target)).variables.find(
        (item) => item.name === name
      )
    : createdVariable
  assert.ok(rectangle?.id && variable?.id, 'Automation returned IDs')
  await tool('set_fill', { id: rectangle.id, color: white }, target, ...write)
  const input = { node_id: rectangle.id, field: 'fills/0/color', variable_id: variable.id }
  const getFill = async () =>
    findFill((await tool('export_svg', { ids: [rectangle.id] }, target)).svg)
  return { getFill, bind: () => tool('bind_variable', input, target, ...write), input }
}

async function screen(caption) {
  const { stdout: bytes } = await exec('import', ['-window', 'root', '-depth', '8', 'rgb:-'], {
    ...options,
    encoding: 'buffer'
  })
  assert.equal(bytes.length, 1280 * 864 * 3)
  let count = 0
  for (let offset = 0; offset < bytes.length; offset += 3) {
    if (
      Math.abs(bytes[offset] - 229) <= 2 &&
      Math.abs(bytes[offset + 1] - 51) <= 2 &&
      Math.abs(bytes[offset + 2] - 107) <= 2
    )
      count++
  }
  if (caption) await exec('import', ['-window', 'root', join(evidence, `${caption}.png`)], options)
  return count
}

const STARTUP_WAIT_MS = 60_000
const STARTUP_POLL_MS = 750
const HEALTH_TIMEOUT_MS = 2_000
const PAINT_SETTLE_MS = 550
const fixtureName = /^desktop-fixture(?:\.fig)?$/i
const knownDiagnostics = [
  /Could not read MCP discovery file/i,
  /no app|app not connected|not connected|RPC request timed out/i,
  /Unauthorized|Authentication token is invalid/i,
  /openpencil-mcp-http.{0,30}(?:not found|does not exist)|MCP automation is not installed/i,
  /major\.minor compatibility|requires @open-pencil\/mcp/i,
  /cannot open display|could not connect to display|no display name/i,
  /error while loading shared libraries|Failed to load .*webkit/i,
  /dbus|D-Bus/i,
  /EGL|GLX|GPU process|DMABUF/i,
  /WebKitWebProcess|WebView process/i,
  /not allowed|forbidden|Permission denied/i,
  /Could not open|failed to open|error while opening/i,
  /ECONNREFUSED|ENOENT|EADDRINUSE|EACCES/i
]
function diagnosticFlags(output) {
  return knownDiagnostics.filter((pattern) => pattern.test(output)).map((pattern) => pattern.source)
}

async function nativeDiagnostics(app) {
  const discoveryInfo = await readFile(discovery, 'utf8')
    .then(JSON.parse)
    .catch(() => null)
  const samples = {
    appPid: app.pid,
    appExitCode: app.exitCode,
    appSignal: app.signalCode,
    discoveryFound: discoveryInfo !== null,
    discoveryHasToken: typeof discoveryInfo?.authToken === 'string'
  }
  if (samples.discoveryHasToken && discoveryInfo.httpPort === 7600) {
    try {
      const health = await fetch('http://127.0.0.1:7600/health', {
        headers: { authorization: 'Bearer ' + discoveryInfo.authToken },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
      })
      const { status, version: serverVersion, authRequired } = await health.json()
      report.mcpHealth = { httpStatus: health.status, status, version: serverVersion, authRequired }
    } catch (error) {
      report.mcpHealth = { error: error.cause?.code ?? error.name }
    }
  }
  const output = await exec('ps', ['-e', '-o', 'pid=,ppid=,comm='], options).catch(() => null)
  const processes = (output?.stdout ?? '')
    .trim()
    .split('\n')
    .map((line) => {
      const [pid, parent, name] = line.trim().split(/\s+/, 3)
      return { pid: Number(pid), parent: Number(parent), name }
    })
  const owned = new Set([app.pid])
  for (;;) {
    const size = owned.size
    for (const process of processes) {
      if (owned.has(process.parent)) owned.add(process.pid)
    }
    if (owned.size === size) break
  }
  samples.children = processes.filter((process) => owned.has(process.pid))
  samples.startupDiagnostics = diagnosticFlags(appLog)
  report.native = samples
}

async function ready(app, fig) {
  const deadline = Date.now() + STARTUP_WAIT_MS
  let readCount = 0
  let explicitOpen = false
  while (Date.now() < deadline) {
    assert.equal(app.exitCode, null, 'AppImage exited before opening a document')
    let data
    try {
      data = JSON.parse(await command('documents', 'list', '--json'))
    } catch (error) {
      report.cli = {
        succeeded: false,
        code: error.code,
        diagnostics: diagnosticFlags(String(error.stderr ?? error.message))
      }
      await delay(STARTUP_POLL_MS)
      continue
    }
    const docs = Array.isArray(data) ? data : data.documents
    assert.ok(Array.isArray(docs), 'Unsupported CLI documents list format')
    report.cli = {
      succeeded: true,
      documents: docs.map((doc) => ({
        id: doc.id,
        name: /^(desktop-fixture(?:\.fig)?|untitled|home)$/i.test(doc.name) ? doc.name : 'other',
        active: doc.active
      }))
    }
    const fixture = docs.find((doc) => fixtureName.test(doc.name))
    if (fixture?.active) {
      report.documentOpen = explicitOpen ? 'explicit CLI' : 'native argv'
      return fixture.id
    }
    if (!explicitOpen && ++readCount === 4) {
      // An attached editor may open Home on startup. Use the product's CLI on
      // the same synthetic file, and report that fallback as a separate path.
      await command('documents', 'open', fig, '--json')
      explicitOpen = true
    }
    await delay(STARTUP_POLL_MS)
  }
  throw new Error('Matching released CLI could not see an active AppImage document')
}

let app
let appLog = ''
try {
  const installed = {}
  for (const name of ['cli', 'mcp']) {
    const packageJSON = join(tools, '@open-pencil', name, 'package.json')
    installed[name] = JSON.parse(await readFile(packageJSON, 'utf8')).version
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
  app.on('error', (error) => {
    appLog = error.message
  })
  const captureStartupLog = (bytes) => {
    appLog = (appLog + bytes.toString()).slice(-6000)
  }
  app.stdout.on('data', captureStartupLog)
  app.stderr.on('data', captureStartupLog)
  const documentId = await ready(app, fig)
  await nativeDiagnostics(app)
  assert.equal(report.mcpHealth?.status, 'ok', 'The matching MCP companion is not attached')
  assert.equal(report.mcpHealth?.version, version, 'The MCP companion version does not match')
  assert.equal(
    report.mcpHealth?.authRequired,
    true,
    'The MCP companion requires its normal authentication'
  )
  report.documentId = documentId
  stage('live MCP tool roundtrip')
  const live = await draw(undefined, 'color/smoke')
  const x11Windows = await exec(
    'xdotool',
    ['search', '--onlyvisible', '--name', 'OpenPencil|desktop-fixture'],
    options
  ).catch(() => null)
  if (x11Windows) {
    const window = x11Windows.stdout.trim().split('\n').at(-1)
    await exec('xdotool', ['windowfocus', window, 'key', 'shift+1'], options).catch(() => undefined)
  }
  await delay(PAINT_SETTLE_MS)
  report.live = { before: await live.getFill(), pixelsBefore: await screen('before') }
  assert.equal(report.live.before, white)
  const binding = await live.bind()
  assert.equal(binding.variable_id, live.input.variable_id)
  report.live.binding = binding
  report.live.after = await live.getFill()
  await delay(PAINT_SETTLE_MS)
  report.live.pixelsAfter = await screen('after')
  if (report.live.after === white) report.verdict = 'stored-binding-still-white-in-export'
  else if (
    report.live.after === targetColor &&
    report.live.pixelsAfter > report.live.pixelsBefore + 500
  ) {
    report.verdict = 'bound-color-in-live-export-and-native-display'
  } else if (report.live.after === targetColor)
    report.verdict = 'live-export-correct-display-unverified'
  else throw new Error(`Unexpected SVG fill ${report.live.after}`)
  stage('complete')
} catch (error) {
  report.verdict = 'inconclusive'
  report.error =
    error.code === undefined ? String(error.message).split('\n')[0] : 'A proof command failed'
  if (app) {
    await nativeDiagnostics(app)
    await screen('startup-failure').catch((captureError) => {
      report.captureError = captureError.code ?? captureError.name
    })
  }
  console.error(report.error)
  process.exitCode = 1
} finally {
  app?.kill()
  await writeFile(join(evidence, 'result.json'), `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(JSON.stringify(report) + '\n')
}
