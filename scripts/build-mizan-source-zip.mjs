#!/usr/bin/env node
/**
 * Builds artifacts/audit-maroc/public/mizan-code-source.zip — the "download the
 * full source" archive the Settings page links to.
 *
 * Pure Node: no `bash`, no `zip` binary, no npm dependency, so it behaves
 * identically on Windows (PowerShell or cmd), macOS, Linux and CI images. The
 * previous `bash scripts/build-mizan-source-zip.sh` prebuild step failed the
 * whole `pnpm run build` on Windows, where neither tool is on PATH.
 *
 * Writes a standard deflate ZIP by hand (local headers + central directory +
 * EOCD) rather than shelling out.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "artifacts", "audit-maroc", "public", "mizan-code-source.zip");

/** Same set the shell script packaged, in the same order. */
const INCLUDE = [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "tsconfig.base.json",
  "replit.md",
  "LOCAL-TESTS.md",
  "DEPLOYMENT.md",
  ".env.example",
  ".env.local.example",
  "docker-compose.local.yml",
  "artifacts/audit-maroc",
  "artifacts/api-server",
  "lib/api-spec",
  "lib/api-client-react",
  "lib/api-zod",
  "lib/db",
  "scripts",
];

/**
 * Directories never packaged. `.git` and `node_modules` keep the archive
 * small; `dist`/`build` are rebuildable outputs.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".turbo",
  ".cache",
  ".vite",
]);

/**
 * Files never packaged. The `.env*` rule is a hard requirement: those files
 * hold real database credentials and must never ship inside a downloadable
 * archive. `.env.example` / `.env.local.example` are allow-listed above and
 * re-admitted explicitly below because they contain placeholders only.
 */
const ALLOWED_ENV_FILES = new Set([".env.example", ".env.local.example"]);

function isExcludedFile(name) {
  if (name === "mizan-code-source.zip") return true;
  if (name.endsWith(".tsbuildinfo")) return true;
  if (name.endsWith(".log")) return true;
  if (name.startsWith(".env") && !ALLOWED_ENV_FILES.has(name)) return true;
  return false;
}

/** Collects every packaged file as a repo-relative POSIX path, sorted. */
async function collect(entry) {
  const absolute = join(ROOT, entry);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    return [];
  }

  if (info.isFile()) {
    const name = entry.split("/").pop() ?? entry;
    return isExcludedFile(name) ? [] : [entry];
  }
  if (!info.isDirectory()) return [];

  const found = [];
  const walk = async (dir) => {
    for (const child of await readdir(dir, { withFileTypes: true })) {
      if (child.isDirectory()) {
        if (SKIP_DIRS.has(child.name)) continue;
        await walk(join(dir, child.name));
        continue;
      }
      if (!child.isFile()) continue;
      if (isExcludedFile(child.name)) continue;
      found.push(relative(ROOT, join(dir, child.name)).split(sep).join("/"));
    }
  };
  await walk(absolute);
  return found.sort();
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time pair used by the ZIP headers. */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      ((date.getHours() & 0x1f) << 11) |
      ((date.getMinutes() & 0x3f) << 5) |
      ((Math.floor(date.getSeconds() / 2)) & 0x1f),
    date:
      (((year - 1980) & 0x7f) << 9) |
      (((date.getMonth() + 1) & 0x0f) << 5) |
      (date.getDate() & 0x1f),
  };
}

async function main() {
  const files = [];
  for (const entry of INCLUDE) {
    files.push(...(await collect(entry)));
  }

  const unique = [...new Set(files)].sort();
  if (!unique.length) {
    throw new Error("Nothing to package: no source file matched the include list.");
  }
  if (unique.length > 0xffff) {
    throw new Error(`Too many entries for a non-Zip64 archive: ${unique.length}.`);
  }

  // Deterministic timestamp so an unchanged tree produces an identical archive.
  const stamp = dosDateTime(new Date(Date.UTC(2024, 0, 1, 0, 0, 0)));

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const path of unique) {
    const nameBytes = Buffer.from(path, "utf8");
    const content = await readFile(join(ROOT, path));
    const compressed = deflateRawSync(content, { level: 9 });
    // Deflate can expand incompressible input; store it raw in that case.
    const useDeflate = compressed.length < content.length;
    const payload = useDeflate ? compressed : content;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    localParts.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    // Unix mode 0644 in the high word. `>>> 0` because `<<` yields a signed
    // 32-bit value and 0o100644 << 16 overflows into the negative range.
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + payload.length;
    if (offset > 0xffffffff) {
      throw new Error("Archive exceeds the 4 GB non-Zip64 limit.");
    }
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(unique.length, 8);
  eocd.writeUInt16LE(unique.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  const archive = Buffer.concat([...localParts, centralDirectory, eocd]);

  await mkdir(dirname(OUTPUT), { recursive: true });
  await unlink(OUTPUT).catch(() => undefined);
  await writeFile(OUTPUT, archive);

  const digest = createHash("sha256").update(archive).digest("hex").slice(0, 12);
  process.stdout.write(
    `Created ${relative(ROOT, OUTPUT).split(sep).join("/")} ` +
      `(${unique.length} files, ${(archive.length / 1024).toFixed(0)} KiB, sha256:${digest})\n`,
  );
}

main().catch((error) => {
  console.error(`build-mizan-source-zip failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
