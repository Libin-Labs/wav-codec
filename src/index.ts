export type WavFormat = 'pcm16' | 'float32';

export interface WavChunk {
  /** Four printable ASCII characters. */
  readonly id: string;
  readonly data: Uint8Array;
}

export interface WavAudio {
  readonly format: WavFormat;
  readonly channels: number;
  readonly sampleRate: number;
  /** Interleaved samples: Int16Array for pcm16, Float32Array for float32. */
  readonly samples: Int16Array | Float32Array;
  /** Number of sample frames (samples.length / channels). */
  readonly frames: number;
  /** Chunks other than fmt and data (for example LIST, fact), in file order, with odd padding removed. */
  readonly chunks: readonly WavChunk[];
}

export interface WavDecodeOptions {
  /** Maximum input byte length. Default 268,435,456. */
  maxBytes?: number;
  /** Maximum number of chunks walked. Default 1,024. */
  maxChunks?: number;
}

export interface WavEncodeInput {
  readonly format: WavFormat;
  readonly channels: number;
  readonly sampleRate: number;
  readonly samples: Int16Array | Float32Array;
  /** Extra chunks written after the data chunk (for example LIST). */
  readonly chunks?: readonly WavChunk[];
}

export type WavErrorCode = 'truncated' | 'bad-signature' | 'bad-chunk' | 'unsupported' | 'limit';

export class WavError extends Error {
  readonly code: WavErrorCode;
  readonly offset: number | undefined;
  constructor(code: WavErrorCode, message: string, offset?: number) {
    super(message);
    this.name = 'WavError';
    this.code = code;
    this.offset = offset;
  }
}

const DEFAULT_MAX_BYTES = 268_435_456;
const DEFAULT_MAX_CHUNKS = 1024;
// Trailing 14 bytes of the KSDATAFORMAT_SUBTYPE GUIDs after the 16-bit format code.
const GUID_TAIL = [
  0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];

function posInt(value: number | undefined, fallback: number, name: string): number {
  const v = value ?? fallback;
  if (!Number.isSafeInteger(v) || v < 1) throw new RangeError(`${name} must be a positive integer`);
  return v;
}

function fourcc(view: Uint8Array, at: number): string {
  return String.fromCharCode(view[at]!, view[at + 1]!, view[at + 2]!, view[at + 3]!);
}

function checkId(id: string): void {
  if (!/^[\x20-\x7e]{4}$/.test(id))
    throw new RangeError('chunk id must be four printable ASCII characters');
}

