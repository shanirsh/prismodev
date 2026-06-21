// Generates media/icon.png — a simple solid-brand placeholder marketplace icon
// (256x256). No dependencies; uses Node's zlib. Replace with real artwork later.
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const SIZE = 256;
const BG = [138, 92, 246]; // brand violet #8A5CF6
const DOT = [255, 255, 255]; // white mark

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// Raw RGBA scanlines with a filled circle "mark" in the center.
const cx = SIZE / 2;
const cy = SIZE / 2;
const r = SIZE * 0.18;
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let o = 0;
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const inDot = (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
    const [rr, gg, bb] = inDot ? DOT : BG;
    raw[o++] = rr;
    raw[o++] = gg;
    raw[o++] = bb;
    raw[o++] = 255;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

fs.writeFileSync(path.join(__dirname, "icon.png"), png);
console.log("wrote media/icon.png", png.length, "bytes");
