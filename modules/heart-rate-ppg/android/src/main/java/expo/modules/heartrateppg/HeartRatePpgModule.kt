package expo.modules.heartrateppg

import android.annotation.SuppressLint
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.Image
import android.media.ImageReader
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sqrt

class HeartRatePpgModule : Module() {
  private var cameraDevice: CameraDevice? = null
  private var captureSession: CameraCaptureSession? = null
  private var previewRequestBuilder: CaptureRequest.Builder? = null
  private var imageReader: ImageReader? = null
  private var cameraThread: HandlerThread? = null
  private var cameraHandler: Handler? = null
  private var startedAt = 0L
  private var durationMs = 45_000L
  private val running = AtomicBoolean(false)
  private data class ColorSample(val time: Double, val red: Double, val green: Double, val blue: Double)
  private val samples = mutableListOf<ColorSample>()
  private var lastEmit = 0L
  private var missingFingerFrames = 0
  private var hasSeenFinger = false
  private var stableFingerFrames = 0
  private var cameraControlsLocked = false
  private val toneGenerator by lazy { ToneGenerator(AudioManager.STREAM_MUSIC, 65) }

  override fun definition() = ModuleDefinition {
    Name("HeartRatePpg")

    Events("onPpgUpdate")

    AsyncFunction("isAvailableAsync") {
      findBackCameraWithFlash() != null
    }

    AsyncFunction("playBeatAsync") {
      toneGenerator.startTone(ToneGenerator.TONE_PROP_BEEP, 70)
    }

    AsyncFunction("startMeasurementAsync") { durationSeconds: Double? ->
      start(((durationSeconds ?: 45.0).coerceIn(20.0, 60.0) * 1000).toLong())
    }

    AsyncFunction("stopMeasurementAsync") {
      stop("stopped", null)
    }
  }

  private fun context(): Context? = appContext.reactContext

