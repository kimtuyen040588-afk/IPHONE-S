#!/usr/bin/env node

/**
 * Safe updater for the packaged Mac gateway.
 * It only accepts a ZIP published by this project's fixed GitHub repository,
 * verifies GitHub's SHA-256 digest, validates the expected bundle, then keeps
 * the previous app beside the replacement as a recoverable backup.
 */
import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const owner = 'kimtuyen040588-afk';
const repository = 'IPHONE-S';
const assetName = 'PhoneFarmGateway-macos-arm64.zip';
const expectedBundleId = 'cc.jiahao.phonefarm.gateway';
const action = process.argv[2] ?? 'check';

function option(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

function compareVersions(left, right) {
    const leftParts = left.replace(/^v/, '').split('.').map((part) => Number(part) || 0);
    const rightParts = right.replace(/^v/, '').split('.').map((part) => Number(part) || 0);
    for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
        if ((leftParts[index] ?? 0) !== (rightParts[index] ?? 0)) return (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    }
    return 0;
}

function run(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => code === 0 ? resolve(output) : reject(new Error(output || `${command} failed`)));
    });
}

async function release() {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repository}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PhoneFarmGateway-Updater' },
    });
    if (!response.ok) throw new Error('无法连接到官方更新服务器');
    const body = await response.json();
    const asset = body.assets?.find((item) => item.name === assetName);
    if (!asset?.browser_download_url || !asset.digest?.startsWith('sha256:')) throw new Error('官方更新包缺少完整性校验信息');
    const url = new URL(asset.browser_download_url);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith(`/${owner}/${repository}/releases/download/`)) {
        throw new Error('更新地址不受信任');
    }
    return { version: String(body.tag_name ?? '').replace(/^gateway-v/, ''), url: url.toString(), sha256: asset.digest.slice('sha256:'.length) };
}

async function sha256(file) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

async function check() {
    const current = option('--current');
    if (!current) throw new Error('缺少当前版本号');
    const latest = await release();
    const available = compareVersions(latest.version, current) > 0;
    console.log(JSON.stringify({ available, current, latest: latest.version, message: available ? `发现新版本 ${latest.version}` : '已经是最新版本' }));
}

async function install() {
    const current = option('--current');
    const appPath = option('--app-path');
    const parentPid = option('--pid');
    if (!current || !appPath || !parentPid) throw new Error('更新参数不完整');
    if (path.basename(appPath) !== 'PhoneFarmGateway.app') throw new Error('只能更新手机机房 Mac 网关本身');
    const latest = await release();
    if (compareVersions(latest.version, current) <= 0) throw new Error('已经是最新版本');
    try {
        await access(path.dirname(appPath), constants.W_OK);
    } catch {
        throw new Error('当前程序所在文件夹不可写。请把 App 放在“下载”或你的个人“应用程序”文件夹后重试');
    }
    const staging = await mkdtemp(path.join(os.tmpdir(), 'phone-farm-update-'));
    const archive = path.join(staging, assetName);
    const response = await fetch(latest.url, { headers: { 'User-Agent': 'PhoneFarmGateway-Updater' } });
    if (!response.ok || !response.body) throw new Error('下载更新失败');
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
    if (await sha256(archive) !== latest.sha256) throw new Error('更新包校验失败，已停止安装');
    await run('/usr/bin/ditto', ['-x', '-k', archive, staging]);
    const candidate = path.join(staging, 'PhoneFarmGateway.app');
    const resolvedCandidate = await realpath(candidate);
    if (!resolvedCandidate.startsWith(`${staging}${path.sep}`)) throw new Error('更新包结构异常');
    const bundleId = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print:CFBundleIdentifier', path.join(candidate, 'Contents', 'Info.plist')])).trim();
    if (bundleId !== expectedBundleId) throw new Error('更新包不是本程序，已停止安装');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', candidate]);
    const helper = path.join(staging, 'install-after-quit.sh');
    const backup = `${appPath}.previous`;
    const script = `#!/bin/sh
set -eu
replacement="$1"
target="$2"
backup="$3"
parent_pid="$4"
while kill -0 "$parent_pid" 2>/dev/null; do sleep 1; done
if [ -e "$backup" ]; then mv "$backup" "${backup}.older"; fi
mv "$target" "$backup"
mv "$replacement" "$target"
open "$target"
`;
    await writeFile(helper, script, { mode: 0o700 });
    await chmod(helper, 0o700);
    const child = spawn('/bin/sh', [helper, candidate, appPath, backup, parentPid], { detached: true, stdio: 'ignore' });
    child.unref();
    console.log(`已验证并准备安装 ${latest.version}；程序退出后会自动重开。`);
}

try {
    if (action === 'check') await check();
    else if (action === 'install') await install();
    else throw new Error('用法：update-gateway.mjs check | install');
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
