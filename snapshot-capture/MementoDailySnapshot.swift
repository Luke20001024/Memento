import AppKit
@preconcurrency import AVFoundation
@preconcurrency import CoreLocation
import Darwin
import Foundation

private enum SnapshotFailure: LocalizedError {
    case cameraDenied
    case cameraUnavailable
    case cameraConfiguration
    case jpegUnavailable
    case captureFailed(String)
    case appendHelperMissing
    case appendFailed(String)
    case operationTimedOut(String)

    var errorDescription: String? {
        switch self {
        case .cameraDenied:
            return "没有摄像头权限。可在系统设置 → 隐私与安全性 → 相机中重新授权。"
        case .cameraUnavailable:
            return "没有找到可用的 Mac 前置摄像头。"
        case .cameraConfiguration:
            return "无法配置摄像头。"
        case .jpegUnavailable:
            return "当前摄像头无法生成 JPEG 照片。"
        case .captureFailed(let details):
            return "拍摄失败：\(details)"
        case .appendHelperMissing:
            return "找不到每日第一帧落档脚本，请重新运行 Memento 安装器。"
        case .appendFailed(let details):
            return "每日第一帧未能写入 Memento：\(details)"
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

// 系统相机或 Foundation Process 偶发不响应 cancellation 时，不能让 claim 后的 App 永久存活。
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
                oneShot.resume(with: .failure(SnapshotFailure.operationTimedOut(operationName)))
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
            .appendingPathComponent("memento-snapshot-process-\(UUID().uuidString).stderr")

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
            throw SnapshotFailure.operationTimedOut(operationName)
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

private struct WeatherSnapshot {
    let summary: String
    let observedAt: String
}

private struct OpenMeteoResponse: Decodable {
    struct Current: Decodable {
        let time: String
        let temperature: Double
        let apparentTemperature: Double?
        let weatherCode: Int

        enum CodingKeys: String, CodingKey {
            case time
            case temperature = "temperature_2m"
            case apparentTemperature = "apparent_temperature"
            case weatherCode = "weather_code"
        }
    }

    let current: Current
}

private enum WeatherService {
    static func fetch(for location: CLLocation) async -> WeatherSnapshot? {
        // 约 11 km 粒度；精确经纬度不发送，也不落档。
        let latitude = (location.coordinate.latitude * 10).rounded() / 10
        let longitude = (location.coordinate.longitude * 10).rounded() / 10

        var components = URLComponents(string: "https://api.open-meteo.com/v1/forecast")
        components?.queryItems = [
            URLQueryItem(name: "latitude", value: String(format: "%.1f", latitude)),
            URLQueryItem(name: "longitude", value: String(format: "%.1f", longitude)),
            URLQueryItem(
                name: "current",
                value: "temperature_2m,apparent_temperature,weather_code"
            ),
            URLQueryItem(name: "timezone", value: "auto"),
            URLQueryItem(name: "forecast_days", value: "1"),
        ]
        guard let url = components?.url else { return nil }

        var request = URLRequest(url: url)
        request.timeoutInterval = 6
        request.setValue("Memento-Daily-Snapshot/1.0", forHTTPHeaderField: "User-Agent")

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                return nil
            }
            let payload = try JSONDecoder().decode(OpenMeteoResponse.self, from: data)
            let current = payload.current
            let condition = weatherDescription(code: current.weatherCode)
            let temperature = formatTemperature(current.temperature)

            var summary = "\(condition) · \(temperature)°C"
            if let apparent = current.apparentTemperature,
               abs(apparent - current.temperature) >= 1 {
                summary += "（体感 \(formatTemperature(apparent))°C）"
            }
            return WeatherSnapshot(summary: summary, observedAt: current.time)
        } catch {
            return nil
        }
    }

    private static func formatTemperature(_ value: Double) -> String {
        String(format: "%.1f", value)
    }

    private static func weatherDescription(code: Int) -> String {
        switch code {
        case 0: return "晴"
        case 1: return "大致晴朗"
        case 2: return "局部多云"
        case 3: return "阴"
        case 45, 48: return "有雾"
        case 51, 53, 55: return "毛毛雨"
        case 56, 57: return "冻毛毛雨"
        case 61: return "小雨"
        case 63: return "中雨"
        case 65: return "大雨"
        case 66, 67: return "冻雨"
        case 71: return "小雪"
        case 73: return "中雪"
        case 75: return "大雪"
        case 77: return "米雪"
        case 80: return "小阵雨"
        case 81: return "中阵雨"
        case 82: return "强阵雨"
        case 85, 86: return "阵雪"
        case 95: return "雷暴"
        case 96, 99: return "雷暴伴冰雹"
        default: return "天气码 \(code)"
        }
    }
}

@MainActor
private final class OneShotLocationProvider: NSObject {
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<CLLocation?, Never>?
    private var timeoutTask: Task<Void, Never>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyThreeKilometers
    }

