import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WavError, decodeWav, encodeWav } from '../dist/esm/index.js';

// Python 3.13 wave module: 2 channels, 8000 Hz, frames (0,1) (-1,32767) (-32768,1234).
const WAVE_PCM16 =
  '524946463000000057415645666d74201000000001000200401f0000007d000004001000646174610c00000000000100ffffff7f0080d204';
// scipy.io.wavfile.write float32 mono 44100 Hz [0, .5, -.25, 1] (fmt 18 bytes + fact chunk).
const SCIPY_F32 =
  '524946464200000057415645666d7420120000000300010044ac000010b102000400200000006661637404000000040000006461746110000000000000000000003f000080be0000803f';
// scipy.io.wavfile.write int16 stereo 22050 Hz [[1,-2],[3,-4]].
const SCIPY_I16 =
  '524946462c00000057415645666d7420100000000100020022560000885801000400100064617461080000000100feff0300fcff';
const bytes = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const u16 = (n) => [n & 255, n >> 8];
const chunk = (id, body) => [
  ...ascii(id),
  ...u32(body.length),
  ...body,
  ...(body.length & 1 ? [0] : []),
];
const riff = (...chunks) => {
  const body = [...ascii('WAVE'), ...chunks.flat()];
  return Uint8Array.from([...ascii('RIFF'), ...u32(body.length), ...body]);
};
const fmt16 = chunk('fmt ', [
  ...u16(1),
  ...u16(1),
  ...u32(8000),
  ...u32(16000),
  ...u16(2),
  ...u16(16),
]);

test('decodes Python wave PCM16 output', () => {
  const audio = decodeWav(bytes(WAVE_PCM16));
  assert.equal(audio.format, 'pcm16');
  assert.equal(audio.channels, 2);
  assert.equal(audio.sampleRate, 8000);
  assert.equal(audio.frames, 3);
  assert.deepEqual([...audio.samples], [0, 1, -1, 32767, -32768, 1234]);
  assert.deepEqual(audio.chunks, []);
});

test('decodes scipy float32 (format tag 3, fmt 18, fact chunk)', () => {
  const audio = decodeWav(bytes(SCIPY_F32));
  assert.equal(audio.format, 'float32');
  assert.equal(audio.sampleRate, 44100);
  assert.deepEqual([...audio.samples], [0, 0.5, -0.25, 1]);
  assert.deepEqual(
    audio.chunks.map((c) => c.id),
    ['fact'],
  );
  assert.deepEqual([...audio.chunks[0].data], [4, 0, 0, 0]);
});

test('encoder reproduces the reference files byte for byte', () => {
  assert.deepEqual(
    encodeWav({
      format: 'pcm16',
      channels: 2,
      sampleRate: 8000,
      samples: Int16Array.of(0, 1, -1, 32767, -32768, 1234),
    }),
    bytes(WAVE_PCM16),
  );
  assert.deepEqual(
    encodeWav({
      format: 'float32',
      channels: 1,
      sampleRate: 44100,
      samples: Float32Array.of(0, 0.5, -0.25, 1),
    }),
    bytes(SCIPY_F32),
  );
  assert.deepEqual(
    encodeWav({
      format: 'pcm16',
      channels: 2,
      sampleRate: 22050,
      samples: Int16Array.of(1, -2, 3, -4),
    }),
    bytes(SCIPY_I16),
  );
});