/** Decodes a RIFF/WAVE file holding PCM 16-bit or IEEE float 32-bit samples. */
export function decodeWav(input: Uint8Array, options: WavDecodeOptions = {}): WavAudio {
  if (!(input instanceof Uint8Array)) throw new TypeError('input must be a Uint8Array');
  const maxBytes = posInt(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes');
  const maxChunks = posInt(options.maxChunks, DEFAULT_MAX_CHUNKS, 'maxChunks');
  if (input.length > maxBytes) throw new WavError('limit', 'input exceeds maxBytes');
  if (input.length < 12) throw new WavError('truncated', 'RIFF header truncated', 0);
  const tag = fourcc(input, 0);
  if (tag !== 'RIFF') {
    throw new WavError(
      tag === 'RIFX' || tag === 'RF64' ? 'unsupported' : 'bad-signature',
      `unsupported container ${JSON.stringify(tag)}`,
      0,
    );
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (fourcc(input, 8) !== 'WAVE') throw new WavError('bad-signature', 'RIFF form is not WAVE', 8);
  const riffSize = view.getUint32(4, true);
  if (riffSize < 4) throw new WavError('bad-chunk', 'RIFF size too small', 4);
  const end = riffSize + 8;
  if (end > input.length) throw new WavError('truncated', 'RIFF size exceeds input length', 4);
  let format: WavFormat | undefined;
  let channels = 0;
  let sampleRate = 0;
  let blockAlign = 0;
  let dataAt = -1;
  let dataSize = 0;
  const chunks: WavChunk[] = [];
  let at = 12;
  let walked = 0;
  while (at < end) {
    if (++walked > maxChunks) throw new WavError('limit', 'too many chunks', at);
    if (at + 8 > end) throw new WavError('truncated', 'chunk header truncated', at);
    const id = fourcc(input, at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (body + size > end)
      throw new WavError('truncated', `chunk ${JSON.stringify(id)} exceeds RIFF size`, at);
    if (id === 'fmt ') {
      if (format !== undefined) throw new WavError('bad-chunk', 'duplicate fmt chunk', at);
      if (size < 16) throw new WavError('bad-chunk', 'fmt chunk too small', at);
      let code = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      blockAlign = view.getUint16(body + 12, true);
      const bits = view.getUint16(body + 14, true);
      if (code === 0xfffe) {
        if (size < 40 || view.getUint16(body + 16, true) < 22)
          throw new WavError('bad-chunk', 'bad WAVE_FORMAT_EXTENSIBLE fmt chunk', at);
        code = view.getUint16(body + 24, true);
        for (let i = 0; i < GUID_TAIL.length; i++) {
          if (input[body + 26 + i] !== GUID_TAIL[i])
            throw new WavError('unsupported', 'unsupported extensible sub-format', at);
        }
      }
      if (code === 1 && bits === 16) format = 'pcm16';
      else if (code === 3 && bits === 32) format = 'float32';
      else
        throw new WavError('unsupported', `unsupported format tag ${code} with ${bits} bits`, at);
      if (channels < 1) throw new WavError('bad-chunk', 'channels must be at least 1', at);
      if (sampleRate < 1) throw new WavError('bad-chunk', 'sample rate must be at least 1', at);
      if (blockAlign !== channels * (bits / 8))
        throw new WavError('bad-chunk', 'blockAlign does not match channels and bits', at);
    } else if (id === 'data') {
      if (dataAt >= 0) throw new WavError('bad-chunk', 'duplicate data chunk', at);
      if (format === undefined) throw new WavError('bad-chunk', 'data chunk before fmt chunk', at);
      dataAt = body;
      dataSize = size;
    } else {
      chunks.push({ id, data: input.slice(body, body + size) });
    }
    at = body + size + (size & 1);
  }
  if (format === undefined) throw new WavError('bad-chunk', 'missing fmt chunk');
  if (dataAt < 0) throw new WavError('bad-chunk', 'missing data chunk');
  if (dataSize % blockAlign !== 0)
    throw new WavError('bad-chunk', 'data size is not a whole number of frames', dataAt - 4);
  const frames = dataSize / blockAlign;
  const count = frames * channels;
  const samples = format === 'pcm16' ? new Int16Array(count) : new Float32Array(count);
  if (samples instanceof Int16Array) {
    for (let i = 0; i < count; i++) samples[i] = view.getInt16(dataAt + i * 2, true);
  } else {
    for (let i = 0; i < count; i++) samples[i] = view.getFloat32(dataAt + i * 4, true);
  }
  return { format, channels, sampleRate, samples, frames, chunks };
}

/** Encodes interleaved PCM16 or float32 samples as a canonical RIFF/WAVE file. */
export function encodeWav(audio: WavEncodeInput): Uint8Array {
  const { format, channels, sampleRate, samples } = audio;
  if (format !== 'pcm16' && format !== 'float32')
    throw new TypeError('format must be pcm16 or float32');
  if (format === 'pcm16' ? !(samples instanceof Int16Array) : !(samples instanceof Float32Array)) {
    throw new TypeError(
      format === 'pcm16' ? 'pcm16 requires an Int16Array' : 'float32 requires a Float32Array',
    );
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > 0xffff)
    throw new RangeError('channels must be 1..65535');
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 0xffffffff)
    throw new RangeError('sampleRate must be 1..4294967295');
  if (samples.length % channels !== 0)
    throw new RangeError('samples.length must be a multiple of channels');
  const bytesPer = format === 'pcm16' ? 2 : 4;
  const blockAlign = channels * bytesPer;
  if (blockAlign > 0xffff) throw new RangeError('frame is too large');
  const dataSize = samples.length * bytesPer;
  const fmtSize = format === 'pcm16' ? 16 : 18;
  const extras = audio.chunks ?? [];
  let total = 4 + 8 + fmtSize + (format === 'float32' ? 12 : 0) + 8 + dataSize + (dataSize & 1);
  for (const chunk of extras) {
    checkId(chunk.id);
    if (chunk.id === 'fmt ' || chunk.id === 'data' || chunk.id === 'RIFF')
      throw new RangeError(`reserved chunk id ${chunk.id}`);
    total += 8 + chunk.data.length + (chunk.data.length & 1);
  }
  if (total > 0xffffffff) throw new RangeError('audio too large for RIFF');
  const out = new Uint8Array(total + 8);
  const view = new DataView(out.buffer);
  let at = 0;
  const put = (id: string): void => {
    for (let i = 0; i < 4; i++) out[at + i] = id.charCodeAt(i);
    at += 4;
  };
  put('RIFF');
  view.setUint32(at, total, true);
  at += 4;
  put('WAVE');
  put('fmt ');
  view.setUint32(at, fmtSize, true);
  view.setUint16(at + 4, format === 'pcm16' ? 1 : 3, true);
  view.setUint16(at + 6, channels, true);
  view.setUint32(at + 8, sampleRate, true);
  view.setUint32(
    at + 12,
    sampleRate * blockAlign > 0xffffffff ? 0xffffffff : sampleRate * blockAlign,
    true,
  );
  view.setUint16(at + 16, blockAlign, true);
  view.setUint16(at + 18, bytesPer * 8, true);
  at += 4 + fmtSize;
  if (format === 'float32') {
    put('fact');
    view.setUint32(at, 4, true);
    view.setUint32(at + 4, samples.length / channels, true);
    at += 8;
  }
  put('data');
  view.setUint32(at, dataSize, true);
  at += 4;
  if (samples instanceof Int16Array) {
    for (let i = 0; i < samples.length; i++) view.setInt16(at + i * 2, samples[i]!, true);
  } else {
    for (let i = 0; i < samples.length; i++) view.setFloat32(at + i * 4, samples[i]!, true);
  }
  at += dataSize + (dataSize & 1);
  for (const chunk of extras) {
    put(chunk.id);
    view.setUint32(at, chunk.data.length, true);
    out.set(chunk.data, at + 4);
    at += 4 + chunk.data.length + (chunk.data.length & 1);
  }
  return out;
}
