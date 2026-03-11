/**
 * Call Recorder Browser Tool
 *
 * Intercepts WebRTC streams to capture both local (microphone) and remote
 * (incoming) audio during Teams calls. Records to raw PCM and sends chunks
 * to the main process via IPC for WAV file writing.
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
  console.info(`${LOG_PREFIX} Initialized - auto-recording enabled`);
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
    audioContext = new AudioContext({ sampleRate });
    mixedDestination = audioContext.createMediaStreamDestination();

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

    isRecording = true;

    if (ipcRendererRef) {
      ipcRendererRef.send('call-recording-start', { sampleRate, channels: 1 });
    }

    // Connect any already-captured streams
    for (const src of connectedSources) {
      connectStreamToMixer(src.stream, src.label);
    }

    console.info(`${LOG_PREFIX} Recording started`);
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

    if (ipcRendererRef) {
      ipcRendererRef.send('call-recording-stop');
    }

    console.info(`${LOG_PREFIX} Recording stopped`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Error stopping recording:`, error.message);
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
 * Patch RTCPeerConnection to intercept remote audio tracks.
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

  console.debug(`${LOG_PREFIX} Patched RTCPeerConnection for remote audio capture`);
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
