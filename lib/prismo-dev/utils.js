const fs = require("fs");
const path = require("path");

const { BINARY_EXTENSIONS } = require("./constants");

function shouldUseColor() {
  return process.stdout.isTTY && !process.env.NO_COLOR;
}

const colorCodes = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
};

function color(text, tone, enabled = shouldUseColor()) {
  if (!enabled || !colorCodes[tone]) return text;
  return `${colorCodes[tone]}${text}${colorCodes.reset}`;
}

function severityIcon(severity) {
  if (severity === "critical") return "[critical]";
  if (severity === "high") return "[high]";
  if (severity === "medium") return "[medium]";
  return "[low]";
}

function severityColor(severity) {
  if (severity === "critical" || severity === "high") return "red";
  if (severity === "medium") return "yellow";
  return "cyan";
}

function printStep(label, json = false) {
  if (json) return () => {};
  process.stderr.write(`${color("...", "cyan")} ${label}`);
  return (status = "done") => {
    process.stderr.write(` ${color(`[${status}]`, status === "done" ? "green" : "yellow")}\n`);
  };
}

function estimateTokens(textOrBytes) {
  const length = typeof textOrBytes === "string" ? textOrBytes.length : Number(textOrBytes || 0);
  return Math.ceil(length / 4);
}

function readIfText(filePath, maxBytes = 2 * 1024 * 1024) {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return null;

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > maxBytes) return null;

  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

module.exports = {
  color,
  estimateTokens,
  printStep,
  readIfText,
  safeReadJson,
  severityColor,
  severityIcon,
  shouldUseColor,
};