    func requestLocation() async -> CLLocation? {
        guard CLLocationManager.locationServicesEnabled() else { return nil }

        return await withCheckedContinuation { continuation in
            self.continuation = continuation
            continueForCurrentAuthorization()
            timeoutTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(6))
                self?.finish(nil)
            }
        }
    }

    private func continueForCurrentAuthorization() {
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            manager.requestLocation()
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            finish(nil)
        @unknown default:
            finish(nil)
        }
    }

    private func finish(_ location: CLLocation?) {
        guard let continuation else { return }
        self.continuation = nil
        timeoutTask?.cancel()
        timeoutTask = nil
        manager.stopUpdatingLocation()
        continuation.resume(returning: location)
    }
}

extension OneShotLocationProvider: CLLocationManagerDelegate {
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor [weak self] in
            guard let self, self.continuation != nil else { return }
            self.continueForCurrentAuthorization()
        }
    }

    nonisolated func locationManager(
        _ manager: CLLocationManager,
        didUpdateLocations locations: [CLLocation]
    ) {
        let location = locations.last
        Task { @MainActor [weak self] in
            self?.finish(location)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor [weak self] in
            self?.finish(nil)
        }
    }
}

private final class CameraPreviewView: NSView {
    let previewLayer: AVCaptureVideoPreviewLayer

    init(session: AVCaptureSession) {
        previewLayer = AVCaptureVideoPreviewLayer(session: session)
        super.init(frame: .zero)
        wantsLayer = true
        layer = CALayer()
        previewLayer.videoGravity = .resizeAspectFill
        layer?.addSublayer(previewLayer)
    }

    required init?(coder: NSCoder) {
        nil
    }

    override func layout() {
        super.layout()
        previewLayer.frame = bounds
    }
}

