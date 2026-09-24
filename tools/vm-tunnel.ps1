# Keeps a reverse SSH tunnel open so Claude Code on the dev VM can reach the
# pet's hook server on this machine.
#
#   VM 127.0.0.1:4317  ->  (ssh)  ->  this machine 127.0.0.1:4317
#
# Why a REVERSE tunnel: the network routes host -> VM but not VM -> host, so
# the host has to dial out. It also means the pet keeps binding loopback —
# no 0.0.0.0 bind, no firewall hole, no shared secret. SSH is the auth.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\vm-tunnel.ps1
#
# Runs until killed, reconnecting if the link drops. The key is restricted to
# port-forwarding only on the VM side (authorized_keys `restrict,port-forwarding`).

param(
  [string]$VmUser = 'mapache',
  [string]$VmHost = '10.0.17.103',
  [int]$Port      = 4317,
  [string]$Key    = "$env:USERPROFILE\.ssh\clawdbot_tunnel"
)

if (-not (Test-Path $Key)) { Write-Host "missing key: $Key"; exit 1 }

Write-Host "tunnel: VM ${VmHost}:$Port -> localhost:$Port  (ctrl-c to stop)"

while ($true) {
  $started = Get-Date
  # ExitOnForwardFailure: fail loudly rather than sit there connected but not
  # forwarding. ServerAlive*: notice a dead link within ~90s instead of hanging.
  # -n matters: with -N and no command, ssh still reads stdin, and a detached
  # process has stdin at EOF — it exits the instant it starts. -n points stdin
  # at nul and it stays up.
  # 127.0.0.1, NOT localhost: the pet's hook server binds IPv4 only, while
  # `localhost` resolves to ::1 first on Windows — so a localhost forward
  # delivers to IPv6 loopback where nothing is listening, and the VM sees
  # "empty reply from server" rather than a refusal.
  & ssh -n -N -R "${Port}:127.0.0.1:$Port" `
      -i $Key `
      -o IdentitiesOnly=yes `
      -o BatchMode=yes `
      -o ExitOnForwardFailure=yes `
      -o ServerAliveInterval=30 `
      -o ServerAliveCountMax=3 `
      -o StrictHostKeyChecking=accept-new `
      "$VmUser@$VmHost" 2>&1 | ForEach-Object { Write-Host "  ssh: $_" }

  $up = [int]((Get-Date) - $started).TotalSeconds
  Write-Host "$(Get-Date -Format 'HH:mm:ss') tunnel dropped after ${up}s — reconnecting in 5s"
  # a tunnel that dies instantly is usually a real fault (key, host, port in
  # use); back off a little so a broken config does not spin
  Start-Sleep -Seconds $(if ($up -lt 5) { 15 } else { 5 })
}
