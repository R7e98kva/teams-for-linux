/**
 * Call Recorder Browser Tool
 *
 * Intercepts WebRTC streams to capture both local (microphone) and remote
 * (incoming) audio during Teams calls. Records to raw PCM and sends chunks
 * to the main process via IPC for WAV file writing.
 *
 * When mode is "video" or "both", captures all video sources:
 * - Remote participant video tracks (via RTCPeerConnection ontrack)
 * - Local outgoing video (via RTCPeerConnection addTrack - includes Teams
 *   background filters/effects)
 *
 * All sources are composited onto a canvas. Screen shares are detected at
 * render time by resolution (>=1600px wide) and given 2/3 of the canvas.
 *
 * Activated automatically when a call connects if callRecording.enabled is true.
 */

const LOG_PREFIX = '[CALL_RECORDER]';

// Minimum video width to be considered a screen share rather than a camera
const SCREEN_SHARE_MIN_WIDTH = 1600;

let ipcRendererRef = null;
let config = null;
let isRecording = false;
let audioContext = null;
let mixedDestination = null;
let scriptProcessor = null;
let connectedSources = [];
let sampleRate = 44100;

// Video compositing state
const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const RENDER_INTERVAL_MS = 33; // ~30fps

let mediaRecorder = null;
let videoTracks = new Map(); // index -> { track, videoElement, source }
let compositeCanvas = null;
let compositeCtx = null;
let renderIntervalId = null;
let canvasStream = null;
let combinedStream = null;
let nextTrackIndex = 0;

// Call metadata for file naming
let callStartTime = null;

/**
 * Initialize the call recorder tool
 * @param {object} cfg - Application configuration
 * @param {object} ipcRenderer - Electron IPC renderer
 */
function init(cfg, ipcRenderer) {
  config = cfg;
  ipcRendererRef = ipcRenderer;

  const recordingConfig = config?.callRecording;
  if (!recordingConfig?.enabled) {
    return;
  }

  patchRTCPeerConnection();
  patchGetUserMedia();
  console.info(`${LOG_PREFIX} Initialized - auto-recording enabled (mode: ${recordingConfig.mode || 'audio'})`);
}

/**
 * Check if video recording is enabled by config mode.
 */
function shouldRecordVideo() {
  const mode = config?.callRecording?.mode || 'audio';
  return mode === 'video' || mode === 'both';
}

/**
 * Check if audio-only WAV recording is enabled by config mode.
 */
function shouldRecordAudio() {
  const mode = config?.callRecording?.mode || 'audio';
  return mode === 'audio' || mode === 'both';
}

/**
 * Calculate grid dimensions for participant count.
 * @param {number} count - Number of video tracks
 * @returns {{ cols: number, rows: number }}
 */
function calculateGrid(count) {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  return { cols, rows };
}

/**
 * Create a hidden video element to decode a video track's frames.
 */
function createVideoElement(track) {
  const video = document.createElement('video');
  video.srcObject = new MediaStream([track]);
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.style.position = 'fixed';
  video.style.top = '-9999px';
  video.style.width = '1px';
  video.style.height = '1px';
  document.body.appendChild(video);
  video.play().catch(() => {});
  return video;
}

/**
 * Clean up a video element.
 */
function removeVideoElement(videoElement) {
  try {
    videoElement.pause();
    videoElement.srcObject = null;
    videoElement.remove();
  } catch {
    // Element may already be removed
  }
}

/**
 * Add a video track for compositing.
 * @param {MediaStreamTrack} track
 * @param {string} source - "remote", "local-camera", or "local-screenshare"
 */
function addVideoTrack(track, source) {
  // Avoid duplicates
  for (const [, entry] of videoTracks) {
    if (entry.track === track) return;
  }

  const index = nextTrackIndex++;
  const videoElement = createVideoElement(track);
  videoTracks.set(index, { track, videoElement, source });

  track.addEventListener('ended', () => {
    removeVideoTrack(index);
  });

  console.debug(`${LOG_PREFIX} Added ${source} video track (total: ${videoTracks.size})`);

  // If recording is active but video recording hasn't started yet, start it
  if (isRecording && shouldRecordVideo() && !mediaRecorder) {
    startVideoRecording();
  }
}

