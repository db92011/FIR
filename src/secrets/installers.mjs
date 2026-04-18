import fs from "node:fs";
import path from "node:path";
import { ensureDir, fileExists, readText } from "../utils.mjs";

function parseEnv(content = "") {
  const rows = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) {
      rows.push({ type: "entry", key: match[1], value: match[2] });
    } else {
      rows.push({ type: "raw", value: line });
    }
  }
  return rows;
}

function quoteEnvValue(rawValue) {
  return JSON.stringify(String(rawValue));
}

export function writeEnvValue(filePath, key, rawValue) {
  ensureDir(path.dirname(filePath));
  const existing = fileExists(filePath) ? readText(filePath, "") : "";
  const rows = parseEnv(existing);
  const rendered = `${key}=${quoteEnvValue(rawValue)}`;
  let replaced = false;
  const nextRows = rows.map((row) => {
    if (row.type === "entry" && row.key === key) {
      replaced = true;
      return rendered;
    }
    return row.type === "entry" ? `${row.key}=${row.value}` : row.value;
  });
  if (!replaced) {
    if (nextRows.length && nextRows.at(-1) !== "") nextRows.push("");
    nextRows.push(rendered);
  }
  const finalText = `${nextRows.join("\n").replace(/\n+$/g, "")}\n`;
  ensureDir(path.dirname(filePath));
  return finalText;
}

export function installSecretValue(install = {}, rawValue) {
  if (install.type !== "env_file") {
    return {
      type: install.type || "unknown",
      status: "skipped",
      message: "Unsupported install type for FIR secret installer.",
    };
  }
  const content = writeEnvValue(install.path, install.key || install.name, rawValue);
  ensureDir(path.dirname(install.path));
  fs.writeFileSync(install.path, content, "utf8");
  return {
    type: "env_file",
    status: "installed",
    path: install.path,
    key: install.key || install.name,
  };
}
