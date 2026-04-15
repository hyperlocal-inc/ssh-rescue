import { execSync } from 'node:child_process';
import http from 'node:http';

const PORT = process.env.PORT || 3000;
const EXEC_TIMEOUT_MS = 15_000;

function run(cmd) {
  try {
    const stdout = execSync(cmd, { timeout: EXEC_TIMEOUT_MS, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true, output: stdout.trim() };
  } catch (err) {
    return { ok: false, output: (err.stderr || err.stdout || err.message || '').trim() };
  }
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function revertToPort22() {
  log('=== REVERTING SSH TO PORT 22 ===');

  // Step 1: Write a clean sshd_config Port line
  log('--- Step 1: Set Port 22 in sshd_config ---');
  const readConfig = run('cat /etc/ssh/sshd_config');
  if (!readConfig.ok) {
    log(`FAILED to read sshd_config: ${readConfig.output}`);
    return;
  }

  let config = readConfig.output;

  // Remove any AddressFamily / ListenAddress we added
  config = config.replace(/^\s*AddressFamily\s+.*/gm, '');
  config = config.replace(/^\s*ListenAddress\s+.*/gm, '');

  // Replace Port line with 22
  if (/^\s*Port\s+/m.test(config)) {
    config = config.replace(/^\s*Port\s+\d+/m, 'Port 22');
  } else {
    config = `Port 22\n${config}`;
  }

  // Clean up any blank line runs from removals
  config = config.replace(/\n{3,}/g, '\n\n');

  const escaped = config.replace(/'/g, "'\\''");
  const writeResult = run(`printf '%s' '${escaped}' | sudo tee /etc/ssh/sshd_config > /dev/null`);
  log(`Write sshd_config: ${writeResult.ok ? 'OK' : writeResult.output}`);

  // Step 2: Remove the socket override that forces 22222
  log('--- Step 2: Remove ssh.socket override ---');
  const rmOverride = run('sudo rm -f /etc/systemd/system/ssh.socket.d/override.conf');
  log(`Remove socket override: ${rmOverride.ok ? 'OK' : rmOverride.output}`);

  // Also try removing the whole drop-in dir if empty
  run('sudo rmdir /etc/systemd/system/ssh.socket.d 2>/dev/null');

  // Step 3: Validate config before restart
  log('--- Step 3: Validate sshd_config ---');
  const testResult = run('sudo sshd -t 2>&1');
  log(`sshd -t: ${testResult.ok ? 'OK (no errors)' : testResult.output}`);

  if (!testResult.ok && testResult.output.length > 0 && !testResult.output.includes('0/SUCCESS')) {
    log('CONFIG VALIDATION FAILED - attempting anyway since we need SSH back');
  }

  // Step 4: Reload systemd and restart
  log('--- Step 4: Restart SSH on port 22 ---');
  const daemonReload = run('sudo systemctl daemon-reload');
  log(`daemon-reload: ${daemonReload.ok ? 'OK' : daemonReload.output}`);

  // Stop socket first to release the old port
  const stopSocket = run('sudo systemctl stop ssh.socket');
  log(`stop ssh.socket: ${stopSocket.ok ? 'OK' : stopSocket.output}`);

  const stopService = run('sudo systemctl stop ssh.service');
  log(`stop ssh.service: ${stopService.ok ? 'OK' : stopService.output}`);

  // Start socket (will now use default port 22 since override is gone)
  const startSocket = run('sudo systemctl start ssh.socket');
  log(`start ssh.socket: ${startSocket.ok ? 'OK' : startSocket.output}`);

  // Step 5: iptables — ensure port 22 is wide open at the top of the chain
  log('--- Step 5: iptables rules for port 22 ---');
  const ipt4 = run('sudo iptables -I INPUT 1 -p tcp --dport 22 -j ACCEPT');
  log(`iptables allow 22: ${ipt4.ok ? 'OK' : ipt4.output}`);
  const ipt6 = run('sudo ip6tables -I INPUT 1 -p tcp --dport 22 -j ACCEPT');
  log(`ip6tables allow 22: ${ipt6.ok ? 'OK' : ipt6.output}`);

  // Also ensure UFW knows about 22
  const ufwAllow = run('sudo ufw allow 22/tcp');
  log(`ufw allow 22: ${ufwAllow.ok ? 'OK' : ufwAllow.output}`);
  const ufwReload = run('sudo ufw reload');
  log(`ufw reload: ${ufwReload.ok ? 'OK' : ufwReload.output}`);

  // Step 6: Verify
  log('--- Step 6: Verify ---');
  const ssAll = run('ss -tlnp');
  log(`All listeners:\n${ssAll.output}`);

  const sshListeners = run('ss -tlnp | grep -E ":22\\b"');
  log(`Port 22 listeners: ${sshListeners.ok ? sshListeners.output : 'NONE FOUND'}`);

  const iptHead = run('sudo iptables -L INPUT -n --line-numbers | head -10');
  log(`iptables INPUT top 10:\n${iptHead.output}`);

  const effectiveConfig = run('sudo sshd -T 2>/dev/null | grep -E "^(port|listenaddress|addressfamily)"');
  log(`sshd effective: ${effectiveConfig.output}`);

  const socketStatus = run('systemctl status ssh.socket 2>&1');
  log(`ssh.socket status:\n${socketStatus.output}`);

  const serviceStatus = run('systemctl status ssh.service 2>&1');
  log(`ssh.service status:\n${serviceStatus.output}`);

  log('=== REVERT COMPLETE ===');
}

// Run the revert immediately on startup
revertToPort22();

// Keep alive for PM2
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('SSH rescue alive. Check PM2 logs for results.');
});

server.listen(PORT, () => {
  log(`SSH Rescue server alive on port ${PORT}`);
});