/**
 * Remove a video track and clean up its video element.
 */
function removeVideoTrack(index) {
  const entry = videoTracks.get(index);
  if (!entry) return;

  removeVideoElement(entry.videoElement);
  videoTracks.delete(index);

  console.debug(`${LOG_PREFIX} Removed video track (total: ${videoTracks.size})`);

  if (videoTracks.size === 0 && mediaRecorder) {
    stopVideoRecording();
  }
}

/**
 * Start the canvas rendering loop using setInterval.
 * Uses setInterval instead of requestAnimationFrame so rendering
 * continues when the window is hidden (e.g. Hyprland workspace switch).
 */
function startRenderLoop() {
  if (renderIntervalId !== null) return;

  compositeCanvas = document.createElement('canvas');
  compositeCanvas.width = CANVAS_WIDTH;
  compositeCanvas.height = CANVAS_HEIGHT;
  compositeCtx = compositeCanvas.getContext('2d');

  renderIntervalId = setInterval(renderFrame, RENDER_INTERVAL_MS);
}

/**
 * Stop the canvas rendering loop.
 */
function stopRenderLoop() {
  if (renderIntervalId !== null) {
    clearInterval(renderIntervalId);
    renderIntervalId = null;
  }
  compositeCanvas = null;
  compositeCtx = null;
}

/**
 * Draw a video element scaled to fit within a rectangle, preserving aspect ratio.
 */
function drawVideoFit(videoElement, x, y, width, height) {
  if (!videoElement || videoElement.readyState < 2) return;

  const videoWidth = videoElement.videoWidth || width;
  const videoHeight = videoElement.videoHeight || height;
  const videoAspect = videoWidth / videoHeight;
  const cellAspect = width / height;

  let drawWidth, drawHeight, drawX, drawY;
  if (videoAspect > cellAspect) {
    drawWidth = width;
    drawHeight = width / videoAspect;
    drawX = x;
    drawY = y + (height - drawHeight) / 2;
  } else {
    drawHeight = height;
    drawWidth = height * videoAspect;
    drawX = x + (width - drawWidth) / 2;
    drawY = y;
  }

  compositeCtx.drawImage(videoElement, drawX, drawY, drawWidth, drawHeight);
}

/**
 * Check if a video element is a screen share based on its resolution.
 * Screen shares are typically 1600px+ wide, cameras are 640-1280px.
 */
function isScreenShare(videoElement) {
  return videoElement.readyState >= 2 && videoElement.videoWidth >= SCREEN_SHARE_MIN_WIDTH;
}

/**
 * Render all video tracks onto the canvas.
 *
 * At render time, detects screen shares by resolution (>=1600px wide).
 * Screen shares get 2/3 of the canvas, participants get the right 1/3.
 *
 * Layout when screen sharing is active:
 * +--------------------+---------+
 * |                    | Part 1  |
 * |   Screen Share     +---------+
 * |   (left 2/3)       | Part 2  |
 * |                    +---------+
 * |                    | Part 3  |
 * +--------------------+---------+
 *
 * Layout when no screen share:
 * Standard grid of all video feeds
 */
function renderFrame() {
  if (!compositeCtx) return;

  // Clear to black
  compositeCtx.fillStyle = '#000000';
  compositeCtx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  // Separate screen shares from camera feeds by resolution
  const screenShares = [];
  const cameras = [];

  for (const entry of videoTracks.values()) {
    if (isScreenShare(entry.videoElement)) {
      screenShares.push(entry.videoElement);
    } else {
      cameras.push(entry.videoElement);
    }
  }

  if (screenShares.length > 0) {
    // Screen share layout: screen share(s) on left 2/3, cameras on right 1/3
    const shareWidth = Math.round(CANVAS_WIDTH * 2 / 3);
    const sideWidth = CANVAS_WIDTH - shareWidth;

    // Draw screen share(s) on the left — stack if multiple
    const shareHeight = CANVAS_HEIGHT / screenShares.length;
    for (let i = 0; i < screenShares.length; i++) {
      drawVideoFit(screenShares[i], 0, i * shareHeight, shareWidth, shareHeight);
    }

    // Draw camera feeds stacked on the right
    if (cameras.length > 0) {
      const cellHeight = CANVAS_HEIGHT / cameras.length;
      for (let i = 0; i < cameras.length; i++) {
        drawVideoFit(cameras[i], shareWidth, i * cellHeight, sideWidth, cellHeight);
      }
    }
  } else {
    // No screen share — standard grid of all feeds
    if (cameras.length === 0) return;

    const { cols, rows } = calculateGrid(cameras.length);
    const cellWidth = CANVAS_WIDTH / cols;
    const cellHeight = CANVAS_HEIGHT / rows;

    for (let i = 0; i < cameras.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      drawVideoFit(cameras[i], col * cellWidth, row * cellHeight, cellWidth, cellHeight);
    }
  }
}

