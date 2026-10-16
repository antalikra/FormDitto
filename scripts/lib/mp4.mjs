// Minimal MP4 (ISO BMFF) muxer for one H.264 video track, "fast start" layout: ftyp, moov, mdat.
// Input: AVCDecoderConfigurationRecord (WebCodecs decoderConfig.description with avc.format='avc')
// and length-prefixed samples in decode order with constant frame duration (no B-frames).

function box(type, ...parts) {
  const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, body]);
}

function full(type, version, flags, ...parts) {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0);
  return box(type, vf, ...parts);
}

const u8 = (n) => Buffer.from([n & 0xff]);
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }
const zeros = (n) => Buffer.alloc(n);

const MATRIX = Buffer.concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

/**
 * @param {{width:number,height:number,fps:number,avcC:Buffer,samples:{data:Buffer,key:boolean}[]}} opts
 * @returns {Buffer}
 */
export function muxH264({ width, height, fps, avcC, samples }) {
  if (!samples.length) throw new Error('no samples');
  if (!samples[0].key) throw new Error('first sample must be a key frame');
  const timescale = fps * 1000;
  const delta = 1000;
  const count = samples.length;
  const mediaDuration = count * delta;
  const movieDuration = Math.round((count / fps) * 1000); // movie timescale 1000

  const ftyp = box('ftyp', 'isom', u32(0x200), 'isom', 'iso2', 'avc1', 'mp41');

  const build = (chunkOffset) => {
    const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(movieDuration), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(2));
    const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(movieDuration), zeros(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(width << 16), u32(height << 16));
    const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(mediaDuration), u16(0x55c4), u16(0));
    const hdlr = full('hdlr', 0, 0, u32(0), 'vide', zeros(12), 'VideoHandler', u8(0));
    const vmhd = full('vmhd', 0, 1, zeros(8));
    const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
    const compressor = zeros(32);
    const avc1 = box('avc1', zeros(6), u16(1), zeros(16), u16(width), u16(height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), compressor, u16(0x0018), u16(0xffff), box('avcC', avcC), box('pasp', u32(1), u32(1)));
    const stsd = full('stsd', 0, 0, u32(1), avc1);
    const stts = full('stts', 0, 0, u32(1), u32(count), u32(delta));
    const keys = samples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
    const stss = full('stss', 0, 0, u32(keys.length), ...keys.map(u32));
    const stsc = full('stsc', 0, 0, u32(1), u32(1), u32(count), u32(1));
    const stsz = full('stsz', 0, 0, u32(0), u32(count), ...samples.map((s) => u32(s.data.length)));
    const stco = full('stco', 0, 0, u32(1), u32(chunkOffset));
    const stbl = box('stbl', stsd, stts, stss, stsc, stsz, stco);
    const minf = box('minf', vmhd, dinf, stbl);
    const mdia = box('mdia', mdhd, hdlr, minf);
    const trak = box('trak', tkhd, mdia);
    return box('moov', mvhd, trak);
  };

  const moovSize = build(0).length;
  const moov = build(ftyp.length + moovSize + 8);
  const payload = Buffer.concat(samples.map((s) => s.data));
  const mdatHead = Buffer.alloc(8);
  mdatHead.writeUInt32BE(8 + payload.length, 0);
  mdatHead.write('mdat', 4, 'ascii');
  return Buffer.concat([ftyp, moov, mdatHead, payload]);
}
