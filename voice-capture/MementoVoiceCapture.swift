import AppKit
import AVFoundation
import Darwin
import Speech

private enum CaptureFailure: LocalizedError {
    case microphoneDenied
    case recorderUnavailable
    case localSpeechUnavailable
    case appendHelperMissing
    case appendFailed(String)
    case operationTimedOut(String)

    var errorDescription: String? {
        switch self {
        case .microphoneDenied:
            return "没有麦克风权限。请在系统设置的隐私与安全性中允许 Memento 语音记录使用麦克风。"
        case .recorderUnavailable:
            return "无法启动本地录音。"
        case .localSpeechUnavailable:
            return "这台 Mac 当前无法使用 Apple 本地中文语音识别。原始录音仍会保留。"
        case .appendHelperMissing:
            return "找不到 Memento 的语音落档脚本，请重新运行安装器。"
        case .appendFailed(let details):
            return "语音记录未能写入 Memento。\n\n\(details)"
        case .operationTimedOut(let operation):
            return "\(operation)超时，已停止等待。"
        }
    }
}

private final class OneShotContinuation<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Error>?

    init(_ continuation: CheckedContinuation<Value, Error>) {
        self.continuation = continuation
    }

    func resume(with result: Result<Value, Error>) {
        lock.lock()
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(with: result)
    }
}

// 使用非结构化竞速，超时时不会继续等待一个不响应 cancellation 的系统框架调用。
// App 即将退出时，仍在底层收尾的任务会随短生命周期进程一起结束。
private func withTimeout<Value: Sendable>(
    after timeout: Duration,
    operationName: String,
    operation: @escaping @Sendable () async throws -> Value
) async throws -> Value {
    let operationTask = Task<Value, Error> {
        try await operation()
    }

    return try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { continuation in
            let oneShot = OneShotContinuation(continuation)

            Task {
                do {
                    oneShot.resume(with: .success(try await operationTask.value))
                } catch {
                    oneShot.resume(with: .failure(error))
                }
            }

            Task {
                do {
                    try await Task.sleep(for: timeout)
                } catch {
                    return
                }
                operationTask.cancel()
                oneShot.resume(with: .failure(CaptureFailure.operationTimedOut(operationName)))
            }
        }
    } onCancel: {
        operationTask.cancel()
    }
}

private struct ProcessResult: Sendable {
    let status: Int32
    let standardError: String
}

private enum TimedProcessRunner {
    private enum Completion {
        case exited(Int32)
        case timedOut
        case cancelled
        case waitFailed(Int32)
    }

