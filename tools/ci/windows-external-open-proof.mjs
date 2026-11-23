import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { prepareWindowsRuntime } from './windows-external-open-runtime.mjs'

const source = '1814dcbd0a493924adc6518e5bd35f25a60a582e'
const beta = {
  revision: '9e43b6d3b26cea2badcf3707489da579696b9857',
  version: '0.17.0-beta.4',
  asset: 'OpenPencil_0.17.0-beta.4_x64-setup.exe',
  sha256: 'd78c10d8379361a0fcc84cb665b406eece60c73812d2634ecf0b49585521a573'
}
const proofFiles = new Set([
  '.github/workflows/proof-windows-external-open.yml',
  'tools/ci/windows-external-open-proof.mjs',
  'tools/ci/windows-external-open-runtime.mjs'
])
const { GITHUB_ACTIONS, RUNNER_OS, RUNNER_TEMP, LOCALAPPDATA, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } =
  process.env
const lane = process.env.PROOF_LANE
const operation = process.argv[2]

assert.equal(process.platform, 'win32', 'This proof only runs on Windows CI')
assert.equal(process.arch, 'x64', 'The issue and binaries target x64')
assert.equal(GITHUB_ACTIONS, 'true')
assert.equal(RUNNER_OS, 'Windows')
assert.ok(RUNNER_TEMP && LOCALAPPDATA && GITHUB_RUN_ID && GITHUB_RUN_ATTEMPT)
assert.ok(lane === 'master' || lane === 'beta4', 'Unknown proof lane')
assert.ok(operation === 'prepare' || operation === 'run')

const root = join(RUNNER_TEMP, 'openpencil-2018-' + lane)
const reportDirectory = resolve('windows-proof-result', lane)
const reportPath = join(reportDirectory, 'result.json')
const fixtures = join(root, 'Synthetic design files')
const tools = join(root, 'companions')
const discoveryPath = join(
  LOCALAPPDATA,
  'OpenPencil2018Proof',
  GITHUB_RUN_ID + '-' + GITHUB_RUN_ATTEMPT,
  lane,
  'mcp.json'
)
const mcpPort = 7600
const CDP_PROBE_TIMEOUT_MS = 1_500
const MCP_HEALTH_TIMEOUT_MS = 5_000
const report =
  operation === 'run'
    ? JSON.parse(await readFile(reportPath, 'utf8'))
    : { lane, source: lane === 'master' ? source : beta.revision, outcomes: [] }
const exec = promisify(execFile)

async function command(program, args, options = {}) {
  const result = await exec(program, args, { timeout: 60_000, windowsHide: true, ...options })
  return result.stdout.trim()
}

function powershell(code) {
  return command(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      // oxlint-disable-next-line @open-pencil/data/no-hand-rolled-base64 -- this CI bootstrap runs before dependencies are installed.
      Buffer.from(code, 'utf16le').toString('base64')
    ],
    { timeout: 180_000 }
  )
}

async function stage(name, details = {}) {
  report.stage = name
  report.outcomes.push({ stage: name, ...details })
  await mkdir(reportDirectory, { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(name + ' ' + JSON.stringify(details) + '\n')
}

async function sha256(file) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
}

async function openPort(port = 0) {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port
      server.close(() => resolvePort(actual))
    })
  })
}

async function until(description, check, timeout = 35_000) {
  const end = Date.now() + timeout
  let lastError
  do {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(450)
  } while (Date.now() < end)
  throw new Error(description, { cause: lastError })
}

async function prepare() {
  await stage('prepare-runner')
  const changed = (await command('git', ['diff', '--name-only', source, '--'])).split(/\r?\n/u)
  assert.deepEqual(
    changed.filter((file) => file && !proofFiles.has(file)),
    [],
    'Product checkout differs from reviewed master'
  )
  const runner = await prepareWindowsRuntime({
    lane,
    root,
    tools,
    beta,
    command,
    powershell,
    sha256,
    stage
  })
  report.runner = runner
  await stage(lane === 'master' ? 'waiting-for-native-build' : 'waiting-for-native-run', runner)
}

