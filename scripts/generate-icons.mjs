/**
 * 生成应用与托盘图标（assets/icon.png + assets/icon.ico）。
 *
 * 为什么手写编码器而不是装依赖：本项目运行时依赖只有 electron，
 * 引入 sharp/png-to-ico 等仅用于一次性生成图标的依赖不划算（见 docs/编码规范.md §1）。
 * 本脚本只用 Node 内置能力（node:zlib），零第三方依赖。
 *
 * 用法：npm run gen:icons
 * 产物：assets/icon.png（256×256，供窗口与页面使用）
 *       assets/icon.ico（内嵌同一张 PNG，供 electron-builder 生成 Windows 可执行文件图标）
 *
 * 视觉：淡粉色圆角方块背景 + 白色剪贴板 + 金色夹子，
 *       与 docs/设计规范.md §2 的 --color-primary 保持一致。
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = resolve(HERE, '..', 'assets');
const SIZE = 256;

/** 主色 #F7A8BC —— 必须与 docs/设计规范.md §2 的 --color-primary 一致 */
const BG = { r: 0xf7, g: 0xa8, b: 0xbc };
const WHITE = { r: 0xff, g: 0xff, b: 0xff };
/** 夹子用暖金色，与白色板身形成可辨对比 */
const CLIP = { r: 0xf6, g: 0xd0, b: 0x7a };

// ---------- PNG 编码（RGBA / 8bit / 无隔行） ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const crcInput = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);

  return Buffer.concat([length, typeBytes, data, crc]);
}

/** 把 RGBA 像素缓冲编码为 PNG 字节 */
function encodePng(rgba, width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型：RGBA
  ihdr[10] = 0; // 压缩方法
  ihdr[11] = 0; // 过滤方法
  ihdr[12] = 0; // 隔行扫描：无

  // 每行前置一个过滤类型字节（0 = None）
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 绘图 ----------

function isInsideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) {
    return false;
  }
  const corners = [
    [left + radius, top + radius],
    [right - radius, top + radius],
    [left + radius, bottom - radius],
    [right - radius, bottom - radius],
  ];
  for (const [cx, cy] of corners) {
    const inCornerBoxX = (x < left + radius && cx === left + radius) || (x > right - radius && cx === right - radius);
    const inCornerBoxY = (y < top + radius && cy === top + radius) || (y > bottom - radius && cy === bottom - radius);
    if (inCornerBoxX && inCornerBoxY) {
      const dx = x - cx;
      const dy = y - cy;
      return dx * dx + dy * dy <= radius * radius;
    }
  }
  return true;
}

function setPixel(buf, width, x, y, color) {
  const offset = (y * width + x) * 4;
  buf[offset] = color.r;
  buf[offset + 1] = color.g;
  buf[offset + 2] = color.b;
  buf[offset + 3] = 0xff;
}

function drawIcon() {
  const buf = Buffer.alloc(SIZE * SIZE * 4); // 默认全透明

  // 背景：圆角方块
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (isInsideRoundedRect(x, y, 0, 0, SIZE - 1, SIZE - 1, 56)) {
        setPixel(buf, SIZE, x, y, BG);
      }
    }
  }

  // 剪贴板板身：白色圆角矩形
  const board = { left: 62, top: 52, right: 193, bottom: 210 };
  for (let y = board.top; y <= board.bottom; y += 1) {
    for (let x = board.left; x <= board.right; x += 1) {
      if (isInsideRoundedRect(x, y, board.left, board.top, board.right, board.bottom, 18)) {
        setPixel(buf, SIZE, x, y, WHITE);
      }
    }
  }

  // 正文横线：主色，示意“文字条目”
  const lineThickness = 10;
  const lines = [
    { top: 106, bottom: 106 + lineThickness - 1, left: 84, right: 171 },
    { top: 134, bottom: 134 + lineThickness - 1, left: 84, right: 171 },
    { top: 162, bottom: 162 + lineThickness - 1, left: 84, right: 145 },
  ];
  for (const line of lines) {
    for (let y = line.top; y <= line.bottom; y += 1) {
      for (let x = line.left; x <= line.right; x += 1) {
        setPixel(buf, SIZE, x, y, BG);
      }
    }
  }

  // 顶部夹子：暖金色圆角矩形（最后绘制，压在板身之上）
  const clip = { left: 100, top: 26, right: 155, bottom: 62 };
  for (let y = clip.top; y <= clip.bottom; y += 1) {
    for (let x = clip.left; x <= clip.right; x += 1) {
      if (isInsideRoundedRect(x, y, clip.left, clip.top, clip.right, clip.bottom, 14)) {
        setPixel(buf, SIZE, x, y, CLIP);
      }
    }
  }

  return buf;
}

// ---------- ICO 封装 ----------

/**
 * 由一张 PNG 生成单尺寸 .ico。
 * PNG 内嵌形式（Vista 及以后支持），故 #0 项直接放 PNG 数据。
 */
function encodeIco(png, width, height) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // 保留
  header.writeUInt16LE(1, 2); // 类型：1 = 图标
  header.writeUInt16LE(1, 4); // 图像数量

  const entry = Buffer.alloc(16);
  // 256 在 ICO 目录项里用 0 表示
  entry[0] = width >= 256 ? 0 : width;
  entry[1] = height >= 256 ? 0 : height;
  entry[2] = 0; // 调色板颜色数
  entry[3] = 0; // 保留
  entry.writeUInt16LE(1, 4); // 颜色平面
  entry.writeUInt16LE(32, 6); // 位深
  entry.writeUInt32LE(png.length, 8); // 数据长度
  entry.writeUInt32LE(header.length + entry.length, 12); // 数据偏移

  return Buffer.concat([header, entry, png]);
}

// ---------- 主流程 ----------

const rgba = drawIcon();
const png = encodePng(rgba, SIZE, SIZE);
const ico = encodeIco(png, SIZE, SIZE);

mkdirSync(ASSETS_DIR, { recursive: true });
writeFileSync(join(ASSETS_DIR, 'icon.png'), png);
writeFileSync(join(ASSETS_DIR, 'icon.ico'), ico);

console.log(`已生成 assets/icon.png (${png.length} 字节)`);
console.log(`已生成 assets/icon.ico (${ico.length} 字节)`);