/**
 * Extract meeting/call metadata from the Teams DOM.
 *
 * For planned meetings: extracts the meeting title from the call header.
 * For ad-hoc calls: extracts participant forenames from the roster or video tiles.
 *
 * @returns {{ meetingName: string|null, participants: string[] }}
 */
function extractCallMetadata() {
  let meetingName = null;
  const participants = [];

  try {
    // Try to get meeting title from the call header area.
    // Teams shows the meeting title in various elements depending on version.
    const titleSelectors = [
      '[data-tid="call-title"]',
      '[data-tid="meeting-title"]',
      '.calling-header .title',
      '.meeting-header .title',
      '[data-tid="call-composite"] [class*="title"]',
      '[class*="callingHeader"] [class*="title"]',
      '[class*="meetingTitle"]',
    ];

    for (const selector of titleSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        const text = el.textContent?.trim();
        if (text && text.length > 0 && text.length < 200) {
          meetingName = text;
          break;
        }
      }
    }

    // Extract participant names from the roster or video tile labels
    const nameSelectors = [
      '[data-tid="roster-participant"] [class*="name"]',
      '[data-tid="participantList"] [class*="name"]',
      '[class*="participantItem"] [class*="displayName"]',
      '[data-tid="video-tile"] [class*="displayName"]',
      '[class*="videoGallery"] [class*="displayName"]',
      '[class*="callingParticipant"] [class*="name"]',
    ];

    const nameSet = new Set();
    for (const selector of nameSelectors) {
      for (const el of document.querySelectorAll(selector)) {
        const text = el.textContent?.trim();
        if (text && text.length > 0 && text.length < 100) {
          // Extract forename (first word)
          const forename = text.split(/\s+/)[0];
          if (forename) {
            nameSet.add(forename);
          }
        }
      }
      if (nameSet.size > 0) break;
    }

    participants.push(...nameSet);
  } catch (error) {
    console.debug(`${LOG_PREFIX} Failed to extract call metadata:`, error.message);
  }

  return { meetingName, participants };
}

/**
 * Start recording audio streams.
 * Called when a call connects.
 */