  private fun start(durationMs: Long) {
    val context = context() ?: return
    if (running.get()) return
    if (context.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
      send("failed", 0, 0.0, quality = 0.0, message = "Can cap quyen camera de do nhip tim.")
      return
    }
    val cameraId = findBackCameraWithFlash()
    if (cameraId == null) {
      send("failed", 0, 0.0, quality = 0.0, message = "Thiet bi can camera sau va den flash.")
      return
    }

    this.durationMs = durationMs
    samples.clear()
    missingFingerFrames = 0
    hasSeenFinger = false
    stableFingerFrames = 0
    cameraControlsLocked = false
    startedAt = System.currentTimeMillis()
    running.set(true)
    cameraThread = HandlerThread("HeartRatePpgCamera").also { it.start() }
    cameraHandler = Handler(cameraThread!!.looper)
    imageReader = ImageReader.newInstance(320, 240, ImageFormat.YUV_420_888, 2).apply {
      setOnImageAvailableListener({ reader ->
        val image = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
        try {
          onFrame(image)
        } finally {
          image.close()
        }
      }, cameraHandler)
    }

    val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    @SuppressLint("MissingPermission")
    manager.openCamera(cameraId, object : CameraDevice.StateCallback() {
      override fun onOpened(camera: CameraDevice) {
        cameraDevice = camera
        val target = imageReader?.surface ?: return
        camera.createCaptureSession(listOf(target), object : CameraCaptureSession.StateCallback() {
          override fun onConfigured(session: CameraCaptureSession) {
            captureSession = session
            val requestBuilder = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
              addTarget(target)
              set(CaptureRequest.FLASH_MODE, CaptureRequest.FLASH_MODE_TORCH)
              if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                val maxFlashLevel = manager.getCameraCharacteristics(cameraId)
                  .get(CameraCharacteristics.FLASH_INFO_STRENGTH_MAXIMUM_LEVEL) ?: 1
                set(CaptureRequest.FLASH_STRENGTH_LEVEL, min(2, maxFlashLevel))
              }
              set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
              set(CaptureRequest.CONTROL_AE_LOCK, false)
              set(CaptureRequest.CONTROL_AWB_MODE, CaptureRequest.CONTROL_AWB_MODE_AUTO)
              set(CaptureRequest.CONTROL_AWB_LOCK, false)
            }
            previewRequestBuilder = requestBuilder
            val request = requestBuilder.build()
            session.setRepeatingRequest(request, null, cameraHandler)
            send("warming", 0, 0.0, quality = 0.1, message = "Dang on dinh tin hieu...")
          }

          override fun onConfigureFailed(session: CameraCaptureSession) {
            stop("failed", "Khong khoi dong duoc camera.")
          }
        }, cameraHandler)
      }

      override fun onDisconnected(camera: CameraDevice) {
        stop("failed", "Camera bi ngat ket noi.")
      }

      override fun onError(camera: CameraDevice, error: Int) {
        stop("failed", "Camera bao loi khi do.")
      }
    }, cameraHandler)
  }

  private fun stop(status: String, message: String?) {
    if (!running.getAndSet(false) && status != "failed") return
    cameraHandler?.post {
      try {
        captureSession?.stopRepeating()
      } catch (_: Exception) {
      }
      captureSession?.close()
      cameraDevice?.close()
      imageReader?.close()
      captureSession = null
      cameraDevice = null
      imageReader = null
      send(status, elapsedMs(), progress(), quality = qualityScore(), message = message)
      cameraThread?.quitSafely()
      cameraThread = null
      cameraHandler = null
    } ?: send(status, elapsedMs(), progress(), quality = qualityScore(), message = message)
  }

  private fun onFrame(image: Image) {
    if (!running.get()) return
    val elapsed = elapsedMs()
    val color = averageColor(image)
    val previous = samples.lastOrNull()
    val motion = previous?.let { (abs(it.red - color.red) + abs(it.green - color.green) + abs(it.blue - color.blue)) / 3 } ?: 0.0
    samples.add(ColorSample(elapsed / 1000.0, color.red, color.green, color.blue))
    if (samples.size > 1800) {
      samples.subList(0, samples.size - 1800).clear()
    }
    val detection = fingerDetectionScore(color, motion)
    val fingerDetected = detection.confidence >= 85.0
    if (detection.confidence >= 65.0) {
      hasSeenFinger = true
    }
    stableFingerFrames = if (fingerDetected) stableFingerFrames + 1 else max(0, stableFingerFrames - 2)
    missingFingerFrames = if (detection.confidence >= 55.0) 0 else missingFingerFrames + 1
    if (stableFingerFrames >= 15) {
      lockCameraControlsIfNeeded()
    }
    val signalUsable = detection.confidence >= 72.0 || (hasSeenFinger && missingFingerFrames < 180)

    val now = System.currentTimeMillis()
    if (now - lastEmit > 200) {
      lastEmit = now
      val live = if (signalUsable) liveBpmEstimate() else Pair(null, 0.0)
      send(
        if (elapsed < 4000 || detection.confidence < 85.0 || stableFingerFrames < 15) "warming" else "measuring",
        elapsed,
        progress(),
        bpm = live.first,
        quality = max(detection.confidence / 100, if (signalUsable) max(max(qualityScore(), live.second), 0.2) else 0.0),
        signal = color.red,
        message = if (detection.confidence >= 85.0 && stableFingerFrames >= 15) null else detection.message
      )
    }

    if (hasSeenFinger && missingFingerFrames > 180) {
      stop("failed", "Đã mất tín hiệu ngón tay. Chạm vòng tròn để đo lại.")
      return
    }

    if (elapsed > 4000 && missingFingerFrames > 240) {
      samples.clear()
    }

    if (elapsed >= durationMs || (elapsed >= 30_000 && qualityScore() >= 0.82)) {
      val result = estimateBpm()
      if (result.first != null && result.second >= 0.38) {
        val spo2 = estimateSpO2()
        val respiration = estimateRespiration()
        send(
          "complete",
          elapsed,
          1.0,
          bpm = result.first,
          spo2 = spo2.first,
          respiration = respiration.first,
          quality = max(result.second, (result.second * 0.68 + spo2.second * 0.16 + respiration.second * 0.16).coerceIn(0.0, 1.0))
        )
        cleanup()
      } else {
        stop("stopped", "Tin hieu chua du tot. Hay giu ngon tay nhe hon va do lai.")
      }
    }
  }

  private fun cleanup() {
    running.set(false)
    cameraHandler?.post {
      try {
        captureSession?.stopRepeating()
      } catch (_: Exception) {
      }
      captureSession?.close()
      cameraDevice?.close()
      imageReader?.close()
      captureSession = null
      cameraDevice = null
      previewRequestBuilder = null
      imageReader = null
      cameraThread?.quitSafely()
      cameraThread = null
      cameraHandler = null
    }
  }

  private fun findBackCameraWithFlash(): String? {
    val context = context() ?: return null
    val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    return manager.cameraIdList.firstOrNull { id ->
      val characteristics = manager.getCameraCharacteristics(id)
      val facing = characteristics.get(CameraCharacteristics.LENS_FACING)
      val flash = characteristics.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
      facing == CameraCharacteristics.LENS_FACING_BACK && flash
    }
  }

  private data class AverageColor(val red: Double, val green: Double, val blue: Double, val brightness: Double, val variance: Double)
  private data class FingerDetection(val confidence: Double, val message: String)

  private fun averageColor(image: Image): AverageColor {
    val width = image.width
    val height = image.height
    val yPlane = image.planes[0]
    val uPlane = image.planes[1]
    val vPlane = image.planes[2]
    val yBuffer = yPlane.buffer
    val uBuffer = uPlane.buffer
    val vBuffer = vPlane.buffer
    var redTotal = 0.0
    var greenTotal = 0.0
    var blueTotal = 0.0
    val brightnessValues = mutableListOf<Double>()
    var count = 0

    var y = height / 5
    while (y < height * 4 / 5) {
      var x = width / 5
      while (x < width * 4 / 5) {
        val yIndex = y * yPlane.rowStride + x * yPlane.pixelStride
        val uvX = x / 2
        val uvY = y / 2
        val uIndex = uvY * uPlane.rowStride + uvX * uPlane.pixelStride
        val vIndex = uvY * vPlane.rowStride + uvX * vPlane.pixelStride
        val yy = yBuffer.get(yIndex).toInt() and 0xff
        val uu = (uBuffer.get(uIndex).toInt() and 0xff) - 128
        val vv = (vBuffer.get(vIndex).toInt() and 0xff) - 128
        val red = (yy + 1.402 * vv).coerceIn(0.0, 255.0)
        val green = (yy - 0.344136 * uu - 0.714136 * vv).coerceIn(0.0, 255.0)
        val blue = (yy + 1.772 * uu).coerceIn(0.0, 255.0)
        redTotal += red
        greenTotal += green
        blueTotal += blue
        brightnessValues.add((red + green + blue) / 3)
        count += 1
        x += 10
      }
      y += 10
    }
    if (count <= 0) return AverageColor(0.0, 0.0, 0.0, 0.0, 0.0)
    val brightness = brightnessValues.average()
    val variance = brightnessValues.sumOf { (it - brightness).pow(2) } / brightnessValues.size
    return AverageColor(redTotal / count, greenTotal / count, blueTotal / count, brightness, variance)
  }

  private fun isFingerDetected(): Boolean {
    val latest = samples.lastOrNull() ?: return false
    if (samples.size < 12) return false
    val brightness = (latest.red + latest.green + latest.blue) / 3
    return fingerDetectionScore(AverageColor(latest.red, latest.green, latest.blue, brightness, 20.0), 0.0).confidence >= 72.0
  }

  private fun fingerDetectionScore(stats: AverageColor, motion: Double): FingerDetection {
    if (stats.brightness > 235) return FingerDetection(18.0, "Che kín camera và flash.")
    if (stats.brightness < 18) return FingerDetection(12.0, "Bật flash hoặc đặt ngón tay sát hơn.")

    val total = max(stats.red + stats.green + stats.blue, 1.0)
    val redRatio = stats.red / total
    val saturation = (max(max(stats.red, stats.green), stats.blue) - min(min(stats.red, stats.green), stats.blue)) / max(max(max(stats.red, stats.green), stats.blue), 1.0)
    val recent = samples.takeLast(90)
    val meanRed = if (recent.isEmpty()) stats.red else recent.map { it.red }.average()
    val redStd = if (recent.size > 8) standardDeviation(recent.map { it.red }) else 0.0
    val pulseRatio = redStd / max(meanRed, 1.0)

    var score = 0.0
    score += ((redRatio - 0.35) / 0.22).coerceIn(0.0, 1.0) * 30
    score += (saturation / 0.32).coerceIn(0.0, 1.0) * 20
    score += ((stats.brightness - 35) / 120).coerceIn(0.0, 1.0) * 15
    score += ((pulseRatio - 0.002) / 0.018).coerceIn(0.0, 1.0) * 20
    score += (1 - motion / 34).coerceIn(0.0, 1.0) * 10
    score += (1 - abs(stats.variance - 28) / 180).coerceIn(0.0, 1.0) * 5

    if (redRatio < 0.34 || saturation < 0.08) {
      return FingerDetection(min(score, 48.0), "Đặt ngón tay che kín camera và flash.")
    }
    if (motion > 40) {
      return FingerDetection(min(score, 58.0), "Giữ yên điện thoại.")
    }
    if (score < 55) return FingerDetection(score, "Đặt ngón tay lên camera.")
    if (score < 85) return FingerDetection(score, "Đang chuẩn bị, giữ yên tay...")
    return FingerDetection(score, "Sẵn sàng đo.")
  }

  private fun lockCameraControlsIfNeeded() {
    if (cameraControlsLocked) return
    val session = captureSession ?: return
    val builder = previewRequestBuilder ?: return
    try {
      builder.set(CaptureRequest.CONTROL_AE_LOCK, true)
      builder.set(CaptureRequest.CONTROL_AWB_LOCK, true)
      session.setRepeatingRequest(builder.build(), null, cameraHandler)
      cameraControlsLocked = true
    } catch (_: Exception) {
      cameraControlsLocked = true
    }
  }

  private fun qualityScore(): Double {
    if ((!isFingerDetected() && !(hasSeenFinger && missingFingerFrames < 90)) || samples.size < 120) return 0.0
    val values = samples.takeLast(240).map { it.red }
    val mean = values.average()
    val std = sqrt(values.sumOf { (it - mean).pow(2) } / values.size)
    val brightness = ((mean - 80) / 120).coerceIn(0.0, 1.0)
    val pulse = (std / 4).coerceIn(0.0, 1.0)
    return (brightness * 0.45 + pulse * 0.55).coerceIn(0.0, 1.0)
  }

  private fun estimateBpm(): Pair<Int?, Double> {
    if (!isFingerDetected() && !(hasSeenFinger && missingFingerFrames < 45)) return Pair(null, 0.0)
    val result = bpmFromRecentSamples(24.0, true)
    val bpm = result.first ?: return Pair(null, qualityScore() * 0.55)
    return Pair(bpm, (qualityScore() * 0.55 + result.second * 0.45).coerceIn(0.0, 1.0))
  }

  private fun estimateSpO2(): Pair<Int?, Double> {
    if (!isFingerDetected() && !(hasSeenFinger && missingFingerFrames < 45)) return Pair(null, 0.0)
    val lastTime = samples.lastOrNull()?.time ?: return Pair(null, 0.0)
    val usable = samples.filter { it.time >= max(0.0, lastTime - 24.0) }
    if (usable.size <= 210) return Pair(null, 0.0)

    val redValues = usable.map { it.red }
    val blueValues = usable.map { it.blue }
    val greenValues = usable.map { it.green }
    val redDc = redValues.average()
    val blueDc = blueValues.average()
    val greenDc = greenValues.average()
    if (redDc <= 90 || blueDc <= 4 || greenDc <= 4) return Pair(null, 0.0)

    val redAc = standardDeviation(preprocessedSignal(redValues, 30.0))
    val blueAc = standardDeviation(preprocessedSignal(blueValues, 30.0))
    val greenAc = standardDeviation(preprocessedSignal(greenValues, 30.0))
    if (redAc <= 0.00008 || blueAc <= 0.00008 || greenAc <= 0.00008) return Pair(null, 0.0)

    val ratioBlue = (redAc / redDc) / max(blueAc / blueDc, 0.000001)
    val ratioGreen = (redAc / redDc) / max(greenAc / greenDc, 0.000001)
    val ratio = ratioBlue * 0.65 + ratioGreen * 0.35
    if (ratio < 0.12 || ratio > 1.15) return Pair(null, 0.0)

    val raw = 104.0 - 17.0 * ratio
    if (raw < 88 || raw > 100.5) return Pair(null, 0.0)
    val spo2 = raw.roundToInt().coerceIn(88, 100)
    val ratioQuality = (1 - abs(ratio - 0.45) / 0.75).coerceIn(0.0, 1.0)
    val perfusionQuality = ((redDc - 100) / 80).coerceIn(0.0, 1.0)
    val quality = (ratioQuality * 0.65 + perfusionQuality * 0.35).coerceIn(0.0, 1.0)
    if (quality < 0.42) return Pair(null, quality)
    return Pair(spo2, quality)
  }

  private fun estimateRespiration(): Pair<Int?, Double> {
    if (!isFingerDetected() && !(hasSeenFinger && missingFingerFrames < 45)) return Pair(null, 0.0)
    val lastTime = samples.lastOrNull()?.time ?: return Pair(null, 0.0)
    val usable = samples.filter { it.time >= max(0.0, lastTime - 30.0) }
    if (usable.size <= 300) return Pair(null, 0.0)
    val first = usable.firstOrNull()?.time ?: return Pair(null, 0.0)
    val last = usable.lastOrNull()?.time ?: return Pair(null, 0.0)
    if (last <= first) return Pair(null, 0.0)
    val sampleRate = (usable.size - 1) / (last - first)
    if (sampleRate <= 5) return Pair(null, 0.0)

    val candidates = listOfNotNull(
      respirationFromValues(usable.map { it.red }, sampleRate),
      respirationFromValues(usable.map { it.green }, sampleRate),
      respirationFromValues(usable.map { (it.red + it.green) / 2 }, sampleRate)
    )
    val best = candidates.maxByOrNull { it.second } ?: return Pair(null, 0.0)
    if (best.second < 0.5) return Pair(null, best.second)
    return best
  }

  private fun respirationFromValues(values: List<Double>, sampleRate: Double): Pair<Int?, Double>? {
    val signal = respiratorySignal(values, sampleRate)
    if (signal.size <= 300 || standardDeviation(signal) <= 0.00004) return null

    val powers = mutableMapOf<Int, Double>()
    var bestRpm = 0
    var bestPower = 0.0
    for (rpm in 6..30) {
      val power = spectralPower(signal, sampleRate, rpm.toDouble())
      powers[rpm] = power
      if (power > bestPower) {
        bestPower = power
        bestRpm = rpm
      }
    }
    if (bestRpm == 0) return null
    val averagePower = powers.values.average()
    val spectralRatio = bestPower / max(averagePower, 0.0000001)
    if (spectralRatio < 1.35) return null

    val ac = respiratoryAutocorrelation(signal, sampleRate)
    if (ac != null && abs((ac.first ?: bestRpm) - bestRpm) > 4) return null
    val agreement = ac?.let { (1 - abs((it.first ?: bestRpm) - bestRpm) / 4.0).coerceIn(0.0, 1.0) } ?: 0.65
    val rpm = ac?.let { (bestRpm * 0.55 + (it.first ?: bestRpm) * 0.45).roundToInt() } ?: bestRpm
    if (rpm !in 6..30) return null
    val quality = (((spectralRatio - 1) / 3) * 0.65 + agreement * 0.35).coerceIn(0.0, 1.0)
    return Pair(rpm, quality)
  }

  private fun respiratorySignal(values: List<Double>, sampleRate: Double): List<Double> {
    val mean = values.average()
    if (mean <= 1) return emptyList()
    val normalized = values.map { (it - mean) / mean }
    val smooth = movingAverage(medianFilter(normalized, 5), max(5, (sampleRate * 0.7).roundToInt()))
    val baseline = movingAverage(smooth, max(31, (sampleRate * 6).roundToInt()))
    return smooth.zip(baseline) { value, base -> value - base }
  }

  private fun respiratoryAutocorrelation(signal: List<Double>, sampleRate: Double): Pair<Int?, Double>? {
    val minLag = max(1, (sampleRate * 60 / 30).roundToInt())
    val maxLag = min(signal.size - 2, (sampleRate * 60 / 6).roundToInt())
    if (maxLag <= minLag) return null
    var bestLag = 0
    var bestCorr = -1.0
    for (lag in minLag..maxLag) {
      val corr = autocorrelation(signal, lag)
      if (corr > bestCorr) {
        bestCorr = corr
        bestLag = lag
      }
    }
    if (bestLag <= 0 || bestCorr < 0.2) return null
    val rpm = (60 * sampleRate / bestLag).roundToInt()
    if (rpm !in 6..30) return null
    return Pair(rpm, ((bestCorr - 0.15) / 0.55).coerceIn(0.0, 1.0))
  }

  private fun liveBpmEstimate(): Pair<Int?, Double> {
    if (!isFingerDetected() && !(hasSeenFinger && missingFingerFrames < 180)) return Pair(null, 0.0)
    val result = bpmFromRecentSamples(10.0, false)
    val bpm = result.first ?: return Pair(null, qualityScore())
    return Pair(bpm, (qualityScore() * 0.6 + result.second * 0.4 + 0.05).coerceIn(0.0, 1.0))
  }

  private fun bpmFromRecentSamples(seconds: Double, final: Boolean): Pair<Int?, Double> {
    val lastTime = samples.lastOrNull()?.time ?: return Pair(null, 0.0)
    val usable = samples.filter { it.time >= max(0.0, lastTime - seconds) }
    if (usable.size <= if (final) 210 else 90) return Pair(null, 0.0)

    val first = usable.firstOrNull()?.time ?: return Pair(null, 0.0)
    val last = usable.lastOrNull()?.time ?: return Pair(null, 0.0)
    if (last <= first) return Pair(null, 0.0)
    val sampleRate = (usable.size - 1) / (last - first)
    val candidates = listOfNotNull(
      fusedBpm(usable.map { it.green }, sampleRate, final),
      fusedBpm(usable.map { it.red }, sampleRate, final),
      fusedBpm(usable.map { (it.green + it.red) / 2 }, sampleRate, final)
    )
    return candidates.maxByOrNull { it.second } ?: Pair(null, 0.0)
  }

  private fun fusedBpm(values: List<Double>, sampleRate: Double, final: Boolean): Pair<Int?, Double>? {
    if (values.size <= (if (final) 210 else 90) || sampleRate <= 5) return null
    val signal = preprocessedSignal(values, sampleRate)
    if (standardDeviation(signal) <= 0.00008) return null

    val fft = spectralBpm(signal, sampleRate, final)
    val peaks = peakBpm(signal, sampleRate, final)
    val ac = autocorrelationBpm(signal, sampleRate, final)
    val results = listOfNotNull(fft, peaks, ac)
    if (results.size < 2) return null

    val bpms = results.map { it.first ?: return null }
    val spread = (bpms.maxOrNull() ?: 0) - (bpms.minOrNull() ?: 0)
    val allowedSpread = if (final) {
      if (results.size == 3) 10.0 else 7.0
    } else {
      14.0
    }
    if (spread > allowedSpread) return null

    val totalWeight = max(results.sumOf { it.second }, 0.0001)
    val fused = (results.sumOf { (it.first ?: 0) * it.second } / totalWeight).roundToInt()
    val agreement = (1 - spread / allowedSpread).coerceIn(0.0, 1.0)
    val methodCoverage = if (results.size == 3) 1.0 else 0.82
    val stability = ((results.map { it.second }.average() * 0.7 + agreement * 0.3) * methodCoverage).coerceIn(0.0, 1.0)
    return Pair(fused, stability)
  }

  private fun preprocessedSignal(values: List<Double>, sampleRate: Double): List<Double> {
    val mean = values.average()
    if (mean <= 1) return emptyList()
    val normalized = values.map { (it - mean) / mean }
    val medianed = medianFilter(normalized, 3)
    val smoothed = movingAverage(medianed, 5)
    val baseline = movingAverage(smoothed, max(21, (sampleRate * 1.4).roundToInt()))
    var signal = smoothed.zip(baseline) { value, base -> value - base }
    signal = signal.mapIndexed { index, value ->
      val window = 0.54 - 0.46 * kotlin.math.cos((2 * Math.PI * index) / max(signal.size - 1, 1))
      value * window
    }
    return signal
  }

  private fun spectralBpmFromRaw(values: List<Double>, sampleRate: Double, final: Boolean): Pair<Int?, Double>? {
    if (values.size <= (if (final) 210 else 90) || sampleRate <= 5) return null
    return spectralBpm(preprocessedSignal(values, sampleRate), sampleRate, final)
  }

  private fun spectralBpm(signal: List<Double>, sampleRate: Double, final: Boolean): Pair<Int?, Double>? {
    if (signal.size <= (if (final) 210 else 90) || sampleRate <= 5 || standardDeviation(signal) <= 0.00008) return null

    val powers = mutableMapOf<Int, Double>()
    var bestBpm = 0
    var bestPower = 0.0
    for (bpm in 48..150) {
      val power = spectralPower(signal, sampleRate, bpm.toDouble())
      powers[bpm] = power
      if (power > bestPower) {
        bestPower = power
        bestBpm = bpm
      }
    }
    if (bestBpm == 0) return null

    if (bestBpm > 118) {
      val half = bestBpm / 2
      val halfPower = neighborhoodPower(powers, half)
      if (half >= 48 && halfPower >= bestPower * 0.42) {
        bestBpm = half
        bestPower = halfPower
      }
    } else if (bestBpm < 58) {
      val double = bestBpm * 2
      val doublePower = neighborhoodPower(powers, double)
      if (double <= 150 && doublePower >= bestPower * 0.35) {
        bestBpm = double
        bestPower = doublePower
      }
    }

    val averagePower = powers.values.average()
    val ratio = bestPower / max(averagePower, 0.0000001)
    if (ratio < if (final) 1.35 else 1.18) return null
    return Pair(bestBpm, ((ratio - 1) / 4).coerceIn(0.0, 1.0))
  }

  private fun peakBpm(signal: List<Double>, sampleRate: Double, final: Boolean): Pair<Int?, Double>? {
    if (signal.size <= (if (final) 210 else 90) || sampleRate <= 5) return null
    val std = standardDeviation(signal)
    if (std <= 0.00008) return null
    val threshold = std * 0.25
    val minDistance = max(1, (sampleRate * 60 / 150).roundToInt())
    val peaks = mutableListOf<Int>()
    var lastPeak = -minDistance
    for (index in 1 until signal.size - 1) {
      if (signal[index] <= threshold || signal[index] <= signal[index - 1] || signal[index] < signal[index + 1]) continue
      if (index - lastPeak >= minDistance) {
        peaks.add(index)
        lastPeak = index
      } else if (peaks.isNotEmpty() && signal[index] > signal[peaks.last()]) {
        peaks[peaks.lastIndex] = index
        lastPeak = index
      }
    }
    if (peaks.size < if (final) 6 else 4) return null
    val intervals = peaks.drop(1).zip(peaks).map { (right, left) -> (right - left) / sampleRate }
      .filter { it >= 60.0 / 150 && it <= 60.0 / 48 }
    if (intervals.size < if (final) 5 else 3) return null
    val period = median(intervals)
    val bpm = (60 / period).roundToInt()
    if (bpm !in 48..150) return null
    val cv = standardDeviation(intervals) / max(period, 0.0001)
    return Pair(bpm, (1 - cv * 4).coerceIn(0.0, 1.0))
  }

  private fun autocorrelationBpm(signal: List<Double>, sampleRate: Double, final: Boolean): Pair<Int?, Double>? {
    if (signal.size <= (if (final) 210 else 90) || sampleRate <= 5) return null
    val minLag = max(1, (sampleRate * 60 / 150).roundToInt())
    val maxLag = min(signal.size - 2, (sampleRate * 60 / 48).roundToInt())
    if (maxLag <= minLag) return null
    var bestLag = 0
    var bestCorr = -1.0
    for (lag in minLag..maxLag) {
      val corr = autocorrelation(signal, lag)
      if (corr > bestCorr) {
        bestCorr = corr
        bestLag = lag
      }
    }
    if (bestLag <= 0 || bestCorr < if (final) 0.26 else 0.2) return null
    val bpm = (60 * sampleRate / bestLag).roundToInt()
    if (bpm !in 48..150) return null
    return Pair(bpm, ((bestCorr - 0.2) / 0.7).coerceIn(0.0, 1.0))
  }

  private fun spectralPower(values: List<Double>, sampleRate: Double, bpm: Double): Double {
    val frequency = bpm / 60
    var real = 0.0
    var imaginary = 0.0
    values.forEachIndexed { index, value ->
      val angle = 2 * Math.PI * frequency * index / sampleRate
      real += value * kotlin.math.cos(angle)
      imaginary -= value * kotlin.math.sin(angle)
    }
    return real * real + imaginary * imaginary
  }

  private fun neighborhoodPower(powers: Map<Int, Double>, bpm: Int): Double {
    return ((bpm - 2)..(bpm + 2)).maxOf { powers[it] ?: 0.0 }
  }

  private fun movingAverage(values: List<Double>, window: Int): List<Double> {
    if (values.isEmpty()) return emptyList()
    return values.indices.map { index ->
      val start = max(0, index - window / 2)
      val end = min(values.size - 1, index + window / 2)
      values.subList(start, end + 1).average()
    }
  }

  private fun medianFilter(values: List<Double>, window: Int): List<Double> {
    if (values.isEmpty() || window <= 1) return values
    return values.indices.map { index ->
      val start = max(0, index - window / 2)
      val end = min(values.size - 1, index + window / 2)
      median(values.subList(start, end + 1))
    }
  }

  private fun standardDeviation(values: List<Double>): Double {
    if (values.isEmpty()) return 0.0
    val mean = values.average()
    return sqrt(values.sumOf { (it - mean).pow(2) } / values.size)
  }

  private fun autocorrelation(values: List<Double>, lag: Int): Double {
    if (lag <= 0 || values.size <= lag + 2) return -1.0
    var numerator = 0.0
    var leftEnergy = 0.0
    var rightEnergy = 0.0
    for (index in lag until values.size) {
      val left = values[index]
      val right = values[index - lag]
      numerator += left * right
      leftEnergy += left * left
      rightEnergy += right * right
    }
    return numerator / max(sqrt(leftEnergy * rightEnergy), 0.000001)
  }

  private fun median(values: List<Double>): Double {
    val sorted = values.sorted()
    if (sorted.isEmpty()) return 0.0
    val middle = sorted.size / 2
    return if (sorted.size % 2 == 0) {
      (sorted[middle - 1] + sorted[middle]) / 2
    } else {
      sorted[middle]
    }
  }

  private fun elapsedMs() = System.currentTimeMillis() - startedAt

  private fun progress() = min(elapsedMs().toDouble() / durationMs, 1.0)

  private fun send(
    status: String,
    elapsedMs: Long,
    progress: Double,
    bpm: Int? = null,
    spo2: Int? = null,
    respiration: Int? = null,
    quality: Double,
    signal: Double? = null,
    message: String? = null
  ) {
    val body = mutableMapOf<String, Any>(
      "status" to status,
      "elapsedMs" to elapsedMs.toInt(),
      "progress" to progress,
      "quality" to quality
    )
    bpm?.let { body["bpm"] = it }
    spo2?.let { body["spo2"] = it }
    respiration?.let { body["respiration"] = it }
    signal?.let { body["signal"] = it }
    message?.let { body["message"] = it }
    sendEvent("onPpgUpdate", body)
  }
}