function fixtureName(letter) {
  return 'External design ' + letter
}

async function run() {
  const { executable, cli, companion, cliVersion, mcpVersion, expectedVersion } = await toolchain()
  const { chromium } = await import(
    pathToFileURL(join(tools, 'node_modules', 'playwright-core', 'index.mjs')).href
  )
  await stage('native-executable', {
    version: expectedVersion,
    cliVersion,
    mcpVersion,
    sha256: await sha256(executable)
  })

  const binaries = join(tools, 'node_modules', '.bin')
  await mkdir(binaries, { recursive: true })
  if (lane === 'master') {
    // Same executable contract as the official npm Windows bin shim.
    await writeFile(
      join(binaries, 'openpencil-mcp-http.cmd'),
      '@"' + process.execPath + '" "' + companion + '" %*\r\n'
    )
  }
  await mkdir(dirname(discoveryPath), { recursive: true })
  await mkdir(fixtures, { recursive: true })
  const port = await openPort()
  await openPort(mcpPort)
  const env = {
    ...process.env,
    Path: [binaries, dirname(process.execPath), process.env.Path || process.env.PATH || ''].join(
      ';'
    ),
    OPENPENCIL_MCP_DISCOVERY_PATH: discoveryPath,
    OPENPENCIL_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
    OPENPENCIL_SELF_UPDATE: '0',
    WEBVIEW2_USER_DATA_FOLDER: join(root, 'WebView2 isolated profile'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      '--remote-debugging-address=127.0.0.1 --remote-debugging-port=' + port
  }
  // Windows sorts duplicate case-insensitive environment keys before choosing one.
  delete env.PATH

  const call = (...args) =>
    command(process.execPath, [cli, ...args], { env, cwd: fixtures, timeout: 30_000 })
  const documents = async () => JSON.parse(await call('documents', 'list', '--json'))
  const { letters, paths, expected, hashes, beforeHashes } = await createFixtures(call)

  const cdpURL = 'http://127.0.0.1:' + port
  const main = spawn(executable, [paths[0]], {
    cwd: fixtures,
    env,
    stdio: 'ignore',
    windowsHide: false
  })
  assert.ok(main.pid)
  let launchError
  main.on('error', (error) => {
    launchError = error
  })
  let browser
  let page
  let lastDocuments = []
  const launches = [{ document: expected[0], launch: 'cold argv', pid: main.pid }]
  report.launches = launches
  try {
    const version = await until(
      'The desktop process did not provide a WebView2 CDP endpoint',
      async () => {
        if (launchError) throw launchError
        assert.equal(main.exitCode, null, 'OpenPencil exited before WebView2 became ready')
        const response = await fetch(cdpURL + '/json/version', {
          signal: AbortSignal.timeout(CDP_PROBE_TIMEOUT_MS)
        })
        return response.ok ? response.json() : null
      }
    )
    browser = await chromium.connectOverCDP(cdpURL)
    page = await until('No Tauri WebView2 document', () =>
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) =>
          /^(https?:\/\/tauri\.localhost|tauri:\/\/localhost)(\/|$)/u.test(candidate.url())
        )
    )
    const runtime = await page.evaluate(async () => ({
      agent: navigator.userAgent,
      version: await window.__TAURI_INTERNALS__?.invoke('plugin:app|version'),
      viewport: { width: innerWidth, height: innerHeight }
    }))
    assert.ok(runtime.agent.includes('Windows'), 'CDP did not attach to Windows')
    assert.equal(
      runtime.version,
      expectedVersion,
      'The native WebView belongs to an unexpected application version'
    )
    await stage('verified-native-webview', { pid: main.pid, product: version.Browser, ...runtime })
    const welcome = page.locator('[data-test-id="ai-setup-dialog"]')
    if (await welcome.isVisible()) {
      await welcome
        .getByRole('button', { name: /^(start designing|skip for now)$/iu })
        .click({ timeout: 10_000 })
    }

    const userTab = (name) => page.getByRole('tab').filter({ hasText: name })
    const readActive = (name) =>
      until('No MCP document became active for ' + name, async () => {
        lastDocuments = await documents()
        return lastDocuments.find((doc) => doc.name === name && doc.active)
      })
    const load = async (name, letter) => {
      const doc = await readActive(name)
      await page
        .locator('[data-test-id="layers-item"]')
        .filter({
          hasText: 'Synthetic marker ' + letter
        })
        .waitFor({ state: 'visible', timeout: 25_000 })
      return doc
    }
    const appEval = async (id, code) =>
      JSON.parse(await call('eval', '--document-id', id, '--code', code, '--json'))
    const first = await load(expected[0], 'A')
    const issuedDiscovery = JSON.parse(await readFile(discoveryPath, 'utf8'))
    assert.equal(issuedDiscovery.httpPort, mcpPort)
    assert.ok(issuedDiscovery.authToken, 'Expected the real authenticated MCP bridge')
    const health = await fetch('http://127.0.0.1:' + mcpPort + '/health', {
      headers: { authorization: 'Bearer ' + issuedDiscovery.authToken },
      signal: AbortSignal.timeout(MCP_HEALTH_TIMEOUT_MS)
    })
    assert.ok(health.ok)
    assert.equal(
      (await health.json()).version,
      mcpVersion,
      'Connected to a different MCP companion'
    )
    await stage('verified-independent-mcp', { version: mcpVersion, pid: main.pid, first: first.id })

    const readMarker = String.raw`
      const shape = figma.currentPage.children.find(node => node.name === 'Unsaved Windows proof');
      return shape ? { id: shape.id, width: shape.width, height: shape.height } : null;
    `
    const dirty = await appEval(
      first.id,
      String.raw`
      const shape = figma.createRectangle();
      shape.name = 'Unsaved Windows proof';
      shape.resize(123, 57);
      return { id: shape.id, width: shape.width, height: shape.height };
    `
    )
    assert.ok(dirty?.id)
    assert.deepEqual(await appEval(first.id, readMarker), dirty)
    await until(
      'A never became dirty',
      async () => (await userTab(expected[0]).getAttribute('data-dirty')) === 'true'
    )
    await stage('dirty-first-document', { document: first.id, edit: dirty })

    for (const [index, letter] of letters.entries()) {
      if (!index) continue
      assert.equal(main.exitCode, null, 'The original process exited')
      if (letter === 'F') {
        assert.equal(await userTab(expected[0]).getAttribute('data-dirty'), 'true')
        assert.deepEqual(await appEval(first.id, readMarker), dirty)
        await stage('five-documents-before-sixth', {
          documents: lastDocuments.map(({ id, name }) => ({ id, name })),
          dirty
        })
      }
      // Reproduce OpenPencil.exe "file.fig", with cwd and spaces in the real argument.
      const activation = exec(executable, [basename(paths[index])], {
        env,
        cwd: fixtures,
        windowsHide: false,
        timeout: 22_000
      })
      const secondaryPid = activation.child.pid
      assert.ok(
        secondaryPid && secondaryPid !== main.pid,
        'No separate native argv process was spawned'
      )
      const launch = {
        document: expected[index],
        launch: 'second process argv',
        pid: secondaryPid,
        primaryPid: main.pid
      }
      launches.push(launch)
      await activation
      launch.exitCode = 0
      await stage('external-process-exited-' + letter, launch)
      const opened = await load(expected[index], letter)
      launch.id = opened.id
      await stage('external-open-' + letter, {
        opened: opened.id,
        documents: lastDocuments.map(({ id, name }) => ({ id, name }))
      })
      if (index < 5) {
        assert.deepEqual(
          lastDocuments.filter((doc) => expected.includes(doc.name)).map((doc) => doc.name),
          expected.slice(0, index + 1)
        )
      }
    }
    assert.equal(main.exitCode, null, 'The primary process did not survive the sixth open')
    const afterOpen = lastDocuments.filter((doc) => expected.includes(doc.name))
    report.nativeBoundaryReached = true
    const uiAfterF = await tabBar(page, expected[0], expected[5])
    await stage('sixth-open-observed', { documents: afterOpen, tabBar: uiAfterF })
    await page.screenshot({ path: join(reportDirectory, 'after-sixth.png') })
    if (afterOpen.length < 6) {
      report.verdict = 'sixth-open-removed-existing-document'
      throw new Error('F opened, but MCP no longer lists all five earlier documents')
    }
    assert.deepEqual(
      afterOpen.map(({ name }) => name),
      expected
    )
    if (!expected.every((name) => uiAfterF.tabs.some((tab) => tab.name === name))) {
      report.verdict = 'documents-retained-but-tab-bar-omits-a-tab'
      throw new Error('MCP lists six documents, but the tab bar omits at least one')
    }
    assert.equal(new Set(afterOpen.map(({ id }) => id)).size, 6)
    assert.equal(afterOpen[0].id, first.id, 'A was replaced with a different editor tab')

    await recordNarrowViewport(page, main.pid, runtime.viewport.width, expected[0], expected[5])
    await userTab(expected[0]).click()
    await readActive(expected[0])
    await page
      .locator('[data-test-id="layers-item"]')
      .filter({ hasText: 'Unsaved Windows proof' })
      .waitFor()
    assert.equal(await userTab(expected[0]).getAttribute('data-dirty'), 'true')
    assert.deepEqual(await appEval(first.id, readMarker), dirty)
    await page.screenshot({ path: join(reportDirectory, 'returned-to-dirty-a.png') })
    report.verdict = 'all-six-retained-with-unsaved-edit'
    await stage('verified-return-to-first-tab', { document: first.id, edit: dirty })
  } catch (error) {
    report.verdict ??= 'inconclusive'
    await stage('scenario-stopped', {
      reason: error.message,
      ...(error.cause ? { cause: error.cause.message } : {}),
      documents: lastDocuments.map(({ id, name, active }) => ({ id, name, active }))
    })
    throw error
  } finally {
    try {
      const afterHashes = await hashes()
      const unchanged = JSON.stringify(afterHashes) === JSON.stringify(beforeHashes)
      const unexpectedWrite = report.verdict === 'all-six-retained-with-unsaved-edit' && !unchanged
      if (unexpectedWrite) report.verdict = 'unexpected-write-to-fixture'
      await stage('disk-checksums-after', { unchanged, hashes: afterHashes })
      assert.ok(!unexpectedWrite, 'A synthetic file changed on disk')
    } finally {
      if (main.exitCode === null) {
        await command('taskkill.exe', ['/PID', String(main.pid), '/T', '/F'], {
          timeout: 12_000
        }).catch(warnCleanup)
      }
      await browser?.close().catch(warnCleanup)
    }
  }
}