function startRecording() {
  if (isRecording || !config?.callRecording?.enabled) {
    return;
  }

  try {
    // Always initialize AudioContext and mixer — needed for both audio WAV
    // pipeline and as the audio source for MediaRecorder in video mode
    audioContext = new AudioContext({ sampleRate });
    mixedDestination = audioContext.createMediaStreamDestination();

    if (shouldRecordAudio()) {
      // Buffer size 4096, mono input, mono output
      scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
      mixedDestination.stream.getAudioTracks().forEach(track => {
        const source = audioContext.createMediaStreamSource(
          new MediaStream([track])
        );
        source.connect(scriptProcessor);
      });

      scriptProcessor.connect(audioContext.destination);

      scriptProcessor.onaudioprocess = (event) => {
        if (!isRecording) return;
        const inputData = event.inputBuffer.getChannelData(0);
        // Convert Float32 to Int16 PCM
        const pcm16 = float32ToInt16(inputData);
        if (ipcRendererRef) {
          ipcRendererRef.send('call-recording-chunk', Array.from(pcm16));
        }
      };

      if (ipcRendererRef) {
        ipcRendererRef.send('call-recording-start', { sampleRate, channels: 1 });
      }
    }

    isRecording = true;
    callStartTime = new Date();

    // Connect any already-captured streams
    for (const src of connectedSources) {
      connectStreamToMixer(src.stream, src.label);
    }

    // Start video recording if any video sources are already available
    if (shouldRecordVideo() && videoTracks.size > 0) {
      startVideoRecording();
    }

    console.info(`${LOG_PREFIX} Recording started (mode: ${config?.callRecording?.mode || 'audio'})`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to start recording:`, error.message);
  }
}

/**
 * Stop recording and finalize the file.
 * Called when a call disconnects.
 */
function stopRecording() {
  if (!isRecording) {
    return;
  }

  isRecording = false;

  try {
    // Stop video recording first
    stopVideoRecording();

    // Clean up all video tracks and their video elements
    for (const [, entry] of videoTracks) {
      removeVideoElement(entry.videoElement);
    }
    videoTracks.clear();
    nextTrackIndex = 0;

    if (scriptProcessor) {
      scriptProcessor.disconnect();
      scriptProcessor = null;
    }

    for (const src of connectedSources) {
      try {
        src.node?.disconnect();
      } catch {
        // Source may already be disconnected
      }
    }
    connectedSources = [];

    if (audioContext && audioContext.state !== 'closed') {
      audioContext.close().catch(() => {});
    }
    audioContext = null;
    mixedDestination = null;

    // Extract call metadata for file naming before sending stop signals
    const metadata = extractCallMetadata();
    const callInfo = {
      startTime: callStartTime?.toISOString() || null,
      meetingName: metadata.meetingName,
      participants: metadata.participants,
    };

    if (ipcRendererRef && shouldRecordAudio()) {
      ipcRendererRef.send('call-recording-stop', callInfo);
    }

    callStartTime = null;

    console.info(`${LOG_PREFIX} Recording stopped`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Error stopping recording:`, error.message);
  }
}

/**
 * Start video recording using MediaRecorder with canvas compositing + mixed audio.
 */
function startVideoRecording() {
  if (mediaRecorder) {
    console.debug(`${LOG_PREFIX} Video recording already active`);
    return;
  }
  if (videoTracks.size === 0) {
    console.debug(`${LOG_PREFIX} No active video sources available`);
    return;
  }

  try {
    // Start the canvas rendering loop
    startRenderLoop();

    // Capture the canvas as a video stream at 30fps
    canvasStream = compositeCanvas.captureStream(30);

    // Build combined stream: canvas video + mixed audio
    const tracks = [...canvasStream.getVideoTracks()];

    if (mixedDestination) {
      const audioTracks = mixedDestination.stream.getAudioTracks();
      if (audioTracks.length > 0) {
        tracks.push(audioTracks[0]);
      }
    }

    combinedStream = new MediaStream(tracks);

    const mimeType = 'video/webm;codecs=vp8,opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      console.error(`${LOG_PREFIX} MediaRecorder does not support ${mimeType}`);
      stopRenderLoop();
      return;
    }

    mediaRecorder = new MediaRecorder(combinedStream, {
      mimeType,
      videoBitsPerSecond: 1_500_000,
    });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0 && ipcRendererRef) {
        event.data.arrayBuffer().then(buffer => {
          ipcRendererRef.send('call-video-recording-chunk', Array.from(new Uint8Array(buffer)));
        }).catch(error => {
          console.error(`${LOG_PREFIX} Failed to process video chunk:`, error.message);
        });
      }
    };

    mediaRecorder.onerror = (event) => {
      console.error(`${LOG_PREFIX} MediaRecorder error:`, event.error?.message);
    };

    mediaRecorder.onstop = () => {
      console.debug(`${LOG_PREFIX} MediaRecorder stopped`);
    };

    // Request data every 1 second
    mediaRecorder.start(1000);

    if (ipcRendererRef) {
      ipcRendererRef.send('call-video-recording-start', { mimeType });
    }

    console.info(`${LOG_PREFIX} Video recording started (${videoTracks.size} sources)`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to start video recording:`, error.message);
    stopRenderLoop();
  }
}

/**
 * Stop video recording and finalize the WebM file.
 */
function stopVideoRecording() {
  if (!mediaRecorder) {
    return;
  }

  try {
    if (mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    mediaRecorder = null;
    combinedStream = null;
    canvasStream = null;

    // Stop the rendering loop
    stopRenderLoop();

    if (ipcRendererRef) {
      const metadata = extractCallMetadata();
      ipcRendererRef.send('call-video-recording-stop', {
        startTime: callStartTime?.toISOString() || null,
        meetingName: metadata.meetingName,
        participants: metadata.participants,
      });
    }

    console.info(`${LOG_PREFIX} Video recording stopped`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Error stopping video recording:`, error.message);
  }
}