    static func run(
        executableURL: URL,
        arguments: [String],
        timeout: Duration,
        operationName: String
    ) async throws -> ProcessResult {
        let fileManager = FileManager.default
        let errorURL = fileManager.temporaryDirectory
            .appendingPathComponent("memento-process-\(UUID().uuidString).stderr")

        guard fileManager.createFile(
            atPath: errorURL.path,
            contents: nil,
            attributes: [.posixPermissions: NSNumber(value: 0o600)]
        ) else {
            throw CocoaError(.fileWriteUnknown)
        }

        defer { try? fileManager.removeItem(at: errorURL) }

        try fileManager.setAttributes(
            [.posixPermissions: NSNumber(value: 0o600)],
            ofItemAtPath: errorURL.path
        )

        let pid = try spawn(
            executableURL: executableURL,
            arguments: arguments,
            standardErrorURL: errorURL
        )
        let completion = await monitor(pid: pid, timeout: timeout)

        switch completion {
        case .exited(let status):
            let data = (try? Data(contentsOf: errorURL)) ?? Data()
            let details = String(data: data.prefix(16_384), encoding: .utf8) ?? "未知错误"
            return ProcessResult(status: status, standardError: details)
        case .timedOut:
            throw CaptureFailure.operationTimedOut(operationName)
        case .cancelled:
            throw CancellationError()
        case .waitFailed(let errorNumber):
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errorNumber))
        }
    }

    private static func spawn(
        executableURL: URL,
        arguments: [String],
        standardErrorURL: URL
    ) throws -> pid_t {
        var actions: posix_spawn_file_actions_t?
        var attributes: posix_spawnattr_t?
        var result = posix_spawn_file_actions_init(&actions)
        guard result == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(result))
        }
        defer { posix_spawn_file_actions_destroy(&actions) }

        result = posix_spawnattr_init(&attributes)
        guard result == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(result))
        }
        defer { posix_spawnattr_destroy(&attributes) }

        result = posix_spawn_file_actions_addopen(
            &actions,
            STDOUT_FILENO,
            "/dev/null",
            O_WRONLY,
            0
        )
        guard result == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(result))
        }
        result = posix_spawn_file_actions_addopen(
            &actions,
            STDERR_FILENO,
            standardErrorURL.path,
            O_WRONLY | O_APPEND,
            mode_t(0o600)
        )
        guard result == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(result))
        }

        result = posix_spawnattr_setpgroup(&attributes, 0)
        guard result == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(result))
        }
        let spawnFlags = POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT
        result = posix_spawnattr_setflags(&attributes, Int16(spawnFlags))
        guard result == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(result))
        }

        let executablePath = executableURL.path
        let argumentStorage = ([executablePath] + arguments).map { strdup($0) }
        defer { argumentStorage.forEach { free($0) } }
        guard argumentStorage.allSatisfy({ $0 != nil }) else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(ENOMEM))
        }
        var argumentPointers = argumentStorage
        argumentPointers.append(nil)

        let environment = ProcessInfo.processInfo.environment.map { "\($0.key)=\($0.value)" }
        let environmentStorage = environment.map { strdup($0) }
        defer { environmentStorage.forEach { free($0) } }
        guard environmentStorage.allSatisfy({ $0 != nil }) else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(ENOMEM))
        }
        var environmentPointers = environmentStorage
        environmentPointers.append(nil)

        var pid: pid_t = 0
        result = executablePath.withCString { executablePointer in
            argumentPointers.withUnsafeMutableBufferPointer { argv in
                environmentPointers.withUnsafeMutableBufferPointer { envp in
                    posix_spawn(
                        &pid,
                        executablePointer,
                        &actions,
                        &attributes,
                        argv.baseAddress!,
                        envp.baseAddress!
                    )
                }
            }
        }
        guard result == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(result))
        }
        return pid
    }

    private static func monitor(pid: pid_t, timeout: Duration) async -> Completion {
        let clock = ContinuousClock()
        let started = clock.now

        while true {
            var waitStatus: Int32 = 0
            let waitResult = Darwin.waitpid(pid, &waitStatus, WNOHANG)
            if waitResult == pid {
                return .exited(terminationStatus(from: waitStatus))
            }
            if waitResult == -1, errno != EINTR {
                return .waitFailed(errno)
            }

            if Task.isCancelled {
                await terminateProcessGroupAndReap(pid: pid)
                return .cancelled
            }
            if started.duration(to: clock.now) >= timeout {
                await terminateProcessGroupAndReap(pid: pid)
                return .timedOut
            }

            try? await Task.sleep(for: .milliseconds(20))
        }
    }

    private static func terminateProcessGroupAndReap(pid: pid_t) async {
        guard pid > 0 else { return }

        _ = Darwin.kill(-pid, SIGTERM)
        let clock = ContinuousClock()
        let graceStarted = clock.now
        var leaderReaped = false

        while graceStarted.duration(to: clock.now) < .milliseconds(300) {
            if !leaderReaped {
                leaderReaped = reapIfExited(pid: pid)
            }
            if !processGroupExists(pid: pid) {
                break
            }
            try? await Task.sleep(for: .milliseconds(20))
        }

        if processGroupExists(pid: pid) {
            _ = Darwin.kill(-pid, SIGKILL)
        }

        while !leaderReaped {
            var waitStatus: Int32 = 0
            let waitResult = Darwin.waitpid(pid, &waitStatus, WNOHANG)
            if waitResult == pid || (waitResult == -1 && errno == ECHILD) {
                leaderReaped = true
            } else if waitResult == -1 && errno != EINTR {
                leaderReaped = true
            } else {
                try? await Task.sleep(for: .milliseconds(10))
            }
        }
    }

    private static func reapIfExited(pid: pid_t) -> Bool {
        var waitStatus: Int32 = 0
        let waitResult = Darwin.waitpid(pid, &waitStatus, WNOHANG)
        return waitResult == pid || (waitResult == -1 && errno == ECHILD)
    }

    private static func processGroupExists(pid: pid_t) -> Bool {
        if Darwin.kill(-pid, 0) == 0 { return true }
        return errno == EPERM
    }

    private static func terminationStatus(from waitStatus: Int32) -> Int32 {
        let signal = waitStatus & 0x7f
        return signal == 0 ? (waitStatus >> 8) & 0xff : signal
    }
}

