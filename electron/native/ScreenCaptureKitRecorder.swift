import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreImage
import CoreGraphics
import ImageIO

struct CaptureConfig: Codable {
	let fps: Int?
	let displayId: CGDirectDisplayID?
	let windowId: UInt32?
	let outputPath: String?
	let capturesSystemAudio: Bool?
	let capturesMicrophone: Bool?
	let systemAudioOutputPath: String?
	let microphoneDeviceId: String?
	let microphoneLabel: String?
	let microphoneOutputPath: String?
	let capturesWebcam: Bool?
	let webcamDeviceId: String?
	let webcamLabel: String?
	let webcamOutputPath: String?
	let webcamWidth: Int?
	let webcamHeight: Int?
	let webcamFPS: Int?
	let webcamPreviewPath: String?
	let webcamPreviewOnly: Bool?
}

struct ListedAudioDevice: Codable {
	let label: String
	let uniqueId: String
	let modelId: String
	let connected: Bool
}

let targetCaptureFPS = 30
let maxInlineAudioTailExtension = CMTime(seconds: 2.0, preferredTimescale: 600)
let crashRecoveryFragmentInterval = CMTime(seconds: 5.0, preferredTimescale: 600)
let videoKeepAliveIntervalNanoseconds: UInt64 = 500_000_000
let audioWatchdogIntervalNanoseconds: UInt64 = 500_000_000
let maxVideoKeepAliveLagBeforeFailure = CMTime(seconds: 5.0, preferredTimescale: 600)
let maxMicrophoneAudioGapBeforeFailure = CMTime(seconds: 5.0, preferredTimescale: 600)
let maxScreenOutputPixels = 2560 * 1440
let maxScreenOutputLongEdge = 2560
let screenEncoderDimensionMultiple = 16
let nativeCaptureStatsInterval = CMTime(seconds: 5.0, preferredTimescale: 600)
let webcamWatchdogIntervalNanoseconds: UInt64 = 500_000_000
let maxWebcamFrameGapBeforeFailure = CMTime(seconds: 5.0, preferredTimescale: 600)
let webcamVisualSampleInterval = CMTime(seconds: 1.0, preferredTimescale: 600)
let webcamVisualStallLogThreshold = CMTime(seconds: 20.0, preferredTimescale: 600)
let webcamVisualStallFailureThreshold = CMTime(seconds: 60.0, preferredTimescale: 600)
let webcamVisualSignatureDiffThreshold = 0.25
// This proof preview is rendered from the exact native camera frames accepted
// by the webcam writer. Cap it at 30fps: on a 30fps camera, lower thresholds
// accidentally skip every other frame and make the teleprompter look stalled.
let webcamPreviewFrameInterval = CMTime(value: 1, timescale: 30)
let webcamPreviewLongEdge = 360
let webcamPreviewRingSize = 8
let webcamVisibleMaxLumaThreshold = 24
let webcamVisibleAverageLumaThreshold = 4.0
let webcamPreflightVisibleFrameTimeoutSeconds = 5.0
let minNativeScreenVideoBitRate = 8_000_000
let maxNativeScreenVideoBitRate = 16_000_000
let minNativeWebcamVideoBitRate = 800_000
let maxNativeWebcamVideoBitRate = 45_000_000

final class ScreenCaptureRecorder: NSObject, SCStreamOutput, SCStreamDelegate, AVCaptureVideoDataOutputSampleBufferDelegate {
	private let queue = DispatchQueue(label: "recordly.screencapturekit.video")
	private var assetWriter: AVAssetWriter?
	private var videoInput: AVAssetWriterInput?
	private var videoPixelBufferAdaptor: AVAssetWriterInputPixelBufferAdaptor?
	private var systemAudioWriter: AVAssetWriter?
	private var systemAudioInput: AVAssetWriterInput?
	private var microphoneOnlyWriter: AVAssetWriter?
	private var microphoneOnlyInput: AVAssetWriterInput?
	private let webcamQueue = DispatchQueue(label: "recordly.webcam.video")
	private let webcamPreviewQueue = DispatchQueue(label: "recordly.webcam.preview", qos: .userInitiated)
	private let webcamPreviewContext = CIContext(options: [.useSoftwareRenderer: false])
	private let webcamPreflightCondition = NSCondition()
	private var webcamSession: AVCaptureSession?
	private var webcamWriter: AVAssetWriter?
	private var webcamInput: AVAssetWriterInput?
	private var webcamPixelBufferAdaptor: AVAssetWriterInputPixelBufferAdaptor?
	private var webcamOutputURL: URL?
	private var webcamPreviewURLs: [URL] = []
	private var firstWebcamSampleTime: CMTime?
	private var lastWebcamPresentationTime: CMTime = .zero
	private var lastWebcamDuration: CMTime = .zero
	private var lastWebcamFrameHostTime: CMTime?
	private var webcamInputNotReadySinceHostTime: CMTime?
	private var lastWebcamVisualSampleHostTime: CMTime?
	private var lastWebcamVisualSignature: [UInt8]?
	private var webcamVisualStableSinceHostTime: CMTime?
	private var webcamVisualStallLogged = false
	private var webcamPreflightAcceptingFrames = false
	private var webcamPreflightVisibleFrameReady = false
	private var webcamPreflightFrameCount = 0
	private var webcamWatchdogTask: Task<Void, Never>?
	private var webcamPipelineFailureTriggered = false
	private var stream: SCStream?
	private var firstSampleTime: CMTime = .zero
	private var firstSystemAudioSampleTime: CMTime?
	private var firstMicrophoneSampleTime: CMTime?
	private var lastSampleBuffer: CMSampleBuffer?
	private var lastVideoPixelBuffer: CVPixelBuffer?
	private var lastVideoPresentationTime: CMTime = .zero
	private var lastVideoDuration: CMTime = .zero
	private var lastInlineAudioPresentationTime: CMTime = .invalid
	private var lastInlineAudioDuration: CMTime = .zero
	private var lastInlineAudioHostTime: CMTime?
	private var lastMicrophoneAudioPresentationTime: CMTime = .invalid
	private var lastMicrophoneAudioDuration: CMTime = .zero
	private var lastMicrophoneAudioHostTime: CMTime?
	private var isRecording = false
	private var isPaused = false
	private var pauseStartedHostTime: CMTime?
	private var pendingResumeAdjustment = false
	private var accumulatedPausedDuration: CMTime = .zero
	private var recordingStartedHostTime: CMTime?
	private var sessionStarted = false
	private var frameCount = 0
	private var videoAppendedFrameCount = 0
	private var videoHoldFrameCount = 0
	private var loggedFirstVideoFrame = false
	private var lastVideoStatsHostTime: CMTime?
	private var lastVideoStatsAppendedFrameCount = 0
	private var outputURL: URL?
	private var microphoneOutputURL: URL?
	private var trackedWindowId: UInt32?
	private var windowValidationTask: Task<Void, Never>?
	private var videoKeepAliveTask: Task<Void, Never>?
	private var audioWatchdogTask: Task<Void, Never>?
	private var videoKeepAliveNotReadySince: CMTime?
	private var videoPipelineFailureTriggered = false
	private var audioPipelineFailureTriggered = false
	private var inlineAudioInput: AVAssetWriterInput?
	private var firstInlineAudioSampleTime: CMTime?
	private var capturesSystemAudio = false
	private var capturesMicrophone = false
	private var writesSystemAudioToSeparateTrack = false
	private var writesMicrophoneToSeparateTrack = false
	private var capturesWebcam = false
	private var webcamPreviewOnly = false
	private var screenTargetFPS = targetCaptureFPS
	private var webcamTargetFPS = 30
	private var webcamFrameCount = 0
	private var loggedFirstWebcamFrame = false
	private var loggedFirstVisibleWebcamFrame = false
	private var lastWebcamStatsHostTime: CMTime?
	private var lastWebcamStatsFrameCount = 0
	private var lastWebcamPreviewHostTime: CMTime?
	private var webcamPreviewFrameCount = 0
	private var webcamPreviewWriteInFlight = false
	private var inlineAudioBufferCount = 0
	private var microphoneAudioBufferCount = 0
	private var lastAudioStatsHostTime: CMTime?
	private var lastAudioStatsBufferCount = 0

	private let microphoneOutputTypeRawValue = 2

	func startCapture(configJSON: String) async throws {
		guard !isRecording else {
			throw NSError(domain: "RecordlyCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "Recording is already in progress"])
		}

		guard let data = configJSON.data(using: .utf8) else {
			throw NSError(domain: "RecordlyCapture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Invalid JSON input"])
		}

		let config = try JSONDecoder().decode(CaptureConfig.self, from: data)
		if config.webcamPreviewOnly == true {
			try startWebcamPreviewOnly(config: config)
			return
		}

		webcamPreviewOnly = false
		let availableContent = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
		let streamConfig = SCStreamConfiguration()
		capturesSystemAudio = config.capturesSystemAudio ?? false
		capturesMicrophone = config.capturesMicrophone ?? false
		capturesWebcam = config.capturesWebcam ?? false
		webcamTargetFPS = max(1, min(60, config.webcamFPS ?? 30))
		if capturesMicrophone && !supportsNativeMicrophoneCapture(streamConfig: streamConfig) {
			fputs("MICROPHONE_CAPTURE_UNAVAILABLE\n", stderr)
			fflush(stderr)
			capturesMicrophone = false
		}
		writesSystemAudioToSeparateTrack = capturesSystemAudio
		writesMicrophoneToSeparateTrack = capturesMicrophone
		let requestedFPS = max(1, min(60, config.fps ?? targetCaptureFPS))
		screenTargetFPS = requestedFPS
		streamConfig.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(requestedFPS))
		streamConfig.queueDepth = 6
		streamConfig.pixelFormat = kCVPixelFormatType_32BGRA
		streamConfig.showsCursor = false
		streamConfig.capturesAudio = capturesSystemAudio || capturesMicrophone
		streamConfig.sampleRate = 48000
		streamConfig.channelCount = 2
		streamConfig.excludesCurrentProcessAudio = true

		if capturesMicrophone {
			streamConfig.setValue(true, forKey: "captureMicrophone")
			if let microphoneDeviceId = Self.resolveMicrophoneCaptureDeviceID(config: config) {
				streamConfig.setValue(microphoneDeviceId, forKey: "microphoneCaptureDeviceID")
				fputs("MICROPHONE_CAPTURE_DEVICE_RESOLVED requestedLabel=\"\(Self.sanitizeLogValue(config.microphoneLabel ?? ""))\" requestedDeviceId=\"\(Self.sanitizeLogValue(config.microphoneDeviceId ?? ""))\" resolvedDeviceId=\"\(Self.sanitizeLogValue(microphoneDeviceId))\"\n", stderr)
				fflush(stderr)
			} else {
				fputs(
					"MICROPHONE_CAPTURE_DEVICE_DEFAULT requestedLabel=\"\(Self.sanitizeLogValue(config.microphoneLabel ?? ""))\" requestedDeviceId=\"\(Self.sanitizeLogValue(config.microphoneDeviceId ?? ""))\" available=\"\(Self.sanitizeLogValue(Self.audioDeviceSummary(AVCaptureDevice.devices(for: .audio))))\"\n",
					stderr
				)
				fflush(stderr)
			}
		}

		let filter: SCContentFilter
		let sourceWidth: Int
		let sourceHeight: Int

