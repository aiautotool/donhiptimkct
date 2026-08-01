import AVFoundation
import ExpoModulesCore

public class HeartRatePpgModule: Module {
  private let session = AVCaptureSession()
  private let captureQueue = DispatchQueue(label: "heart-rate-ppg.capture")
  private let frameDelegate = PpgFrameDelegate()
  private var activeDevice: AVCaptureDevice?
  private var startedAt = Date()
  private var durationSeconds = 45.0
  private var samples: [(time: Double, red: Double, green: Double, blue: Double)] = []
  private var lastEmit = Date.distantPast
  private var isRunning = false
  private var torchTimer: DispatchSourceTimer?
  private var missingFingerFrames = 0
  private var hasSeenFinger = false
  private var stableFingerFrames = 0
  private var cameraControlsLocked = false

  public func definition() -> ModuleDefinition {
    Name("HeartRatePpg")

    Events("onPpgUpdate")

    AsyncFunction("isAvailableAsync") { () -> Bool in
      guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
        return false
      }
      return device.hasTorch
    }

    AsyncFunction("startMeasurementAsync") { (durationSeconds: Double?) in
      try self.start(durationSeconds: min(max(durationSeconds ?? 45.0, 20.0), 60.0))
    }

    AsyncFunction("stopMeasurementAsync") {
      self.stop(status: "stopped", message: nil)
    }
  }

  private func start(durationSeconds: Double) throws {
    guard !isRunning else { return }
    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
      send(status: "failed", elapsedMs: 0, progress: 0, quality: 0, message: "Can cap quyen camera de do nhip tim.")
      return
    }
    guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back), device.hasTorch else {
      send(status: "failed", elapsedMs: 0, progress: 0, quality: 0, message: "Thiet bi can camera sau va den flash.")
      return
    }

    self.durationSeconds = durationSeconds
    startedAt = Date()
    samples.removeAll()
    missingFingerFrames = 0
    hasSeenFinger = false
    stableFingerFrames = 0
    cameraControlsLocked = false
    activeDevice = device
    isRunning = true

    captureQueue.async {
      self.session.beginConfiguration()
      self.session.sessionPreset = .low
      self.session.inputs.forEach { self.session.removeInput($0) }
      self.session.outputs.forEach { self.session.removeOutput($0) }

      do {
        let input = try AVCaptureDeviceInput(device: device)
        if self.session.canAddInput(input) {
          self.session.addInput(input)
        }

        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [
          kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
        ]
        self.frameDelegate.onSample = { [weak self] sampleBuffer in
          self?.handleSample(sampleBuffer)
        }
        output.setSampleBufferDelegate(self.frameDelegate, queue: self.captureQueue)
        if self.session.canAddOutput(output) {
          self.session.addOutput(output)
        }
        self.session.commitConfiguration()

        try device.lockForConfiguration()
        device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 30)
        device.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: 30)
        if device.isExposureModeSupported(.continuousAutoExposure) {
          device.exposureMode = .continuousAutoExposure
        }
        if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
          device.whiteBalanceMode = .continuousAutoWhiteBalance
        }
        device.unlockForConfiguration()

        self.session.startRunning()
        try self.setTorch(on: true)
        self.send(status: "warming", elapsedMs: 0, progress: 0, quality: 0.1, message: "Dang on dinh tin hieu...")
      } catch {
        if self.session.isRunning {
          self.session.stopRunning()
        }
        self.isRunning = false
        self.send(status: "failed", elapsedMs: 0, progress: 0, quality: 0, message: "Khong bat duoc camera hoac den flash.")
      }
    }
  }

  private func startTorchKeepAlive() {
    torchTimer?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: captureQueue)
    timer.schedule(deadline: .now() + 0.25, repeating: 0.5)
    timer.setEventHandler { [weak self] in
      guard let self, self.isRunning, let device = self.activeDevice, device.hasTorch else { return }
      if !device.isTorchActive || device.torchMode != .on {
        try? self.setTorch(on: true)
      }
    }
    torchTimer = timer
    timer.resume()
  }

  private func stopTorchKeepAlive() {
    torchTimer?.cancel()
    torchTimer = nil
  }

  private func setTorch(on: Bool) throws {
    guard let device = activeDevice, device.hasTorch else { return }
    try device.lockForConfiguration()
    defer { device.unlockForConfiguration() }
    if on {
      let coolLevel = min(AVCaptureDevice.maxAvailableTorchLevel, 0.28)
      try device.setTorchModeOn(level: coolLevel)
    } else {
      device.torchMode = .off
    }
  }

  private func stop(status: String, message: String?) {
    captureQueue.async {
      self.stopTorchKeepAlive()
      try? self.setTorch(on: false)
      if self.session.isRunning {
        self.session.stopRunning()
      }
      self.isRunning = false
      self.activeDevice = nil
      self.frameDelegate.onSample = nil
      self.send(
        status: status,
        elapsedMs: Int(Date().timeIntervalSince(self.startedAt) * 1000),
        progress: min(Date().timeIntervalSince(self.startedAt) / self.durationSeconds, 1),
        quality: self.qualityScore(),
        message: message
      )
    }
  }

  private func cleanup() {
    stopTorchKeepAlive()
    try? setTorch(on: false)
    if session.isRunning {
      session.stopRunning()
    }
    isRunning = false
    activeDevice = nil
    frameDelegate.onSample = nil
  }

  private func handleSample(_ sampleBuffer: CMSampleBuffer) {
    guard isRunning, let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    let elapsed = Date().timeIntervalSince(startedAt)
    let stats = analyzeFrame(in: pixelBuffer)
    let previous = samples.last
    let motion = previous.map {
      (abs($0.red - stats.red) + abs($0.green - stats.green) + abs($0.blue - stats.blue)) / 3
    } ?? 0
    samples.append((time: elapsed, red: stats.red, green: stats.green, blue: stats.blue))
    if samples.count > 1800 {
      samples.removeFirst(samples.count - 1800)
    }
    let detection = fingerDetectionScore(stats: stats, motion: motion)
    let fingerDetected = detection.confidence >= 85
    if detection.confidence >= 65 {
      hasSeenFinger = true
    }
    stableFingerFrames = fingerDetected ? stableFingerFrames + 1 : max(0, stableFingerFrames - 2)
    missingFingerFrames = detection.confidence >= 55 ? 0 : missingFingerFrames + 1
    if stableFingerFrames >= 15 {
      lockCameraControlsIfNeeded()
    }
    let signalUsable = detection.confidence >= 72 || (hasSeenFinger && missingFingerFrames < 180)

    let progress = min(elapsed / durationSeconds, 1)
    let ready = detection.confidence >= 85 && stableFingerFrames >= 15
    let status = elapsed < 4 || !ready ? "warming" : "measuring"
    if Date().timeIntervalSince(lastEmit) > 0.2 {
      lastEmit = Date()
      let live = signalUsable ? liveBpmEstimate() : (bpm: nil, quality: 0.0)
      send(
        status: status,
        elapsedMs: Int(elapsed * 1000),
        progress: progress,
        bpm: live.bpm,
        quality: max(detection.confidence / 100, signalUsable ? max(qualityScore(), live.quality, 0.2) : 0),
        signal: stats.red,
        message: ready ? nil : detection.message
      )
    }

    if hasSeenFinger && missingFingerFrames > 180 {
      stop(status: "failed", message: "Đã mất tín hiệu ngón tay. Chạm vòng tròn để đo lại.")
      return
    }

    if elapsed > 4 && missingFingerFrames > 240 {
      samples.removeAll()
    }

    if elapsed >= durationSeconds || (elapsed >= 30 && qualityScore() >= 0.82) {
      let result = estimateBpm()
      if let bpm = result.bpm, result.quality >= 0.38 {
        let spo2 = estimateSpO2()
        send(status: "complete", elapsedMs: Int(elapsed * 1000), progress: 1, bpm: bpm, spo2: spo2.spo2, quality: min(max(result.quality * 0.75 + spo2.quality * 0.25, result.quality), 1), message: nil)
        cleanup()
      } else {
        stop(status: "stopped", message: "Tin hieu chua du tot. Hay giu ngon tay nhe hon va do lai.")
      }
    }
  }

  private func analyzeFrame(in pixelBuffer: CVPixelBuffer) -> (red: Double, green: Double, blue: Double, brightness: Double, variance: Double) {
    CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

    let width = CVPixelBufferGetWidth(pixelBuffer)
    let height = CVPixelBufferGetHeight(pixelBuffer)
    let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
    guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return (0, 0, 0, 0, 0) }
    let buffer = base.assumingMemoryBound(to: UInt8.self)
    let startX = width / 5
    let endX = width * 4 / 5
    let startY = height / 5
    let endY = height * 4 / 5
    var redTotal = 0.0
    var greenTotal = 0.0
    var blueTotal = 0.0
    var brightnessValues: [Double] = []
    var count = 0.0

    stride(from: startY, to: endY, by: 10).forEach { y in
      stride(from: startX, to: endX, by: 10).forEach { x in
        let offset = y * bytesPerRow + x * 4
        blueTotal += Double(buffer[offset])
        greenTotal += Double(buffer[offset + 1])
        redTotal += Double(buffer[offset + 2])
        brightnessValues.append((Double(buffer[offset + 2]) + Double(buffer[offset + 1]) + Double(buffer[offset])) / 3)
        count += 1
      }
    }
    guard count > 0 else { return (0, 0, 0, 0, 0) }
    let brightness = brightnessValues.reduce(0, +) / Double(brightnessValues.count)
    let variance = brightnessValues.reduce(0) { $0 + pow($1 - brightness, 2) } / Double(brightnessValues.count)
    return (redTotal / count, greenTotal / count, blueTotal / count, brightness, variance)
  }

  private func isFingerDetected() -> Bool {
    guard let latest = samples.last, samples.count >= 12 else { return false }
    let brightness = (latest.red + latest.green + latest.blue) / 3
    let score = fingerDetectionScore(
      stats: (red: latest.red, green: latest.green, blue: latest.blue, brightness: brightness, variance: 20),
      motion: 0
    )
    return score.confidence >= 72
  }

  private func fingerDetectionScore(
    stats: (red: Double, green: Double, blue: Double, brightness: Double, variance: Double),
    motion: Double
  ) -> (confidence: Double, message: String) {
    if stats.brightness > 235 { return (18, "Che kín camera và flash.") }
    if stats.brightness < 18 { return (12, "Bật flash hoặc đặt ngón tay sát hơn.") }

    let total = max(stats.red + stats.green + stats.blue, 1)
    let redRatio = stats.red / total
    let saturation = (max(stats.red, stats.green, stats.blue) - min(stats.red, stats.green, stats.blue)) / max(max(stats.red, stats.green, stats.blue), 1)
    let recent = samples.suffix(90)
    let meanRed = recent.isEmpty ? stats.red : recent.map(\.red).reduce(0, +) / Double(recent.count)
    let redStd = recent.count > 8 ? standardDeviation(recent.map(\.red)) : 0
    let pulseRatio = redStd / max(meanRed, 1)

    var score = 0.0
    score += min(max((redRatio - 0.35) / 0.22, 0), 1) * 30
    score += min(max(saturation / 0.32, 0), 1) * 20
    score += min(max((stats.brightness - 35) / 120, 0), 1) * 15
    score += min(max((pulseRatio - 0.002) / 0.018, 0), 1) * 20
    score += min(max(1 - motion / 34, 0), 1) * 10
    score += min(max(1 - abs(stats.variance - 28) / 180, 0), 1) * 5

    if redRatio < 0.34 || saturation < 0.08 {
      return (min(score, 48), "Đặt ngón tay che kín camera và flash.")
    }
    if motion > 40 {
      return (min(score, 58), "Giữ yên điện thoại.")
    }
    if score < 55 {
      return (score, "Đặt ngón tay lên camera.")
    }
    if score < 85 {
      return (score, "Đang chuẩn bị, giữ yên tay...")
    }
    return (score, "Sẵn sàng đo.")
  }

  private func lockCameraControlsIfNeeded() {
    guard !cameraControlsLocked, let device = activeDevice else { return }
    do {
      try device.lockForConfiguration()
      if device.isExposureModeSupported(.locked) {
        device.exposureMode = .locked
      }
      if device.isWhiteBalanceModeSupported(.locked) {
        device.whiteBalanceMode = .locked
      }
      device.unlockForConfiguration()
      cameraControlsLocked = true
    } catch {
      cameraControlsLocked = true
    }
  }

  private func qualityScore() -> Double {
    guard (isFingerDetected() || (hasSeenFinger && missingFingerFrames < 90)), samples.count > 120 else { return 0 }
    let values = samples.suffix(240).map(\.red)
    let mean = values.reduce(0, +) / Double(values.count)
    let variance = values.reduce(0) { $0 + pow($1 - mean, 2) } / Double(values.count)
    let std = sqrt(variance)
    let brightness = min(max((mean - 80) / 120, 0), 1)
    let pulse = min(max(std / 4, 0), 1)
    return min(max(brightness * 0.45 + pulse * 0.55, 0), 1)
  }

  private func estimateBpm() -> (bpm: Int?, quality: Double) {
    guard isFingerDetected() || (hasSeenFinger && missingFingerFrames < 45) else { return (nil, 0) }
    let result = bpmFromRecentSamples(seconds: 24, final: true)
    guard let bpm = result.bpm else { return (nil, qualityScore() * 0.55) }
    return (bpm, min(qualityScore() * 0.55 + result.stability * 0.45, 1))
  }

  private func estimateSpO2() -> (spo2: Int?, quality: Double) {
    guard isFingerDetected() || (hasSeenFinger && missingFingerFrames < 45) else { return (nil, 0) }
    let lastTime = samples.last?.time ?? 0
    let usable = samples.filter { $0.time >= max(0, lastTime - 24) }
    guard usable.count > 210 else { return (nil, 0) }

    let redValues = usable.map(\.red)
    let blueValues = usable.map(\.blue)
    let greenValues = usable.map(\.green)
    let redDc = redValues.reduce(0, +) / Double(redValues.count)
    let blueDc = blueValues.reduce(0, +) / Double(blueValues.count)
    let greenDc = greenValues.reduce(0, +) / Double(greenValues.count)
    guard redDc > 90, blueDc > 4, greenDc > 4 else { return (nil, 0) }

    let redAc = standardDeviation(preprocessedSignal(values: redValues, sampleRate: 30))
    let blueAc = standardDeviation(preprocessedSignal(values: blueValues, sampleRate: 30))
    let greenAc = standardDeviation(preprocessedSignal(values: greenValues, sampleRate: 30))
    guard redAc > 0.00008, blueAc > 0.00008, greenAc > 0.00008 else { return (nil, 0) }

    let ratioBlue = (redAc / redDc) / max(blueAc / blueDc, 0.000001)
    let ratioGreen = (redAc / redDc) / max(greenAc / greenDc, 0.000001)
    let ratio = ratioBlue * 0.65 + ratioGreen * 0.35
    guard ratio >= 0.12, ratio <= 1.15 else { return (nil, 0) }

    let raw = 104.0 - 17.0 * ratio
    guard raw >= 88, raw <= 100.5 else { return (nil, 0) }
    let spo2 = Int(min(max(raw.rounded(), 88), 100))
    let ratioQuality = min(max(1 - abs(ratio - 0.45) / 0.75, 0), 1)
    let perfusionQuality = min(max((redDc - 100) / 80, 0), 1)
    let quality = min(max(ratioQuality * 0.65 + perfusionQuality * 0.35, 0), 1)
    guard quality >= 0.42 else { return (nil, quality) }
    return (spo2, quality)
  }

  private func liveBpmEstimate() -> (bpm: Int?, quality: Double) {
    guard isFingerDetected() || (hasSeenFinger && missingFingerFrames < 180) else { return (nil, 0) }
    let result = bpmFromRecentSamples(seconds: 10, final: false)
    guard let bpm = result.bpm else { return (nil, qualityScore()) }
    return (bpm, min(qualityScore() * 0.6 + result.stability * 0.4 + 0.05, 1))
  }

  private func bpmFromRecentSamples(seconds: Double, final: Bool) -> (bpm: Int?, stability: Double) {
    let lastTime = samples.last?.time ?? 0
    let usable = samples.filter { $0.time >= max(0, lastTime - seconds) }
    guard usable.count > (final ? 210 : 90) else { return (nil, 0) }

    guard let first = usable.first?.time, let last = usable.last?.time, last > first else { return (nil, 0) }
    let sampleRate = Double(usable.count - 1) / (last - first)
    let candidates = [
      fusedBpm(values: usable.map(\.green), sampleRate: sampleRate, final: final),
      fusedBpm(values: usable.map(\.red), sampleRate: sampleRate, final: final),
      fusedBpm(values: usable.map { ($0.green + $0.red) / 2 }, sampleRate: sampleRate, final: final)
    ].compactMap { $0 }
    guard let best = candidates.max(by: { $0.stability < $1.stability }) else { return (nil, 0) }
    return best
  }

  private func fusedBpm(values: [Double], sampleRate: Double, final: Bool) -> (bpm: Int?, stability: Double)? {
    guard values.count > (final ? 210 : 90), sampleRate > 5 else { return nil }
    let signal = preprocessedSignal(values: values, sampleRate: sampleRate)
    guard standardDeviation(signal) > 0.00008 else { return nil }

    let fft = spectralBpm(signal: signal, sampleRate: sampleRate, final: final)
    let peaks = peakBpm(signal: signal, sampleRate: sampleRate, final: final)
    let ac = autocorrelationBpm(signal: signal, sampleRate: sampleRate, final: final)
    let results = [fft, peaks, ac].compactMap { $0 }
    guard results.count >= 2 else { return nil }

    let bpms = results.map(\.bpm)
    let spread = Double((bpms.max() ?? 0) - (bpms.min() ?? 0))
    let allowedSpread = final ? (results.count == 3 ? 10.0 : 7.0) : 14.0
    guard spread <= allowedSpread else { return nil }

    let weightedSum = results.reduce(0.0) { $0 + Double($1.bpm) * $1.stability }
    let totalWeight = max(results.reduce(0.0) { $0 + $1.stability }, 0.0001)
    let fused = Int((weightedSum / totalWeight).rounded())
    let agreement = max(0, 1 - spread / allowedSpread)
    let methodCoverage = results.count == 3 ? 1.0 : 0.82
    let stability = min(max((results.map(\.stability).reduce(0, +) / Double(results.count) * 0.7 + agreement * 0.3) * methodCoverage, 0), 1)
    return (fused, stability)
  }

  private func preprocessedSignal(values: [Double], sampleRate: Double) -> [Double] {
    let mean = values.reduce(0, +) / Double(max(values.count, 1))
    guard mean > 1 else { return [] }
    let normalized = values.map { ($0 - mean) / mean }
    let medianed = medianFilter(normalized, window: 3)
    let smoothed = movingAverage(medianed, window: 5)
    let baseline = movingAverage(smoothed, window: max(21, Int(sampleRate * 1.4)))
    var signal = zip(smoothed, baseline).map { $0 - $1 }
    signal = signal.enumerated().map { index, value in
      let window = 0.54 - 0.46 * cos((2 * Double.pi * Double(index)) / Double(max(signal.count - 1, 1)))
      return value * window
    }
    return signal
  }

  private func spectralBpm(values: [Double], sampleRate: Double, final: Bool) -> (bpm: Int?, stability: Double)? {
    guard values.count > (final ? 210 : 90), sampleRate > 5 else { return nil }
    let signal = preprocessedSignal(values: values, sampleRate: sampleRate)
    return spectralBpm(signal: signal, sampleRate: sampleRate, final: final)
  }

  private func spectralBpm(signal: [Double], sampleRate: Double, final: Bool) -> (bpm: Int, stability: Double)? {
    guard signal.count > (final ? 210 : 90), sampleRate > 5, standardDeviation(signal) > 0.00008 else { return nil }

    var powers: [Int: Double] = [:]
    var bestBpm = 0
    var bestPower = 0.0
    for bpm in 48...150 {
      let power = spectralPower(signal, sampleRate: sampleRate, bpm: Double(bpm))
      powers[bpm] = power
      if power > bestPower {
        bestPower = power
        bestBpm = bpm
      }
    }
    guard bestBpm > 0 else { return nil }

    if bestBpm > 118 {
      let half = bestBpm / 2
      let halfPower = neighborhoodPower(powers, bpm: half)
      if half >= 48 && halfPower >= bestPower * 0.42 {
        bestBpm = half
        bestPower = halfPower
      }
    } else if bestBpm < 58 {
      let double = bestBpm * 2
      let doublePower = neighborhoodPower(powers, bpm: double)
      if double <= 150 && doublePower >= bestPower * 0.35 {
        bestBpm = double
        bestPower = doublePower
      }
    }

    let averagePower = powers.values.reduce(0, +) / Double(max(powers.count, 1))
    let ratio = bestPower / max(averagePower, 0.0000001)
    guard ratio >= (final ? 1.35 : 1.18) else { return nil }
    return (bestBpm, min(max((ratio - 1) / 4, 0), 1))
  }

  private func peakBpm(signal: [Double], sampleRate: Double, final: Bool) -> (bpm: Int, stability: Double)? {
    guard signal.count > (final ? 210 : 90), sampleRate > 5 else { return nil }
    let std = standardDeviation(signal)
    guard std > 0.00008 else { return nil }
    let threshold = std * 0.25
    let minDistance = max(1, Int(sampleRate * 60 / 150))
    var peaks: [Int] = []
    var lastPeak = -minDistance
    for index in 1..<(signal.count - 1) {
      guard signal[index] > threshold, signal[index] > signal[index - 1], signal[index] >= signal[index + 1] else { continue }
      if index - lastPeak >= minDistance {
        peaks.append(index)
        lastPeak = index
      } else if let previous = peaks.last, signal[index] > signal[previous] {
        peaks[peaks.count - 1] = index
        lastPeak = index
      }
    }
    guard peaks.count >= (final ? 6 : 4) else { return nil }
    let intervals = zip(peaks.dropFirst(), peaks).map { Double($0 - $1) / sampleRate }
    let usable = intervals.filter { $0 >= 60 / 150 && $0 <= 60 / 48 }
    guard usable.count >= (final ? 5 : 3) else { return nil }
    let period = median(usable)
    let bpm = Int((60 / period).rounded())
    guard bpm >= 48 && bpm <= 150 else { return nil }
    let cv = standardDeviation(usable) / max(period, 0.0001)
    return (bpm, min(max(1 - cv * 4, 0), 1))
  }

  private func autocorrelationBpm(signal: [Double], sampleRate: Double, final: Bool) -> (bpm: Int, stability: Double)? {
    guard signal.count > (final ? 210 : 90), sampleRate > 5 else { return nil }
    let minLag = max(1, Int(sampleRate * 60 / 150))
    let maxLag = min(signal.count - 2, Int(sampleRate * 60 / 48))
    guard maxLag > minLag else { return nil }
    var bestLag = 0
    var bestCorr = -1.0
    for lag in minLag...maxLag {
      let corr = autocorrelation(signal, lag: lag)
      if corr > bestCorr {
        bestCorr = corr
        bestLag = lag
      }
    }
    guard bestLag > 0, bestCorr >= (final ? 0.26 : 0.2) else { return nil }
    let bpm = Int((60 * sampleRate / Double(bestLag)).rounded())
    guard bpm >= 48 && bpm <= 150 else { return nil }
    return (bpm, min(max((bestCorr - 0.2) / 0.7, 0), 1))
  }

  private func spectralPower(_ values: [Double], sampleRate: Double, bpm: Double) -> Double {
    let frequency = bpm / 60
    var real = 0.0
    var imaginary = 0.0
    for (index, value) in values.enumerated() {
      let angle = 2 * Double.pi * frequency * Double(index) / sampleRate
      real += value * cos(angle)
      imaginary -= value * sin(angle)
    }
    return real * real + imaginary * imaginary
  }

  private func neighborhoodPower(_ powers: [Int: Double], bpm: Int) -> Double {
    return ((bpm - 2)...(bpm + 2)).map { powers[$0] ?? 0 }.max() ?? 0
  }

  private func movingAverage(_ values: [Double], window: Int) -> [Double] {
    guard !values.isEmpty else { return [] }
    return values.indices.map { index in
      let start = max(0, index - window / 2)
      let end = min(values.count - 1, index + window / 2)
      let slice = values[start...end]
      return slice.reduce(0, +) / Double(slice.count)
    }
  }

  private func medianFilter(_ values: [Double], window: Int) -> [Double] {
    guard !values.isEmpty, window > 1 else { return values }
    return values.indices.map { index in
      let start = max(0, index - window / 2)
      let end = min(values.count - 1, index + window / 2)
      return median(Array(values[start...end]))
    }
  }

  private func standardDeviation(_ values: [Double]) -> Double {
    guard !values.isEmpty else { return 0 }
    let mean = values.reduce(0, +) / Double(values.count)
    let variance = values.reduce(0) { $0 + pow($1 - mean, 2) } / Double(values.count)
    return sqrt(variance)
  }

  private func autocorrelation(_ values: [Double], lag: Int) -> Double {
    guard lag > 0, values.count > lag + 2 else { return -1 }
    var numerator = 0.0
    var leftEnergy = 0.0
    var rightEnergy = 0.0
    for index in lag..<values.count {
      let left = values[index]
      let right = values[index - lag]
      numerator += left * right
      leftEnergy += left * left
      rightEnergy += right * right
    }
    return numerator / max(sqrt(leftEnergy * rightEnergy), 0.000001)
  }

  private func median(_ values: [Double]) -> Double {
    let sorted = values.sorted()
    guard !sorted.isEmpty else { return 0 }
    let middle = sorted.count / 2
    if sorted.count % 2 == 0 {
      return (sorted[middle - 1] + sorted[middle]) / 2
    }
    return sorted[middle]
  }

  private func send(status: String, elapsedMs: Int, progress: Double, bpm: Int? = nil, spo2: Int? = nil, quality: Double, signal: Double? = nil, message: String?) {
    var body: [String: Any] = [
      "status": status,
      "elapsedMs": elapsedMs,
      "progress": progress,
      "quality": quality
    ]
    if let bpm = bpm { body["bpm"] = bpm }
    if let spo2 = spo2 { body["spo2"] = spo2 }
    if let signal = signal { body["signal"] = signal }
    if let message = message { body["message"] = message }
    sendEvent("onPpgUpdate", body)
  }
}

private class PpgFrameDelegate: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  var onSample: ((CMSampleBuffer) -> Void)?

  func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
    onSample?(sampleBuffer)
  }
}