private enum VoiceRecoveryStore {
    static func recover(
        sourceURL: URL,
        vaultURL: URL,
        fileManager: FileManager = .default
    ) throws -> URL {
        let recoveryRoot = vaultURL
            .appendingPathComponent(".recovery", isDirectory: true)
        try fileManager.createDirectory(
            at: recoveryRoot,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: NSNumber(value: 0o700)]
        )
        try fileManager.setAttributes(
            [.posixPermissions: NSNumber(value: 0o700)],
            ofItemAtPath: recoveryRoot.path
        )

        let recoveryDirectory = recoveryRoot
            .appendingPathComponent("voice", isDirectory: true)
        try fileManager.createDirectory(
            at: recoveryDirectory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: NSNumber(value: 0o700)]
        )
        try fileManager.setAttributes(
            [.posixPermissions: NSNumber(value: 0o700)],
            ofItemAtPath: recoveryDirectory.path
        )

        let timestamp = ISO8601DateFormatter()
            .string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
        let finalURL = recoveryDirectory
            .appendingPathComponent("voice-\(timestamp)-\(UUID().uuidString).m4a")
        let stagingURL = recoveryDirectory
            .appendingPathComponent(".\(UUID().uuidString).partial")

        do {
            try fileManager.copyItem(at: sourceURL, to: stagingURL)
            try fileManager.setAttributes(
                [.posixPermissions: NSNumber(value: 0o600)],
                ofItemAtPath: stagingURL.path
            )
            // staging 与最终文件位于同一目录；rename 后才对外可见完整恢复文件。
            try fileManager.moveItem(at: stagingURL, to: finalURL)
            try? fileManager.removeItem(at: sourceURL)
            return finalURL
        } catch {
            try? fileManager.removeItem(at: stagingURL)
            throw error
        }
    }
}

@available(macOS 26.0, *)
private enum LocalSpeechTranscriber {
    static func transcribe(audioURL: URL) async throws -> String {
        guard SpeechTranscriber.isAvailable,
              let locale = await SpeechTranscriber.supportedLocale(
                equivalentTo: Locale(identifier: "zh_CN")
              ) else {
            throw CaptureFailure.localSpeechUnavailable
        }

        let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
        if let installation = try await AssetInventory.assetInstallationRequest(
            supporting: [transcriber]
        ) {
            try await installation.downloadAndInstall()
        }

        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let resultTask = Task<String, Error> {
            var transcript = ""
            for try await result in transcriber.results where result.isFinal {
                transcript += String(result.text.characters)
            }
            return transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        do {
            let audioFile = try AVAudioFile(forReading: audioURL)
            if let lastSampleTime = try await analyzer.analyzeSequence(from: audioFile) {
                try await analyzer.finalizeAndFinish(through: lastSampleTime)
            } else {
                await analyzer.cancelAndFinishNow()
            }
            return try await resultTask.value
        } catch {
            resultTask.cancel()
            throw error
        }
    }
}

@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate {
    private let fileManager = FileManager.default
    private var recorder: AVAudioRecorder?
    private var workDirectory: URL?
    private var captureInProgress = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard #available(macOS 26.0, *) else {
            showError("Memento 本地语音记录需要 macOS 26 或更高版本。")
            terminate()
            return
        }

