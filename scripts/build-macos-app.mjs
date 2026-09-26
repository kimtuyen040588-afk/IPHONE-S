#!/usr/bin/env node

/** Build a self-contained Apple-silicon .app and a zip suitable for GitHub Releases. */
import { access, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, '..');
const releaseDirectory = path.join(root, 'release');
const stagingDirectory = path.join(os.tmpdir(), 'phone-farm-gateway-package');
const app = path.join(stagingDirectory, 'PhoneFarmGateway.app');
const contents = path.join(app, 'Contents');
const resources = path.join(contents, 'Resources');
const signingIdentity = process.env.DEVELOPER_ID_APPLICATION ?? '-';

function run(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
    });
}

async function required(target, label) {
    try { await access(target); } catch { throw new Error(`${label} 不存在：${target}`); }
}

if (process.platform !== 'darwin') throw new Error('macOS 安装包只能在 Mac 上构建');
await required(path.join(root, 'desktop', 'PhoneFarmGateway.swift'), 'macOS 网关界面');
await required(path.join(root, 'node_modules'), 'node_modules（先运行 npm ci）');
await required(path.join(root, '.appium2'), '.appium2（先运行 npm run appium:install-driver）');

await rm(releaseDirectory, { recursive: true, force: true });
await rm(stagingDirectory, { recursive: true, force: true });
await mkdir(releaseDirectory, { recursive: true });
await mkdir(path.join(contents, 'MacOS'), { recursive: true });
await mkdir(resources, { recursive: true });
await writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>手机机房 Mac 网关</string>
<key>CFBundleExecutable</key><string>PhoneFarmGateway</string>
<key>CFBundleIdentifier</key><string>cc.jiahao.phonefarm.gateway</string>
<key>CFBundleName</key><string>PhoneFarmGateway</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.1</string>
<key>CFBundleVersion</key><string>2</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>`);

await run('xcrun', ['swiftc', '-parse-as-library', '-O', '-target', 'arm64-apple-macosx14.0', '-framework', 'SwiftUI', '-framework', 'AppKit',
    path.join(root, 'desktop', 'PhoneFarmGateway.swift'), '-o', path.join(contents, 'MacOS', 'PhoneFarmGateway')]);

const runtime = path.join(resources, 'phone-farm');
await mkdir(runtime, { recursive: true });
// Node's .bin entries are symlinks. Dereference them so macOS can seal the
// app bundle; an escaping symlink makes a distributable signature invalid.
await run('rsync', ['-aL', '--exclude=.git', '--exclude=.env', '--exclude=.env.devices',
    '--exclude=.wda', '--exclude=.scheduler-data', '--exclude=release', `${root}/`, `${runtime}/`]);
await mkdir(path.join(runtime, 'node', 'bin'), { recursive: true });
await cp(process.execPath, path.join(runtime, 'node', 'bin', 'node'));
await run('codesign', ['--force', '--sign', signingIdentity, path.join(contents, 'MacOS', 'PhoneFarmGateway')]);
await run('codesign', ['--force', '--deep', '--sign', signingIdentity, app]);
await cp(app, path.join(releaseDirectory, 'PhoneFarmGateway.app'), { recursive: true });
await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, path.join(releaseDirectory, 'PhoneFarmGateway-macos-arm64.zip')]);
console.log(`\n✓ 已生成：${path.join(releaseDirectory, 'PhoneFarmGateway-macos-arm64.zip')}`);
if (signingIdentity === '-') console.log('发布前请用 Developer ID 证书重新签名并公证；当前是本机开发测试签名。');
