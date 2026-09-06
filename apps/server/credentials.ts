import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import type { Connection } from "../../packages/domain";

let keys: Record<string, string> = {};
let filename = "";
export function loadCredentials(root: string) {
  filename = join(root, "credentials.json");
  keys = existsSync(filename) ? JSON.parse(readFileSync(filename, "utf8")) : {};
  if (existsSync(filename)) chmodSync(filename, 0o600);
}
export function saveCredential(connectionId: string, key: string) {
  if (!filename) throw Error("密钥存储尚未初始化");
  const next = { ...keys, [connectionId]: key };
  const temp = filename + ".tmp";
  writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, filename);
  keys = next;
}
export function getCredential(c: Connection) {
  return keys[c.id] || process.env[c.keyEnv];
}