        startCapture()
    }

    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        if captureInProgress {
            notify(title: "Memento", message: "上一条语音仍在处理中，请稍候再试")
            return false
        }
        startCapture()
        return true
    }

    private func startCapture() {
        guard !captureInProgress else { return }
        captureInProgress = true
        Task { await capture() }
    }

    @available(macOS 26.0, *)
    private func capture() async {
        let sourceApp = argumentValue(named: "--source-app")
            ?? NSWorkspace.shared.frontmostApplication?.localizedName
            ?? ""
        let directory = fileManager.temporaryDirectory
            .appendingPathComponent("memento-voice-\(UUID().uuidString)", isDirectory: true)
        workDirectory = directory
        var recoverableAudioURL: URL?

        defer {
            recorder?.stop()
            recorder = nil
            captureInProgress = false
            cleanup()
        }

        do {
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)

            guard await requestMicrophoneAccess() else {
                throw CaptureFailure.microphoneDenied
            }

            let speechAllowed = await requestSpeechRecognitionAccess()
            let audioURL = directory.appendingPathComponent("voice.m4a")
            let activeRecorder = try makeRecorder(outputURL: audioURL)
            recorder = activeRecorder

            guard activeRecorder.record() else {
                throw CaptureFailure.recorderUnavailable
            }

            NSApp.activate(ignoringOtherApps: true)
            let action = showRecordingDialog()
            let duration = activeRecorder.currentTime
            activeRecorder.stop()
            recorder = nil

            if action == .cancel || duration < 0.2 {
                terminate()
                return
            }
            recoverableAudioURL = audioURL

            notify(title: "Memento", message: "正在本地转写并整理语音记录")

            let transcript: String
            if speechAllowed {
                do {
                    transcript = try await withTimeout(
                        after: .seconds(90),
                        operationName: "Apple 本地语音转写"
                    ) {
                        try await LocalSpeechTranscriber.transcribe(audioURL: audioURL)
                    }
                } catch {
                    transcript = ""
                }
            } else {
                transcript = ""
            }

            let transcriptURL = directory.appendingPathComponent("transcript.txt")
            try transcript.write(to: transcriptURL, atomically: true, encoding: .utf8)

            try await appendToMemento(
                audioURL: audioURL,
                transcriptURL: transcriptURL,
                duration: duration,
                sourceApp: sourceApp
            )
            recoverableAudioURL = nil

            terminate()
        } catch {
            var message = error.localizedDescription
            if let audioURL = recoverableAudioURL,
               fileManager.fileExists(atPath: audioURL.path) {
                do {
                    let recoveryURL = try VoiceRecoveryStore.recover(
                        sourceURL: audioURL,
                        vaultURL: vaultURL,
                        fileManager: fileManager
                    )
                    message += "\n\n原始录音已安全保存在：\n\(recoveryURL.path)"
                } catch {
                    message += "\n\n原始录音恢复失败，临时副本将被清理。"
                }
            }
            showError(message)
            terminate()
        }
    }

    private enum RecordingAction {
        case save
        case cancel
    }

    private func showRecordingDialog() -> RecordingAction {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.icon = NSImage(systemSymbolName: "waveform", accessibilityDescription: "正在录音")
        alert.messageText = "正在记录语音"
        alert.informativeText = "说完后停止，原始录音和本地转写会一起存入 Memento。"
        alert.addButton(withTitle: "停止并存入")
        alert.addButton(withTitle: "取消")
        return alert.runModal() == .alertFirstButtonReturn ? .save : .cancel
    }

    private func makeRecorder(outputURL: URL) throws -> AVAudioRecorder {
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]
        let recorder = try AVAudioRecorder(url: outputURL, settings: settings)
        guard recorder.prepareToRecord() else {
            throw CaptureFailure.recorderUnavailable
        }
        return recorder
    }

    private func requestMicrophoneAccess() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return true
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: .audio) { allowed in
                    continuation.resume(returning: allowed)
                }
            }
        default:
            return false
        }
    }

    private func requestSpeechRecognitionAccess() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            return true
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { status in
                    continuation.resume(returning: status == .authorized)
                }
            }
        default:
            return false
        }
    }

    private func argumentValue(named name: String) -> String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
            return nil
        }
        let value = arguments[index + 1]
        return value.isEmpty ? nil : value
    }

    private func appendToMemento(
        audioURL: URL,
        transcriptURL: URL,
        duration: TimeInterval,
        sourceApp: String
    ) async throws {
        let helperURL = vaultURL
            .appendingPathComponent(".scripts", isDirectory: true)
            .appendingPathComponent("append_voice.sh")
        guard fileManager.isExecutableFile(atPath: helperURL.path) else {
            throw CaptureFailure.appendHelperMissing
        }

        let result = try await TimedProcessRunner.run(
            executableURL: URL(fileURLWithPath: "/bin/bash"),
            arguments: [
                helperURL.path,
                audioURL.path,
                transcriptURL.path,
                String(format: "%.1f", duration),
                sourceApp,
            ],
            timeout: .seconds(20),
            operationName: "语音落档"
        )

        guard result.status == 0 else {
            throw CaptureFailure.appendFailed(result.standardError)
        }
    }

    private var vaultURL: URL {
        if let configured = ProcessInfo.processInfo.environment["MEMENTO_VAULT"],
           !configured.isEmpty {
            return URL(fileURLWithPath: configured, isDirectory: true)
        }
        return fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent("AISecretary", isDirectory: true)
    }

    private func notify(title: String, message: String) {
        let script = "display notification \(appleScriptString(message)) with title \(appleScriptString(title))"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        try? process.run()
    }

    private func appleScriptString(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }

    private func showError(_ message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Memento 语音记录失败"
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        alert.runModal()
    }

    private func cleanup() {
        guard let workDirectory else { return }
        try? fileManager.removeItem(at: workDirectory)
        self.workDirectory = nil
    }

    private func terminate() {
        NSApp.terminate(nil)
    }
}