function warnCleanup(error) {
  console.warn('Could not clean up Windows proof processes:', error.message)
}

async function toolchain() {
  const executable =
    lane === 'master' ? resolve('target/debug/OpenPencil.exe') : join(root, 'OpenPencil.exe')
  const cli =
    lane === 'master'
      ? resolve('packages/cli/bin/openpencil.js')
      : join(tools, 'node_modules', '@open-pencil', 'cli', 'bin', 'openpencil.js')
  const companion =
    lane === 'master'
      ? resolve('packages/mcp/dist/index.mjs')
      : join(tools, 'node_modules', '@open-pencil', 'mcp', 'dist', 'index.mjs')
  const prefix =
    lane === 'master' ? resolve('packages') : join(tools, 'node_modules', '@open-pencil')
  const cliVersion = JSON.parse(await readFile(join(prefix, 'cli', 'package.json'), 'utf8')).version
  const mcpVersion = JSON.parse(await readFile(join(prefix, 'mcp', 'package.json'), 'utf8')).version
  const sourceVersion = JSON.parse(await readFile('package.json', 'utf8')).version
  const expectedVersion = lane === 'master' ? sourceVersion : beta.version
  assert.equal(cliVersion, expectedVersion)
  assert.equal(mcpVersion, expectedVersion)
  return { executable, cli, companion, cliVersion, mcpVersion, expectedVersion }
}

