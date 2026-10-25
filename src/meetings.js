// Watches window titles for a meeting starting (Zoom, Teams, Meet, Webex, Slack huddles, phone calls via
// Google Voice) and reports each new one once. One long-lived PowerShell process lists titles every 4 s.
const { spawn } = require('child_process');

const RULES = [
  { app: 'Zoom', test: (p, t) => /zoom/i.test(p) && /zoom meeting|meeting controls|zoom webinar/i.test(t) },
  { app: 'Microsoft Teams', test: (p, t) => /teams/i.test(p + t) && /\b(meeting|call)\b/i.test(t) && !/^microsoft teams$/i.test(t) },
  { app: 'Google Meet', test: (_p, t) => /^Meet\s*[-–—:]\s*[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(t) || /Google Meet/i.test(t) && /[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(t) },
  { app: 'Webex', test: (p, t) => /webex|ciscocollab/i.test(p + t) && /meeting/i.test(t) },
  { app: 'Slack huddle', test: (p, t) => /slack/i.test(p) && /huddle/i.test(t) },
  { app: 'Google Voice call', test: (_p, t) => /voice\.google|Google Voice/i.test(t) && /call/i.test(t) },
];

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $w = Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { @{ p = $_.ProcessName; t = $_.MainWindowTitle } }
  ConvertTo-Json -Compress -InputObject @($w)
  Start-Sleep -Seconds 4
}`;

let proc = null;
const seen = new Map(); // key -> last time seen

function start(onMeeting) {
  if (proc) return;
  proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      let wins;
      try { wins = JSON.parse(line); } catch { continue; }
      const now = Date.now();
      for (const w of [].concat(wins || [])) {
        const rule = RULES.find((r) => r.test(String(w.p || ''), String(w.t || '')));
        if (!rule) continue;
        const key = rule.app + '|' + w.t;
        const last = seen.get(key);
        seen.set(key, now);
        // Report a meeting when it first appears, or again after it was gone for 10+ minutes.
        if (!last || now - last > 10 * 60 * 1000) onMeeting({ app: rule.app, title: w.t });
      }
    }
  });
  proc.on('exit', () => { proc = null; });
}

function stop() {
  if (proc) proc.kill();
  proc = null;
}

module.exports = { start, stop, RULES };
