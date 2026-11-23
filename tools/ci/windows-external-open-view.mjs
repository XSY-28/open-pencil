import assert from 'node:assert/strict'
import { join } from 'node:path'

const CDP_STARTUP_TIMEOUT_MS = 12_000
const CDP_PROBE_TIMEOUT_MS = 1_500

export async function observeWebView({ chromium, cdpURL, main, expectedVersion, until, stage }) {
  let browser
  let page
  try {
    const version = await until(
      'The desktop process did not provide a WebView2 CDP endpoint',
      async () => {
        assert.equal(main.exitCode, null, 'OpenPencil exited before WebView2 became ready')
        const response = await fetch(cdpURL + '/json/version', {
          signal: AbortSignal.timeout(CDP_PROBE_TIMEOUT_MS)
        })
        return response.ok ? response.json() : null
      },
      CDP_STARTUP_TIMEOUT_MS
    )
    browser = await chromium.connectOverCDP(cdpURL, { timeout: CDP_STARTUP_TIMEOUT_MS })
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

    return { browser, page, viewportWidth: runtime.viewport.width }
  } catch (error) {
    await stage('native-webview-observation-unavailable', {
      reason: error.message,
      code: error.cause?.cause?.code ?? error.cause?.code
    })
    return { browser, page: null }
  }
}

export async function recordStartup({ pid, powershell, stage }) {
  assert.ok(Number.isSafeInteger(pid))
  try {
    const sample = JSON.parse(
      await powershell(
        String.raw`
      $appPid = PROCESS_ID
      $main = Get-Process -Id $appPid -ErrorAction SilentlyContinue
      $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $appPid" |
        Select-Object Name, ProcessId)
      $windowsPrincipal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
      @{
        pid = $appPid
        running = $null -ne $main
        mainWindow = $null -ne $main -and $main.MainWindowHandle -ne [IntPtr]::Zero
        elevatedRunner = $windowsPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        childProcesses = $children
      } | ConvertTo-Json -Compress
    `.replace('PROCESS_ID', String(pid))
      )
    )
    await stage('native-startup-process-sample', sample)
  } catch (error) {
    await stage('native-startup-process-sample-unavailable', { reason: error.message })
  }
}

export async function recordNarrowViewport({
  page,
  pid,
  originalWidth,
  firstName,
  activeName,
  reportDirectory,
  powershell,
  until,
  stage
}) {
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

export function tabBar(page, firstName, activeName) {
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
