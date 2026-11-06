# @lp-labs/wav-codec

Bounded RIFF/WAVE decoder and encoder for 16-bit PCM and 32-bit IEEE float audio: real chunk walking, odd-size chunk padding, channel/rate/blockAlign validation. Produces and parses sample data only; it never plays or synthesizes sound.

## Install

```sh
npm install @lp-labs/wav-codec
```

Node.js 18+; standalone ES2022 core with DOM-library types only. Zero runtime or peer dependencies. ESM and CommonJS builds with separate declarations. No filesystem, network, timer or environment access: every function works on in-memory bytes or strings you provide.

## Quickstart

```js
import { decodeWav, encodeWav } from '@lp-labs/wav-codec';
const samples = Int16Array.of(0, 1000, -1000, 32767);
const file = encodeWav({ format: 'pcm16', channels: 2, sampleRate: 8000, samples });
const audio = decodeWav(file);
console.log(file.length, audio.format, audio.channels, audio.frames, [...audio.samples]);
```

CommonJS consumers use `const api = require('@lp-labs/wav-codec')`. The same named API is available in both module formats. No default export.

## API, behavior and options

`decodeWav(bytes, options?)` returns `{ format, channels, sampleRate, samples, frames, chunks }`. `format` is `'pcm16'` (samples is an `Int16Array`) or `'float32'` (`Float32Array`); samples are interleaved and owned by the result. `chunks` lists every chunk other than `fmt ` and `data` (for example `LIST`, `fact`) as `{ id, data }` in file order with pad bytes removed.

`encodeWav({ format, channels, sampleRate, samples, chunks? })` writes a canonical file: `RIFF`, `WAVE`, a 16-byte `fmt ` chunk for PCM (format tag 1) or an 18-byte `fmt ` (tag 3, cbSize 0) plus a `fact` chunk for float, then `data`, then optional extra chunks. Odd-sized extra chunks are followed by a zero pad byte that is counted in the RIFF size but not the chunk size. The PCM and float layouts are byte-identical to Python's `wave` module and scipy's `wavfile.write`.

Decoder details: little-endian `RIFF` only (`RIFX` and `RF64` are rejected as unsupported). The RIFF size must fit inside the input; bytes after it are ignored. `fmt ` must precede `data`, each may appear once, blockAlign must equal channels*bytes, and the data size must be a whole number of frames. `WAVE_FORMAT_EXTENSIBLE` (0xFFFE) is accepted when the sub-format GUID is the standard PCM or IEEE-float GUID; channel masks are not interpreted. A missing pad byte after the final odd chunk is tolerated. Options: `maxBytes` (default 268,435,456) and `maxChunks` (default 1,024).

All exports: `WavFormat`, `WavChunk`, `WavAudio`, `WavDecodeOptions`, `WavEncodeInput`, `WavErrorCode`, `WavError`, `decodeWav`, `encodeWav`.

## Full TypeScript declarations

```ts
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
export declare class WavError extends Error {
  readonly code: WavErrorCode;
  readonly offset: number | undefined;
  constructor(code: WavErrorCode, message: string, offset?: number);
}
/** Decodes a RIFF/WAVE file holding PCM 16-bit or IEEE float 32-bit samples. */
export declare function decodeWav(input: Uint8Array, options?: WavDecodeOptions): WavAudio;
/** Encodes interleaved PCM16 or float32 samples as a canonical RIFF/WAVE file. */
export declare function encodeWav(audio: WavEncodeInput): Uint8Array;
```

## Examples

### Float32 with metadata chunks

```js
import { decodeWav, encodeWav } from '@lp-labs/wav-codec';
const list = { id: 'LIST', data: new TextEncoder().encode('abc') }; // odd size => pad byte
const file = encodeWav({
  format: 'float32',
  channels: 1,
  sampleRate: 44100,
  samples: Float32Array.of(0, 0.5, -0.25, 1),
  chunks: [list],
});
const audio = decodeWav(file);
console.log(
  audio.chunks.map((chunk) => chunk.id),
  audio.chunks[0].data.length,
  file.length % 2,
);
```

### Handling errors

```js
import { WavError, decodeWav } from '@lp-labs/wav-codec';
try {
  decodeWav(new TextEncoder().encode('RIFF....WAVE'));
} catch (error) {
  console.log(error instanceof WavError, error.code);
}
```

## Customization

Use `maxBytes` and `maxChunks` to tighten limits for untrusted uploads. Convert samples to your preferred scale (for example `int16 / 32768`) after decoding; the codec does no resampling, normalization, dithering or channel mapping. Extra chunks are plain bytes so you can parse `LIST/INFO`, `bext` or `cue ` yourself.

## Errors

Malformed files throw `WavError` with `code` (`'truncated'`, `'bad-signature'`, `'bad-chunk'`, `'unsupported'`, `'limit'`) and the byte `offset` when known. Invalid arguments throw `TypeError`/`RangeError`. No partial audio is returned on failure.

## Performance

One pass over chunk headers plus one linear sample conversion using DataView, so unaligned input views are safe. Memory is the input plus one decoded sample array. Chunk walking is capped by `maxChunks`; size arithmetic is validated before any allocation.

## Scope and non-goals

Supported: 16-bit PCM and 32-bit float, any channel count 1..65535, standard and extensible fmt chunks. Rejected explicitly: 8/24/32-bit integer PCM, 64-bit float, A-law, mu-law, ADPCM, MP3-in-WAV, RF64/RIFX, compressed formats. No playback, no sound output, no streaming, no >4 GiB files. NaN and infinite float samples are preserved bit-for-bit.

## Development

```sh
npm ci --offline
npm run typecheck
npm test
npm run format:check
```

TypeScript ^5.9.3 and Prettier ^3.6.2 are development-only. Build emits dist/esm and dist/cjs. Tests use Node's test runner; consumer.mts and consumer.cts exercise bare package imports including negative type assertions.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
