import {
  WavError,
  decodeWav,
  encodeWav,
  type WavAudio,
  type WavChunk,
  type WavFormat,
} from '@lp-labs/wav-codec';
const format: WavFormat = 'float32';
const file: Uint8Array = encodeWav({
  format,
  channels: 1,
  sampleRate: 8000,
  samples: new Float32Array(2),
});
const audio: WavAudio = decodeWav(file, { maxChunks: 4 });
const chunks: readonly WavChunk[] = audio.chunks;
const error: WavError = new WavError('limit', 'x', 0);
void [audio.samples.length, chunks, error.code];
// @ts-expect-error unknown format
encodeWav({ format: 'pcm24', channels: 1, sampleRate: 1, samples: new Int16Array(1) });
// @ts-expect-error samples must be typed arrays
encodeWav({ format, channels: 1, sampleRate: 1, samples: [1, 2] });
