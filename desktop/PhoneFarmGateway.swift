import AppKit
import SwiftUI

@main
struct PhoneFarmGatewayApp: App {
    var body: some Scene {
        WindowGroup("手机机房 Mac 网关") {
            GatewayView().frame(minWidth: 720, minHeight: 570)
        }
        .windowResizability(.contentSize)
    }
}

@MainActor
final class GatewayModel: ObservableObject {
    @Published var output = "欢迎。按从上到下的顺序完成配置。\n"
    @Published var working = false

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

    func run(_ script: String, _ arguments: [String] = []) {
        guard let root, let node else {
            output = "找不到内置网关程序。请重新下载完整安装包。"
            return
        }
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
                self?.output += process.terminationStatus == 0 ? "\n完成。\n" : "\n未完成，请根据上面的提示处理后重试。\n"
            }
        }
        do { try task.run() }
        catch {
            working = false
            output = "无法启动网关程序：\(error.localizedDescription)"
        }
    }

    func openXcode() {
        let xcode = URL(fileURLWithPath: "/Applications/Xcode.app")
        if FileManager.default.fileExists(atPath: xcode.path) {
            NSWorkspace.shared.openApplication(at: xcode, configuration: .init()) { _, error in
                Task { @MainActor in
                    if let error { self.output = "无法打开 Xcode：\(error.localizedDescription)" }
                    else { self.output = "已打开 Xcode。请进入 Xcode → Settings → Accounts，使用官方 Apple 窗口登录并完成双重验证。完成后回到这里。\n" }
                }
            }
        } else {
            NSWorkspace.shared.open(URL(string: "https://developer.apple.com/xcode/")!)
            output = "这台 Mac 还没有 Xcode，已打开官方下载页。安装完成后回到这里重新检查。\n"
        }
    }

    func openConsole() { NSWorkspace.shared.open(URL(string: "http://127.0.0.1:3000")!) }
}

struct GatewayView: View {
    @StateObject private var model = GatewayModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                Text("手机机房 · Mac 网关").font(.system(size: 28, weight: .bold))
                Text("把这台 Mac 配成 iPhone 设备控制网关。Apple 账号密码只在官方 Xcode 窗口输入，本程序不会读取或保存它。")
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 10) {
                step(number: "1", title: "检查电脑", detail: "确认 Xcode、Docker 和本机环境") { model.run("scripts/gateway-bootstrap.mjs", ["doctor"]) }
                step(number: "2", title: "准备网关", detail: "建立本机配置和数据库") { model.run("scripts/gateway-bootstrap.mjs", ["install"]) }
                step(number: "3", title: "登录 Apple", detail: "只在官方 Xcode 完成") { model.openXcode() }
                step(number: "4", title: "启动网关", detail: "登录后自动运行") { model.run("scripts/launch-agent.mjs", ["install"]) }
            }
            HStack {
                Button("打开设备控制台") { model.openConsole() }.buttonStyle(.borderedProminent)
                Button("重新检查") { model.run("scripts/gateway-bootstrap.mjs", ["doctor"]) }.disabled(model.working)
                if model.working { ProgressView().controlSize(.small) }
                Spacer()
                Text("下一步：插入并解锁第一台 iPhone，再在控制台点“添加设备”。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            TextEditor(text: $model.output)
                .font(.system(.body, design: .monospaced)).padding(8)
                .background(Color(nsColor: .textBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.25)))
        }
        .padding(28)
    }

    private func step(number: String, title: String, detail: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 7) {
                Text("步骤 \(number)").font(.caption).foregroundStyle(.secondary)
                Text(title).font(.headline)
                Text(detail).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.leading)
            }
            .frame(maxWidth: .infinity, minHeight: 84, alignment: .leading).padding(12)
        }
        .buttonStyle(.bordered)
    }
}