		if let windowId = config.windowId {
			trackedWindowId = windowId
			guard let window = availableContent.windows.first(where: { $0.windowID == windowId }) else {
				throw NSError(domain: "RecordlyCapture", code: 3, userInfo: [NSLocalizedDescriptionKey: "Window not found"])
			}

			filter = SCContentFilter(desktopIndependentWindow: window)

			let candidateDisplay = availableContent.displays.first(where: {
				$0.frame.intersects(window.frame) || $0.frame.contains(CGPoint(x: window.frame.midX, y: window.frame.midY))
			})
			let scaleFactor = ScreenCaptureRecorder.scaleFactor(for: candidateDisplay?.displayID ?? CGMainDisplayID())
			sourceWidth = max(2, Int(window.frame.width) * scaleFactor)
			sourceHeight = max(2, Int(window.frame.height) * scaleFactor)
			if #available(macOS 14.0, *) {
				streamConfig.ignoreShadowsSingleWindow = true
			}
		} else {
			trackedWindowId = nil
			let displayId = config.displayId ?? CGMainDisplayID()
			guard let display = availableContent.displays.first(where: { $0.displayID == displayId }) else {
				throw NSError(domain: "RecordlyCapture", code: 4, userInfo: [NSLocalizedDescriptionKey: "Display not found"])
			}

			filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
			let displayBounds = CGDisplayBounds(display.displayID)
			let scaleFactor = ScreenCaptureRecorder.scaleFactor(for: display.displayID)
			sourceWidth = max(2, Int(displayBounds.width) * scaleFactor)
			sourceHeight = max(2, Int(displayBounds.height) * scaleFactor)
		}

		let outputDimensions = Self.stableScreenOutputDimensions(
			sourceWidth: sourceWidth,
			sourceHeight: sourceHeight
		)
		let outputWidth = outputDimensions.width
		let outputHeight = outputDimensions.height
		streamConfig.width = outputWidth
		streamConfig.height = outputHeight
		if outputDimensions.wasCapped {
			fputs("VIDEO_OUTPUT_DOWNSCALED sourceWidth=\(sourceWidth) sourceHeight=\(sourceHeight) outputWidth=\(outputWidth) outputHeight=\(outputHeight) scale=\(outputDimensions.scale)\n", stderr)
		} else {
			fputs("VIDEO_OUTPUT_NATIVE sourceWidth=\(sourceWidth) sourceHeight=\(sourceHeight) outputWidth=\(outputWidth) outputHeight=\(outputHeight)\n", stderr)
		}
		fflush(stderr)

		let destinationURL: URL
		if let outputPath = config.outputPath, !outputPath.isEmpty {
			destinationURL = URL(fileURLWithPath: outputPath)
		} else {
			destinationURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
				.appendingPathComponent("output_\(Int(Date().timeIntervalSince1970)).mp4")
		}

			outputURL = destinationURL
			let outputFileType: AVFileType = destinationURL.pathExtension.lowercased() == "mp4" ? .mp4 : .mov
			assetWriter = try AVAssetWriter(url: destinationURL, fileType: outputFileType)
			assetWriter?.movieFragmentInterval = crashRecoveryFragmentInterval
			microphoneOutputURL = nil
		firstSystemAudioSampleTime = nil
		firstMicrophoneSampleTime = nil

		guard let assistant = AVOutputSettingsAssistant(preset: .preset3840x2160) else {
			throw NSError(domain: "RecordlyCapture", code: 5, userInfo: [NSLocalizedDescriptionKey: "Unable to create output settings assistant"])
		}

		assistant.sourceVideoFormat = try CMVideoFormatDescription(
			videoCodecType: .h264,
			width: outputWidth,
			height: outputHeight
		)

		guard var outputSettings = assistant.videoSettings else {
			throw NSError(domain: "RecordlyCapture", code: 6, userInfo: [NSLocalizedDescriptionKey: "Output settings unavailable"])
		}

		outputSettings[AVVideoWidthKey] = outputWidth
		outputSettings[AVVideoHeightKey] = outputHeight
		var compressionProperties =
			outputSettings[AVVideoCompressionPropertiesKey] as? [String: Any] ?? [:]
		let screenBitRate = Self.screenVideoBitRate(width: outputWidth, height: outputHeight, fps: requestedFPS)
		compressionProperties[AVVideoAverageBitRateKey] = screenBitRate
		compressionProperties[AVVideoExpectedSourceFrameRateKey] = requestedFPS
		compressionProperties[AVVideoMaxKeyFrameIntervalKey] = requestedFPS * 2
		compressionProperties[AVVideoAllowFrameReorderingKey] = false
		compressionProperties[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel
		outputSettings[AVVideoCompressionPropertiesKey] = compressionProperties
		fputs("VIDEO_ENCODER_SETTINGS bitRate=\(screenBitRate) fps=\(requestedFPS) keyFrameInterval=\(requestedFPS * 2)\n", stderr)
		fflush(stderr)

		let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: outputSettings)
		videoInput.expectsMediaDataInRealTime = true

		guard let assetWriter = assetWriter, assetWriter.canAdd(videoInput) else {
			throw NSError(domain: "RecordlyCapture", code: 7, userInfo: [NSLocalizedDescriptionKey: "Unable to add video writer input"])
		}

		assetWriter.add(videoInput)
		self.videoInput = videoInput
		self.videoPixelBufferAdaptor = AVAssetWriterInputPixelBufferAdaptor(
			assetWriterInput: videoInput,
			sourcePixelBufferAttributes: [
				kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
				kCVPixelBufferWidthKey as String: outputWidth,
				kCVPixelBufferHeightKey as String: outputHeight,
				kCVPixelBufferIOSurfacePropertiesKey as String: [:],
			]
		)

		// Add inline audio track directly to the video so the .mp4 always contains audio.
		// This eliminates the dependency on the post-recording ffmpeg mux step.
		if capturesSystemAudio || capturesMicrophone {
			let inlineAudio = AVAssetWriterInput(mediaType: .audio, outputSettings: Self.audioOutputSettings(bitRate: 192_000))
			inlineAudio.expectsMediaDataInRealTime = true
			if assetWriter.canAdd(inlineAudio) {
				assetWriter.add(inlineAudio)
				self.inlineAudioInput = inlineAudio
			}
		}

		if writesSystemAudioToSeparateTrack {
			guard let systemAudioOutputPath = config.systemAudioOutputPath, !systemAudioOutputPath.isEmpty else {
				throw NSError(domain: "RecordlyCapture", code: 11, userInfo: [NSLocalizedDescriptionKey: "Missing system audio output path for audio capture"])
			}

				let systemAudioURL = URL(fileURLWithPath: systemAudioOutputPath)
				let systemAudioWriter = try AVAssetWriter(url: systemAudioURL, fileType: .m4a)
				systemAudioWriter.movieFragmentInterval = crashRecoveryFragmentInterval
				let systemAudioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: Self.audioOutputSettings(bitRate: 160_000))
			systemAudioInput.expectsMediaDataInRealTime = true

			guard systemAudioWriter.canAdd(systemAudioInput) else {
				throw NSError(domain: "RecordlyCapture", code: 12, userInfo: [NSLocalizedDescriptionKey: "Unable to add system audio writer input"])
			}

			systemAudioWriter.add(systemAudioInput)
			self.systemAudioWriter = systemAudioWriter
			self.systemAudioInput = systemAudioInput

			guard systemAudioWriter.startWriting() else {
				throw NSError(domain: "RecordlyCapture", code: 13, userInfo: [NSLocalizedDescriptionKey: systemAudioWriter.error?.localizedDescription ?? "Unable to start system audio writing"])
			}

			systemAudioWriter.startSession(atSourceTime: .zero)
		}

		if writesMicrophoneToSeparateTrack {
			guard let microphoneOutputPath = config.microphoneOutputPath, !microphoneOutputPath.isEmpty else {
				throw NSError(domain: "RecordlyCapture", code: 14, userInfo: [NSLocalizedDescriptionKey: "Missing microphone output path for microphone capture"])
			}

				let microphoneURL = URL(fileURLWithPath: microphoneOutputPath)
				microphoneOutputURL = microphoneURL
				let microphoneWriter = try AVAssetWriter(url: microphoneURL, fileType: .m4a)
				microphoneWriter.movieFragmentInterval = crashRecoveryFragmentInterval
				let microphoneInput = AVAssetWriterInput(mediaType: .audio, outputSettings: Self.audioOutputSettings(bitRate: 128_000))
			microphoneInput.expectsMediaDataInRealTime = true

			guard microphoneWriter.canAdd(microphoneInput) else {
				throw NSError(domain: "RecordlyCapture", code: 15, userInfo: [NSLocalizedDescriptionKey: "Unable to add microphone writer input"])
			}

			microphoneWriter.add(microphoneInput)
			self.microphoneOnlyWriter = microphoneWriter
			self.microphoneOnlyInput = microphoneInput

			guard microphoneWriter.startWriting() else {
				throw NSError(domain: "RecordlyCapture", code: 16, userInfo: [NSLocalizedDescriptionKey: microphoneWriter.error?.localizedDescription ?? "Unable to start microphone audio writing"])
			}

			microphoneWriter.startSession(atSourceTime: .zero)
		}

		let stream = SCStream(filter: filter, configuration: streamConfig, delegate: self)
		self.stream = stream
		try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
		if capturesSystemAudio {
			try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
		}
		if capturesMicrophone {
			guard let microphoneOutputType = SCStreamOutputType(rawValue: microphoneOutputTypeRawValue) else {
				throw NSError(
					domain: "RecordlyCapture",
					code: 17,
					userInfo: [NSLocalizedDescriptionKey: "Microphone stream output type is unavailable"]
				)
			}
			try stream.addStreamOutput(self, type: microphoneOutputType, sampleHandlerQueue: queue)
		}
		try await stream.startCapture()

		guard assetWriter.startWriting() else {
			throw NSError(domain: "RecordlyCapture", code: 8, userInfo: [NSLocalizedDescriptionKey: assetWriter.error?.localizedDescription ?? "Unable to start video writing"])
		}

		assetWriter.startSession(atSourceTime: .zero)
		isPaused = false
		pauseStartedHostTime = nil
		pendingResumeAdjustment = false
		accumulatedPausedDuration = .zero
		recordingStartedHostTime = nil
		frameCount = 0
		videoAppendedFrameCount = 0
		videoHoldFrameCount = 0
		loggedFirstVideoFrame = false
		lastVideoStatsHostTime = nil
		lastVideoStatsAppendedFrameCount = 0
		firstSampleTime = .zero
		lastVideoPresentationTime = .zero
		lastVideoDuration = .zero
		lastInlineAudioPresentationTime = .invalid
		lastInlineAudioDuration = .zero
		lastInlineAudioHostTime = nil
		lastMicrophoneAudioPresentationTime = .invalid
		lastMicrophoneAudioDuration = .zero
		lastMicrophoneAudioHostTime = nil
		videoKeepAliveNotReadySince = nil
		videoPipelineFailureTriggered = false
		audioPipelineFailureTriggered = false
		webcamPipelineFailureTriggered = false
		inlineAudioBufferCount = 0
		microphoneAudioBufferCount = 0
		lastAudioStatsHostTime = nil
		lastAudioStatsBufferCount = 0
		if capturesWebcam {
			try startWebcamCapture(config: config)
			guard waitForWebcamPreflightVisibleFrame(timeoutSeconds: webcamPreflightVisibleFrameTimeoutSeconds) else {
				cancelWebcamCaptureStartup()
				throw NSError(
					domain: "RecordlyCapture",
					code: 31,
					userInfo: [NSLocalizedDescriptionKey: "Selected webcam did not deliver a visible frame before recording start"]
				)
			}
		}

		let gateOpenHostTime = CMClockGetTime(CMClockGetHostTimeClock())
		recordingStartedHostTime = gateOpenHostTime
		lastVideoStatsHostTime = gateOpenHostTime
		lastAudioStatsHostTime = gateOpenHostTime
		if capturesWebcam {
			lastWebcamStatsHostTime = gateOpenHostTime
		}
		sessionStarted = true
		isRecording = true
		fputs("CAPTURE_GATE_OPENED capturesWebcam=\(capturesWebcam) hostTime=\(CMTimeGetSeconds(gateOpenHostTime))\n", stderr)
		fflush(stderr)
		startVideoKeepAlive()
		startAudioWatchdogIfNeeded()
		startWebcamWatchdogIfNeeded()
		startWindowValidationIfNeeded()
		print("Recording started")
		fflush(stdout)
	}

	func stopCapture() async throws -> String {
		guard isRecording else {
			throw NSError(domain: "RecordlyCapture", code: 9, userInfo: [NSLocalizedDescriptionKey: "No recording in progress"])
		}

		return try await finishCapture()
	}

	func pauseCapture() {
		guard isRecording, !isPaused else { return }
		isPaused = true
		pauseStartedHostTime = CMClockGetTime(CMClockGetHostTimeClock())
		pendingResumeAdjustment = false
	}

	func resumeCapture() {
		guard isRecording, isPaused else { return }
		isPaused = false
		pendingResumeAdjustment = true
		let now = CMClockGetTime(CMClockGetHostTimeClock())
		if lastMicrophoneAudioHostTime != nil {
			lastMicrophoneAudioHostTime = now
		}
		if lastInlineAudioHostTime != nil {
			lastInlineAudioHostTime = now
		}
		if lastAudioStatsHostTime != nil {
			lastAudioStatsHostTime = now
		}
	}

	private func startWebcamPreviewOnly(config: CaptureConfig) throws {
		capturesSystemAudio = false
		capturesMicrophone = false
		writesSystemAudioToSeparateTrack = false
		writesMicrophoneToSeparateTrack = false
		capturesWebcam = true
		webcamPreviewOnly = true
		webcamTargetFPS = max(1, min(60, config.webcamFPS ?? 30))
		isPaused = false
		pauseStartedHostTime = nil
		pendingResumeAdjustment = false
		accumulatedPausedDuration = .zero
		frameCount = 0
		videoAppendedFrameCount = 0
		videoHoldFrameCount = 0
		firstSampleTime = .zero
		lastVideoPresentationTime = .zero
		lastVideoDuration = .zero
		lastInlineAudioPresentationTime = .invalid
		lastInlineAudioDuration = .zero
		lastInlineAudioHostTime = nil
		lastMicrophoneAudioPresentationTime = .invalid
		lastMicrophoneAudioDuration = .zero
		lastMicrophoneAudioHostTime = nil
		videoKeepAliveNotReadySince = nil
		videoPipelineFailureTriggered = false
		audioPipelineFailureTriggered = false
		webcamPipelineFailureTriggered = false
		inlineAudioBufferCount = 0
		microphoneAudioBufferCount = 0
		lastAudioStatsHostTime = nil
		lastAudioStatsBufferCount = 0

		try startWebcamCapture(config: config, enablePreflight: false)

		let gateOpenHostTime = CMClockGetTime(CMClockGetHostTimeClock())
		recordingStartedHostTime = gateOpenHostTime
		lastWebcamStatsHostTime = gateOpenHostTime
		sessionStarted = true
		isRecording = true
		fputs("WEBCAM_PREVIEW_ONLY_STARTED hostTime=\(CMTimeGetSeconds(gateOpenHostTime))\n", stderr)
		fflush(stderr)
		startWebcamWatchdogIfNeeded()
		print("Recording started")
		fflush(stdout)
	}

	private func startWebcamCapture(config: CaptureConfig, enablePreflight: Bool = true) throws {
		guard let webcamOutputPath = config.webcamOutputPath, !webcamOutputPath.isEmpty else {
			throw NSError(domain: "RecordlyCapture", code: 18, userInfo: [NSLocalizedDescriptionKey: "Missing webcam output path"])
		}

		guard let device = Self.resolveWebcamCaptureDevice(config: config) else {
			throw NSError(domain: "RecordlyCapture", code: 19, userInfo: [NSLocalizedDescriptionKey: "Unable to find selected webcam"])
		}

		let width = max(2, config.webcamWidth ?? 1280)
		let height = max(2, config.webcamHeight ?? 720)
		let webcamURL = URL(fileURLWithPath: webcamOutputPath)
		if let webcamPreviewPath = config.webcamPreviewPath?.trimmingCharacters(in: .whitespacesAndNewlines), !webcamPreviewPath.isEmpty {
			let previewURL = URL(fileURLWithPath: webcamPreviewPath)
			let previewURLs = Self.webcamPreviewFrameURLs(for: previewURL)
			try? FileManager.default.createDirectory(
				at: previewURL.deletingLastPathComponent(),
				withIntermediateDirectories: true
			)
			try? FileManager.default.removeItem(at: previewURL)
			for frameURL in previewURLs {
				try? FileManager.default.removeItem(at: frameURL)
			}
			webcamPreviewURLs = previewURLs
			lastWebcamPreviewHostTime = nil
			webcamPreviewFrameCount = 0
			webcamPreviewWriteInFlight = false
		} else {
			webcamPreviewURLs = []
			lastWebcamPreviewHostTime = nil
			webcamPreviewFrameCount = 0
			webcamPreviewWriteInFlight = false
		}
		let writer = try AVAssetWriter(url: webcamURL, fileType: .mp4)
		writer.movieFragmentInterval = crashRecoveryFragmentInterval

		let assistant: AVOutputSettingsAssistant?
		if width >= 3840 || height >= 2160 {
			assistant = AVOutputSettingsAssistant(preset: .preset3840x2160)
		} else if width >= 1920 || height >= 1080 {
			assistant = AVOutputSettingsAssistant(preset: .preset1920x1080)
		} else {
			assistant = AVOutputSettingsAssistant(preset: .preset1280x720)
		}

		guard let assistant = assistant else {
			throw NSError(domain: "RecordlyCapture", code: 20, userInfo: [NSLocalizedDescriptionKey: "Unable to create webcam output settings assistant"])
		}

		assistant.sourceVideoFormat = try CMVideoFormatDescription(
			videoCodecType: .h264,
			width: width,
			height: height
		)

		guard var outputSettings = assistant.videoSettings else {
			throw NSError(domain: "RecordlyCapture", code: 21, userInfo: [NSLocalizedDescriptionKey: "Webcam output settings unavailable"])
		}
		outputSettings[AVVideoWidthKey] = width
		outputSettings[AVVideoHeightKey] = height
		var compressionProperties =
			outputSettings[AVVideoCompressionPropertiesKey] as? [String: Any] ?? [:]
		let webcamBitRate = Self.webcamVideoBitRate(width: width, height: height, fps: webcamTargetFPS)
		compressionProperties[AVVideoAverageBitRateKey] = webcamBitRate
		compressionProperties[AVVideoExpectedSourceFrameRateKey] = webcamTargetFPS
		compressionProperties[AVVideoMaxKeyFrameIntervalKey] = webcamTargetFPS * 2
		compressionProperties[AVVideoAllowFrameReorderingKey] = false
		compressionProperties[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel
		outputSettings[AVVideoCompressionPropertiesKey] = compressionProperties
		fputs("WEBCAM_ENCODER_SETTINGS bitRate=\(webcamBitRate) fps=\(webcamTargetFPS) keyFrameInterval=\(webcamTargetFPS * 2)\n", stderr)
		fflush(stderr)

		let input = AVAssetWriterInput(mediaType: .video, outputSettings: outputSettings)
		input.expectsMediaDataInRealTime = true
			guard writer.canAdd(input) else {
				throw NSError(domain: "RecordlyCapture", code: 22, userInfo: [NSLocalizedDescriptionKey: "Unable to add webcam writer input"])
			}
			writer.add(input)
			let pixelBufferAdaptor = AVAssetWriterInputPixelBufferAdaptor(
				assetWriterInput: input,
				sourcePixelBufferAttributes: [
					kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
					kCVPixelBufferWidthKey as String: width,
					kCVPixelBufferHeightKey as String: height,
					kCVPixelBufferIOSurfacePropertiesKey as String: [:],
				]
			)
			guard writer.startWriting() else {
				throw NSError(domain: "RecordlyCapture", code: 23, userInfo: [NSLocalizedDescriptionKey: writer.error?.localizedDescription ?? "Unable to start webcam writing"])
			}
		writer.startSession(atSourceTime: .zero)

		let session = AVCaptureSession()
		session.beginConfiguration()
		if (width >= 3840 || height >= 2160), session.canSetSessionPreset(.hd4K3840x2160) {
			session.sessionPreset = .hd4K3840x2160
		} else if (width >= 1920 || height >= 1080), session.canSetSessionPreset(.hd1920x1080) {
			session.sessionPreset = .hd1920x1080
		} else if session.canSetSessionPreset(.hd1280x720) {
			session.sessionPreset = .hd1280x720
		}
		fputs("WEBCAM_SESSION_PRESET preset=\"\(session.sessionPreset.rawValue)\" requestedWidth=\(width) requestedHeight=\(height)\n", stderr)
		fflush(stderr)

		do {
			try device.lockForConfiguration()
			defer { device.unlockForConfiguration() }

			if let frameDuration = Self.supportedExactFrameDuration(for: device, targetFPS: webcamTargetFPS) {
				device.activeVideoMinFrameDuration = frameDuration
				device.activeVideoMaxFrameDuration = frameDuration
				fputs("WEBCAM_FRAME_DURATION_SELECTED fps=\(webcamTargetFPS) duration=\(CMTimeGetSeconds(frameDuration)) ranges=\"\(Self.sanitizeLogValue(Self.frameRateRangeSummary(device.activeFormat.videoSupportedFrameRateRanges)))\"\n", stderr)
				fflush(stderr)
			} else {
				fputs("WEBCAM_FRAME_DURATION_UNCHANGED fps=\(webcamTargetFPS) reason=no-exact-supported-endpoint ranges=\"\(Self.sanitizeLogValue(Self.frameRateRangeSummary(device.activeFormat.videoSupportedFrameRateRanges)))\"\n", stderr)
				fflush(stderr)
			}
		} catch {
			fputs("WEBCAM_FRAME_DURATION_UNCHANGED fps=\(webcamTargetFPS) reason=\"\(Self.sanitizeLogValue(error.localizedDescription))\"\n", stderr)
			fflush(stderr)
		}

		let deviceInput = try AVCaptureDeviceInput(device: device)
		guard session.canAddInput(deviceInput) else {
			throw NSError(domain: "RecordlyCapture", code: 24, userInfo: [NSLocalizedDescriptionKey: "Unable to add webcam device input"])
		}
		session.addInput(deviceInput)

		let output = AVCaptureVideoDataOutput()
		output.alwaysDiscardsLateVideoFrames = true
		output.videoSettings = [
			kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
		]
		output.setSampleBufferDelegate(self, queue: webcamQueue)
		guard session.canAddOutput(output) else {
			throw NSError(domain: "RecordlyCapture", code: 25, userInfo: [NSLocalizedDescriptionKey: "Unable to add webcam video output"])
		}
		session.addOutput(output)
		session.commitConfiguration()

			webcamOutputURL = webcamURL
			webcamWriter = writer
			webcamInput = input
			webcamPixelBufferAdaptor = pixelBufferAdaptor
			webcamSession = session
		firstWebcamSampleTime = nil
		lastWebcamPresentationTime = .zero
		lastWebcamDuration = .zero
		lastWebcamFrameHostTime = nil
		webcamInputNotReadySinceHostTime = nil
		webcamFrameCount = 0
		loggedFirstWebcamFrame = false
		loggedFirstVisibleWebcamFrame = false
		lastWebcamStatsHostTime = CMClockGetTime(CMClockGetHostTimeClock())
		lastWebcamStatsFrameCount = 0
		lastWebcamVisualSampleHostTime = nil
		lastWebcamVisualSignature = nil
		webcamVisualStableSinceHostTime = nil
		webcamVisualStallLogged = false
		resetWebcamPreflight(acceptingFrames: enablePreflight)
		session.startRunning()

		fputs("WEBCAM_CAPTURE_STARTED label=\(device.localizedName) path=\(webcamOutputPath)\n", stderr)
		fflush(stderr)
	}

	private func resetWebcamPreflight(acceptingFrames: Bool) {
		webcamPreflightCondition.lock()
		webcamPreflightAcceptingFrames = acceptingFrames
		webcamPreflightVisibleFrameReady = false
		webcamPreflightFrameCount = 0
		webcamPreflightCondition.unlock()
	}

	private func noteWebcamPreflightFrame(_ sampleBuffer: CMSampleBuffer) {
		webcamPreflightCondition.lock()
		let acceptingFrames = webcamPreflightAcceptingFrames
		webcamPreflightCondition.unlock()
		guard acceptingFrames else { return }

		guard let visibleMetrics = webcamVisibleContentMetrics(for: sampleBuffer) else {
			return
		}
		let isVisible =
			visibleMetrics.maxLuma > webcamVisibleMaxLumaThreshold ||
			visibleMetrics.averageLuma > webcamVisibleAverageLumaThreshold
		let hostTime = CMClockGetTime(CMClockGetHostTimeClock())

		webcamPreflightCondition.lock()
		webcamPreflightFrameCount += 1
		if isVisible && !webcamPreflightVisibleFrameReady {
			webcamPreflightVisibleFrameReady = true
			fputs(
				"WEBCAM_PREFLIGHT_VISIBLE_FRAME_READY frames=\(webcamPreflightFrameCount) hostTime=\(CMTimeGetSeconds(hostTime)) averageLuma=\(visibleMetrics.averageLuma) maxLuma=\(visibleMetrics.maxLuma)\n",
				stderr
			)
			fflush(stderr)
			webcamPreflightCondition.broadcast()
		}
		webcamPreflightCondition.unlock()
	}

	private func waitForWebcamPreflightVisibleFrame(timeoutSeconds: TimeInterval) -> Bool {
		let deadline = Date(timeIntervalSinceNow: timeoutSeconds)
		webcamPreflightCondition.lock()
		defer {
			webcamPreflightAcceptingFrames = false
			webcamPreflightCondition.unlock()
		}

		while webcamPreflightAcceptingFrames && !webcamPreflightVisibleFrameReady {
			if !webcamPreflightCondition.wait(until: deadline) {
				break
			}
		}
		return webcamPreflightVisibleFrameReady
	}

	private func cancelWebcamCaptureStartup() {
		webcamPreflightCondition.lock()
		webcamPreflightAcceptingFrames = false
		webcamPreflightCondition.broadcast()
		webcamPreflightCondition.unlock()

		webcamSession?.stopRunning()
		webcamSession = nil
		webcamInput?.markAsFinished()
		webcamWriter?.cancelWriting()
		webcamWriter = nil
		webcamInput = nil
		webcamPixelBufferAdaptor = nil
		webcamOutputURL = nil
		webcamPreviewURLs = []
	}

	func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
		guard sessionStarted, sampleBuffer.isValid, isRecording, !videoPipelineFailureTriggered, !audioPipelineFailureTriggered, !webcamPipelineFailureTriggered else { return }
		guard let presentationTime = adjustedPresentationTime(for: sampleBuffer, outputType: outputType) else { return }

		if outputType == .screen {
			guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
					  let attachment = attachments.first,
					  let statusRawValue = attachment[SCStreamFrameInfo.status] as? Int,
					  let status = SCFrameStatus(rawValue: statusRawValue),
					  status == .complete else {
				return
			}

			guard let videoInput = videoInput, videoInput.isReadyForMoreMediaData else { return }

			if firstSampleTime == .zero {
				firstSampleTime = sampleBuffer.presentationTimeStamp
			}

			let sampleDuration = frameDuration(for: sampleBuffer)
			let nextPresentationTime: CMTime
			if lastSampleBuffer == nil {
				nextPresentationTime = presentationTime
			} else {
				nextPresentationTime = CMTimeMaximum(presentationTime, lastVideoPresentationTime + sampleDuration)
			}

			guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
				fputs("VIDEO_SAMPLE_MISSING_PIXEL_BUFFER\n", stderr)
				fflush(stderr)
				return
			}

			if appendVideoPixelBuffer(
				pixelBuffer,
				presentationTime: nextPresentationTime,
				duration: sampleDuration,
				copyForAppend: true
			) {
				lastSampleBuffer = sampleBuffer
				lastVideoPixelBuffer = pixelBuffer
				frameCount += 1
			}
			return
		}

		if outputType == .audio {
			guard let systemAudioInput else { return }
			_ = appendAudioSampleBuffer(sampleBuffer, to: systemAudioInput, firstSampleTime: &firstSystemAudioSampleTime, presentationTime: presentationTime)
			// Also write system audio to the inline video track
			if let inlineAudioInput, inlineAudioInput.isReadyForMoreMediaData {
				_ = appendAudioSampleBuffer(sampleBuffer, to: inlineAudioInput, firstSampleTime: &firstInlineAudioSampleTime, presentationTime: presentationTime)
			}
			return
		}

		if outputType.rawValue == microphoneOutputTypeRawValue {
			var wroteMicrophoneBuffer = false
			if let microphoneOnlyInput {
				wroteMicrophoneBuffer = appendAudioSampleBuffer(sampleBuffer, to: microphoneOnlyInput, firstSampleTime: &firstMicrophoneSampleTime, presentationTime: presentationTime)
			}
			// Write mic to inline video track only if there's no system audio (avoids double-writing)
			if !capturesSystemAudio, let inlineAudioInput, inlineAudioInput.isReadyForMoreMediaData {
				let wroteInlineMicrophoneBuffer = appendAudioSampleBuffer(sampleBuffer, to: inlineAudioInput, firstSampleTime: &firstInlineAudioSampleTime, presentationTime: presentationTime)
				if !wroteMicrophoneBuffer && wroteInlineMicrophoneBuffer {
					noteMicrophoneAudioBufferWritten(sampleBuffer: sampleBuffer, presentationTime: presentationTime)
				}
			}
			if wroteMicrophoneBuffer {
				noteMicrophoneAudioBufferWritten(sampleBuffer: sampleBuffer, presentationTime: presentationTime)
			}
			return
		}

		return
	}

	func captureOutput(
		_ output: AVCaptureOutput,
		didOutput sampleBuffer: CMSampleBuffer,
		from connection: AVCaptureConnection
	) {
		guard capturesWebcam, sampleBuffer.isValid, !webcamPipelineFailureTriggered else {
			return
		}
		if !sessionStarted || !isRecording {
			noteWebcamPreflightFrame(sampleBuffer)
			return
		}
		guard !isPaused else {
			return
		}
		guard let webcamInput, let webcamPixelBufferAdaptor else { return }
		guard let webcamPixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
			triggerWebcamPipelineFailure(
				reason: "webcam-sample-missing-pixel-buffer",
				stalledFor: maxWebcamFrameGapBeforeFailure,
				hostTime: CMClockGetTime(CMClockGetHostTimeClock())
			)
			return
		}

		let sampleTime = sampleBuffer.presentationTimeStamp
		if firstWebcamSampleTime == nil {
			firstWebcamSampleTime = sampleTime
		}
		guard let firstWebcamSampleTime else { return }

		let duration = webcamFrameDuration(for: sampleBuffer)
		let relativePresentationTime = max(.zero, sampleTime - firstWebcamSampleTime - accumulatedPausedDuration)
		let presentationTime =
			lastWebcamPresentationTime == .zero
				? relativePresentationTime
				: CMTimeMaximum(relativePresentationTime, lastWebcamPresentationTime + duration)

		guard webcamInput.isReadyForMoreMediaData else {
			let now = CMClockGetTime(CMClockGetHostTimeClock())
			if webcamInputNotReadySinceHostTime == nil {
				webcamInputNotReadySinceHostTime = now
				fputs("WEBCAM_INPUT_NOT_READY hostTime=\(CMTimeGetSeconds(now))\n", stderr)
				fflush(stderr)
			}
			let notReadyDuration = now - (webcamInputNotReadySinceHostTime ?? now)
			if notReadyDuration > maxWebcamFrameGapBeforeFailure {
				triggerWebcamPipelineFailure(reason: "webcam-input-not-ready", stalledFor: notReadyDuration, hostTime: now)
			}
			return
		}
		webcamInputNotReadySinceHostTime = nil

		guard webcamWriter?.status == .writing else {
			fputs("WEBCAM_PIXEL_BUFFER_APPEND_SKIPPED writerStatus=\(webcamWriter?.status.rawValue ?? -1) \(Self.describeAssetWriterFailure(webcamWriter))\n", stderr)
			fflush(stderr)
			triggerWebcamPipelineFailure(
				reason: "webcam-writer-not-writing",
				stalledFor: maxWebcamFrameGapBeforeFailure,
				hostTime: CMClockGetTime(CMClockGetHostTimeClock())
			)
			return
		}

		guard let appendPixelBuffer = normalizedWebcamPixelBufferForAppend(
			webcamPixelBuffer,
			adaptor: webcamPixelBufferAdaptor
		) else {
			triggerWebcamPipelineFailure(reason: "webcam-pixel-buffer-copy-failed", stalledFor: maxWebcamFrameGapBeforeFailure, hostTime: CMClockGetTime(CMClockGetHostTimeClock()))
			return
		}

		if webcamPixelBufferAdaptor.append(appendPixelBuffer, withPresentationTime: presentationTime) {
			lastWebcamPresentationTime = presentationTime
			lastWebcamDuration = duration
			let hostTime = CMClockGetTime(CMClockGetHostTimeClock())
			lastWebcamFrameHostTime = hostTime
			webcamInputNotReadySinceHostTime = nil
			webcamFrameCount += 1
			if !loggedFirstWebcamFrame {
				loggedFirstWebcamFrame = true
				fputs("WEBCAM_FIRST_FRAME_WRITTEN frames=\(webcamFrameCount) pts=\(CMTimeGetSeconds(presentationTime))\n", stderr)
				fflush(stderr)
			}
			if !loggedFirstVisibleWebcamFrame,
			   let visibleMetrics = webcamVisibleContentMetrics(for: sampleBuffer),
			   (visibleMetrics.maxLuma > webcamVisibleMaxLumaThreshold ||
				visibleMetrics.averageLuma > webcamVisibleAverageLumaThreshold) {
				loggedFirstVisibleWebcamFrame = true
				fputs("WEBCAM_FIRST_VISIBLE_FRAME_WRITTEN frames=\(webcamFrameCount) pts=\(CMTimeGetSeconds(presentationTime)) averageLuma=\(visibleMetrics.averageLuma) maxLuma=\(visibleMetrics.maxLuma)\n", stderr)
				fflush(stderr)
			}
			emitWebcamCaptureStatsIfNeeded(hostTime: hostTime)
			observeWebcamVisualMotion(sampleBuffer: sampleBuffer, hostTime: hostTime)
			maybeWriteWebcamPreviewFrame(
				pixelBuffer: appendPixelBuffer,
				hostTime: hostTime,
				acceptedFrameCount: webcamFrameCount,
				presentationTime: presentationTime
			)
			return
			}

		let sourceWidth = CVPixelBufferGetWidth(webcamPixelBuffer)
		let sourceHeight = CVPixelBufferGetHeight(webcamPixelBuffer)
		let appendWidth = CVPixelBufferGetWidth(appendPixelBuffer)
		let appendHeight = CVPixelBufferGetHeight(appendPixelBuffer)
		fputs("WEBCAM_PIXEL_BUFFER_APPEND_FAILED writerStatus=\(webcamWriter?.status.rawValue ?? -1) \(Self.describeAssetWriterFailure(webcamWriter)) sourceWidth=\(sourceWidth) sourceHeight=\(sourceHeight) appendWidth=\(appendWidth) appendHeight=\(appendHeight) pts=\(CMTimeGetSeconds(presentationTime)) lastPts=\(CMTimeGetSeconds(lastWebcamPresentationTime)) duration=\(CMTimeGetSeconds(duration))\n", stderr)
		fflush(stderr)
		triggerWebcamPipelineFailure(reason: "webcam-pixel-buffer-append-failed", stalledFor: maxWebcamFrameGapBeforeFailure, hostTime: CMClockGetTime(CMClockGetHostTimeClock()))
	}

	func stream(_ stream: SCStream, didStopWithError error: Error) {
		fputs("VIDEO_STREAM_STOPPED_WITH_ERROR message=\"\(Self.sanitizeLogValue(error.localizedDescription))\"\n", stderr)
		fflush(stderr)
		let lag = currentVideoLagForFailure()
		triggerVideoPipelineFailure(reason: "screen-stream-error", lag: lag, stalledFor: lag)
	}

	private func finishCapture() async throws -> String {
		windowValidationTask?.cancel()
		windowValidationTask = nil
		videoKeepAliveTask?.cancel()
		videoKeepAliveTask = nil
		audioWatchdogTask?.cancel()
		audioWatchdogTask = nil
		webcamWatchdogTask?.cancel()
		webcamWatchdogTask = nil
		videoKeepAliveNotReadySince = nil
		videoPipelineFailureTriggered = false
		audioPipelineFailureTriggered = false
		webcamPipelineFailureTriggered = false
		trackedWindowId = nil
		let wasWebcamPreviewOnly = webcamPreviewOnly
		let finishStartedHostTime = CMClockGetTime(CMClockGetHostTimeClock())

		if let activeStream = stream {
			do {
				try await activeStream.stopCapture()
			} catch {
				// Stream may have already been stopped by the system — continue with file finalization
			}
		}
		stream = nil
		closeActivePauseIfNeeded(at: finishStartedHostTime)
		isRecording = false
		webcamSession?.stopRunning()
		webcamSession = nil

		let finalScreenPath = outputURL?.path ?? ""
		let finalWebcamPath = webcamOutputURL?.path ?? ""
		let finalWebcamFrameCount = webcamFrameCount
		let finalWebcamLastPts = lastWebcamPresentationTime
		let finalWebcamDuration = lastWebcamPresentationTime + (lastWebcamDuration.isValid ? lastWebcamDuration : .zero)
		let finalMicrophonePath = microphoneOutputURL?.path ?? ""
		let finalMicrophoneBufferCount = microphoneAudioBufferCount
		let finalMicrophoneLastPts = lastMicrophoneAudioPresentationTime
		let finalMicrophoneDuration = latestMicrophoneAudioEndTime()

		let finalVideoFrameCount = videoAppendedFrameCount
		let finalVideoHoldFrameCount = videoHoldFrameCount
		let finalVideoRealFrameCount = max(0, finalVideoFrameCount - finalVideoHoldFrameCount)
		let finalVideoLastPts = lastVideoPresentationTime

		let endTime: CMTime
		if wasWebcamPreviewOnly {
			endTime = finalWebcamDuration
		} else {
			let videoEndTime = lastVideoPresentationTime + lastVideoFrameDuration()
			let wallClockEndTime = elapsedRecordingDurationAtStop()
			if wallClockEndTime.isValid && wallClockEndTime > videoEndTime + lastVideoFrameDuration() {
				fputs("FINAL_VIDEO_KEEPALIVE_SKIPPED_AT_STOP wallClockEnd=\(CMTimeGetSeconds(wallClockEndTime)) videoEnd=\(CMTimeGetSeconds(videoEndTime)) reason=avoid-final-append-corruption\n", stderr)
				fflush(stderr)
			}
			endTime = resolvedCaptureEndTime(videoEndTime: videoEndTime)
			assetWriter?.endSession(atSourceTime: endTime)
			videoInput?.markAsFinished()
			inlineAudioInput?.markAsFinished()
			await assetWriter?.finishWriting()
		}

		systemAudioInput?.markAsFinished()
		await systemAudioWriter?.finishWriting()

		microphoneOnlyInput?.markAsFinished()
		await microphoneOnlyWriter?.finishWriting()

		webcamInput?.markAsFinished()
		await webcamWriter?.finishWriting()

		if !wasWebcamPreviewOnly {
			logVideoWriterFinalized(
				path: finalScreenPath,
				writer: assetWriter,
				frames: finalVideoFrameCount,
				realFrames: finalVideoRealFrameCount,
				holdFrames: finalVideoHoldFrameCount,
				duration: endTime,
				lastPts: finalVideoLastPts
			)
		}
		if !finalWebcamPath.isEmpty || finalWebcamFrameCount > 0 {
			logWebcamWriterFinalized(
				path: finalWebcamPath,
				writer: webcamWriter,
				frames: finalWebcamFrameCount,
				duration: finalWebcamDuration,
				lastPts: finalWebcamLastPts
			)
		}
		if writesMicrophoneToSeparateTrack || !finalMicrophonePath.isEmpty || finalMicrophoneBufferCount > 0 {
			logAudioWriterFinalized(
				eventName: "MICROPHONE_RECORDING_FINALIZED",
				path: finalMicrophonePath,
				writer: microphoneOnlyWriter,
				buffers: finalMicrophoneBufferCount,
				duration: finalMicrophoneDuration,
				lastPts: finalMicrophoneLastPts
			)
		}

		let path = finalScreenPath
			assetWriter = nil
			videoInput = nil
			systemAudioWriter = nil
			systemAudioInput = nil
			microphoneOnlyWriter = nil
			microphoneOnlyInput = nil
			webcamWriter = nil
			webcamInput = nil
			webcamPixelBufferAdaptor = nil
			webcamOutputURL = nil
		webcamPreviewURLs = []
		lastWebcamPreviewHostTime = nil
		webcamPreviewFrameCount = 0
		webcamPreviewWriteInFlight = false
		videoPixelBufferAdaptor = nil
		inlineAudioInput = nil
		outputURL = nil
		microphoneOutputURL = nil
		sessionStarted = false
		firstSampleTime = .zero
		firstSystemAudioSampleTime = nil
		firstMicrophoneSampleTime = nil
		firstInlineAudioSampleTime = nil
		lastSampleBuffer = nil
		lastVideoPixelBuffer = nil
		lastVideoPresentationTime = .zero
		lastVideoDuration = .zero
		lastInlineAudioPresentationTime = .invalid
		lastInlineAudioDuration = .zero
		lastInlineAudioHostTime = nil
		lastMicrophoneAudioPresentationTime = .invalid
		lastMicrophoneAudioDuration = .zero
		lastMicrophoneAudioHostTime = nil
		frameCount = 0
		videoAppendedFrameCount = 0
		videoHoldFrameCount = 0
		lastVideoStatsHostTime = nil
		lastVideoStatsAppendedFrameCount = 0
		inlineAudioBufferCount = 0
		microphoneAudioBufferCount = 0
		lastAudioStatsHostTime = nil
		lastAudioStatsBufferCount = 0
		videoKeepAliveTask?.cancel()
		videoKeepAliveTask = nil
		audioWatchdogTask?.cancel()
		audioWatchdogTask = nil
		webcamWatchdogTask?.cancel()
		webcamWatchdogTask = nil
		videoKeepAliveNotReadySince = nil
		videoPipelineFailureTriggered = false
		audioPipelineFailureTriggered = false
		webcamPipelineFailureTriggered = false
		isPaused = false
		pauseStartedHostTime = nil
		pendingResumeAdjustment = false
		accumulatedPausedDuration = .zero
		recordingStartedHostTime = nil
		capturesSystemAudio = false
		capturesMicrophone = false
		capturesWebcam = false
		webcamPreviewOnly = false
		screenTargetFPS = targetCaptureFPS
		writesSystemAudioToSeparateTrack = false
		writesMicrophoneToSeparateTrack = false
		firstWebcamSampleTime = nil
		lastWebcamPresentationTime = .zero
		lastWebcamDuration = .zero
		lastWebcamFrameHostTime = nil
		webcamInputNotReadySinceHostTime = nil
		webcamFrameCount = 0
		loggedFirstWebcamFrame = false
		loggedFirstVisibleWebcamFrame = false
		lastWebcamStatsHostTime = nil
		lastWebcamStatsFrameCount = 0
		lastWebcamVisualSampleHostTime = nil
		lastWebcamVisualSignature = nil
		webcamVisualStableSinceHostTime = nil
		webcamVisualStallLogged = false
		resetWebcamPreflight(acceptingFrames: false)
		return path
	}

	private func logVideoWriterFinalized(
		path: String,
		writer: AVAssetWriter?,
		frames: Int,
		realFrames: Int,
		holdFrames: Int,
		duration: CMTime,
		lastPts: CMTime
	) {
		let status = Self.assetWriterStatusName(writer)
		let durationSeconds = duration.isValid ? CMTimeGetSeconds(duration) : 0
		let lastPtsSeconds = lastPts.isValid ? CMTimeGetSeconds(lastPts) : 0
		let errorSummary = Self.assetWriterErrorSummary(writer)
		fputs(
			"VIDEO_RECORDING_FINALIZED path=\"\(Self.sanitizeLogValue(path))\" writerStatus=\(status) frames=\(frames) realFrames=\(realFrames) holdFrames=\(holdFrames) duration=\(durationSeconds) lastPts=\(lastPtsSeconds)\(errorSummary)\n",
			stderr
		)
		fflush(stderr)
	}

	private func logWebcamWriterFinalized(
		path: String,
		writer: AVAssetWriter?,
		frames: Int,
		duration: CMTime,
		lastPts: CMTime
	) {
		let status = Self.assetWriterStatusName(writer)
		let durationSeconds = duration.isValid ? CMTimeGetSeconds(duration) : 0
		let lastPtsSeconds = lastPts.isValid ? CMTimeGetSeconds(lastPts) : 0
		let errorSummary = Self.assetWriterErrorSummary(writer)
		fputs(
			"WEBCAM_RECORDING_FINALIZED path=\"\(Self.sanitizeLogValue(path))\" writerStatus=\(status) frames=\(frames) duration=\(durationSeconds) lastPts=\(lastPtsSeconds)\(errorSummary)\n",
			stderr
		)
		fflush(stderr)
	}

	private func logAudioWriterFinalized(
		eventName: String,
		path: String,
		writer: AVAssetWriter?,
		buffers: Int,
		duration: CMTime,
		lastPts: CMTime
	) {
		let status = Self.assetWriterStatusName(writer)
		let durationSeconds = duration.isValid ? CMTimeGetSeconds(duration) : 0
		let lastPtsSeconds = lastPts.isValid ? CMTimeGetSeconds(lastPts) : -1
		let errorSummary = Self.assetWriterErrorSummary(writer)
		fputs(
			"\(eventName) path=\"\(Self.sanitizeLogValue(path))\" writerStatus=\(status) buffers=\(buffers) duration=\(durationSeconds) lastPts=\(lastPtsSeconds)\(errorSummary)\n",
			stderr
		)
		fflush(stderr)
	}

	private func adjustedPresentationTime(for sampleBuffer: CMSampleBuffer, outputType: SCStreamOutputType) -> CMTime? {
		if isPaused {
			return nil
		}

		let sampleTime = sampleBuffer.presentationTimeStamp
		if pendingResumeAdjustment, let pauseStartedHostTime {
			let pauseGap = sampleTime - pauseStartedHostTime
			if pauseGap > .zero {
				accumulatedPausedDuration = accumulatedPausedDuration + pauseGap
			}
			self.pauseStartedHostTime = nil
			pendingResumeAdjustment = false
		}

		if outputType == .screen {
			if firstSampleTime == .zero {
				firstSampleTime = sampleTime
			}
		}

		// Use video's first sample time as the common time base for ALL tracks.
		// This ensures audio files contain leading silence when audio hardware
		// delivers its first sample after the first video frame (e.g. iPhone mic
		// over Continuity Camera can lag 1-2 seconds behind).
		if firstSampleTime == .zero {
			// Video hasn't started yet — drop this audio sample to avoid
			// negative timestamps.
			return nil
		}

		return max(.zero, sampleTime - firstSampleTime - accumulatedPausedDuration)
	}

	private func activePausedDuration(at hostTime: CMTime) -> CMTime {
		guard isPaused, let pauseStartedHostTime else {
			return .zero
		}

		let activePauseDuration = hostTime - pauseStartedHostTime
		return activePauseDuration > .zero ? activePauseDuration : .zero
	}

	private func closeActivePauseIfNeeded(at hostTime: CMTime) {
		let activePauseDuration = activePausedDuration(at: hostTime)
		if activePauseDuration > .zero {
			accumulatedPausedDuration = accumulatedPausedDuration + activePauseDuration
			fputs("PAUSE_CLOSED_AT_STOP duration=\(CMTimeGetSeconds(activePauseDuration)) accumulatedPaused=\(CMTimeGetSeconds(accumulatedPausedDuration))\n", stderr)
			fflush(stderr)
		}

		if isPaused || pauseStartedHostTime != nil || pendingResumeAdjustment {
			isPaused = false
			pauseStartedHostTime = nil
			pendingResumeAdjustment = false
		}
	}

	private func elapsedRecordingDurationAtStop() -> CMTime {
		guard let recordingStartedHostTime else {
			return .invalid
		}

		let now = CMClockGetTime(CMClockGetHostTimeClock())
		let elapsed = now - recordingStartedHostTime - accumulatedPausedDuration - activePausedDuration(at: now)
		return elapsed > .zero ? elapsed : .zero
	}

	private func startVideoKeepAlive() {
		videoKeepAliveTask?.cancel()
		videoKeepAliveTask = Task.detached(priority: .utility) { [weak self] in
			while !Task.isCancelled {
				try? await Task.sleep(nanoseconds: videoKeepAliveIntervalNanoseconds)
				if Task.isCancelled { return }
				self?.queue.async { [weak self] in
					self?.appendVideoKeepAliveFrameIfNeeded()
				}
			}
		}
	}

	private func startAudioWatchdogIfNeeded() {
		audioWatchdogTask?.cancel()
		guard capturesMicrophone else { return }
		audioWatchdogTask = Task.detached(priority: .utility) { [weak self] in
			while !Task.isCancelled {
				try? await Task.sleep(nanoseconds: audioWatchdogIntervalNanoseconds)
				if Task.isCancelled { return }
				self?.queue.async { [weak self] in
					self?.validateMicrophoneAudioDelivery()
				}
			}
		}
	}

	private func startWebcamWatchdogIfNeeded() {
		webcamWatchdogTask?.cancel()
		guard capturesWebcam else { return }
		webcamWatchdogTask = Task.detached(priority: .utility) { [weak self] in
			while !Task.isCancelled {
				try? await Task.sleep(nanoseconds: webcamWatchdogIntervalNanoseconds)
				if Task.isCancelled { return }
				self?.webcamQueue.async { [weak self] in
					self?.validateWebcamFrameDelivery()
				}
			}
		}
	}

	private func validateMicrophoneAudioDelivery() {
		guard capturesMicrophone, isRecording, sessionStarted, !isPaused, !audioPipelineFailureTriggered else { return }
		let now = CMClockGetTime(CMClockGetHostTimeClock())
		guard let recordingStartedHostTime else { return }
		let elapsed = now - recordingStartedHostTime - accumulatedPausedDuration

		guard microphoneAudioBufferCount > 0 else {
			if elapsed > maxMicrophoneAudioGapBeforeFailure {
				triggerAudioPipelineFailure(
					reason: "microphone-no-first-buffer",
					stalledFor: elapsed,
					audioVideoDrift: elapsed
				)
			}
			return
		}

		let microphoneAudioEnd = latestMicrophoneAudioEndTime()
		let videoEnd = lastVideoPresentationTime + lastVideoFrameDuration()
		if microphoneAudioEnd.isValid {
			let audioVideoDrift = CMTimeMaximum(.zero, videoEnd - microphoneAudioEnd)
			if audioVideoDrift > maxMicrophoneAudioGapBeforeFailure {
				triggerAudioPipelineFailure(
					reason: "microphone-audio-lagging-video",
					stalledFor: audioVideoDrift,
					audioVideoDrift: audioVideoDrift
				)
				return
			}
		}

		if let lastMicrophoneAudioHostTime {
			let staleFor = now - lastMicrophoneAudioHostTime
			if staleFor > maxMicrophoneAudioGapBeforeFailure {
				triggerAudioPipelineFailure(
					reason: "microphone-sample-callback-stale",
					stalledFor: staleFor,
					audioVideoDrift: microphoneAudioEnd.isValid ? CMTimeMaximum(.zero, videoEnd - microphoneAudioEnd) : staleFor
				)
			}
		}
	}

	private func validateWebcamFrameDelivery() {
		guard capturesWebcam, isRecording, sessionStarted, !isPaused else { return }
		let now = CMClockGetTime(CMClockGetHostTimeClock())
		guard let lastWebcamFrameHostTime else {
			guard let recordingStartedHostTime else { return }
			let startupGap = now - recordingStartedHostTime
			if startupGap > maxWebcamFrameGapBeforeFailure {
				triggerWebcamPipelineFailure(reason: "webcam-no-first-frame", stalledFor: startupGap, hostTime: now)
			}
			return
		}

		let frameGap = now - lastWebcamFrameHostTime
		if frameGap > maxWebcamFrameGapBeforeFailure {
			triggerWebcamPipelineFailure(reason: "webcam-frame-gap", stalledFor: frameGap, hostTime: now)
		}
	}

	private func triggerWebcamPipelineFailure(reason: String, stalledFor: CMTime, hostTime: CMTime) {
		guard !webcamPipelineFailureTriggered else { return }
		webcamPipelineFailureTriggered = true
		fputs("WEBCAM_PIPELINE_STALLED reason=\(reason) stalledFor=\(CMTimeGetSeconds(stalledFor)) hostTime=\(CMTimeGetSeconds(hostTime)) action=stop-recording\n", stderr)
		fflush(stderr)

		Task.detached(priority: .userInitiated) { [weak self] in
			guard let self else {
				exit(2)
			}
			do {
				let outputPath = try await self.finishCapture()
				fputs("WEBCAM_CAPTURE_DISABLED reason=\(reason) action=stopped-recording\n", stderr)
				fflush(stderr)
				print("Recording stopped. Output path: \(outputPath)")
				fflush(stdout)
				exit(0)
			} catch {
				fputs("WEBCAM_PIPELINE_STALLED_FINALIZE_FAILED reason=\(reason) error=\"\(Self.sanitizeLogValue(error.localizedDescription))\"\n", stderr)
				fflush(stderr)
				exit(2)
			}
		}
	}

		private func observeWebcamVisualMotion(sampleBuffer: CMSampleBuffer, hostTime: CMTime) {
			if let lastSample = lastWebcamVisualSampleHostTime,
			   hostTime - lastSample < webcamVisualSampleInterval {
				return
			}

		guard let signature = webcamVisualSignature(for: sampleBuffer) else {
			return
		}

		lastWebcamVisualSampleHostTime = hostTime

		if let previousSignature = lastWebcamVisualSignature {
			let meanDiff = meanSignatureDifference(previousSignature, signature)
			if meanDiff <= webcamVisualSignatureDiffThreshold {
				if webcamVisualStableSinceHostTime == nil {
					webcamVisualStableSinceHostTime = hostTime
				}

				let stalledFor = hostTime - (webcamVisualStableSinceHostTime ?? hostTime)
				if !webcamVisualStallLogged && stalledFor >= webcamVisualStallLogThreshold {
					webcamVisualStallLogged = true
					fputs("WEBCAM_VISUAL_STALL_SUSPECTED stalledFor=\(CMTimeGetSeconds(stalledFor)) meanDiff=\(meanDiff)\n", stderr)
					fflush(stderr)
				}

				if stalledFor >= webcamVisualStallFailureThreshold {
					triggerWebcamPipelineFailure(reason: "webcam-visual-stall", stalledFor: stalledFor, hostTime: hostTime)
					return
				}
			} else {
				if webcamVisualStallLogged {
					fputs("WEBCAM_VISUAL_STALL_RECOVERED meanDiff=\(meanDiff)\n", stderr)
					fflush(stderr)
				}
				webcamVisualStableSinceHostTime = nil
				webcamVisualStallLogged = false
			}
		}

			lastWebcamVisualSignature = signature
	}

	private func maybeWriteWebcamPreviewFrame(
		pixelBuffer: CVPixelBuffer,
		hostTime: CMTime,
		acceptedFrameCount: Int,
		presentationTime: CMTime
	) {
		guard !webcamPreviewURLs.isEmpty else { return }
		if let lastWebcamPreviewHostTime,
		   hostTime - lastWebcamPreviewHostTime < webcamPreviewFrameInterval {
			return
		}
		guard !webcamPreviewWriteInFlight else {
			return
		}

		guard let previewPixelBuffer = Self.copyPixelBuffer(pixelBuffer) else {
			fputs("WEBCAM_PREVIEW_FRAME_COPY_FAILED hostTime=\(CMTimeGetSeconds(hostTime)) acceptedFrame=\(acceptedFrameCount) acceptedPts=\(CMTimeGetSeconds(presentationTime))\n", stderr)
			fflush(stderr)
			return
		}

		lastWebcamPreviewHostTime = hostTime
		webcamPreviewWriteInFlight = true
		webcamPreviewFrameCount += 1
		let previewSequence = webcamPreviewFrameCount
		let webcamPreviewURL = webcamPreviewURLs[(previewSequence - 1) % webcamPreviewURLs.count]

		webcamPreviewQueue.async { [weak self, previewPixelBuffer, webcamPreviewURL] in
			guard let self else { return }
			defer {
				self.webcamQueue.async { [weak self] in
					self?.webcamPreviewWriteInFlight = false
				}
			}

			let sourceWidth = max(1, CVPixelBufferGetWidth(previewPixelBuffer))
			let sourceHeight = max(1, CVPixelBufferGetHeight(previewPixelBuffer))
			let longEdge = max(sourceWidth, sourceHeight)
			let scale = min(1.0, Double(webcamPreviewLongEdge) / Double(longEdge))
			let image = CIImage(cvPixelBuffer: previewPixelBuffer).transformed(
				by: CGAffineTransform(scaleX: scale, y: scale)
			)
			let qualityKey = CIImageRepresentationOption(
				rawValue: kCGImageDestinationLossyCompressionQuality as String
			)

			guard let jpegData = self.webcamPreviewContext.jpegRepresentation(
				of: image,
				colorSpace: CGColorSpaceCreateDeviceRGB(),
				options: [qualityKey: 0.62]
			) else {
				return
			}

			do {
				try jpegData.write(to: webcamPreviewURL, options: [])
				fputs("WEBCAM_PREVIEW_FRAME_WRITTEN path=\"\(Self.sanitizeLogValue(webcamPreviewURL.path))\" bytes=\(jpegData.count) hostTime=\(CMTimeGetSeconds(hostTime)) sequence=\(previewSequence) acceptedFrame=\(acceptedFrameCount) acceptedPts=\(CMTimeGetSeconds(presentationTime))\n", stderr)
				fflush(stderr)
			} catch {
				fputs("WEBCAM_PREVIEW_FRAME_WRITE_FAILED path=\"\(Self.sanitizeLogValue(webcamPreviewURL.path))\" error=\"\(Self.sanitizeLogValue(error.localizedDescription))\"\n", stderr)
				fflush(stderr)
			}
		}
	}

	private func webcamVisibleContentMetrics(for sampleBuffer: CMSampleBuffer) -> (averageLuma: Double, maxLuma: Int)? {
		guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
			return nil
		}

		CVPixelBufferLockBaseAddress(imageBuffer, .readOnly)
		defer { CVPixelBufferUnlockBaseAddress(imageBuffer, .readOnly) }

		guard let baseAddress = CVPixelBufferGetBaseAddress(imageBuffer) else {
			return nil
		}

		let width = CVPixelBufferGetWidth(imageBuffer)
		let height = CVPixelBufferGetHeight(imageBuffer)
		let bytesPerRow = CVPixelBufferGetBytesPerRow(imageBuffer)
		guard width > 0, height > 0, bytesPerRow > 0 else {
			return nil
		}

		let pixelBytes = baseAddress.assumingMemoryBound(to: UInt8.self)
		let pixelCount = width * height
		let step = max(1, pixelCount / 4096)
		var sampledPixels = 0
		var totalLuma = 0
		var maxLuma = 0

		var pixel = 0
		while pixel < pixelCount {
			let x = pixel % width
			let y = pixel / width
			let offset = y * bytesPerRow + x * 4
			let blue = Int(pixelBytes[offset])
			let green = Int(pixelBytes[offset + 1])
			let red = Int(pixelBytes[offset + 2])
			let luma = ((red * 54) + (green * 183) + (blue * 19)) >> 8
			totalLuma += luma
			maxLuma = max(maxLuma, luma)
			sampledPixels += 1
			pixel += step
		}

		guard sampledPixels > 0 else {
			return nil
		}

		return (averageLuma: Double(totalLuma) / Double(sampledPixels), maxLuma: maxLuma)
	}

		private func webcamVisualSignature(for sampleBuffer: CMSampleBuffer) -> [UInt8]? {
			guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
				return nil
		}

		CVPixelBufferLockBaseAddress(imageBuffer, .readOnly)
		defer { CVPixelBufferUnlockBaseAddress(imageBuffer, .readOnly) }

		guard let baseAddress = CVPixelBufferGetBaseAddress(imageBuffer) else {
			return nil
		}

		let width = CVPixelBufferGetWidth(imageBuffer)
		let height = CVPixelBufferGetHeight(imageBuffer)
		let bytesPerRow = CVPixelBufferGetBytesPerRow(imageBuffer)
		guard width > 0, height > 0, bytesPerRow > 0 else {
			return nil
		}

		let pixelBytes = baseAddress.assumingMemoryBound(to: UInt8.self)
		let grid = 8
		var signature: [UInt8] = []
		signature.reserveCapacity(grid * grid)

		for yIndex in 0..<grid {
			let y = min(height - 1, max(0, (height * (yIndex * 2 + 1)) / (grid * 2)))
			for xIndex in 0..<grid {
				let x = min(width - 1, max(0, (width * (xIndex * 2 + 1)) / (grid * 2)))
				let offset = y * bytesPerRow + x * 4
				let blue = Double(pixelBytes[offset])
				let green = Double(pixelBytes[offset + 1])
				let red = Double(pixelBytes[offset + 2])
				let luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
				signature.append(UInt8(max(0, min(255, Int(luminance.rounded())))))
			}
		}

		return signature
	}

	private func meanSignatureDifference(_ lhs: [UInt8], _ rhs: [UInt8]) -> Double {
		guard lhs.count == rhs.count, !lhs.isEmpty else {
			return Double.greatestFiniteMagnitude
		}

		var total = 0
		for index in lhs.indices {
			total += abs(Int(lhs[index]) - Int(rhs[index]))
		}
		return Double(total) / Double(lhs.count)
	}

	private func noteMicrophoneAudioBufferWritten(sampleBuffer: CMSampleBuffer, presentationTime: CMTime) {
		let now = CMClockGetTime(CMClockGetHostTimeClock())
		microphoneAudioBufferCount += 1
		lastMicrophoneAudioPresentationTime = presentationTime
		lastMicrophoneAudioDuration = sampleBuffer.duration
		lastMicrophoneAudioHostTime = now
		if microphoneAudioBufferCount == 1 {
			fputs(
				"MICROPHONE_AUDIO_FIRST_BUFFER_WRITTEN buffers=1 pts=\(CMTimeGetSeconds(presentationTime)) duration=\(CMTimeGetSeconds(sampleBuffer.duration))\n",
				stderr
			)
			fflush(stderr)
		}
		emitAudioCaptureStatsIfNeeded(hostTime: now)
	}

	private func latestMicrophoneAudioEndTime() -> CMTime {
		guard lastMicrophoneAudioPresentationTime.isValid else {
			return .invalid
		}

		if lastMicrophoneAudioDuration.isValid && lastMicrophoneAudioDuration > .zero {
			return lastMicrophoneAudioPresentationTime + lastMicrophoneAudioDuration
		}

		return lastMicrophoneAudioPresentationTime
	}

	private func emitAudioCaptureStatsIfNeeded(hostTime: CMTime) {
		guard capturesMicrophone, let recordingStartedHostTime else { return }
		let lastStatsHostTime = lastAudioStatsHostTime ?? recordingStartedHostTime
		let statsInterval = hostTime - lastStatsHostTime
		guard statsInterval >= nativeCaptureStatsInterval else { return }

		let elapsed = max(.zero, hostTime - recordingStartedHostTime - accumulatedPausedDuration)
		let elapsedSeconds = max(0.001, CMTimeGetSeconds(elapsed))
		let recentSeconds = max(0.001, CMTimeGetSeconds(statsInterval))
		let totalAudioBuffers = microphoneAudioBufferCount
		let recentBuffers = max(0, totalAudioBuffers - lastAudioStatsBufferCount)
		let recentBuffersPerSecond = Double(recentBuffers) / recentSeconds
		let totalBuffersPerSecond = Double(totalAudioBuffers) / elapsedSeconds
		let micEnd = latestMicrophoneAudioEndTime()
		let inlineEnd = latestInlineAudioEndTime()
		let videoEnd = lastVideoPresentationTime + lastVideoFrameDuration()
		let audioVideoDrift = micEnd.isValid ? CMTimeGetSeconds(CMTimeMaximum(.zero, videoEnd - micEnd)) : -1
		let micPts = lastMicrophoneAudioPresentationTime.isValid ? CMTimeGetSeconds(lastMicrophoneAudioPresentationTime) : -1
		let inlinePts = lastInlineAudioPresentationTime.isValid ? CMTimeGetSeconds(lastInlineAudioPresentationTime) : -1
		let micEndSeconds = micEnd.isValid ? CMTimeGetSeconds(micEnd) : -1
		let inlineEndSeconds = inlineEnd.isValid ? CMTimeGetSeconds(inlineEnd) : -1

		fputs(
			"AUDIO_CAPTURE_STATS microphoneBuffers=\(microphoneAudioBufferCount) inlineBuffers=\(inlineAudioBufferCount) elapsed=\(elapsedSeconds) recentBuffersPerSecond=\(recentBuffersPerSecond) totalBuffersPerSecond=\(totalBuffersPerSecond) lastMicPts=\(micPts) lastInlinePts=\(inlinePts) micEnd=\(micEndSeconds) inlineEnd=\(inlineEndSeconds) audioVideoDrift=\(audioVideoDrift)\n",
			stderr
		)
		fflush(stderr)
		self.lastAudioStatsHostTime = hostTime
		self.lastAudioStatsBufferCount = totalAudioBuffers
	}

	private func emitVideoCaptureStatsIfNeeded(hostTime: CMTime) {
		guard let recordingStartedHostTime else { return }
		let lastStatsHostTime = lastVideoStatsHostTime ?? recordingStartedHostTime
		let statsInterval = hostTime - lastStatsHostTime
		guard statsInterval >= nativeCaptureStatsInterval else { return }

		let elapsed = max(.zero, hostTime - recordingStartedHostTime - accumulatedPausedDuration)
		let elapsedSeconds = max(0.001, CMTimeGetSeconds(elapsed))
		let recentSeconds = max(0.001, CMTimeGetSeconds(statsInterval))
		let recentFrames = max(0, videoAppendedFrameCount - lastVideoStatsAppendedFrameCount)
		let recentFps = Double(recentFrames) / recentSeconds
		let totalFps = Double(videoAppendedFrameCount) / elapsedSeconds

		fputs(
			"VIDEO_CAPTURE_STATS frames=\(videoAppendedFrameCount) realFrames=\(frameCount) holdFrames=\(videoHoldFrameCount) elapsed=\(elapsedSeconds) recentFps=\(recentFps) totalFps=\(totalFps) lastPts=\(CMTimeGetSeconds(lastVideoPresentationTime))\n",
			stderr
		)
		fflush(stderr)
		self.lastVideoStatsHostTime = hostTime
		self.lastVideoStatsAppendedFrameCount = videoAppendedFrameCount
	}

	private func emitWebcamCaptureStatsIfNeeded(hostTime: CMTime) {
		guard capturesWebcam, let recordingStartedHostTime else { return }
		let lastStatsHostTime = lastWebcamStatsHostTime ?? recordingStartedHostTime
		let statsInterval = hostTime - lastStatsHostTime
		guard statsInterval >= nativeCaptureStatsInterval else { return }

		let elapsed = max(.zero, hostTime - recordingStartedHostTime - accumulatedPausedDuration)
		let elapsedSeconds = max(0.001, CMTimeGetSeconds(elapsed))
		let recentSeconds = max(0.001, CMTimeGetSeconds(statsInterval))
		let recentFrames = max(0, webcamFrameCount - lastWebcamStatsFrameCount)
		let recentFps = Double(recentFrames) / recentSeconds
		let totalFps = Double(webcamFrameCount) / elapsedSeconds

		fputs(
			"WEBCAM_CAPTURE_STATS frames=\(webcamFrameCount) elapsed=\(elapsedSeconds) recentFps=\(recentFps) totalFps=\(totalFps) lastPts=\(CMTimeGetSeconds(lastWebcamPresentationTime))\n",
			stderr
		)
		fflush(stderr)
		self.lastWebcamStatsHostTime = hostTime
		self.lastWebcamStatsFrameCount = webcamFrameCount
	}

	private func webcamFrameDuration(for sampleBuffer: CMSampleBuffer) -> CMTime {
		if sampleBuffer.duration.isValid && sampleBuffer.duration > .zero {
			return sampleBuffer.duration
		}

		if lastWebcamDuration.isValid && lastWebcamDuration > .zero {
			return lastWebcamDuration
		}

		return CMTime(value: 1, timescale: CMTimeScale(webcamTargetFPS))
	}

	private func appendVideoKeepAliveFrameIfNeeded() {
		guard isRecording, sessionStarted, !isPaused, !videoPipelineFailureTriggered, !webcamPipelineFailureTriggered else { return }
		guard let originalBuffer = lastVideoPixelBuffer, let videoInput else { return }

		let duplicateDuration = lastVideoFrameDuration()
		let currentVideoEndTime = lastVideoPresentationTime + duplicateDuration
		let elapsed = elapsedRecordingDurationAtStop()
		guard elapsed.isValid else { return }

		let lag = elapsed - currentVideoEndTime
		guard lag > duplicateDuration else {
			videoKeepAliveNotReadySince = nil
			return
		}

		guard videoInput.isReadyForMoreMediaData else {
			if videoKeepAliveNotReadySince == nil {
				videoKeepAliveNotReadySince = elapsed
			}
			let notReadyDuration = elapsed - (videoKeepAliveNotReadySince ?? elapsed)
			if lag > maxVideoKeepAliveLagBeforeFailure && notReadyDuration > maxVideoKeepAliveLagBeforeFailure {
				triggerVideoPipelineFailure(
					reason: "video-input-not-ready",
					lag: lag,
					stalledFor: notReadyDuration
				)
			}
			return
		}

		videoKeepAliveNotReadySince = nil
		let presentationTime = CMTimeMaximum(currentVideoEndTime, elapsed - duplicateDuration)
		let appended = appendVideoPixelBuffer(
			originalBuffer,
			presentationTime: presentationTime,
			duration: duplicateDuration,
			copyForAppend: true,
			countsAsHoldFrame: true
		)
		if !appended && lag > maxVideoKeepAliveLagBeforeFailure {
			triggerVideoPipelineFailure(reason: "video-keepalive-append-failed", lag: lag, stalledFor: lag)
		}
	}

	private func currentVideoLagForFailure() -> CMTime {
		let duplicateDuration = lastVideoFrameDuration()
		let currentVideoEndTime = lastVideoPresentationTime + duplicateDuration
		let elapsed = elapsedRecordingDurationAtStop()
		guard elapsed.isValid else {
			return maxVideoKeepAliveLagBeforeFailure
		}
		return CMTimeMaximum(.zero, elapsed - currentVideoEndTime)
	}

	private func triggerVideoPipelineFailure(reason: String, lag: CMTime, stalledFor: CMTime) {
		guard !videoPipelineFailureTriggered else { return }
		videoPipelineFailureTriggered = true
		fputs("VIDEO_PIPELINE_STALLED reason=\(reason) lag=\(CMTimeGetSeconds(lag)) stalledFor=\(CMTimeGetSeconds(stalledFor))\n", stderr)
		fflush(stderr)

		Task.detached(priority: .userInitiated) { [weak self] in
			guard let self else {
				exit(2)
			}
			do {
				let outputPath = try await self.finishCapture()
				print("Recording stopped. Output path: \(outputPath)")
				fflush(stdout)
				exit(0)
			} catch {
				fputs("VIDEO_PIPELINE_STALLED_FINALIZE_FAILED: \(error.localizedDescription)\n", stderr)
				fflush(stderr)
				exit(2)
			}
		}
	}

	private func triggerAudioPipelineFailure(reason: String, stalledFor: CMTime, audioVideoDrift: CMTime) {
		guard !audioPipelineFailureTriggered else { return }
		audioPipelineFailureTriggered = true
		let audioEnd = latestMicrophoneAudioEndTime()
		let videoEnd = lastVideoPresentationTime + lastVideoFrameDuration()
		let audioEndSeconds = audioEnd.isValid ? CMTimeGetSeconds(audioEnd) : -1
		let videoEndSeconds = videoEnd.isValid ? CMTimeGetSeconds(videoEnd) : -1
		fputs(
			"AUDIO_PIPELINE_STALLED reason=\(reason) stalledFor=\(CMTimeGetSeconds(stalledFor)) audioVideoDrift=\(CMTimeGetSeconds(audioVideoDrift)) audioEnd=\(audioEndSeconds) videoEnd=\(videoEndSeconds) action=stop-recording\n",
			stderr
		)
		fflush(stderr)

		Task.detached(priority: .userInitiated) { [weak self] in
			guard let self else {
				exit(2)
			}
			do {
				let outputPath = try await self.finishCapture()
				print("Recording stopped. Output path: \(outputPath)")
				fflush(stdout)
				exit(0)
			} catch {
				fputs("AUDIO_PIPELINE_STALLED_FINALIZE_FAILED: \(error.localizedDescription)\n", stderr)
				fflush(stderr)
				exit(2)
			}
		}
	}

	private func appendVideoPixelBuffer(
		_ pixelBuffer: CVPixelBuffer,
		presentationTime: CMTime,
		duration: CMTime,
		copyForAppend: Bool = false,
		countsAsHoldFrame: Bool = false
	) -> Bool {
		guard videoInput != nil, let videoPixelBufferAdaptor else { return false }
		guard assetWriter?.status == .writing else {
			fputs("VIDEO_PIXEL_BUFFER_APPEND_SKIPPED writerStatus=\(assetWriter?.status.rawValue ?? -1) \(Self.describeAssetWriterFailure(assetWriter))\n", stderr)
			fflush(stderr)
			return false
		}

		let bufferToAppend: CVPixelBuffer
		if copyForAppend {
			guard let copiedPixelBuffer = Self.copyPixelBuffer(
				pixelBuffer,
				pool: videoPixelBufferAdaptor.pixelBufferPool
			) else {
				fputs("VIDEO_PIXEL_BUFFER_COPY_FAILED\n", stderr)
				fflush(stderr)
				return false
			}
			bufferToAppend = copiedPixelBuffer
		} else {
			bufferToAppend = pixelBuffer
		}

		let appended = videoPixelBufferAdaptor.append(bufferToAppend, withPresentationTime: presentationTime)
		if appended {
			lastVideoPresentationTime = presentationTime
			lastVideoDuration = duration
			videoAppendedFrameCount += 1
			if countsAsHoldFrame {
				videoHoldFrameCount += 1
			}
			if !loggedFirstVideoFrame {
				loggedFirstVideoFrame = true
				let realVideoFramesAtAppend = max(0, videoAppendedFrameCount - videoHoldFrameCount)
				fputs("VIDEO_FIRST_FRAME_WRITTEN frames=\(videoAppendedFrameCount) realFrames=\(realVideoFramesAtAppend) holdFrames=\(videoHoldFrameCount) pts=\(CMTimeGetSeconds(presentationTime))\n", stderr)
				fflush(stderr)
			}
			emitVideoCaptureStatsIfNeeded(hostTime: CMClockGetTime(CMClockGetHostTimeClock()))
			return true
		}

		fputs("VIDEO_PIXEL_BUFFER_APPEND_FAILED writerStatus=\(assetWriter?.status.rawValue ?? -1) \(Self.describeAssetWriterFailure(assetWriter))\n", stderr)
		fflush(stderr)
		return false
	}

	private func normalizedWebcamPixelBufferForAppend(
		_ pixelBuffer: CVPixelBuffer,
		adaptor: AVAssetWriterInputPixelBufferAdaptor
	) -> CVPixelBuffer? {
		guard let pool = adaptor.pixelBufferPool else {
			return Self.copyPixelBuffer(pixelBuffer)
		}

		let sourceWidth = CVPixelBufferGetWidth(pixelBuffer)
		let sourceHeight = CVPixelBufferGetHeight(pixelBuffer)
		let sourcePixelFormat = CVPixelBufferGetPixelFormatType(pixelBuffer)
		guard sourceWidth > 0, sourceHeight > 0 else { return nil }

		var normalizedPixelBuffer: CVPixelBuffer?
		let status = CVPixelBufferPoolCreatePixelBuffer(
			kCFAllocatorDefault,
			pool,
			&normalizedPixelBuffer
		)
		guard status == kCVReturnSuccess, let normalizedPixelBuffer else {
			return nil
		}

		let targetWidth = CVPixelBufferGetWidth(normalizedPixelBuffer)
		let targetHeight = CVPixelBufferGetHeight(normalizedPixelBuffer)
		let targetPixelFormat = CVPixelBufferGetPixelFormatType(normalizedPixelBuffer)
		guard targetWidth > 0, targetHeight > 0 else { return nil }

		if sourceWidth == targetWidth,
		   sourceHeight == targetHeight,
		   sourcePixelFormat == targetPixelFormat {
			CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
			CVPixelBufferLockBaseAddress(normalizedPixelBuffer, [])
			defer {
				CVPixelBufferUnlockBaseAddress(normalizedPixelBuffer, [])
				CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly)
			}

			guard
				let sourceBaseAddress = CVPixelBufferGetBaseAddress(pixelBuffer),
				let destinationBaseAddress = CVPixelBufferGetBaseAddress(normalizedPixelBuffer)
			else {
				return nil
			}

			let sourceBytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
			let destinationBytesPerRow = CVPixelBufferGetBytesPerRow(normalizedPixelBuffer)
			let bytesPerRow = min(sourceBytesPerRow, destinationBytesPerRow)
			for row in 0..<sourceHeight {
				memcpy(
					destinationBaseAddress.advanced(by: row * destinationBytesPerRow),
					sourceBaseAddress.advanced(by: row * sourceBytesPerRow),
					bytesPerRow
				)
			}
			return normalizedPixelBuffer
		}

		let sourceImage = CIImage(cvPixelBuffer: pixelBuffer)
		let sourceExtent = sourceImage.extent
		guard sourceExtent.width > 0, sourceExtent.height > 0 else { return nil }

		let targetRect = CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight)
		let scale = max(
			targetRect.width / sourceExtent.width,
			targetRect.height / sourceExtent.height
		)
		let scaledWidth = sourceExtent.width * scale
		let scaledHeight = sourceExtent.height * scale
		let translateX = (targetRect.width - scaledWidth) / 2 - (sourceExtent.minX * scale)
		let translateY = (targetRect.height - scaledHeight) / 2 - (sourceExtent.minY * scale)
		let transform = CGAffineTransform(a: scale, b: 0, c: 0, d: scale, tx: translateX, ty: translateY)
		let normalizedImage = sourceImage.transformed(by: transform)

		webcamPreviewContext.render(
			normalizedImage,
			to: normalizedPixelBuffer,
			bounds: targetRect,
			colorSpace: CGColorSpaceCreateDeviceRGB()
		)
		return normalizedPixelBuffer
	}

	private static func copyPixelBuffer(
		_ pixelBuffer: CVPixelBuffer,
		pool: CVPixelBufferPool? = nil
	) -> CVPixelBuffer? {
		let width = CVPixelBufferGetWidth(pixelBuffer)
		let height = CVPixelBufferGetHeight(pixelBuffer)
		let pixelFormat = CVPixelBufferGetPixelFormatType(pixelBuffer)
		guard width > 0, height > 0 else { return nil }

		var copiedPixelBuffer: CVPixelBuffer?
		let status: CVReturn
		if let pool {
			status = CVPixelBufferPoolCreatePixelBuffer(
				kCFAllocatorDefault,
				pool,
				&copiedPixelBuffer
			)
		} else {
			let attributes: [String: Any] = [
				kCVPixelBufferPixelFormatTypeKey as String: pixelFormat,
				kCVPixelBufferWidthKey as String: width,
				kCVPixelBufferHeightKey as String: height,
				kCVPixelBufferIOSurfacePropertiesKey as String: [:],
			]
			status = CVPixelBufferCreate(
				kCFAllocatorDefault,
				width,
				height,
				pixelFormat,
				attributes as CFDictionary,
				&copiedPixelBuffer
			)
		}
		guard status == kCVReturnSuccess, let copiedPixelBuffer else {
			return nil
		}

		CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
		CVPixelBufferLockBaseAddress(copiedPixelBuffer, [])
		defer {
			CVPixelBufferUnlockBaseAddress(copiedPixelBuffer, [])
			CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly)
		}

		guard
			let sourceBaseAddress = CVPixelBufferGetBaseAddress(pixelBuffer),
			let destinationBaseAddress = CVPixelBufferGetBaseAddress(copiedPixelBuffer)
		else {
			return nil
		}

		let sourceBytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
		let destinationBytesPerRow = CVPixelBufferGetBytesPerRow(copiedPixelBuffer)
		let bytesPerRow = min(sourceBytesPerRow, destinationBytesPerRow)
		for row in 0..<height {
			memcpy(
				destinationBaseAddress.advanced(by: row * destinationBytesPerRow),
				sourceBaseAddress.advanced(by: row * sourceBytesPerRow),
				bytesPerRow
			)
		}

		return copiedPixelBuffer
	}

	private func frameDuration(for sampleBuffer: CMSampleBuffer) -> CMTime {
		if sampleBuffer.duration.isValid && sampleBuffer.duration > .zero {
			return sampleBuffer.duration
		}

		return lastVideoFrameDuration()
	}

	private func lastVideoFrameDuration() -> CMTime {
		if lastVideoDuration.isValid && lastVideoDuration > .zero {
			return lastVideoDuration
		}

		return CMTime(value: 1, timescale: CMTimeScale(screenTargetFPS))
	}

	private static func describeAssetWriterFailure(_ writer: AVAssetWriter?) -> String {
		guard let writer else {
			return "writerStatus=missing"
		}
		guard let error = writer.error as NSError? else {
			return "error=none"
		}

		return "errorDomain=\(error.domain) errorCode=\(error.code) errorDescription=\(error.localizedDescription)"
	}

	private static func assetWriterStatusName(_ writer: AVAssetWriter?) -> String {
		guard let writer else {
			return "missing"
		}
		switch writer.status {
		case .unknown:
			return "unknown"
		case .writing:
			return "writing"
		case .completed:
			return "completed"
		case .failed:
			return "failed"
		case .cancelled:
			return "cancelled"
		@unknown default:
			return "unknown-\(writer.status.rawValue)"
		}
	}

	private static func assetWriterErrorSummary(_ writer: AVAssetWriter?) -> String {
		guard let error = writer?.error as NSError? else {
			return ""
		}

		return " errorDomain=\"\(sanitizeLogValue(error.domain))\" errorCode=\(error.code) errorDescription=\"\(sanitizeLogValue(error.localizedDescription))\""
	}

	private static func sanitizeLogValue(_ value: String) -> String {
		value
			.replacingOccurrences(of: "\\", with: "\\\\")
			.replacingOccurrences(of: "\"", with: "'")
			.replacingOccurrences(of: "\r", with: " ")
			.replacingOccurrences(of: "\n", with: " ")
	}

	private static func supportedExactFrameDuration(for device: AVCaptureDevice, targetFPS: Int) -> CMTime? {
		let targetFrameRate = Double(targetFPS)
		let tolerance = 0.1
		let ranges = device.activeFormat.videoSupportedFrameRateRanges
		guard !ranges.isEmpty else {
			return nil
		}

		if let fixedRange = ranges.first(where: {
			abs($0.minFrameRate - targetFrameRate) <= tolerance && abs($0.maxFrameRate - targetFrameRate) <= tolerance
		}) {
			return validFrameDuration(fixedRange.minFrameDuration) ?? validFrameDuration(fixedRange.maxFrameDuration)
		}

		if let maxEndpointRange = ranges.first(where: { abs($0.maxFrameRate - targetFrameRate) <= tolerance }) {
			return validFrameDuration(maxEndpointRange.minFrameDuration)
		}

		if let minEndpointRange = ranges.first(where: { abs($0.minFrameRate - targetFrameRate) <= tolerance }) {
			return validFrameDuration(minEndpointRange.maxFrameDuration)
		}

		return nil
	}

	private static func validFrameDuration(_ duration: CMTime) -> CMTime? {
		duration.isValid && duration > .zero ? duration : nil
	}

	private static func frameRateRangeSummary(_ ranges: [AVFrameRateRange]) -> String {
		ranges
			.map { range in
				return String(
					format: "%.2f-%.2f minDuration=%.9f maxDuration=%.9f",
					range.minFrameRate,
					range.maxFrameRate,
					CMTimeGetSeconds(range.minFrameDuration),
					CMTimeGetSeconds(range.maxFrameDuration)
				)
			}
			.joined(separator: "; ")
	}

	private static func webcamPreviewFrameURLs(for baseURL: URL) -> [URL] {
		let directory = baseURL.deletingLastPathComponent()
		let stem = baseURL.deletingPathExtension().lastPathComponent
		let fileExtension = baseURL.pathExtension.isEmpty ? "jpg" : baseURL.pathExtension

		return (0..<webcamPreviewRingSize).map { index in
			directory
				.appendingPathComponent("\(stem)-\(index)")
				.appendingPathExtension(fileExtension)
		}
	}

	private func latestInlineAudioEndTime() -> CMTime {
		guard lastInlineAudioPresentationTime.isValid else {
			return .invalid
		}

		if lastInlineAudioDuration.isValid && lastInlineAudioDuration > .zero {
			return lastInlineAudioPresentationTime + lastInlineAudioDuration
		}

		return lastInlineAudioPresentationTime
	}

	private func resolvedCaptureEndTime(videoEndTime: CMTime) -> CMTime {
		let inlineAudioEndTime = latestInlineAudioEndTime()
		guard inlineAudioEndTime.isValid else {
			return videoEndTime
		}

		if CMTimeCompare(inlineAudioEndTime, videoEndTime) <= 0 {
			return videoEndTime
		}

		// Prevent a stray inline-audio timestamp from forcing finishWriting
		// to finalize an arbitrarily long tail.
		let tailExtension = CMTimeSubtract(inlineAudioEndTime, videoEndTime)
		return videoEndTime + CMTimeMinimum(tailExtension, maxInlineAudioTailExtension)
	}

	private func appendAudioSampleBuffer(_ sampleBuffer: CMSampleBuffer, to input: AVAssetWriterInput, firstSampleTime: inout CMTime?, presentationTime: CMTime) -> Bool {
		guard input.isReadyForMoreMediaData else { return false }

		if firstSampleTime == nil {
			firstSampleTime = presentationTime
		}

		// presentationTime is already relative to the video's first frame
		// (computed by adjustedPresentationTime), so use it directly.
		let timing = CMSampleTimingInfo(duration: sampleBuffer.duration, presentationTimeStamp: presentationTime, decodeTimeStamp: sampleBuffer.decodeTimeStamp)
		if let retimedSampleBuffer = try? CMSampleBuffer(copying: sampleBuffer, withNewTiming: [timing]) {
			let appended = input.append(retimedSampleBuffer)
			if appended, input === inlineAudioInput {
				lastInlineAudioPresentationTime = presentationTime
				lastInlineAudioDuration = sampleBuffer.duration
				lastInlineAudioHostTime = CMClockGetTime(CMClockGetHostTimeClock())
				inlineAudioBufferCount += 1
			}
			return appended
		}
		return false
	}

	private static func audioOutputSettings(bitRate: Int) -> [String: Any] {
		[
			AVFormatIDKey: kAudioFormatMPEG4AAC,
			AVSampleRateKey: 48_000,
			AVNumberOfChannelsKey: 2,
			AVEncoderBitRateKey: bitRate,
		]
	}

	private static func screenVideoBitRate(width: Int, height: Int, fps: Int) -> Int {
		let rawBitRate = width * height * max(1, fps) / 7
		return min(maxNativeScreenVideoBitRate, max(minNativeScreenVideoBitRate, rawBitRate))
	}

	private static func webcamVideoBitRate(width: Int, height: Int, fps: Int) -> Int {
		let rawBitRate = width * height * max(1, fps) / 7
		return min(maxNativeWebcamVideoBitRate, max(minNativeWebcamVideoBitRate, rawBitRate))
	}

	private static func stableScreenOutputDimensions(
		sourceWidth: Int,
		sourceHeight: Int
	) -> (width: Int, height: Int, scale: Double, wasCapped: Bool) {
		let safeSourceWidth = max(2, sourceWidth)
		let safeSourceHeight = max(2, sourceHeight)
		let sourcePixels = safeSourceWidth * safeSourceHeight
		let sourceLongEdge = max(safeSourceWidth, safeSourceHeight)
		var scale = 1.0

		if sourcePixels > maxScreenOutputPixels {
			scale = min(scale, sqrt(Double(maxScreenOutputPixels) / Double(sourcePixels)))
		}

		if sourceLongEdge > maxScreenOutputLongEdge {
			scale = min(scale, Double(maxScreenOutputLongEdge) / Double(sourceLongEdge))
		}

		if scale >= 0.999 {
			let nativeWidth = makeEncoderDimension(safeSourceWidth)
			let nativeHeight = makeEncoderDimension(safeSourceHeight)
			return (
				nativeWidth,
				nativeHeight,
				1.0,
				nativeWidth != safeSourceWidth || nativeHeight != safeSourceHeight
			)
		}

		let scaledWidth = makeEncoderDimension(Int((Double(safeSourceWidth) * scale).rounded()))
		let scaledHeight = makeEncoderDimension(Int((Double(safeSourceHeight) * scale).rounded()))
		return (max(2, scaledWidth), max(2, scaledHeight), scale, true)
	}

	private static func makeEncoderDimension(_ value: Int) -> Int {
		let safeValue = max(2, value)
		let remainder = safeValue % screenEncoderDimensionMultiple
		let aligned = remainder == 0 ? safeValue : safeValue - remainder
		return max(screenEncoderDimensionMultiple, aligned)
	}

	private static func resolveMicrophoneCaptureDeviceID(config: CaptureConfig) -> String? {
		let audioDevices = AVCaptureDevice.devices(for: .audio)
		let requestedLabel = config.microphoneLabel?.trimmingCharacters(in: .whitespacesAndNewlines)
		let requestedDeviceId = config.microphoneDeviceId?.trimmingCharacters(in: .whitespacesAndNewlines)

		if let microphoneDeviceId = requestedDeviceId, !microphoneDeviceId.isEmpty {
			if audioDevices.contains(where: { $0.uniqueID == microphoneDeviceId }) {
				return microphoneDeviceId
			}
		}

		if let microphoneLabel = requestedLabel, !microphoneLabel.isEmpty {
			if let matchedDevice = audioDevices.first(where: { $0.localizedName == microphoneLabel }) {
				return matchedDevice.uniqueID
			}

			let normalizedLabel = normalizeDeviceLabel(microphoneLabel)
			if let matchedDevice = audioDevices.first(where: { normalizeDeviceLabel($0.localizedName) == normalizedLabel }) {
				return matchedDevice.uniqueID
			}
		}

		return nil
	}

	private static func audioDeviceSummary(_ devices: [AVCaptureDevice]) -> String {
		devices
			.map { "\($0.localizedName) [\($0.uniqueID)]" }
			.joined(separator: ", ")
	}

	private static func resolveWebcamCaptureDevice(config: CaptureConfig) -> AVCaptureDevice? {
		let videoDevices = AVCaptureDevice.devices(for: .video)
		let requestedLabel = config.webcamLabel?.trimmingCharacters(in: .whitespacesAndNewlines)
		let requestedDeviceId = config.webcamDeviceId?.trimmingCharacters(in: .whitespacesAndNewlines)

		if let webcamDeviceId = requestedDeviceId, !webcamDeviceId.isEmpty {
			if let matchedDevice = videoDevices.first(where: { $0.uniqueID == webcamDeviceId }) {
				return matchedDevice
			}
		}

		if let webcamLabel = requestedLabel, !webcamLabel.isEmpty {
			if let matchedDevice = videoDevices.first(where: { $0.localizedName == webcamLabel }) {
				return matchedDevice
			}

			let normalizedLabel = normalizeDeviceLabel(webcamLabel)
			if let matchedDevice = videoDevices.first(where: { normalizeDeviceLabel($0.localizedName) == normalizedLabel }) {
				return matchedDevice
			}
		}

		if (requestedLabel?.isEmpty == false) || (requestedDeviceId?.isEmpty == false) {
			fputs(
				"WEBCAM_DEVICE_NOT_FOUND requestedLabel=\"\(sanitizeLogValue(requestedLabel ?? ""))\" requestedDeviceId=\"\(sanitizeLogValue(requestedDeviceId ?? ""))\" available=\"\(sanitizeLogValue(webcamDeviceSummary(videoDevices)))\"\n",
				stderr
			)
			fflush(stderr)
			return nil
		}

		return AVCaptureDevice.default(for: .video)
	}

	private static func webcamDeviceSummary(_ devices: [AVCaptureDevice]) -> String {
		devices
			.map { "\($0.localizedName) [\($0.uniqueID)]" }
			.joined(separator: ", ")
	}

	private static func normalizeDeviceLabel(_ label: String) -> String {
		label
			.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
			.replacingOccurrences(of: "\\s+\\([^)]*\\)\\s*$", with: "", options: .regularExpression)
			.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
			.trimmingCharacters(in: .whitespacesAndNewlines)
	}

	private func supportsNativeMicrophoneCapture(streamConfig: SCStreamConfiguration) -> Bool {
		let supportsConfigSelector = streamConfig.responds(to: Selector(("setCaptureMicrophone:")))
		let supportsDeviceSelector = streamConfig.responds(to: Selector(("setMicrophoneCaptureDeviceID:")))
		let supportsOutputType = SCStreamOutputType(rawValue: microphoneOutputTypeRawValue) != nil
		return supportsConfigSelector && supportsDeviceSelector && supportsOutputType
	}

	private func startWindowValidationIfNeeded() {
		guard let trackedWindowId else {
			windowValidationTask?.cancel()
			windowValidationTask = nil
			return
		}

		windowValidationTask?.cancel()
		windowValidationTask = Task.detached(priority: .utility) { [weak self] in
			guard let self else { return }
			while !Task.isCancelled {
				try? await Task.sleep(nanoseconds: 500_000_000)
				if Task.isCancelled { return }
				guard self.isRecording else { return }

				do {
					let availableContent = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
					let windowStillAvailable = availableContent.windows.contains(where: { $0.windowID == trackedWindowId })
					if !windowStillAvailable {
						print("WINDOW_UNAVAILABLE")
						fflush(stdout)
						let outputPath = try await self.finishCapture()
						print("Recording stopped. Output path: \(outputPath)")
						fflush(stdout)
						exit(0)
					}
				} catch {
					continue
				}
			}
		}
	}

	private static func scaleFactor(for displayId: CGDirectDisplayID) -> Int {
		guard let mode = CGDisplayCopyDisplayMode(displayId) else {
			return 1
		}
		return max(1, mode.pixelWidth / max(1, mode.width))
	}
}