#if MEMENTO_VOICE_SELF_TEST
@main
private struct MementoVoiceCaptureSelfTest {
    static func main() async {
        let clock = ContinuousClock()
        let started = clock.now
        do {
            _ = try await withTimeout(after: .milliseconds(80), operationName: "自测") {
                await withCheckedContinuation { continuation in
                    DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
                        continuation.resume(returning: ())
                    }
                }
            }
            fatalError("timeout self-test unexpectedly completed")
        } catch CaptureFailure.operationTimedOut {
            precondition(started.duration(to: clock.now) < .seconds(1))
        } catch {
            fatalError("unexpected timeout error: \(error)")
        }

        do {
            let result = try await TimedProcessRunner.run(
                executableURL: URL(fileURLWithPath: "/bin/sh"),
                arguments: ["-c", "echo process-error >&2; exit 7"],
                timeout: .seconds(2),
                operationName: "进程自测"
            )
            precondition(result.status == 7)
            precondition(result.standardError.contains("process-error"))

            _ = try await TimedProcessRunner.run(
                executableURL: URL(fileURLWithPath: "/bin/sleep"),
                arguments: ["2"],
                timeout: .milliseconds(80),
                operationName: "进程超时自测"
            )
            fatalError("process timeout self-test unexpectedly completed")
        } catch CaptureFailure.operationTimedOut {
            print("✓ voice capture timeout and process termination self-test")
        } catch {
            fatalError("unexpected process error: \(error)")
        }

        let descendantTestDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("memento-voice-process-tree-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(
            at: descendantTestDirectory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: descendantTestDirectory) }
        let descendantReadyMarker = descendantTestDirectory.appendingPathComponent("ready")
        let descendantLateMarker = descendantTestDirectory.appendingPathComponent("late")
        do {
            _ = try await TimedProcessRunner.run(
                executableURL: URL(fileURLWithPath: "/bin/sh"),
                arguments: [
                    "-c",
                    "trap '' TERM; (trap '' TERM; printf ready > \"$1\"; sleep 1.2; printf late > \"$2\") & while :; do sleep 1; done",
                    "memento-process-tree-self-test",
                    descendantReadyMarker.path,
                    descendantLateMarker.path,
                ],
                timeout: .milliseconds(250),
                operationName: "进程组超时自测"
            )
            fatalError("process-group timeout self-test unexpectedly completed")
        } catch CaptureFailure.operationTimedOut {
            precondition(
                FileManager.default.fileExists(atPath: descendantReadyMarker.path),
                "descendant process never reached the ready marker"
            )
            try? await Task.sleep(for: .seconds(1))
            precondition(
                !FileManager.default.fileExists(atPath: descendantLateMarker.path),
                "descendant process survived timeout and wrote the late marker"
            )
            print("✓ voice capture timeout kills descendant process group self-test")
        } catch {
            fatalError("unexpected process-group error: \(error)")
        }

        let fileManager = FileManager.default
        let recoveryRoot = fileManager.temporaryDirectory
            .appendingPathComponent("memento-voice-recovery-selftest-\(UUID().uuidString)")
        defer { try? fileManager.removeItem(at: recoveryRoot) }
        do {
            try fileManager.createDirectory(at: recoveryRoot, withIntermediateDirectories: true)
            let sourceURL = recoveryRoot.appendingPathComponent("source.m4a")
            try Data("voice".utf8).write(to: sourceURL, options: .atomic)
            let recoveredURL = try VoiceRecoveryStore.recover(
                sourceURL: sourceURL,
                vaultURL: recoveryRoot,
                fileManager: fileManager
            )
            precondition(!fileManager.fileExists(atPath: sourceURL.path))
            precondition(fileManager.fileExists(atPath: recoveredURL.path))
            let fileMode = try fileManager.attributesOfItem(atPath: recoveredURL.path)[.posixPermissions] as? NSNumber
            let directoryMode = try fileManager.attributesOfItem(
                atPath: recoveredURL.deletingLastPathComponent().path
            )[.posixPermissions] as? NSNumber
            let recoveryRootMode = try fileManager.attributesOfItem(
                atPath: recoveredURL.deletingLastPathComponent().deletingLastPathComponent().path
            )[.posixPermissions] as? NSNumber
            precondition(fileMode?.intValue == 0o600)
            precondition(directoryMode?.intValue == 0o700)
            precondition(recoveryRootMode?.intValue == 0o700)
            print("✓ voice recovery permissions and atomic publication self-test")
        } catch {
            fatalError("unexpected recovery error: \(error)")
        }
    }
}
#else
@main
private struct MementoVoiceCaptureApp {
    @MainActor
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        application.run()
        _ = delegate
    }
}
#endif