async function createFixtures(call) {
  const input = join(fixtures, 'fixture.pen')
  await writeFile(input, '{"version":"2.8","children":[]}\n')
  const letters = ['A', 'B', 'C', 'D', 'E', 'F']
  const paths = letters.map((letter) => join(fixtures, fixtureName(letter) + '.fig'))
  const expected = letters.map(fixtureName)
  const hashes = async () =>
    Object.fromEntries(
      await Promise.all(paths.map(async (file) => [basename(file), await sha256(file)]))
    )
  for (const [index, letter] of letters.entries()) {
    await call(
      'eval',
      input,
      '--code',
      [
        'const shape = figma.createRectangle();',
        'shape.name = ' + JSON.stringify('Synthetic marker ' + letter) + ';',
        'shape.resize(80, 60);'
      ].join(' '),
      '--output',
      paths[index],
      '--quiet'
    )
    assert.equal((await readFile(paths[index])).subarray(0, 4).toString('hex'), '504b0304')
  }
  const beforeHashes = await hashes()
  assert.equal(new Set(Object.values(beforeHashes)).size, letters.length)
  await stage('fixture-checksums', beforeHashes)

  return { letters, paths, expected, hashes, beforeHashes }
}

async function recordNarrowViewport(page, pid, originalWidth, firstName, activeName) {
  // Resize the actual Win32 window and observe overflow without changing the WebView viewport via CDP.
  try {
    assert.ok(Number.isSafeInteger(pid))
    await powershell(
      String.raw`
        $ErrorActionPreference = 'Stop'
        Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ResizeProof { [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr window, IntPtr next, int x, int y, int w, int h, uint flags); }'
        $handle = (Get-Process -Id PROCESS_ID).MainWindowHandle
        if (!$handle -or ![ResizeProof]::SetWindowPos($handle, [IntPtr]::Zero, 0, 0, 560, 760, 0x16)) { throw 'Resize of the proof app window failed' }
      `.replace('PROCESS_ID', String(pid))
    )
    await until('The WebView did not resize', () =>
      page.evaluate((previous) => innerWidth < previous, originalWidth)
    )
    await page.screenshot({ path: join(reportDirectory, 'narrow-six-tabs.png') })
    await stage('narrow-native-window', await tabBar(page, firstName, activeName))
  } catch (error) {
    await stage('narrow-native-window-unavailable', { reason: error.message })
  }
}

