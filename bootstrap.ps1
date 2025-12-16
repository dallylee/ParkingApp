<#  bootstrap.ps1
    One-command Windows bootstrap for:
      - Chocolatey (if missing)
      - Node.js LTS
      - Firebase CLI
      - Google Cloud SDK (gcloud)
      - Login: firebase login, gcloud auth login, gcloud auth application-default login

    Usage:
      powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1 -ProjectId your-project-id
#>

param(
  [string]$ProjectId = ""
)

function Assert-Admin {
  $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Re-launching PowerShell as Administrator..."
    $psi = New-Object System.Diagnostics.ProcessStartInfo "PowerShell"
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -ProjectId `"$ProjectId`""
    $psi.Verb = "runas"
    [System.Diagnostics.Process]::Start($psi) | Out-Null
    exit
  }
}

function Install-Choco {
  if (Get-Command choco -ErrorAction SilentlyContinue) {
    Write-Host "Chocolatey already installed."
    return
  }
  Write-Host "Installing Chocolatey..."
  Set-ExecutionPolicy Bypass -Scope Process -Force
  [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
  Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
}

function Refresh-Env {
  if ($env:ChocolateyInstall -and (Test-Path "$env:ChocolateyInstall\helpers\chocolateyProfile.psm1")) {
    try {
      Import-Module "$env:ChocolateyInstall\helpers\chocolateyProfile.psm1" -ErrorAction Stop
      refreshenv | Out-Null
    } catch {
      # Fallback minimal PATH refresh in current session
      $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                  [System.Environment]::GetEnvironmentVariable("Path","User")
    }
  } else {
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path","User")
  }
}

function Ensure-Node {
  if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "Node.js already installed: $(node -v)"
    return
  }
  Write-Host "Installing Node.js LTS..."
  choco install -y nodejs-lts
  Refresh-Env
  Write-Host "Node.js installed: $(node -v)"
}

function Ensure-FirebaseCLI {
  if (Get-Command firebase -ErrorAction SilentlyContinue) {
    Write-Host "Firebase CLI already installed: $(firebase --version)"
    return
  }
  Write-Host "Installing Firebase CLI via npm..."
  npm install -g firebase-tools
  Refresh-Env
  Write-Host "Firebase CLI installed: $(firebase --version)"
}

function Ensure-GCloudSDK {
  if (Get-Command gcloud -ErrorAction SilentlyContinue) {
    Write-Host "Google Cloud SDK already installed: $(gcloud --version | Select-Object -First 1)"
    return
  }
  Write-Host "Installing Google Cloud SDK..."
  choco install -y gcloudsdk
  Refresh-Env
  Write-Host "Google Cloud SDK installed: $(gcloud --version | Select-Object -First 1)"
}

function Do-Logins {
  Write-Host ""
  Write-Host "Launching Firebase login in your browser..."
  firebase login

  Write-Host ""
  Write-Host "Launching Google Cloud user login in your browser..."
  gcloud auth login

  if ($ProjectId -and $ProjectId.Trim() -ne "") {
    Write-Host "Setting active project: $ProjectId"
    gcloud config set project $ProjectId
  } else {
    Write-Host "No -ProjectId provided; you can set it later with:"
    Write-Host "  gcloud config set project YOUR_PROJECT_ID"
  }

  Write-Host ""
  Write-Host "Launching Application Default Credentials login (ADC) for local development..."
  gcloud auth application-default login
}

function Verify-Setup {
  Write-Host ""
  Write-Host "Verification:"
  try { Write-Host ("firebase version: " + (firebase --version)) } catch { Write-Warning "Firebase CLI not responding." }
  try { 
    $gcv = gcloud --version 2>$null
    Write-Host "gcloud version:"
    $gcv | Select-Object -First 3 | ForEach-Object { Write-Host "  $_" }
  } catch { Write-Warning "gcloud not responding." }

  Write-Host ""
  Write-Host "Current gcloud account and project:"
  gcloud auth list --filter=status:ACTIVE
  gcloud config get-value project
  Write-Host ""
  Write-Host "ADC credentials location (if created):"
  $adcPath = Join-Path $env:APPDATA "gcloud\application_default_credentials.json"
  if (Test-Path $adcPath) {
    Write-Host "  $adcPath"
  } else {
    Write-Warning "ADC file not found yet. If you skipped the browser step, re-run: gcloud auth application-default login"
  }
}

# Main
try {
  Assert-Admin
  Install-Choco
  Refresh-Env

  Ensure-Node
  Ensure-FirebaseCLI
  Ensure-GCloudSDK

  Do-Logins
  Verify-Setup

  Write-Host ""
  Write-Host "Bootstrap completed."
} catch {
  Write-Error "Bootstrap failed: $($_.Exception.Message)"
  exit 1
}