@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let fileManager = FileManager.default
    private let captureSession = AVCaptureSession()
    private let photoOutput = AVCapturePhotoOutput()
    private let sessionQueue = DispatchQueue(label: "com.memento.daily-snapshot.camera")

    private var window: NSWindow?
    private var countdownLabel: NSTextField?
    private var countdownTask: Task<Void, Never>?
    private var captureTimeoutTask: Task<Void, Never>?
    private var workDirectory: URL?
    private var finished = false

    private var captureDate = ""
    private var captureTime = ""
    private var weekday = ""
    private var sourceApp = ""
    private var vaultURL: URL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("AISecretary", isDirectory: true)

    func applicationDidFinishLaunching(_ notification: Notification) {
        readArguments()
        logEvent("application launched; source=\(sourceApp.isEmpty ? "unknown" : sourceApp)")
        Task { await beginCapture() }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        skipCapture()
        return false
    }

    private func readArguments() {
        captureDate = argumentValue(named: "--capture-date") ?? formattedDate(Date())
        captureTime = argumentValue(named: "--capture-time") ?? formattedTime(Date())
        weekday = argumentValue(named: "--weekday") ?? formattedWeekday(Date())
        sourceApp = argumentValue(named: "--source-app") ?? ""
        if let vault = argumentValue(named: "--vault"), !vault.isEmpty {
            vaultURL = URL(fileURLWithPath: vault, isDirectory: true)
        }
    }

    private func beginCapture() async {
        let authorization = AVCaptureDevice.authorizationStatus(for: .video)
        logEvent("camera authorization before request=\(authorization.rawValue)")

        do {
            let cameraAllowed = try await withTimeout(
                after: .seconds(60),
                operationName: "等待摄像头授权"
            ) { [weak self] in
                guard let self else { return false }
                return await self.requestCameraAccess()
            }
            guard cameraAllowed else {
                throw SnapshotFailure.cameraDenied
            }
            logEvent("camera access granted")

            try configureCamera()
            logEvent("camera configured")
            showCameraWindow()
            try await withTimeout(after: .seconds(8), operationName: "启动摄像头") { [weak self] in
                guard let self else { return }
                await self.startSession()
            }
            logEvent("capture session started")
            scheduleCaptureTimeout()

            for value in stride(from: 3, through: 1, by: -1) {
                guard !finished else { return }
                countdownLabel?.stringValue = "\(value)"
                try? await Task.sleep(for: .seconds(1))
            }
            guard !finished else { return }
            countdownLabel?.stringValue = ""
            logEvent("requesting photo capture")
            try takePhoto()
        } catch {
            finishWithoutPhoto(message: error.localizedDescription)
        }
    }

    private func requestCameraAccess() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            return true
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: .video) { allowed in
                    continuation.resume(returning: allowed)
                }
            }
        default:
            return false
        }
    }

    private func configureCamera() throws {
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .external],
            mediaType: .video,
            position: .unspecified
        )

        // Mac 内置摄像头通常报告 position = unspecified；不能只按 .front 筛选。
        // 不自动回退到 Continuity Camera，避免意外唤起 iPhone 后摄。
        let camera = discovery.devices.first { device in
            device.deviceType == .builtInWideAngleCamera && !device.isContinuityCamera
        } ?? discovery.devices.first { device in
            device.deviceType == .external && !device.isContinuityCamera
        }
        guard let camera else { throw SnapshotFailure.cameraUnavailable }

        let input = try AVCaptureDeviceInput(device: camera)
        captureSession.beginConfiguration()
        captureSession.sessionPreset = .photo
        defer { captureSession.commitConfiguration() }

        guard captureSession.canAddInput(input), captureSession.canAddOutput(photoOutput) else {
            throw SnapshotFailure.cameraConfiguration
        }
        captureSession.addInput(input)
        captureSession.addOutput(photoOutput)
    }

    private func showCameraWindow() {
        let size = NSSize(width: 520, height: 410)
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Memento · 每日第一帧"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()

        let content = NSView(frame: NSRect(origin: .zero, size: size))
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.black.cgColor

        let preview = CameraPreviewView(session: captureSession)
        preview.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(preview)

        let message = NSTextField(labelWithString: "今天的第一条记录已经保存。3 秒后留下此刻的你。")
        message.textColor = .white
        message.font = .systemFont(ofSize: 14, weight: .medium)
        message.alignment = .center
        message.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(message)

        let countdown = NSTextField(labelWithString: "3")
        countdown.textColor = .white
        countdown.font = .monospacedDigitSystemFont(ofSize: 72, weight: .bold)
        countdown.alignment = .center
        countdown.translatesAutoresizingMaskIntoConstraints = false
        countdown.wantsLayer = true
        countdown.layer?.shadowColor = NSColor.black.cgColor
        countdown.layer?.shadowOpacity = 0.8
        countdown.layer?.shadowRadius = 5
        content.addSubview(countdown)
        countdownLabel = countdown

        let skipButton = NSButton(title: "跳过今天", target: self, action: #selector(skipButtonPressed))
        skipButton.bezelStyle = .rounded
        skipButton.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(skipButton)

        NSLayoutConstraint.activate([
            preview.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            preview.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            preview.topAnchor.constraint(equalTo: content.topAnchor),
            preview.bottomAnchor.constraint(equalTo: content.bottomAnchor),

            message.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            message.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            message.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),

            countdown.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            countdown.centerYAnchor.constraint(equalTo: content.centerYAnchor),

            skipButton.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            skipButton.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -18),
        ])

        window.contentView = content
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func startSession() async {
        await withCheckedContinuation { continuation in
            sessionQueue.async { [captureSession] in
                captureSession.startRunning()
                continuation.resume()
            }
        }
    }

    private func stopSession() {
        sessionQueue.async { [captureSession] in
            if captureSession.isRunning {
                captureSession.stopRunning()
            }
        }
    }

    private func takePhoto() throws {
        guard photoOutput.availablePhotoCodecTypes.contains(.jpeg) else {
            throw SnapshotFailure.jpegUnavailable
        }
        let settings = AVCapturePhotoSettings(
            format: [AVVideoCodecKey: AVVideoCodecType.jpeg]
        )
        settings.photoQualityPrioritization = .balanced
        photoOutput.capturePhoto(with: settings, delegate: self)
    }

    private func scheduleCaptureTimeout() {
        captureTimeoutTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(15))
            } catch {
                // 照片已完成或用户跳过时会取消超时任务;取消不是超时。
                return
            }
            guard !Task.isCancelled else { return }
            guard let self, !self.finished else { return }
            self.finishWithoutPhoto(message: "拍摄超时，今天不会再次打扰。")
        }
    }

    @objc private func skipButtonPressed() {
        skipCapture()
    }

    private func skipCapture() {
        guard !finished else { return }
        finished = true
        countdownTask?.cancel()
        captureTimeoutTask?.cancel()
        stopSession()
        cleanup()
        window?.orderOut(nil)
        NSApp.terminate(nil)
    }

    private func handleCapturedPhoto(_ data: Data) async {
        guard !finished else { return }
        logEvent("photo data received; bytes=\(data.count)")
        captureTimeoutTask?.cancel()
        stopSession()
        countdownLabel?.font = .systemFont(ofSize: 18, weight: .semibold)
        countdownLabel?.stringValue = "正在补充当时天气…"

        do {
            let directory = fileManager.temporaryDirectory
                .appendingPathComponent("memento-daily-snapshot-\(UUID().uuidString)", isDirectory: true)
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
            workDirectory = directory
            let photoURL = directory.appendingPathComponent("daily-portrait.jpg")
            try data.write(to: photoURL, options: .atomic)

            // 只有照片成功后才请求一次位置和天气。
            let location = await OneShotLocationProvider().requestLocation()
            logEvent("location request finished; available=\(location != nil)")
            let weather: WeatherSnapshot? = if let location {
                try? await withTimeout(after: .seconds(7), operationName: "查询天气") {
                    await WeatherService.fetch(for: location)
                }
            } else {
                nil
            }
            logEvent("weather request finished; available=\(weather != nil)")

            try await appendToMemento(photoURL: photoURL, weather: weather)
            logEvent("snapshot appended successfully")
            finished = true
            cleanup()
            window?.orderOut(nil)
            NSApp.terminate(nil)
        } catch {
            finishWithoutPhoto(message: error.localizedDescription)
        }
    }

    private func appendToMemento(photoURL: URL, weather: WeatherSnapshot?) async throws {
        let helperURL = vaultURL
            .appendingPathComponent(".scripts", isDirectory: true)
            .appendingPathComponent("append_daily_snapshot.sh")
        guard fileManager.isExecutableFile(atPath: helperURL.path) else {
            throw SnapshotFailure.appendHelperMissing
        }

        let timezone = TimeZone.current.identifier
        let result: ProcessResult
        do {
            result = try await TimedProcessRunner.run(
                executableURL: URL(fileURLWithPath: "/bin/bash"),
                arguments: [
                    helperURL.path,
                    photoURL.path,
                    captureDate,
                    captureTime,
                    weekday,
                    timezone,
                    weather?.summary ?? "暂不可用",
                    weather?.observedAt ?? "",
                    sourceApp,
                ],
                timeout: .seconds(15),
                operationName: "每日第一帧落档"
            )
        } catch {
            logEvent("append helper failed to launch: \(error.localizedDescription)")
            throw error
        }

        guard result.status == 0 else {
            logEvent("append helper exited \(result.status): \(result.standardError)")
            throw SnapshotFailure.appendFailed(result.standardError)
        }
        logEvent("append helper exited 0")
    }

    private func finishWithoutPhoto(message: String) {
        guard !finished else { return }
        logEvent("finished without photo: \(message)")
        finished = true
        captureTimeoutTask?.cancel()
        stopSession()
        cleanup()
        window?.orderOut(nil)
        notify(message: "每日第一帧未拍摄：\(message)")
        NSApp.terminate(nil)
    }

    private func cleanup() {
        guard let workDirectory else { return }
        try? fileManager.removeItem(at: workDirectory)
        self.workDirectory = nil
    }

    private func notify(message: String) {
        let script = "display notification \(appleScriptString(message)) with title \"Memento\""
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        try? process.run()
    }

    private func logEvent(_ message: String) {
        guard !captureDate.isEmpty else { return }
        let claimDirectory = vaultURL
            .appendingPathComponent(".state", isDirectory: true)
            .appendingPathComponent("daily-snapshot", isDirectory: true)
            .appendingPathComponent("\(captureDate).claim", isDirectory: true)
        let logURL = claimDirectory.appendingPathComponent("events.log")
        let timestamp = ISO8601DateFormatter().string(from: Date())
        guard let data = "\(timestamp) \(message)\n".data(using: .utf8) else { return }

        do {
            try fileManager.createDirectory(at: claimDirectory, withIntermediateDirectories: true)
            if fileManager.fileExists(atPath: logURL.path) {
                let handle = try FileHandle(forWritingTo: logURL)
                defer { try? handle.close() }
                _ = try handle.seekToEnd()
                try handle.write(contentsOf: data)
            } else {
                try data.write(to: logURL, options: .atomic)
            }
        } catch {
            // 日志不得影响每日第一帧主流程。
        }
    }

    private func argumentValue(named name: String) -> String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: name),
              arguments.indices.contains(index + 1) else {
            return nil
        }
        let value = arguments[index + 1]
        return value.isEmpty ? nil : value
    }

    private func formattedDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private func formattedTime(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }

    private func formattedWeekday(_ date: Date) -> String {
        let symbols = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
        return symbols[Calendar.current.component(.weekday, from: date) - 1]
    }

    private func appleScriptString(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }
}