function tabBar(page, firstName, activeName) {
  return page.evaluate(
    ({ firstName, activeName }) => {
      const bar = document.querySelector('[data-slot="tab-bar"]')
      const list = bar?.querySelector('[role="tablist"]')
      const scroller = list?.parentElement
      if (!list || !scroller) throw new Error('The native app did not render the tab bar')
      const bounds = scroller.getBoundingClientRect()
      const tabs = [...list.querySelectorAll('[role="tab"]')].map((tab) => {
        const rect = tab.getBoundingClientRect()
        return {
          name: tab.textContent?.trim() || tab.getAttribute('aria-label'),
          selected: tab.getAttribute('aria-selected') === 'true',
          dirty: tab.getAttribute('data-dirty') === 'true',
          clipped: rect.left < bounds.left - 1 || rect.right > bounds.right + 1
        }
      })
      return {
        viewportWidth: innerWidth,
        scrollLeft: scroller.scrollLeft,
        overflow: scroller.scrollWidth - scroller.clientWidth,
        first: tabs.find((tab) => tab.name === firstName),
        active: tabs.find((tab) => tab.name === activeName),
        tabs
      }
    },
    { firstName, activeName }
  )
}

try {
  if (operation === 'prepare') await prepare()
  else await run()
} catch (error) {
  report.verdict ??= 'inconclusive'
  report.error = error.message
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  throw error
}
