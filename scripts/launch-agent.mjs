#!/usr/bin/env node

/** Installs the gateway as a per-user LaunchAgent, never as a root daemon. */
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.PHONE_FARM_HOME
    ? path.resolve(process.env.PHONE_FARM_HOME)
    : path.resolve(scriptDirectory, '..');
const label = 'cc.jiahao.phonefarm.gateway';
const agentsDirectory = path.join(os.homedir(), 'Library', 'LaunchAgents');
const plistPath = path.join(agentsDirectory, `${label}.plist`);
const logDirectory = path.join(os.homedir(), 'Library', 'Logs', 'PhoneFarmGateway');
const mode = process.argv[2] ?? 'status';

function xml(value) {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function launchctl(args) {
    return new Promise((resolve) => {
        const child = spawn('/bin/launchctl', args, { stdio: 'inherit' });
        child.once('error', () => resolve(false));
        child.once('exit', (code) => resolve(code === 0));
    });
}

async function install() {
    if (process.platform !== 'darwin') throw new Error('Mac 网关只能安装在 macOS 上');
    await mkdir(agentsDirectory, { recursive: true });
    await mkdir(logDirectory, { recursive: true });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(path.join(root, 'scripts', 'device-assistant.mjs'))}</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(path.join(logDirectory, 'gateway.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logDirectory, 'gateway-error.log'))}</string>
</dict></plist>`;
    await writeFile(plistPath, plist, { mode: 0o600 });
    await chmod(plistPath, 0o600);
    const domain = `gui/${process.getuid()}`;
    await launchctl(['bootout', domain, plistPath]);
    if (!await launchctl(['bootstrap', domain, plistPath])) throw new Error('无法让 macOS 启动网关');
    await launchctl(['kickstart', '-k', `${domain}/${label}`]);
    console.log(`✓ 网关已设为登录后自动启动\n日志：${path.join(logDirectory, 'gateway.log')}`);
}

async function uninstall() {
    await launchctl(['bootout', `gui/${process.getuid()}`, plistPath]);
    await rm(plistPath, { force: true });
    console.log('✓ 已停止并移除自动启动设置；数据和设备配置未删除。');
}

if (mode === 'install') await install();
else if (mode === 'uninstall') await uninstall();
else if (mode === 'status') console.log(`自动启动配置：${plistPath}`);
else { console.error('用法：node scripts/launch-agent.mjs install | uninstall | status'); process.exitCode = 1; }