extension AppDelegate: AVCapturePhotoCaptureDelegate {
    nonisolated func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?
    ) {
        let result: Result<Data, Error>
        if let error {
            result = .failure(error)
        } else if let data = photo.fileDataRepresentation() {
            result = .success(data)
        } else {
            result = .failure(SnapshotFailure.captureFailed("没有生成照片数据"))
        }

        Task { @MainActor [weak self] in
            guard let self else { return }
            switch result {
            case .success(let data):
                await self.handleCapturedPhoto(data)
            case .failure(let error):
                self.finishWithoutPhoto(message: error.localizedDescription)
            }
        }
    }
}

#if MEMENTO_SNAPSHOT_SELF_TEST
@main
private struct MementoDailySnapshotSelfTest {
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
        } catch SnapshotFailure.operationTimedOut {
            precondition(started.duration(to: clock.now) < .seconds(1))
        } catch {
            fatalError("unexpected timeout error: \(error)")
        }

        do {
            let result = try await TimedProcessRunner.run(
                executableURL: URL(fileURLWithPath: "/bin/sh"),
                arguments: ["-c", "echo snapshot-error >&2; exit 9"],
                timeout: .seconds(2),
                operationName: "进程自测"
            )
            precondition(result.status == 9)
            precondition(result.standardError.contains("snapshot-error"))

            _ = try await TimedProcessRunner.run(
                executableURL: URL(fileURLWithPath: "/bin/sleep"),
                arguments: ["2"],
                timeout: .milliseconds(80),
                operationName: "进程超时自测"
            )
            fatalError("process timeout self-test unexpectedly completed")
        } catch SnapshotFailure.operationTimedOut {
            print("✓ snapshot timeout and process termination self-test")
        } catch {
            fatalError("unexpected process error: \(error)")
        }

        let descendantTestDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("memento-snapshot-process-tree-\(UUID().uuidString)")
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
        } catch SnapshotFailure.operationTimedOut {
            precondition(
                FileManager.default.fileExists(atPath: descendantReadyMarker.path),
                "descendant process never reached the ready marker"
            )
            try? await Task.sleep(for: .seconds(1))
            precondition(
                !FileManager.default.fileExists(atPath: descendantLateMarker.path),
                "descendant process survived timeout and wrote the late marker"
            )
            print("✓ snapshot timeout kills descendant process group self-test")
        } catch {
            fatalError("unexpected process-group error: \(error)")
        }
    }
}
#else
@main
private struct MementoDailySnapshotApp {
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
