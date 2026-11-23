import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const ASSET_DOWNLOAD_TIMEOUT_MS = 90_000

export async function prepareWindowsRuntime({
  lane,
  root,
  tools,
  beta,
  command,
  powershell,
  sha256,
  stage
}) {
  const runner = JSON.parse(
    await powershell(String.raw`
    $ErrorActionPreference = 'Stop'
    $os = Get-CimInstance Win32_OperatingSystem
    $session = (Get-Process -Id $PID).SessionId
    if ($session -eq 0) { throw 'Runner has no interactive Windows session' }
    if (Get-Process OpenPencil -ErrorAction SilentlyContinue) { throw 'OpenPencil already running' }
    $runtimeKey = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    $paths = @(
      "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$runtimeKey",
      "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$runtimeKey"
    )
    function Read-RuntimeVersion {
      Get-ItemProperty -LiteralPath $paths -Name pv -ErrorAction SilentlyContinue |
        ForEach-Object { $_.pv } | Where-Object { $_ -and $_ -ne '0.0.0.0' } | Select-Object -First 1
    }
    $webview = Read-RuntimeVersion
    if (!$webview) {
      $installer = Join-Path $env:RUNNER_TEMP 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe'
      Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $installer
      $signature = Get-AuthenticodeSignature -FilePath $installer
      if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') {
        throw 'WebView2 Runtime installer does not carry a valid Microsoft signature'
      }
      $install = Start-Process -FilePath $installer -ArgumentList '/silent', '/install' -PassThru -Wait
      if ($install.ExitCode -ne 0) { throw "WebView2 Runtime installer exited $($install.ExitCode)" }
      $webview = Read-RuntimeVersion
      if (!$webview) { throw 'WebView2 Runtime installation did not register a version' }
    }
    @{ windows = $os.Caption; build = $os.BuildNumber; sessionId = $session; webview2 = $webview } |
      ConvertTo-Json -Compress
  `)
  )
  await mkdir(tools, { recursive: true })
  const npm = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  await command(
    process.execPath,
    [
      npm,
      'install',
      '--prefix',
      tools,
      '--ignore-scripts',
      '--no-fund',
      '--no-audit',
      '--save-exact',
      'playwright-core@1.63.0',
      ...(lane === 'beta4'
        ? ['@open-pencil/cli@' + beta.version, '@open-pencil/mcp@' + beta.version]
        : [])
    ],
    { timeout: 180_000 }
  )
  if (lane === 'beta4') {
    const download = join(root, beta.asset)
    const response = await fetch(
      'https://github.com/open-pencil/open-pencil/releases/download/v' +
        beta.version +
        '/' +
        beta.asset,
      {
        signal: AbortSignal.timeout(ASSET_DOWNLOAD_TIMEOUT_MS)
      }
    )
    assert.ok(response.ok, 'Download failed: ' + response.status)
    await writeFile(download, Buffer.from(await response.arrayBuffer()))
    assert.equal(await sha256(download), beta.sha256, 'Official NSIS asset SHA-256 mismatch')
    const sevenZip = join(process.env.ProgramFiles, '7-Zip', '7z.exe')
    await command(sevenZip, ['x', '-y', '-o' + root, download, 'OpenPencil.exe'])
    await stage('verified-beta-package', { name: beta.asset, sha256: beta.sha256 })
  }
  return runner
}
