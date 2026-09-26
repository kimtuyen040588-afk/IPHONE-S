import AppKit
import SwiftUI

struct AppleSigningStatus: Decodable {
    let state: String
    let message: String
}

struct GatewayStatus: Decodable {
    let mac: Bool
    let node: Bool
    let xcode: Bool
    let docker: Bool
    let driver: Bool
    let apple: AppleSigningStatus
    let environment: EnvironmentStatus

    var macReady: Bool { mac && node && xcode && docker && driver }
}

struct EnvironmentStatus: Decodable {
    let xcode: String
    let docker: String
    let driver: String
}

struct UpdateStatus: Decodable {
    let available: Bool
    let current: String
    let latest: String
    let message: String
}

@main
struct PhoneFarmGatewayApp: App {
    var body: some Scene {
        WindowGroup("手机机房 Mac 网关") {
            GatewayView().frame(minWidth: 720, minHeight: 650)
        }
        .windowResizability(.contentSize)
    }
}

@MainActor
final class GatewayModel: ObservableObject {
    @Published var output = "正在检查这台 Mac…\n"
    @Published var working = false
    @Published var status: GatewayStatus?
    @Published var update: UpdateStatus?
    @Published var updateMessage = ""

    var appVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0" }

    private var root: URL? {
        if let configured = ProcessInfo.processInfo.environment["PHONE_FARM_HOME"], !configured.isEmpty {
            return URL(fileURLWithPath: configured, isDirectory: true)
        }
        return Bundle.main.resourceURL?.appendingPathComponent("phone-farm", isDirectory: true)
    }

    private var node: URL? {
        guard let root else { return nil }
        let bundled = root.appendingPathComponent("node/bin/node")
        return FileManager.default.isExecutableFile(atPath: bundled.path) ? bundled : nil
    }

    func refresh() {
        guard let root, let node else { output = "找不到内置网关程序。请重新下载完整安装包。"; return }
        working = true
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let process = Process()
            process.executableURL = node
            process.arguments = [root.appendingPathComponent("scripts/gateway-bootstrap.mjs").path, "status"]
            process.currentDirectoryURL = root
            process.environment = ProcessInfo.processInfo.environment.merging(["PHONE_FARM_HOME": root.path]) { _, new in new }
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            do {
                try process.run()
                process.waitUntilExit()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let decoded = try JSONDecoder().decode(GatewayStatus.self, from: data)
                DispatchQueue.main.async {
                    self?.status = decoded
                    self?.working = false
                    self?.output = self?.summary(for: decoded) ?? ""
                }
            } catch {
                DispatchQueue.main.async { self?.working = false; self?.output = "检查失败：\(error.localizedDescription)" }
            }
        }
    }

    private func summary(for status: GatewayStatus) -> String {
        let macMessage = status.macReady ? "✓ Mac 已准备好" : "• Mac 还有项目需要准备"
        let appleMessage = status.apple.state == "ready" ? "✓ Apple 开发者签名已完成" : "• \(status.apple.message)"
        return "\(macMessage)\n\(appleMessage)\n\n每次完成一步，状态会自动更新；你不需要查终端或填写技术编号。"
    }

    func run(_ script: String, _ arguments: [String] = [], onSuccess: (() -> Void)? = nil) {
        guard let root, let node else { output = "找不到内置网关程序。请重新下载完整安装包。"; return }
        working = true
        output = "正在处理，请稍候…\n"
        let task = Process()
        task.executableURL = node
        task.arguments = [root.appendingPathComponent(script).path] + arguments
        task.currentDirectoryURL = root
        task.environment = ProcessInfo.processInfo.environment.merging(["PHONE_FARM_HOME": root.path]) { _, new in new }
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.output += text }
        }
        task.terminationHandler = { [weak self] process in
            pipe.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async {
                self?.working = false
                if process.terminationStatus == 0 {
                    self?.output += "\n完成。\n"
                    if let onSuccess { onSuccess() } else { self?.refresh() }
                } else {
                    self?.output += "\n未完成，请按上面的提示处理后重试。\n"
                    self?.refresh()
                }
            }
        }
        do { try task.run() } catch { working = false; output = "无法启动网关程序：\(error.localizedDescription)" }
    }

    func checkForUpdates() {
        guard let root, let node else { updateMessage = "找不到更新组件"; return }
        let currentVersion = appVersion
        working = true
        updateMessage = "正在检查更新…"
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let process = Process()
            process.executableURL = node
            process.arguments = [root.appendingPathComponent("scripts/update-gateway.mjs").path, "check", "--current", currentVersion]
            let pipe = Pipe(); process.standardOutput = pipe; process.standardError = pipe
            do {
                try process.run(); process.waitUntilExit()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let result = try JSONDecoder().decode(UpdateStatus.self, from: data)
                DispatchQueue.main.async { self?.update = result; self?.updateMessage = result.message; self?.working = false }
            } catch {
                DispatchQueue.main.async { self?.updateMessage = "更新检查失败，请稍后重试"; self?.working = false }
            }
        }
    }

    func installUpdate() {
        guard let update, update.available else { return }
        updateMessage = "正在下载并校验 \(update.latest)…"
        run("scripts/update-gateway.mjs", ["install", "--current", appVersion, "--app-path", Bundle.main.bundlePath, "--pid", String(ProcessInfo.processInfo.processIdentifier)]) {
            // The verified installer is now waiting for this App to quit, then swaps
            // the bundle and reopens it.  Do not quit before the download finishes.
            NSApplication.shared.terminate(nil)
        }
    }

    func openXcode() {
        let xcode = URL(fileURLWithPath: "/Applications/Xcode.app")
        if FileManager.default.fileExists(atPath: xcode.path) {
            NSWorkspace.shared.openApplication(at: xcode, configuration: .init()) { [weak self] _, error in
                Task { @MainActor in
                    if let error { self?.output = "无法打开 Xcode：\(error.localizedDescription)" }
                    else { self?.output = "已打开 Xcode。请在 Xcode → Settings → Accounts 登录 Apple Developer 账号；完成后回到这里点“重新检查”。" }
                }
            }
        } else {
            NSWorkspace.shared.open(URL(string: "https://developer.apple.com/xcode/")!)
            output = "这台 Mac 还没有 Xcode，已打开官方下载页。安装完成后回到这里重新检查。"
        }
    }

    func prepareEnvironment() {
        run("scripts/gateway-bootstrap.mjs", ["prepare-environment"])
    }

    func openConsole() { NSWorkspace.shared.open(URL(string: "http://127.0.0.1:3000")!) }
}

