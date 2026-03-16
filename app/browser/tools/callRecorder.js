/**
 * Call Recorder Browser Tool
 *
 * Intercepts WebRTC streams to capture both local (microphone) and remote
 * (incoming) audio during Teams calls. Records to raw PCM and sends chunks
 * to the main process via IPC for WAV file writing.
 *
 * When mode is "video" or "both", also captures remote video tracks and
 * composites them onto a canvas in a grid layout. Uses MediaRecorder to
 * produce WebM (VP8+Opus) sent via IPC. Supports multiple participants.
 *
 * Activated automatically when a call connects if callRecording.enabled is true.
 */

const LOG_PREFIX = '[CALL_RECORDER]';

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
let remoteVideoTracks = new Map(); // index -> { track, videoElement }
let compositeCanvas = null;
let compositeCtx = null;
let renderIntervalId = null;
let canvasStream = null;
let combinedStream = null;
let nextTrackIndex = 0;

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
 * Register a remote video track for compositing.
 */
function addRemoteVideoTrack(track) {
  // Avoid duplicates
  for (const [, entry] of remoteVideoTracks) {
    if (entry.track === track) return;
  }

  const index = nextTrackIndex++;
  const videoElement = createVideoElement(track);
  remoteVideoTracks.set(index, { track, videoElement });

  track.addEventListener('ended', () => {
    removeRemoteVideoTrack(index);
  });

  console.debug(`${LOG_PREFIX} Added remote video track (total: ${remoteVideoTracks.size})`);

  // If recording is active but video recording hasn't started yet, start it
  if (isRecording && shouldRecordVideo() && !mediaRecorder) {
    startVideoRecording();
  }
}

/**
 * Deregister a remote video track and clean up its video element.
 */
function removeRemoteVideoTrack(index) {
  const entry = remoteVideoTracks.get(index);
  if (!entry) return;

  removeVideoElement(entry.videoElement);
  remoteVideoTracks.delete(index);

  console.debug(`${LOG_PREFIX} Removed remote video track (total: ${remoteVideoTracks.size})`);

  // If all tracks are gone, stop video recording
  if (remoteVideoTracks.size === 0 && mediaRecorder) {
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
 * Render all video tracks onto the canvas in a grid layout.
 */
function renderFrame() {
  if (!compositeCtx) return;

  const entries = Array.from(remoteVideoTracks.values());
  const count = entries.length;

  // Clear to black
  compositeCtx.fillStyle = '#000000';
  compositeCtx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  if (count === 0) return;

  const { cols, rows } = calculateGrid(count);
  const cellWidth = CANVAS_WIDTH / cols;
  const cellHeight = CANVAS_HEIGHT / rows;

  for (let i = 0; i < entries.length; i++) {
    const { videoElement } = entries[i];

    // Skip if video isn't ready yet
    if (videoElement.readyState < 2) continue;

    const col = i % cols;
    const row = Math.floor(i / cols);
    const cellX = col * cellWidth;
    const cellY = row * cellHeight;

    // Scale to fit while maintaining aspect ratio
    const videoWidth = videoElement.videoWidth || cellWidth;
    const videoHeight = videoElement.videoHeight || cellHeight;
    const videoAspect = videoWidth / videoHeight;
    const cellAspect = cellWidth / cellHeight;

    let drawWidth, drawHeight, drawX, drawY;
    if (videoAspect > cellAspect) {
      drawWidth = cellWidth;
      drawHeight = cellWidth / videoAspect;
      drawX = cellX;
      drawY = cellY + (cellHeight - drawHeight) / 2;
    } else {
      drawHeight = cellHeight;
      drawWidth = cellHeight * videoAspect;
      drawX = cellX + (cellWidth - drawWidth) / 2;
      drawY = cellY;
    }

    compositeCtx.drawImage(videoElement, drawX, drawY, drawWidth, drawHeight);
  }
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

    // Connect any already-captured streams
    for (const src of connectedSources) {
      connectStreamToMixer(src.stream, src.label);
    }

    // Start video recording if remote video tracks are already available
    if (shouldRecordVideo() && remoteVideoTracks.size > 0) {
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

    // Clean up all remote video tracks and their video elements
    for (const [, entry] of remoteVideoTracks) {
      removeVideoElement(entry.videoElement);
    }
    remoteVideoTracks.clear();
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

    if (ipcRendererRef && shouldRecordAudio()) {
      ipcRendererRef.send('call-recording-stop');
    }

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
  if (remoteVideoTracks.size === 0) {
    console.debug(`${LOG_PREFIX} No active remote video tracks available`);
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

    console.info(`${LOG_PREFIX} Video recording started (${remoteVideoTracks.size} tracks)`);
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
      ipcRendererRef.send('call-video-recording-stop');
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
 * Patch RTCPeerConnection to intercept remote audio and video tracks.
 */
function patchRTCPeerConnection() {
  const OriginalRTCPeerConnection = globalThis.RTCPeerConnection;
  if (!OriginalRTCPeerConnection) {
    console.warn(`${LOG_PREFIX} RTCPeerConnection not available`);
    return;
  }

  globalThis.RTCPeerConnection = function (...args) {
    const pc = new OriginalRTCPeerConnection(...args);

    pc.addEventListener('track', (event) => {
      if (event.track.kind === 'audio' && event.streams.length > 0) {
        const remoteStream = event.streams[0];
        // Store for later if recording hasn't started yet
        connectedSources.push({ stream: remoteStream, node: null, label: 'remote' });

        if (isRecording) {
          connectStreamToMixer(remoteStream, 'remote');
        }
      }

      if (event.track.kind === 'video' && event.streams.length > 0) {
        addRemoteVideoTrack(event.track);
      }
    });

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

  console.debug(`${LOG_PREFIX} Patched RTCPeerConnection for remote audio/video capture`);
}

/**
 * Patch getUserMedia to intercept local microphone stream.
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
