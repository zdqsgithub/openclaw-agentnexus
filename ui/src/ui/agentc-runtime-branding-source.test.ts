import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");

function read(path: string) {
  return readFileSync(resolve(root, path), "utf8");
}

function readPngAlphaBounds(path: string) {
  const png = readFileSync(resolve(root, path));
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idatChunks: Buffer[] = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data.readUInt8(8)).toBe(8);
      colorType = data.readUInt8(9);
      expect(colorType).toBe(6);
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  const inflated = inflateSync(Buffer.concat(idatChunks));
  const bytesPerPixel = 4;
  const rowBytes = width * bytesPerPixel;
  let rowOffset = 0;
  let previous = Buffer.alloc(rowBytes);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[rowOffset];
    const raw = inflated.subarray(rowOffset + 1, rowOffset + 1 + rowBytes);
    const current = Buffer.alloc(rowBytes);

    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= bytesPerPixel ? current[x - bytesPerPixel] : 0;
      const up = previous[x] ?? 0;
      const upLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      let value = raw[x];

      if (filter === 1) {
        value = (value + left) & 0xff;
      } else if (filter === 2) {
        value = (value + up) & 0xff;
      } else if (filter === 3) {
        value = (value + Math.floor((left + up) / 2)) & 0xff;
      } else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        value = (value + predictor) & 0xff;
      } else {
        expect(filter).toBe(0);
      }

      current[x] = value;
    }

    for (let x = 0; x < width; x += 1) {
      if (current[x * bytesPerPixel + 3] === 0) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }

    previous = current;
    rowOffset += rowBytes + 1;
  }

  expect(maxX).toBeGreaterThanOrEqual(0);

  return {
    width,
    height,
    colorType,
    boundsWidth: maxX - minX + 1,
    boundsHeight: maxY - minY + 1,
  };
}

describe("AgentC Runtime visible branding", () => {
  it("brands the hosted control shell as AgentC Runtime", () => {
    const visibleSources = [
      "ui/index.html",
      "ui/public/manifest.webmanifest",
      "ui/public/sw.js",
      "ui/src/ui/app-render.ts",
      "ui/src/ui/components/dashboard-header.ts",
      "ui/src/ui/views/login-gate.ts",
      "ui/src/ui/views/chat.ts",
      "ui/src/ui/chat/realtime-talk.ts",
      "ui/src/ui/views/config-quick.ts",
      "agentnexus/runtime-manifest.json",
      "agentnexus/README.md",
    ].map(read);

    const combined = visibleSources.join("\n");

    expect(combined).toContain("AgentC Runtime");
    expect(combined).toContain("AgentC");
    expect(combined).not.toContain("OpenClaw Control");
    expect(combined).not.toContain(">OpenClaw<");
    expect(combined).not.toContain("alt=\"OpenClaw\"");
    expect(combined).not.toContain("Asking OpenClaw");
    expect(combined).not.toContain("AgentNexus OpenClaw Runtime");
  });

  it("keeps internal OpenClaw compatibility identifiers intact", () => {
    const manifest = read("agentnexus/runtime-manifest.json");
    const bootstrap = read("ui/src/ui/controllers/control-ui-bootstrap.test.ts");

    expect(manifest).toContain("\"id\": \"openclaw-agentnexus\"");
    expect(manifest).toContain("\"runtime\": \"clawbot\"");
    expect(bootstrap).toContain("/openclaw");
  });

  it("keeps AgentC Runtime icon assets tightly cropped for sidebar and chat avatars", () => {
    for (const path of ["ui/public/agentc-runtime-mark.png", "ui/public/agentc-runtime-avatar.png"]) {
      const bounds = readPngAlphaBounds(path);

      expect(bounds.width).toBe(1024);
      expect(bounds.height).toBe(1024);
      expect(bounds.colorType).toBe(6);
      expect(bounds.boundsWidth).toBeGreaterThanOrEqual(720);
      expect(bounds.boundsHeight).toBeGreaterThanOrEqual(620);
    }
  });
});