final class RecorderService {
	private let recorder = ScreenCaptureRecorder()
	private let queue = DispatchQueue(label: "recordly.screencapturekit.commands")
	private let completionGroup = DispatchGroup()

	func start(configJSON: String) {
		completionGroup.enter()
		queue.async {
			Task {
				do {
					try await self.recorder.startCapture(configJSON: configJSON)
				} catch {
					fputs("Error starting capture: \(error.localizedDescription)\n", stderr)
					fflush(stderr)
					exit(2)
				}
			}
		}
	}

	func stop() {
		queue.async {
			Task {
				do {
					let outputPath = try await self.recorder.stopCapture()
					print("Recording stopped. Output path: \(outputPath)")
					fflush(stdout)
					self.completionGroup.leave()
				} catch {
					fputs("Error stopping capture: \(error.localizedDescription)\n", stderr)
					fflush(stderr)
					exit(2)
				}
			}
		}
	}

	func pause() {
		queue.async {
			self.recorder.pauseCapture()
		}
	}

	func resume() {
		queue.async {
			self.recorder.resumeCapture()
		}
	}

	func waitUntilFinished() {
		completionGroup.wait()
	}
}

if CommandLine.arguments.dropFirst().first == "--list-audio-devices" {
	let devices = AVCaptureDevice.devices(for: .audio).map {
		ListedAudioDevice(
			label: $0.localizedName,
			uniqueId: $0.uniqueID,
			modelId: $0.modelID,
			connected: $0.isConnected
		)
	}
	do {
		let data = try JSONEncoder().encode(devices)
		if let json = String(data: data, encoding: .utf8) {
			print(json)
			fflush(stdout)
		}
		exit(0)
	} catch {
		fputs("AUDIO_DEVICE_LIST_FAILED \(error.localizedDescription)\n", stderr)
		fflush(stderr)
		exit(2)
	}
}