test('odd-sized chunks are padded on write and skipped on read', () => {
  const list = { id: 'LIST', data: Uint8Array.of(1, 2, 3) };
  const file = encodeWav({
    format: 'pcm16',
    channels: 1,
    sampleRate: 8000,
    samples: Int16Array.of(5, 6),
    chunks: [list, { id: 'abcd', data: Uint8Array.of(9) }],
  });
  assert.equal(file.length % 2, 0);
  assert.equal(new DataView(file.buffer).getUint32(4, true), file.length - 8);
  const audio = decodeWav(file);
  assert.deepEqual([...audio.samples], [5, 6]);
  assert.deepEqual(
    audio.chunks.map((c) => [c.id, [...c.data]]),
    [
      ['LIST', [1, 2, 3]],
      ['abcd', [9]],
    ],
  );
  // Odd chunk before data: the pad byte must be skipped and not read as a chunk id.
  const manual = riff(fmt16, chunk('junk', [7, 7, 7]), chunk('data', [1, 0, 2, 0]));
  assert.deepEqual([...decodeWav(manual).samples], [1, 2]);
  // Missing pad on the very last odd chunk is tolerated.
  const unpadded = riff(fmt16, chunk('data', [1, 0]), chunk('odd ', [1, 2, 3]).slice(0, -1));
  assert.deepEqual(decodeWav(unpadded).chunks[0].data.length, 3);
});

test('WAVE_FORMAT_EXTENSIBLE PCM and float are recognized', () => {
  const tail = [0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71];
  const ext = (code, bits) =>
    chunk('fmt ', [
      ...u16(0xfffe),
      ...u16(1),
      ...u32(1000),
      ...u32((1000 * bits) / 8),
      ...u16(bits / 8),
      ...u16(bits),
      ...u16(22),
      ...u16(bits),
      ...u32(4),
      ...u16(code),
      ...tail,
    ]);
  assert.equal(decodeWav(riff(ext(1, 16), chunk('data', [1, 0]))).format, 'pcm16');
  assert.equal(decodeWav(riff(ext(3, 32), chunk('data', [0, 0, 0x80, 0x3f]))).samples[0], 1);
  const bad = ext(1, 16);
  bad[8 + 24 + 2] = 9;
  assert.throws(
    () => decodeWav(riff(bad, chunk('data', [0, 0]))),
    (e) => e.code === 'unsupported',
  );
});

test('rejects unsupported formats and malformed structure explicitly', () => {
  const f = (code, bits, ch = 1) =>
    chunk('fmt ', [
      ...u16(code),
      ...u16(ch),
      ...u32(8000),
      ...u32((8000 * ch * bits) / 8),
      ...u16((ch * bits) / 8),
      ...u16(bits),
    ]);
  const cases = [
    [riff(f(1, 8), chunk('data', [0])), 'unsupported'],
    [riff(f(1, 24), chunk('data', [0, 0, 0])), 'unsupported'],
    [riff(f(3, 64), chunk('data', new Array(8).fill(0))), 'unsupported'],
    [riff(f(2, 16), chunk('data', [0, 0])), 'unsupported'],
    [riff(fmt16), 'bad-chunk'],
    [riff(chunk('data', [0, 0]), fmt16), 'bad-chunk'],
    [riff(fmt16, fmt16, chunk('data', [0, 0])), 'bad-chunk'],
    [riff(fmt16, chunk('data', [0, 0]), chunk('data', [0, 0])), 'bad-chunk'],
    [riff(fmt16, chunk('data', [0, 0, 0])), 'bad-chunk'],
    [riff(f(1, 16, 0), chunk('data', [])), 'bad-chunk'],
    [riff(chunk('fmt ', [1, 0, 1, 0]), chunk('data', [])), 'bad-chunk'],
    [Uint8Array.from([...ascii('RIFX'), 0, 0, 0, 4, ...ascii('WAVE')]), 'unsupported'],
    [Uint8Array.from([...ascii('RF64'), 255, 255, 255, 255, ...ascii('WAVE')]), 'unsupported'],
    [Uint8Array.from([...ascii('RIFF'), ...u32(4), ...ascii('AVI ')]), 'bad-signature'],
    [Uint8Array.from(ascii('nope')), 'truncated'],
  ];
  for (const [input, code] of cases) {
    assert.throws(
      () => decodeWav(input),
      (e) => e instanceof WavError && e.code === code,
      code,
    );
  }
});

