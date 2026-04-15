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

function runDiagnostics() {
  const results = {};

  results.ss_tlnp = run('ss -tlnp');
  results.ufw_status = run('sudo ufw status verbose');
  results.ufw_numbered = run('sudo ufw status numbered');
  results.iptables_input = run('sudo iptables -L INPUT -n -v --line-numbers');
  results.iptables_all = run('sudo iptables -L -n -v');
  results.ip6tables_input = run('sudo ip6tables -L INPUT -n -v --line-numbers');
  results.sshd_config_port = run("grep -i 'port' /etc/ssh/sshd_config 2>/dev/null || echo 'no port line'");
  results.socket_override = run('cat /etc/systemd/system/ssh.socket.d/override.conf 2>/dev/null || echo "no override"');
  results.systemctl_ssh = run('systemctl status ssh.socket ssh.service 2>&1 || true');
  results.ip_addr = run('ip addr show');
  results.route = run('ip route show default');
  results.sshd_test = run('sudo sshd -T 2>&1 | head -20');
  results.kernel_log = run('dmesg | tail -30 2>/dev/null || echo "no dmesg access"');

  return results;
}

function fixSsh(targetPort) {
  const steps = [];

  try {
    const ufwCheck = run('sudo ufw status');
    if (ufwCheck.output.includes('Status: active')) {
      steps.push({ action: 'ufw_allow', result: run(`sudo ufw allow ${targetPort}/tcp`) });
      steps.push({ action: 'ufw_reload', result: run('sudo ufw reload') });
    }
    steps.push({ action: 'ufw_status_after', result: run('sudo ufw status numbered') });
  } catch (err) {
    steps.push({ action: 'ufw_error', result: { ok: false, output: err.message } });
  }

  try {
    steps.push({ action: 'iptables_direct_allow', result: run(`sudo iptables -I INPUT 1 -p tcp --dport ${targetPort} -j ACCEPT`) });
    steps.push({ action: 'ip6tables_direct_allow', result: run(`sudo ip6tables -I INPUT 1 -p tcp --dport ${targetPort} -j ACCEPT`) });
  } catch (err) {
    steps.push({ action: 'iptables_error', result: { ok: false, output: err.message } });
  }

  steps.push({ action: 'verify_ss', result: run('ss -tlnp | grep sshd') });
  steps.push({ action: 'verify_iptables', result: run(`sudo iptables -L INPUT -n -v | grep ${targetPort}`) });

  return steps;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/diagnose') {
    const results = runDiagnostics();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(results, null, 2));
    return;
  }

  if (url.pathname === '/fix') {
    const port = url.searchParams.get('port') || '22222';
    const steps = fixSsh(port);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ targetPort: port, steps }, null, 2));
    return;
  }

  if (url.pathname === '/run') {
    const cmd = url.searchParams.get('cmd');
    if (!cmd) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'cmd query param required' }));
      return;
    }
    const result = run(cmd);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result, null, 2));
    return;
  }

  if (url.pathname === '/revert-to-22') {
    const steps = [];
    steps.push({ action: 'write_sshd_config', result: run("sudo sed -i 's/^Port .*/Port 22/' /etc/ssh/sshd_config || echo 'no port line to change'") });
    steps.push({ action: 'remove_socket_override', result: run('sudo rm -f /etc/systemd/system/ssh.socket.d/override.conf') });
    steps.push({ action: 'daemon_reload', result: run('sudo systemctl daemon-reload') });
    steps.push({ action: 'restart_ssh_socket', result: run('sudo systemctl restart ssh.socket') });
    steps.push({ action: 'ufw_allow_22', result: run('sudo ufw allow 22/tcp') });
    steps.push({ action: 'ufw_reload', result: run('sudo ufw reload') });
    steps.push({ action: 'iptables_allow_22', result: run('sudo iptables -I INPUT 1 -p tcp --dport 22 -j ACCEPT') });
    steps.push({ action: 'ip6tables_allow_22', result: run('sudo ip6tables -I INPUT 1 -p tcp --dport 22 -j ACCEPT') });
    steps.push({ action: 'verify', result: run('ss -tlnp | grep sshd') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ steps }, null, 2));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<h2>SSH Rescue Tool</h2>
<ul>
<li><a href="/diagnose">GET /diagnose</a> - Full diagnostics</li>
<li><a href="/fix?port=22222">GET /fix?port=22222</a> - Fix firewall for port 22222</li>
<li><a href="/revert-to-22">GET /revert-to-22</a> - Revert SSH back to port 22</li>
<li>GET /run?cmd=COMMAND - Run arbitrary command</li>
</ul>`);
});

server.listen(PORT, () => {
  console.log(`SSH Rescue listening on port ${PORT}`);

  console.log('\\n=== STARTUP DIAGNOSTICS ===');
  const diag = runDiagnostics();
  for (const [key, val] of Object.entries(diag)) {
    console.log(`\\n--- ${key} ---`);
    console.log(val.output);
  }
  console.log('\\n=== END STARTUP DIAGNOSTICS ===');
});