guard CommandLine.arguments.count >= 2 else {
	fputs("Missing config JSON\n", stderr)
	fflush(stderr)
	exit(1)
}

// Force CoreGraphics Services initialization on the main thread.
// Without this, SCContentFilter(desktopIndependentWindow:) crashes with
// CGS_REQUIRE_INIT because CGS is never initialised in a CLI tool.
let _ = CGMainDisplayID()
let configData = CommandLine.arguments[1].data(using: .utf8)
let launchConfig = configData.flatMap { try? JSONDecoder().decode(CaptureConfig.self, from: $0) }
let isWebcamPreviewOnlyLaunch = launchConfig?.webcamPreviewOnly == true

// Pre-flight check: ensure screen recording permission is granted before
// attempting capture. On macOS 15+, a one-session grant may expire after the
// parent app restarts.  CGRequestScreenCaptureAccess() will trigger the
// system-level permission dialog (or open System Settings) when not yet granted.
if !isWebcamPreviewOnlyLaunch && !CGPreflightScreenCaptureAccess() {
	let granted = CGRequestScreenCaptureAccess()
	if !granted {
		fputs("SCREEN_RECORDING_PERMISSION_DENIED\n", stderr)
		fflush(stderr)
		exit(1)
	}
}

// Pre-flight check for microphone access when mic capture is requested.
if launchConfig?.capturesMicrophone == true {
	switch AVCaptureDevice.authorizationStatus(for: .audio) {
	case .authorized:
		break
	case .notDetermined:
		let sem = DispatchSemaphore(value: 0)
		AVCaptureDevice.requestAccess(for: .audio) { _ in sem.signal() }
		sem.wait()
		if AVCaptureDevice.authorizationStatus(for: .audio) != .authorized {
			fputs("MICROPHONE_PERMISSION_DENIED\n", stderr)
			fflush(stderr)
			exit(1)
		}
	default:
		fputs("MICROPHONE_PERMISSION_DENIED\n", stderr)
		fflush(stderr)
		exit(1)
	}
}

// Pre-flight check for camera access when native webcam capture is requested.
if launchConfig?.capturesWebcam == true || isWebcamPreviewOnlyLaunch {
	switch AVCaptureDevice.authorizationStatus(for: .video) {
	case .authorized:
		break
	case .notDetermined:
		let sem = DispatchSemaphore(value: 0)
		AVCaptureDevice.requestAccess(for: .video) { _ in sem.signal() }
		sem.wait()
		if AVCaptureDevice.authorizationStatus(for: .video) != .authorized {
			fputs("CAMERA_PERMISSION_DENIED\n", stderr)
			fflush(stderr)
			exit(1)
		}
	default:
		fputs("CAMERA_PERMISSION_DENIED\n", stderr)
		fflush(stderr)
		exit(1)
	}
}

let service = RecorderService()
service.start(configJSON: CommandLine.arguments[1])

DispatchQueue.global(qos: .utility).async {
	while let input = readLine(strippingNewline: true)?.lowercased() {
		if input == "pause" {
			service.pause()
			continue
		}

		if input == "resume" {
			service.resume()
			continue
		}

		if input == "stop" {
			service.stop()
			break
		}
	}
}

service.waitUntilFinished()