test('sizes that overflow the file or each other fail without reading past bounds', () => {
  const good = riff(fmt16, chunk('data', [1, 0, 2, 0]));
  for (let n = 0; n < good.length; n++) {
    assert.throws(() => decodeWav(good.slice(0, n)), WavError, `length ${n}`);
  }
  const huge = good.slice();
  new DataView(huge.buffer).setUint32(4, 0xffffffff, true);
  assert.throws(
    () => decodeWav(huge),
    (e) => e.code === 'truncated',
  );
  const bigChunk = good.slice();
  new DataView(bigChunk.buffer).setUint32(12 + 8 + 16 + 4, 0xfffffffe, true);
  assert.throws(
    () => decodeWav(bigChunk),
    (e) => e.code === 'truncated',
  );
  assert.equal(decodeWav(Uint8Array.from([...good, 1, 2, 3])).frames, 2);
  assert.throws(
    () => decodeWav(good, { maxBytes: 10 }),
    (e) => e.code === 'limit',
  );
  assert.throws(
    () =>
      decodeWav(riff(fmt16, chunk('a   ', []), chunk('b   ', []), chunk('data', [])), {
        maxChunks: 2,
      }),
    (e) => e.code === 'limit',
  );
});

test('float32 special values and unaligned input views survive', () => {
  const samples = Float32Array.of(Infinity, -Infinity, 1e-30, -0, 3.4028234663852886e38);
  const file = encodeWav({ format: 'float32', channels: 1, sampleRate: 48000, samples });
  const shifted = new Uint8Array(file.length + 3);
  shifted.set(file, 3);
  const audio = decodeWav(shifted.subarray(3));
  assert.deepEqual([...audio.samples], [...samples]);
  assert.ok(Object.is(audio.samples[3], -0));
  assert.equal(
    decodeWav(
      encodeWav({ format: 'float32', channels: 1, sampleRate: 1, samples: Float32Array.of(NaN) }),
    ).samples[0],
    NaN,
  );
});

test('empty audio and multichannel layout', () => {
  const empty = decodeWav(
    encodeWav({ format: 'pcm16', channels: 6, sampleRate: 48000, samples: new Int16Array(0) }),
  );
  assert.equal(empty.frames, 0);
  assert.equal(empty.channels, 6);
  const six = encodeWav({
    format: 'pcm16',
    channels: 6,
    sampleRate: 48000,
    samples: Int16Array.from({ length: 12 }, (_, i) => i),
  });
  assert.equal(new DataView(six.buffer).getUint16(32, true), 12);
  assert.equal(new DataView(six.buffer).getUint32(28, true), 48000 * 12);
});

test('encoder validates arguments and owns its output', () => {
  const ok = { format: 'pcm16', channels: 1, sampleRate: 8000, samples: Int16Array.of(1) };
  assert.throws(() => encodeWav({ ...ok, format: 'pcm8' }), TypeError);
  assert.throws(() => encodeWav({ ...ok, samples: Float32Array.of(1) }), TypeError);
  assert.throws(() => encodeWav({ ...ok, format: 'float32' }), TypeError);
  assert.throws(() => encodeWav({ ...ok, channels: 0 }), RangeError);
  assert.throws(() => encodeWav({ ...ok, channels: 2 }), RangeError);
  assert.throws(() => encodeWav({ ...ok, sampleRate: 0 }), RangeError);
  assert.throws(() => encodeWav({ ...ok, sampleRate: 1.5 }), RangeError);
  assert.throws(
    () => encodeWav({ ...ok, chunks: [{ id: 'data', data: new Uint8Array() }] }),
    RangeError,
  );
  assert.throws(
    () => encodeWav({ ...ok, chunks: [{ id: 'abc', data: new Uint8Array() }] }),
    RangeError,
  );
  const source = Uint8Array.of(1, 2);
  const file = encodeWav({ ...ok, chunks: [{ id: 'abcd', data: source }] });
  source[0] = 99;
  assert.equal(decodeWav(file).chunks[0].data[0], 1);
  assert.throws(() => decodeWav('x'), TypeError);
});
