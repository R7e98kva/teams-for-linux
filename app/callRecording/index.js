const { ipcMain, app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const LOG_PREFIX = '[CALL_RECORDING]';

class CallRecordingManager {
  #config;
  #outputDir;
  #writeStream;
  #sampleRate;
  #channels;
  #dataSize;
  #currentFilePath;
  #videoWriteStream;
  #currentVideoFilePath;
  #videoRecordingStartTime;

  constructor(config) {
    this.#config = config;
    this.#writeStream = null;
    this.#sampleRate = 44100;
    this.#channels = 1;
    this.#dataSize = 0;
    this.#currentFilePath = null;
    this.#videoWriteStream = null;
    this.#currentVideoFilePath = null;
    this.#videoRecordingStartTime = null;

    const configDir = config?.callRecording?.outputDirectory;
    this.#outputDir = configDir || path.join(app.getPath('documents'), 'TeamsRecordings');
  }

  /**
   * Register IPC handlers for call recording events.
   */
  registerHandlers() {
    if (!this.#config?.callRecording?.enabled) {
      return;
    }

    this.#ensureOutputDirectory();

    // Receive recording start signal with audio parameters
    ipcMain.on('call-recording-start', (_event, params) => {
      this.#handleRecordingStart(params);
    });

    // Receive PCM audio chunks from renderer
    ipcMain.on('call-recording-chunk', (_event, pcmData) => {
      this.#handleAudioChunk(pcmData);
    });

    // Receive recording stop signal with optional call metadata for file naming
    ipcMain.on('call-recording-stop', (_event, callInfo) => {
      this.#handleRecordingStop(callInfo);
    });

    // Receive video recording start signal with format parameters
    ipcMain.on('call-video-recording-start', (_event, _params) => {
      this.#handleVideoRecordingStart();
    });

    // Receive encoded WebM video+audio chunks from renderer
    ipcMain.on('call-video-recording-chunk', (_event, data) => {
      this.#handleVideoChunk(data);
    });

    // Receive video recording stop signal with optional call metadata for file naming
    ipcMain.on('call-video-recording-stop', (_event, callInfo) => {
      this.#handleVideoRecordingStop(callInfo);
    });

    console.info(`${LOG_PREFIX} Handlers registered, output directory: ${this.#outputDir}`);
  }

  /**
   * Build a descriptive filename based on call metadata.
   * Planned meetings: yyyy-mm-dd_hh-mm_conferenceName.ext
   * Ad-hoc calls: yyyy-mm-dd_hh-mm_participant1-participant2.ext
   * Fallback: teams-call-timestamp.ext
   *
   * @param {object} callInfo - { startTime, meetingName, participants }
   * @param {string} ext - File extension (e.g. "wav", "webm")
   * @returns {string} filename
   */
  #buildFilename(callInfo, ext) {
    const startDate = callInfo?.startTime ? new Date(callInfo.startTime) : new Date();
    const datePart = startDate.toISOString().slice(0, 10); // yyyy-mm-dd
    const hours = String(startDate.getHours()).padStart(2, '0');
    const minutes = String(startDate.getMinutes()).padStart(2, '0');
    const timePart = `${hours}-${minutes}`;

    let namePart = null;

    if (callInfo?.meetingName) {
      namePart = this.#sanitizeFilename(callInfo.meetingName);
    } else if (callInfo?.participants?.length > 0) {
      namePart = callInfo.participants
        .map(name => this.#sanitizeFilename(name))
        .filter(name => name.length > 0)
        .join('-');
    }

    if (namePart) {
      return `${datePart}_${timePart}_${namePart}.${ext}`;
    }

    // Fallback to timestamp-based name
    const timestamp = startDate.toISOString().replaceAll(/[:.]/g, '-');
    return `teams-call-${timestamp}.${ext}`;
  }

  /**
   * Sanitize a string for use in a filename.
   * Removes characters that are invalid in filenames across platforms.
   */
  #sanitizeFilename(name) {
    return name
      .replaceAll(/[/\\:*?"<>|]/g, '')
      .replaceAll(/\s+/g, '_')
      .slice(0, 100)
      .trim();
  }

  /**
   * Rename a recording file using call metadata.
   * @param {string} currentPath - Current file path
   * @param {object} callInfo - Call metadata
   * @param {string} ext - File extension
   * @returns {string} New file path (or original if rename failed)
   */
  #renameWithMetadata(currentPath, callInfo, ext) {
    if (!currentPath || !callInfo) return currentPath;

    const newFilename = this.#buildFilename(callInfo, ext);
    const newPath = path.join(this.#outputDir, newFilename);

    // Don't rename if already has the right name, or target exists
    if (newPath === currentPath || fs.existsSync(newPath)) {
      return currentPath;
    }

    try {
      fs.renameSync(currentPath, newPath);
      console.info(`${LOG_PREFIX} Renamed recording: ${newFilename}`);
      return newPath;
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to rename recording:`, error.message);
      return currentPath;
    }
  }

  #ensureOutputDirectory() {
    try {
      if (!fs.existsSync(this.#outputDir)) {
        fs.mkdirSync(this.#outputDir, { recursive: true });
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to create output directory:`, error.message);
    }
  }

  #handleRecordingStart(params) {
    if (this.#writeStream) {
      this.#handleRecordingStop();
    }

    this.#sampleRate = params?.sampleRate || 44100;
    this.#channels = params?.channels || 1;
    this.#dataSize = 0;

    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
    const filename = `teams-call-${timestamp}.wav`;
    this.#currentFilePath = path.join(this.#outputDir, filename);

    try {
      this.#writeStream = fs.createWriteStream(this.#currentFilePath);
      // Write a placeholder WAV header (44 bytes), will be updated on stop
      this.#writeStream.write(this.#createWavHeader(0));
      console.info(`${LOG_PREFIX} Recording to file: ${filename}`);
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to create recording file:`, error.message);
      this.#writeStream = null;
    }
  }

  #handleAudioChunk(pcmData) {
    if (!this.#writeStream) {
      return;
    }

    try {
      // pcmData arrives as a Uint8Array of raw Int16 PCM bytes
      const buffer = Buffer.from(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength);
      this.#writeStream.write(buffer);
      this.#dataSize += buffer.length;
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to write audio chunk:`, error.message);
    }
  }

  #handleRecordingStop(callInfo) {
    if (!this.#writeStream) {
      return;
    }

    const filePath = this.#currentFilePath;

    try {
      this.#writeStream.end(() => {
        this.#updateWavHeader();
        const finalPath = this.#renameWithMetadata(filePath, callInfo, 'wav');
        this.#currentFilePath = finalPath;
        console.info(`${LOG_PREFIX} Recording saved: ${finalPath}`);
      });
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to finalize recording:`, error.message);
    }

    this.#writeStream = null;
  }

  #handleVideoRecordingStart() {
    if (this.#videoWriteStream) {
      this.#handleVideoRecordingStop();
    }

    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
    const filename = `teams-call-${timestamp}.webm`;
    this.#currentVideoFilePath = path.join(this.#outputDir, filename);

    try {
      this.#videoWriteStream = fs.createWriteStream(this.#currentVideoFilePath);
      this.#videoRecordingStartTime = Date.now();
      console.info(`${LOG_PREFIX} Video recording to file: ${filename}`);
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to create video recording file:`, error.message);
      this.#videoWriteStream = null;
    }
  }

  #handleVideoChunk(data) {
    if (!this.#videoWriteStream) {
      return;
    }

    try {
      // data arrives as a Uint8Array of raw WebM bytes
      const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      this.#videoWriteStream.write(buffer);
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to write video chunk:`, error.message);
    }
  }

  #handleVideoRecordingStop(callInfo) {
    if (!this.#videoWriteStream) {
      return;
    }

    const durationMs = this.#videoRecordingStartTime
      ? Date.now() - this.#videoRecordingStartTime
      : 0;
    const videoFilePath = this.#currentVideoFilePath;

    try {
      this.#videoWriteStream.end(() => {
        if (durationMs > 0) {
          this.#updateWebMDuration(videoFilePath, durationMs);
        }
        const finalPath = this.#renameWithMetadata(videoFilePath, callInfo, 'webm');
        this.#currentVideoFilePath = finalPath;
        console.info(`${LOG_PREFIX} Video recording saved: ${finalPath}`);
      });
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to finalize video recording:`, error.message);
    }

    this.#videoWriteStream = null;
    this.#videoRecordingStartTime = null;
  }

  /**
   * Parse an EBML VINT (variable-size integer) from a buffer at a given offset.
   * Returns { value, width } where width is the number of bytes consumed.
   */
  #parseVint(buf, offset) {
    const firstByte = buf[offset];
    let width = 0;
    for (let bit = 7; bit >= 0; bit--) {
      if (firstByte & (1 << bit)) {
        width = 8 - bit;
        break;
      }
    }
    if (width === 0) return { value: 0, width: 1 };

    // Mask off the VINT marker bit from the first byte
    let value = firstByte & ((1 << (8 - width)) - 1);
    for (let b = 1; b < width; b++) {
      value = (value * 256) + buf[offset + b];
    }
    return { value, width };
  }

  /**
   * Write a 7-byte big-endian value into an 8-byte VINT buffer (0x01 prefix).
   */
  #writeSegmentSizeVint(size) {
    const buf = Buffer.alloc(8);
    buf[0] = 0x01;
    let remaining = BigInt(size);
    for (let b = 7; b >= 1; b--) {
      buf[b] = Number(remaining & 0xFFn);
      remaining >>= 8n;
    }
    return buf;
  }

  /**
   * Update the WebM Segment size and Duration element after recording.
   * Chrome's MediaRecorder writes Segment with "unknown" size and may omit
   * the Duration element entirely. This method handles both updating an
   * existing Duration and inserting one if missing.
   */
  #updateWebMDuration(filePath, durationMs) {
    try {
      const fileData = fs.readFileSync(filePath);
      const len = fileData.length;

      // 1. Find Segment element (ID: 0x18 0x53 0x80 0x67)
      let segPos = -1;
      for (let i = 0; i < Math.min(len, 64) - 4; i++) {
        if (fileData[i] === 0x18 && fileData[i + 1] === 0x53
          && fileData[i + 2] === 0x80 && fileData[i + 3] === 0x67) {
          segPos = i;
          break;
        }
      }
      if (segPos === -1) {
        console.warn(`${LOG_PREFIX} WebM Segment element not found`);
        return;
      }

      const segSizeVint = this.#parseVint(fileData, segPos + 4);
      const segDataStart = segPos + 4 + segSizeVint.width;

      // 2. Find Info element (ID: 0x15 0x49 0xA9 0x66) inside Segment
      let infoPos = -1;
      const searchEnd = Math.min(len, 65536);
      for (let i = segDataStart; i < searchEnd - 4; i++) {
        if (fileData[i] === 0x15 && fileData[i + 1] === 0x49
          && fileData[i + 2] === 0xA9 && fileData[i + 3] === 0x66) {
          infoPos = i;
          break;
        }
      }
      if (infoPos === -1) {
        console.warn(`${LOG_PREFIX} WebM Info element not found`);
        return;
      }

      const infoSizeVint = this.#parseVint(fileData, infoPos + 4);
      const infoDataStart = infoPos + 4 + infoSizeVint.width;
      const infoDataEnd = infoDataStart + infoSizeVint.value;

      // 3. Search for existing Duration element (ID: 0x44 0x89) inside Info
      let durationFound = false;
      for (let i = infoDataStart; i < infoDataEnd - 3; i++) {
        if (fileData[i] === 0x44 && fileData[i + 1] === 0x89) {
          const durSizeVint = this.#parseVint(fileData, i + 2);
          if (durSizeVint.value === 8 || durSizeVint.value === 4) {
            const dataPos = i + 2 + durSizeVint.width;
            const durBuf = Buffer.alloc(durSizeVint.value);
            if (durSizeVint.value === 8) {
              durBuf.writeDoubleBE(durationMs, 0);
            } else {
              durBuf.writeFloatBE(durationMs, 0);
            }
            durBuf.copy(fileData, dataPos);
            durationFound = true;
            console.debug(`${LOG_PREFIX} WebM Duration element updated in-place`);
          }
          break;
        }
      }

      let outputData = fileData;

      if (!durationFound) {
        // 4. Insert Duration element at the end of Info data
        // Duration element: 0x44 0x89 (ID) + 0x88 (VINT size=8) + 8 bytes float64 = 11 bytes
        const durElement = Buffer.alloc(11);
        durElement[0] = 0x44;
        durElement[1] = 0x89;
        durElement[2] = 0x88;
        durElement.writeDoubleBE(durationMs, 3);

        // Rebuild: [before insertion point] + [duration element] + [rest of file]
        const before = fileData.subarray(0, infoDataEnd);
        const after = fileData.subarray(infoDataEnd);
        outputData = Buffer.concat([before, durElement, after]);

        // 5. Update Info element size (add 11 bytes)
        const newInfoSize = infoSizeVint.value + 11;
        // Rewrite the Info size VINT in the same width
        const infoSizePos = infoPos + 4;
        const newInfoSizeVint = this.#encodeVint(newInfoSize, infoSizeVint.width);
        newInfoSizeVint.copy(outputData, infoSizePos);

        console.debug(`${LOG_PREFIX} WebM Duration element inserted`);
      }

      // 6. Update Segment size to actual data size
      const newSegDataSize = outputData.length - segDataStart;
      const newSegSizeVint = this.#writeSegmentSizeVint(newSegDataSize);
      newSegSizeVint.copy(outputData, segPos + 4);

      fs.writeFileSync(filePath, outputData);
      console.info(`${LOG_PREFIX} WebM metadata updated: ${Math.round(durationMs / 1000)}s`);
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to update WebM metadata:`, error.message);
    }
  }

  /**
   * Encode a value as an EBML VINT with a specific width.
   */
  #encodeVint(value, width) {
    const buf = Buffer.alloc(width);
    // Set the VINT marker bit in the first byte
    const markerBit = 1 << (8 - width);
    let remaining = value;
    for (let b = width - 1; b >= 1; b--) {
      buf[b] = remaining & 0xFF;
      remaining = Math.floor(remaining / 256);
    }
    buf[0] = markerBit | (remaining & (markerBit - 1));
    return buf;
  }

  /**
   * Create a WAV file header.
   * @param {number} dataSize - Size of the PCM data in bytes
   * @returns {Buffer}
   */
  #createWavHeader(dataSize) {
    const header = Buffer.alloc(44);
    const bitsPerSample = 16;
    const byteRate = this.#sampleRate * this.#channels * (bitsPerSample / 8);
    const blockAlign = this.#channels * (bitsPerSample / 8);

    // RIFF header
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);

    // fmt sub-chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);           // Sub-chunk size
    header.writeUInt16LE(1, 20);            // Audio format (PCM)
    header.writeUInt16LE(this.#channels, 22);
    header.writeUInt32LE(this.#sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);

    // data sub-chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return header;
  }

  /**
   * Update the WAV header with the correct data size after recording is complete.
   */
  #updateWavHeader() {
    if (!this.#currentFilePath || this.#dataSize === 0) {
      return;
    }

    try {
      const fd = fs.openSync(this.#currentFilePath, 'r+');
      const header = this.#createWavHeader(this.#dataSize);
      fs.writeSync(fd, header, 0, 44, 0);
      fs.closeSync(fd);
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to update WAV header:`, error.message);
    }
  }
}

module.exports = CallRecordingManager;
