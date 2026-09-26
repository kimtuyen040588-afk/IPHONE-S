# Mac 网关安装包

这是给没有技术背景的操作员使用的 Mac 安装助手，不需要运行终端命令。

## 操作员流程

1. 从 GitHub Releases 下载 `PhoneFarmGateway-macos-arm64.zip`，解压并把 App 拖进“应用程序”。
2. 首次打开，依次点：**检查电脑 → 准备网关 → 登录 Apple → 启动网关**。
3. “登录 Apple”只会打开 Xcode 的官方账号窗口。操作员完成 Apple 双重验证；网关不会收集 Apple ID、密码或验证码。
4. 用数据线接入并解锁 iPhone，在手机上点“信任此电脑”，再按 iPhone 的提示开启开发者模式。
5. 点击“打开设备控制台”，在网页的“添加设备”里完成第一台设备登记。

## 首次安装仍不可省略的项目

- Xcode：由 Apple 提供，负责设备信任、开发者签名和启动测试自动化组件。
- Docker Desktop：本机数据库运行环境。
- Apple Developer Program：真机测试组件需要有效开发者签名。

安装助手会检查这些条件、创建随机的本机数据库密码、安装 LaunchAgent 并在用户登录后启动网关。它不会把控制接口公开到互联网；远程控制台必须另行配置 HTTPS 私有通道和访问令牌。

## 构建发布包（维护者）

```bash
npm ci
npm run appium:install-driver
npm run package:mac
```

输出在 `release/PhoneFarmGateway-macos-arm64.zip`。

当前构建是本机测试签名。面向其他 Mac 发布前，必须使用 Apple Developer ID 签名并通过 Apple 公证（notarization）；否则 macOS 会显示未知开发者警告。

有 Developer ID 证书的发布 Mac 可用下面的方式签名：

```bash
DEVELOPER_ID_APPLICATION='Developer ID Application: 你的公司名 (团队编号)' npm run package:mac
```

再用 Apple 的 `notarytool` 公证生成的 ZIP，公证通过后 stapler 到 App 并重新压缩上传。不要把 Apple 密码或 App 专用密码写进代码库或 GitHub Actions。