/**
 * Connect a MediaStream to the audio mixer for recording.
 */
function connectStreamToMixer(stream, label) {
  if (!audioContext || !mixedDestination) {
    return;
  }

  try {
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(mixedDestination);

    connectedSources.push({ stream, node: source, label });
    console.debug(`${LOG_PREFIX} Connected ${label} audio stream to mixer`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to connect stream:`, error.message);
  }
}

/**
 * Patch RTCPeerConnection to intercept remote and local video tracks.
 *
 * - Remote tracks: captured via 'track' event (incoming from other participants)
 * - Local tracks: captured via addTrack() (outgoing, with Teams filters applied)
 */
function patchRTCPeerConnection() {
  const OriginalRTCPeerConnection = globalThis.RTCPeerConnection;
  if (!OriginalRTCPeerConnection) {
    console.warn(`${LOG_PREFIX} RTCPeerConnection not available`);
    return;
  }

  globalThis.RTCPeerConnection = function (...args) {
    const pc = new OriginalRTCPeerConnection(...args);

    // Capture incoming remote tracks
    pc.addEventListener('track', (event) => {
      if (event.track.kind === 'audio' && event.streams.length > 0) {
        const remoteStream = event.streams[0];
        connectedSources.push({ stream: remoteStream, node: null, label: 'remote' });

        if (isRecording) {
          connectStreamToMixer(remoteStream, 'remote');
        }
      }

      if (event.track.kind === 'video' && event.streams.length > 0) {
        addVideoTrack(event.track, 'remote');
      }
    });

    // Capture outgoing local video tracks (camera with filters, screen share)
    // These have Teams background effects already applied.
    const originalAddTrack = pc.addTrack.bind(pc);
    pc.addTrack = function (track, ...streams) {
      if (track.kind === 'video' && shouldRecordVideo()) {
        addVideoTrack(track, 'local');
        console.debug(`${LOG_PREFIX} Captured local outgoing video track`);
      }
      return originalAddTrack(track, ...streams);
    };

    return pc;
  };

  // Copy static properties and prototype
  globalThis.RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
  Object.keys(OriginalRTCPeerConnection).forEach(key => {
    try {
      globalThis.RTCPeerConnection[key] = OriginalRTCPeerConnection[key];
    } catch {
      // Some static properties may not be configurable
    }
  });

  console.debug(`${LOG_PREFIX} Patched RTCPeerConnection for remote/local video capture`);
}

/**
 * Patch getUserMedia to intercept local microphone stream.
 * Video is NOT captured here — we capture it from RTCPeerConnection.addTrack()
 * instead, which has Teams background filters/effects already applied.
 */
function patchGetUserMedia() {
  if (!navigator.mediaDevices?.getUserMedia) {
    return;
  }

  const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getUserMedia = async function (constraints) {
    const stream = await originalGetUserMedia(constraints);

    if (constraints?.audio) {
      connectedSources.push({ stream, node: null, label: 'local-mic' });

      if (isRecording) {
        connectStreamToMixer(stream, 'local-mic');
      }
    }

    return stream;
  };

  console.debug(`${LOG_PREFIX} Patched getUserMedia for local audio capture`);
}

/**
 * Convert Float32Array PCM samples to Int16Array.
 */
function float32ToInt16(float32Array) {
  const int16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return int16;
}

module.exports = { init, startRecording, stopRecording };
