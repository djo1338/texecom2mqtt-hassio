// Extracts the JavaScript bundle embedded in the upstream texecom2mqtt binary
// (a Node.js single executable application).
//
//   docker create --name t2m dchesterton/texecom2mqtt:1.3.1
//   docker cp t2m:/app/app/dist/texecom2mqtt ./texecom2mqtt.bin
//   docker rm t2m
//   node tools/extract-bundle.mjs texecom2mqtt.bin app/dist/texecom2mqtt.js
//
// The SEA blob stores the main script name followed by its length as a
// little-endian uint64, then the script itself.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [, , binFile, outFile] = process.argv;
if (!binFile || !outFile) {
  console.error("usage: node tools/extract-bundle.mjs <binary> <out.js>");
  process.exit(2);
}

const bin = readFileSync(binFile);
const name = Buffer.from("texecom2mqtt.js");
let found;
for (let i = bin.indexOf(name); i !== -1; i = bin.indexOf(name, i + 1)) {
  const lenAt = i + name.length;
  if (lenAt + 8 > bin.length) break;
  const len = Number(bin.readBigUInt64LE(lenAt));
  const start = lenAt + 8;
  if (len > 0 && start + len <= bin.length && bin.subarray(start, start + 13).toString() === '"use strict";') {
    found = bin.subarray(start, start + len);
    break;
  }
}
if (!found) {
  console.error("could not find the embedded texecom2mqtt.js bundle");
  process.exit(1);
}
writeFileSync(outFile, found);
console.log(`${outFile}: ${found.length} bytes, sha256 ${createHash("sha256").update(found).digest("hex")}`);