struct GatewayView: View {
    @StateObject private var model = GatewayModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 5) {
                Text("接入第一台 iPhone").font(.system(size: 28, weight: .bold))
                Text("只要从上往下做。每完成一步，系统会自己解锁下一步。")
                    .foregroundStyle(.secondary)
            }
            setupRow(number: 1, state: model.status?.macReady == true ? .done : .active,
                     title: "让 Mac 准备好", detail: model.status?.macReady == true ? "Xcode、Docker 和控制驱动已就绪" : "检查 Xcode、Docker 和控制驱动",
                     button: model.status?.macReady == true ? "重新检查" : "检查并准备") { model.run("scripts/gateway-bootstrap.mjs", ["doctor"]) }
            setupRow(number: 2, state: appleState, title: "连接 Apple 开发者账号",
                     detail: model.status?.apple.message ?? "在官方 Xcode 完成登录和签名",
                     button: model.status?.apple.state == "ready" ? "重新检查" : "打开 Xcode 登录") {
                if model.status?.apple.state == "ready" { model.refresh() } else { model.openXcode() }
            }
            setupRow(number: 3, state: .waiting, title: "接入第一台 iPhone",
                     detail: "用数据线连接、解锁手机，并在手机上点“信任”", button: "打开设备控制台") { model.openConsole() }
            setupRow(number: 4, state: .waiting, title: "自动测试并开始运行",
                     detail: "设备接入后，系统会测试连接、截图和恢复能力", button: "启动网关") { model.run("scripts/launch-agent.mjs", ["install"]) }
            HStack {
                Button("重新检查") { model.refresh() }.buttonStyle(.borderedProminent).disabled(model.working)
                Button(model.status?.macReady == true ? "检查环境" : "一键补齐环境") { model.prepareEnvironment() }
                    .disabled(model.working)
                Button(model.update?.available == true ? "立即更新到 \(model.update?.latest ?? "")" : "检查更新") {
                    if model.update?.available == true { model.installUpdate() } else { model.checkForUpdates() }
                }.disabled(model.working)
                if model.working { ProgressView().controlSize(.small) }
                Spacer()
                Text("不确定时只要点“重新检查”。").font(.footnote).foregroundStyle(.secondary)
            }
            if !model.updateMessage.isEmpty { Text(model.updateMessage).font(.footnote).foregroundStyle(.secondary) }
            TextEditor(text: $model.output).font(.system(.body, design: .monospaced)).padding(8)
                .frame(minHeight: 90).background(Color(nsColor: .textBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.25)))
        }
        .padding(28).task { model.refresh() }
    }

    private enum StepState { case done, active, waiting }
    private var appleState: StepState { model.status?.apple.state == "ready" ? .done : .active }

    private func setupRow(number: Int, state: StepState, title: String, detail: String, button: String, action: @escaping () -> Void) -> some View {
        let tint: Color = state == .done ? .green : state == .active ? .blue : .secondary
        return HStack(spacing: 14) {
            ZStack { Circle().fill(tint.opacity(0.15)); Text(state == .done ? "✓" : "\(number)").fontWeight(.bold).foregroundStyle(tint) }
                .frame(width: 34, height: 34)
            VStack(alignment: .leading, spacing: 3) { Text(title).font(.headline); Text(detail).font(.caption).foregroundStyle(.secondary) }
            Spacer()
            Button(button, action: action).disabled(model.working || state == .waiting && number == 4)
        }
        .padding(14).background(tint.opacity(state == .active ? 0.08 : 0.04)).clipShape(RoundedRectangle(cornerRadius: 12))
    }
}
