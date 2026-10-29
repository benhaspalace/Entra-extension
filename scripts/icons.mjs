import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

export async function generateIcons(directory) {
  await mkdir(directory, { recursive: true });
  for (const size of [16, 48, 128]) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;
    header[9] = 6;
    const pixels = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const offset = y * (size * 4 + 1) + 1 + x * 4;
        const mark =
          x > size * 0.25 &&
          x < size * 0.75 &&
          (y < size * 0.3 ||
            y > size * 0.7 ||
            Math.abs(y - size / 2) < size * 0.06);
        pixels.set(mark ? [255, 255, 255, 255] : [0, 100, 170, 255], offset);
      }
    }
    await writeFile(
      join(directory, `icon${size}.png`),
      Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(pixels)),
        chunk('IEND', Buffer.alloc(0)),
      ]),
    );
  }
}
