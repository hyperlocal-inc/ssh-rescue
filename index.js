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

// ============================================================
// FIX SSH ON STARTUP
// ============================================================
function fixSshOnStartup() {
  log('=== SSH FIX STARTING ===');

  // Step 1: Check current sysctl bindv6only
  log('--- Step 1: Check bindv6only ---');
  const bindv6 = run('sysctl net.ipv6.bindv6only');
  log(`bindv6only: ${bindv6.output}`);

  // Step 2: Check current listening state
  log('--- Step 2: Current SSH listeners ---');
  const ssResult = run('ss -tlnp | grep -E "22222|:22\\b"');
  log(`ss output: ${ssResult.output}`);

  // Step 3: Force sshd to listen on BOTH IPv4 and IPv6 explicitly
  // Write AddressFamily and ListenAddress lines to sshd_config
  log('--- Step 3: Fix sshd_config to bind both IPv4 and IPv6 ---');

  // Read current config
  const readConfig = run('cat /etc/ssh/sshd_config');
  if (!readConfig.ok) {
    log(`FAILED to read sshd_config: ${readConfig.output}`);
    return;
  }

  let config = readConfig.output;

  // Ensure Port 22222 is set
  if (/^\s*Port\s+/m.test(config)) {
    config = config.replace(/^\s*Port\s+\d+/m, 'Port 22222');
  } else {
    config = `Port 22222\n${config}`;
  }

  // Remove any existing AddressFamily and ListenAddress lines
  config = config.replace(/^\s*AddressFamily\s+.*/gm, '');
  config = config.replace(/^\s*ListenAddress\s+.*/gm, '');

  // Add explicit ListenAddress for both protocols AFTER Port line
  config = config.replace(
    /^(Port 22222)$/m,
    'Port 22222\nAddressFamily any\nListenAddress 0.0.0.0\nListenAddress ::'
  );

  // Write it back
  const writeResult = run(`echo '${config.replace(/'/g, "'\\''")}' | sudo tee /etc/ssh/sshd_config > /dev/null`);
  log(`Write sshd_config: ${writeResult.ok ? 'OK' : writeResult.output}`);

  // Step 4: Validate config
  log('--- Step 4: Validate config ---');
  const testResult = run('sudo sshd -t 2>&1');
  log(`sshd -t: ${testResult.ok ? 'OK' : testResult.output}`);

  if (!testResult.ok && testResult.output.length > 0) {
    log('CONFIG VALIDATION FAILED - aborting restart');
    return;
  }

  // Step 5: Restart ssh socket and service
  log('--- Step 5: Restart SSH ---');
  const daemonReload = run('sudo systemctl daemon-reload');
  log(`daemon-reload: ${daemonReload.ok ? 'OK' : daemonReload.output}`);

  const restartSocket = run('sudo systemctl restart ssh.socket');
  log(`restart ssh.socket: ${restartSocket.ok ? 'OK' : restartSocket.output}`);

  const restartSsh = run('sudo systemctl restart ssh');
  log(`restart ssh: ${restartSsh.ok ? 'OK' : restartSsh.output}`);

  // Step 6: Also ensure iptables allows port 22222 and port 22 directly
  log('--- Step 6: Direct iptables rules ---');
  const ipt4_22222 = run('sudo iptables -I INPUT 1 -p tcp --dport 22222 -j ACCEPT');
  log(`iptables allow 22222: ${ipt4_22222.ok ? 'OK' : ipt4_22222.output}`);
  const ipt6_22222 = run('sudo ip6tables -I INPUT 1 -p tcp --dport 22222 -j ACCEPT');
  log(`ip6tables allow 22222: ${ipt6_22222.ok ? 'OK' : ipt6_22222.output}`);
  const ipt4_22 = run('sudo iptables -I INPUT 1 -p tcp --dport 22 -j ACCEPT');
  log(`iptables allow 22: ${ipt4_22.ok ? 'OK' : ipt4_22.output}`);
  const ipt6_22 = run('sudo ip6tables -I INPUT 1 -p tcp --dport 22 -j ACCEPT');
  log(`ip6tables allow 22: ${ipt6_22.ok ? 'OK' : ipt6_22.output}`);

  // Step 7: Verify
  log('--- Step 7: Verify ---');
  const verifyResult = run('ss -tlnp | grep sshd');
  log(`SSH listeners after fix: ${verifyResult.output}`);

  const iptVerify = run('sudo iptables -L INPUT -n --line-numbers | head -10');
  log(`iptables INPUT (first 10): ${iptVerify.output}`);

  const effectivePort = run('sudo sshd -T 2>/dev/null | grep -E "^(port|listenaddress|addressfamily)"');
  log(`sshd effective config: ${effectivePort.output}`);

  log('=== SSH FIX COMPLETE ===');
}

// Run the fix immediately
fixSshOnStartup();

// Keep a simple server alive so PM2 doesn't restart
const server = http.createServer((req, res) => {
  const result = {};
  result.ss = run('ss -tlnp | grep sshd');
  result.iptables_head = run('sudo iptables -L INPUT -n --line-numbers | head -10');
  result.sshd_effective = run('sudo sshd -T 2>/dev/null | grep -E "^(port|listenaddress|addressfamily)"');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result, null, 2));
});

server.listen(PORT, () => {
  log(`SSH Rescue server alive on port ${PORT}`);
});
