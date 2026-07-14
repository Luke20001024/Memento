import AppKit
import AVFoundation
import Speech

private enum CaptureFailure: LocalizedError {
    case microphoneDenied
    case recorderUnavailable
    case localSpeechUnavailable
    case appendHelperMissing
    case appendFailed(String)

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

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard #available(macOS 26.0, *) else {
            showError("Memento 本地语音记录需要 macOS 26 或更高版本。")
            terminate()
            return
        }

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
                cleanup()
                terminate()
                return
            }

            notify(title: "Memento", message: "正在本地转写并整理语音记录")

            let transcript: String
            if speechAllowed {
                do {
                    transcript = try await LocalSpeechTranscriber.transcribe(audioURL: audioURL)
                } catch {
                    transcript = ""
                }
            } else {
                transcript = ""
            }

            let transcriptURL = directory.appendingPathComponent("transcript.txt")
            try transcript.write(to: transcriptURL, atomically: true, encoding: .utf8)

            try appendToMemento(
                audioURL: audioURL,
                transcriptURL: transcriptURL,
                duration: duration,
                sourceApp: sourceApp
            )

            cleanup()
            terminate()
        } catch {
            recorder?.stop()
            recorder = nil
            showError(error.localizedDescription)
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
    ) throws {
        let helperURL = vaultURL
            .appendingPathComponent(".scripts", isDirectory: true)
            .appendingPathComponent("append_voice.sh")
        guard fileManager.isExecutableFile(atPath: helperURL.path) else {
            throw CaptureFailure.appendHelperMissing
        }

        let process = Process()
        let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [
            helperURL.path,
            audioURL.path,
            transcriptURL.path,
            String(format: "%.1f", duration),
            sourceApp,
        ]
        process.standardError = errors
        try process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            let data = errors.fileHandleForReading.readDataToEndOfFile()
            let details = String(data: data, encoding: .utf8) ?? "未知错误"
            throw CaptureFailure.appendFailed(details)
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
