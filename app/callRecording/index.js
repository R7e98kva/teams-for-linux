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

    // Receive recording stop signal
    ipcMain.on('call-recording-stop', () => {
      this.#handleRecordingStop();
    });

    // Receive video recording start signal with format parameters
    ipcMain.on('call-video-recording-start', (_event, _params) => {
      this.#handleVideoRecordingStart();
    });

    // Receive encoded WebM video+audio chunks from renderer
    ipcMain.on('call-video-recording-chunk', (_event, data) => {
      this.#handleVideoChunk(data);
    });

    // Receive video recording stop signal
    ipcMain.on('call-video-recording-stop', () => {
      this.#handleVideoRecordingStop();
    });

    console.info(`${LOG_PREFIX} Handlers registered, output directory: ${this.#outputDir}`);
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
      const buffer = Buffer.from(new Int16Array(pcmData).buffer);
      this.#writeStream.write(buffer);
      this.#dataSize += buffer.length;
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to write audio chunk:`, error.message);
    }
  }

  #handleRecordingStop() {
    if (!this.#writeStream) {
      return;
    }

    try {
      this.#writeStream.end(() => {
        this.#updateWavHeader();
        console.info(`${LOG_PREFIX} Recording saved: ${this.#currentFilePath}`);
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
      const buffer = Buffer.from(data);
      this.#videoWriteStream.write(buffer);
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to write video chunk:`, error.message);
    }
  }

  #handleVideoRecordingStop() {
    if (!this.#videoWriteStream) {
      return;
    }

    const durationMs = this.#videoRecordingStartTime
      ? Date.now() - this.#videoRecordingStartTime
      : 0;

    try {
      this.#videoWriteStream.end(() => {
        if (durationMs > 0) {
          this.#updateWebMDuration(this.#currentVideoFilePath, durationMs);
        }
        console.info(`${LOG_PREFIX} Video recording saved: ${this.#currentVideoFilePath}`);
      });
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to finalize video recording:`, error.message);
    }

    this.#videoWriteStream = null;
    this.#videoRecordingStartTime = null;
  }

  /**
   * Update the WebM Segment size and Duration element after recording.
   * Chrome's MediaRecorder writes Segment with "unknown" size and Duration
   * as 0, which prevents players from showing length or allowing seeking.
   * This patches both in-place.
   */
  #updateWebMDuration(filePath, durationMs) {
    try {
      const fileSize = fs.statSync(filePath).size;
      const fd = fs.openSync(filePath, 'r+');
      const searchSize = Math.min(65536, fileSize);
      const buf = Buffer.alloc(searchSize);
      const bytesRead = fs.readSync(fd, buf, 0, searchSize, 0);

      // 1. Find and fix Segment size (ID: 0x18 0x53 0x80 0x67)
      // Chrome writes it as 0x01FFFFFFFFFFFFFF ("unknown" 8-byte VINT)
      let segmentDataStart = -1;
      for (let i = 0; i < bytesRead - 12; i++) {
        if (buf[i] === 0x18 && buf[i + 1] === 0x53
          && buf[i + 2] === 0x80 && buf[i + 3] === 0x67) {
          const sizePos = i + 4;
          // Chrome always writes an 8-byte VINT (starts with 0x01)
          if (buf[sizePos] === 0x01) {
            segmentDataStart = sizePos + 8;
            const actualSize = fileSize - segmentDataStart;
            // Write 8-byte VINT: first byte 0x01 (marker), then 7 bytes big-endian
            const sizeBuf = Buffer.alloc(8);
            sizeBuf[0] = 0x01;
            // Write 7-byte big-endian integer for the segment data size
            for (let b = 7; b >= 1; b--) {
              sizeBuf[b] = Number(BigInt(actualSize) >> (BigInt(7 - b) * 8n) & 0xFFn);
            }
            fs.writeSync(fd, sizeBuf, 0, 8, sizePos);
            console.debug(`${LOG_PREFIX} WebM Segment size updated: ${actualSize} bytes`);
          }
          break;
        }
      }

      // 2. Find and fix Duration element (ID: 0x44 0x89)
      const searchStart = segmentDataStart > 0 ? segmentDataStart : 0;
      for (let i = searchStart; i < bytesRead - 10; i++) {
        if (buf[i] === 0x44 && buf[i + 1] === 0x89) {
          // Parse the VINT size that follows the element ID
          const vintByte = buf[i + 2];
          let vintWidth = 0;
          let dataSize = 0;
          // VINT width is determined by leading zeros + 1
          for (let bit = 7; bit >= 0; bit--) {
            if (vintByte & (1 << bit)) {
              vintWidth = 8 - bit;
              // Mask off the VINT marker bit from first byte
              dataSize = vintByte & ((1 << bit) - 1);
              break;
            }
          }
          // Read remaining VINT bytes
          for (let b = 1; b < vintWidth; b++) {
            dataSize = (dataSize << 8) | buf[i + 2 + b];
          }

          if (dataSize === 8 || dataSize === 4) {
            const dataPos = i + 2 + vintWidth;
            const durBuf = Buffer.alloc(dataSize);
            if (dataSize === 8) {
              durBuf.writeDoubleBE(durationMs, 0);
            } else {
              durBuf.writeFloatBE(durationMs, 0);
            }
            fs.writeSync(fd, durBuf, 0, dataSize, dataPos);
            console.debug(`${LOG_PREFIX} WebM Duration element updated: ${Math.round(durationMs / 1000)}s`);
          }
          break;
        }
      }

      fs.closeSync(fd);
      console.info(`${LOG_PREFIX} WebM metadata updated: ${Math.round(durationMs / 1000)}s`);
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to update WebM metadata:`, error.message);
    }
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
