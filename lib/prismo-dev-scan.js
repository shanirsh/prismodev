const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { execSync, spawnSync } = require("child_process");
const { version: PACKAGE_VERSION } = require("../package.json");

function openUrl(url) {
  try {
    const cmd = process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "start"
      : "xdg-open";
    execSync(`${cmd} ${JSON.stringify(url)}`, { stdio: "ignore" });
  } catch (_) {}
}

const {
  HIGH_RISK_DIRS,
  HIGH_RISK_FILE_NAMES,
  BINARY_EXTENSIONS,
  SOURCE_EXTENSIONS,
  INSTRUCTION_FILES,
  DEFAULT_CLAUDEIGNORE,
  NPX_COMMAND,
  DEFAULT_PRISMO_PROXY_URL,
  CLAUDE_PRICING,
  DEFAULT_CLAUDE_PRICING_KEY,
  GENERATED_ARTIFACT_PATTERNS,
} = require("./prismo-dev/constants");

const {
  color,
  estimateTokens,
  printStep,
  readIfText,
  safeReadJson,
  severityColor,
  severityIcon,
} = require("./prismo-dev/utils");

let scanRepo;

const {
  createOptimizeContext,
  detectFrameworks,
  getContextFileForScope,
  renderContextCommand,
  renderOptimizeTerminal,
  renderStarterPrompt,
  runOptimize,
} = require("./prismo-dev/context-optimize")({
  fs,
  path,
  NPX_COMMAND,
  scanRepo: (...args) => scanRepo(...args),
  safeReadJson,
  readIfText,
  formatBytes: (...args) => formatBytes(...args),
  color,
  writeGeneratedFile: (...args) => writeGeneratedFile(...args),
});

const {
  analyzeSessionFile,
  analyzeCursorSessions,
  buildCursorDiagnosis,
  buildCursorSessionTimeline,
  buildMultiAgentView,
  calculateClaudeCost,
  compactUsageSummary,
  formatMoney,
  formatTokenCount,
  getClaudeCodeCostSummary,
  getClaudeSessionFiles,
  getCodexSessionFiles,
  getCursorSessionSummary,
  getUsageSummary,
  getPositionals,
  parsePositiveInt,
  parseScopeAndTarget,
  renderClaudeCostTerminal,
  renderCursorTerminal,
  renderUsageTerminal,
  renderContextThrottle,
  renderRescuePrompt,
  renderLiveGuardrails,
  renderWatchReport,
  renderWatchTerminal,
  toWatchJsonPayload,
  watchUsage,
  buildWatchEvent,
  writeContextThrottle,
  writeLiveGuardrails,
  writeWatchEvent,
  writeWatchReport,
} = require("./prismo-dev/usage-watch")({
  fs,
  os,
  path,
  NPX_COMMAND,
  CLAUDE_PRICING,
  DEFAULT_CLAUDE_PRICING_KEY,
  GENERATED_ARTIFACT_PATTERNS,
  readIfText,
  estimateTokens,
  color,
  writeGeneratedFile: (...args) => writeGeneratedFile(...args),
});

const scanApi = require("./prismo-dev/scan")({
  fs,
  http,
  https,
  os,
  path,
  HIGH_RISK_DIRS,
  HIGH_RISK_FILE_NAMES,
  BINARY_EXTENSIONS,
  SOURCE_EXTENSIONS,
  INSTRUCTION_FILES,
  DEFAULT_CLAUDEIGNORE,
  NPX_COMMAND,
  estimateTokens,
  readIfText,
  detectFrameworks,
  getUsageSummary,
  getClaudeSessionFiles,
  getCodexSessionFiles,
  compactUsageSummary,
  formatTokenCount,
  color,
});

({ scanRepo } = scanApi);
const {
  calculateReductionPercent,
  chooseRecommendedScope,
  estimateExposedContextTokens,
  formatBytes,
  getNextCommands,
  getTopTokenLeaks,
  renderSetupTerminal,
  runSetup,
  toJsonPayload,
} = scanApi;

const {
  backupIfExists,
  evaluateCi,
  renderCiReport,
  renderMarkdownReport,
  renderOptimizerFitTerminal,
  renderReportCardTerminal,
  renderSimpleScanReport,
  renderTerminalReport,
  writeReport,
} = require("./prismo-dev/report")({
  fs,
  path,
  NPX_COMMAND,
  color,
  severityIcon,
  severityColor,
  estimateTokens,
  formatBytes,
  formatTokenCount,
  getNextCommands,
});

const { appendIgnoreSuggestions, applyFixes } = require("./prismo-dev/fixes")({
  fs,
  path,
  backupIfExists,
  writeReport,
});

function writeGeneratedFile(root, relPath, contents) {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  // Periodic regenerations (connector auto-detect every few minutes) must
  // not churn backups when nothing changed.
  try {
    if (fs.existsSync(fullPath) && fs.readFileSync(fullPath, "utf8") === contents) {
      return { path: relPath, backupPath: null, unchanged: true };
    }
  } catch {}
  const backupPath = backupIfExists(fullPath);
  fs.writeFileSync(fullPath, contents, "utf8");
  return { path: relPath, backupPath };
}

const {
  renderDemoTerminal,
  renderDevTerminal,
  renderDoctorTerminal,
  renderInitTerminal,
  runDevFlow,
  runDoctor,
  runInit,
  toDoctorJsonPayload,
} = require("./prismo-dev/doctor")({
  fs,
  path,
  NPX_COMMAND,
  color,
  applyFixes,
  appendIgnoreSuggestions,
  calculateReductionPercent,
  chooseRecommendedScope,
  createOptimizeContext,
  estimateExposedContextTokens,
  formatTokenCount,
  getContextFileForScope,
  getNextCommands,
  getTopTokenLeaks,
  renderContextCommand,
  renderStarterPrompt,
  runOptimize,
  safeReadJson,
  scanRepo: (...args) => scanRepo(...args),
  writeGeneratedFile,
  backupIfExists,
  printStep,
});

const {
  renderFirewallTerminal,
  runFirewall,
  runTimelineFirewallSuggestions,
} = require("./prismo-dev/firewall")({
  fs,
  path,
  NPX_COMMAND,
  createOptimizeContext,
  writeGeneratedFile,
});

const {
  renderShieldLastTerminal,
  renderShieldSearchTerminal,
  renderShieldTerminal,
  runShieldLast,
  runShieldSearch,
  runShield,
} = require("./prismo-dev/shield")({
  fs,
  path,
  estimateTokens,
  formatBytes: (...args) => formatBytes(...args),
  color,
});

const {
  renderBenchmarkTerminal,
  runBenchmark,
} = require("./prismo-dev/benchmark")({
  NPX_COMMAND,
  estimateTokens,
  formatTokenCount,
  getUsageSummary,
  runShield,
  scanRepo: (...args) => scanRepo(...args),
  color,
});

const {
  buildReceipt,
  renderReceiptTerminal,
} = require("./prismo-dev/receipt")({
  fs,
  path,
  GENERATED_ARTIFACT_PATTERNS,
  NPX_COMMAND,
  formatTokenCount,
  getUsageSummary,
  readIfText,
});

const {
  buildSyncPayload,
  estimateWaste,
  loadConfig,
  renderConnectTerminal,
  renderDigestTerminal,
  renderDisconnectTerminal,
  renderStatusTerminal,
  renderSyncTerminal,
  runConnect,
  runDigest,
  runDisconnect,
  runStatus,
  runSync,
} = require("./prismo-dev/cloud-sync")({
  fs,
  http,
  https,
  os,
  path,
  PACKAGE_VERSION,
  NPX_COMMAND,
  getUsageSummary,
  scanRepo: (...args) => scanRepo(...args),
});

const {
  renderGuardTerminal,
  runGuard,
} = require("./prismo-dev/guard")({
  fs,
  http,
  https,
  os,
  path,
  PACKAGE_VERSION,
  NPX_COMMAND,
  getUsageSummary,
  buildWatchEvent,
  writeContextThrottle,
  writeLiveGuardrails,
  writeWatchEvent,
  runFirewall,
  loadConfig,
});

const repairExecutors = require("./prismo-dev/repair-executors")({
  fs,
  path,
  NPX_COMMAND,
  runDoctor,
  runOptimize,
  runGuard,
  runShield,
  runFirewall,
  getUsageSummary,
  appendIgnoreSuggestions,
});
const {
  REPAIR_CAUSES,
  renderRepairTerminal,
  runRepair,
} = repairExecutors;

const {
  decidePostToolUse,
  decidePreToolUse,
  renderEnforceTerminal,
  runEnforceInstall,
  runEnforceStatus,
  runEnforceUninstall,
} = require("./prismo-dev/enforce")({
  fs,
  path,
  NPX_COMMAND,
  runFirewall,
});

const {
  buildSessionsView,
  renderSessionsTerminal,
  buildLocalReport,
  renderLocalReportTerminal,
} = require("./prismo-dev/sessions-report")({
  path,
  getUsageSummary,
  estimateWaste,
  formatTokenCount,
});

const repairPlanner = require("./prismo-dev/repair-planner")({
  fs,
  path,
  NPX_COMMAND,
  getUsageSummary,
  estimateWaste,
  repairExecutors,
});
const {
  renderPlannerTerminal,
  runPlannerOnce,
} = repairPlanner;

const {
  renderAgentTerminal,
  runAgent,
  registerSelfRepair,
  VALID_MODES: AGENT_VALID_MODES,
} = require("./prismo-dev/agent")({
  fs,
  http,
  https,
  path,
  PACKAGE_VERSION,
  NPX_COMMAND,
  loadConfig,
  runDoctor,
  runSync,
  runGuard,
  runShield,
  runOptimize,
  openUrl,
  repairExecutors,
  repairPlanner,
  getUsageSummary,
});

const {
  renderConnectorTerminal,
  runConnectorInstall,
  runConnectorStart,
  runConnectorStatus,
  runConnectorStop,
  runConnectorUninstall,
} = require("./prismo-dev/connector")({
  fs,
  os,
  path,
  spawnSync,
  NPX_COMMAND,
});

const {
  buildInstructionsAblationPlan,
  buildInstructionsApply,
  buildInstructionsAudit,
  renderInstructionsAblationTerminal,
  renderInstructionsApplyTerminal,
  renderInstructionsAuditTerminal,
} = require("./prismo-dev/instructions")({
  fs,
  path,
  INSTRUCTION_FILES,
  NPX_COMMAND,
  estimateTokens,
  formatTokenCount,
  getUsageSummary,
  readIfText,
});

const {
  buildMultiSessionTimeline,
  renderMultiSessionTimelineTerminal,
} = require("./prismo-dev/timeline")({
  fs,
  path,
  GENERATED_ARTIFACT_PATTERNS,
  NPX_COMMAND,
  formatTokenCount,
  getUsageSummary,
  readIfText,
});

const {
  buildReplay,
  renderReplayTerminal,
} = require("./prismo-dev/replay")({
  NPX_COMMAND,
  buildMultiSessionTimeline,
  buildReceipt,
  formatTokenCount,
});

const {
  buildBoundaryCheck,
  renderBoundaryTerminal,
} = require("./prismo-dev/boundaries")({
  NPX_COMMAND,
  buildMultiAgentView,
  getUsageSummary,
});

const {
  renderMcpDoctorTerminal,
  runMcpDoctor,
  runMcpServer,
} = require("./prismo-dev/mcp");

const { runCli } = require("./prismo-dev/cli")({
  PACKAGE_VERSION,
  NPX_COMMAND,
  DEFAULT_PRISMO_PROXY_URL,
  AGENT_VALID_MODES,
  registerSelfRepair,
  openUrl,
  printStep,
  getPositionals,
  parsePositiveInt,
  parseScopeAndTarget,
  applyFixes,
  createOptimizeContext,
  getContextFileForScope,
  renderContextCommand,
  renderStarterPrompt,
  renderOptimizeTerminal,
  runOptimize,
  renderDemoTerminal,
  renderDevTerminal,
  renderDoctorTerminal,
  renderInitTerminal,
  runDevFlow,
  runDoctor,
  runInit,
  toDoctorJsonPayload,
  renderFirewallTerminal,
  runFirewall,
  runTimelineFirewallSuggestions,
  renderShieldLastTerminal,
  renderShieldSearchTerminal,
  renderShieldTerminal,
  runShieldLast,
  runShieldSearch,
  runShield,
  renderBenchmarkTerminal,
  runBenchmark,
  renderReceiptTerminal,
  buildReceipt,
  renderConnectTerminal,
  renderDigestTerminal,
  renderDisconnectTerminal,
  renderStatusTerminal,
  renderSyncTerminal,
  runConnect,
  runDigest,
  runDisconnect,
  runStatus,
  runSync,
  buildSessionsView,
  renderSessionsTerminal,
  buildLocalReport,
  renderLocalReportTerminal,
  renderGuardTerminal,
  runGuard,
  REPAIR_CAUSES,
  renderRepairTerminal,
  runRepair,
  renderPlannerTerminal,
  runPlannerOnce,
  decidePostToolUse,
  decidePreToolUse,
  renderEnforceTerminal,
  runEnforceInstall,
  runEnforceStatus,
  runEnforceUninstall,
  renderAgentTerminal,
  runAgent,
  renderConnectorTerminal,
  runConnectorInstall,
  runConnectorStart,
  runConnectorStatus,
  runConnectorStop,
  runConnectorUninstall,
  renderInstructionsAblationTerminal,
  renderInstructionsApplyTerminal,
  renderInstructionsAuditTerminal,
  buildInstructionsAblationPlan,
  buildInstructionsApply,
  buildInstructionsAudit,
  renderMultiSessionTimelineTerminal,
  buildMultiSessionTimeline,
  renderReplayTerminal,
  buildReplay,
  renderBoundaryTerminal,
  buildBoundaryCheck,
  renderMcpDoctorTerminal,
  runMcpDoctor,
  runMcpServer,
  renderSetupTerminal,
  runSetup,
  renderClaudeCostTerminal,
  getClaudeCodeCostSummary,
  renderCursorTerminal,
  getCursorSessionSummary,
  getUsageSummary,
  compactUsageSummary,
  renderUsageTerminal,
  watchUsage,
  scanRepo,
  toJsonPayload,
  evaluateCi,
  renderCiReport,
  renderTerminalReport,
  renderSimpleScanReport,
  renderOptimizerFitTerminal,
  renderReportCardTerminal,
  writeReport,
  formatBytes,
  formatTokenCount,
  buildMultiAgentView,
  buildSyncPayload,
  loadConfig,
});

module.exports = {
  applyFixes,
  estimateTokens,
  renderMarkdownReport,
  renderBoundaryTerminal,
  renderSimpleScanReport,
  renderClaudeCostTerminal,
  renderCursorTerminal,
  renderInstructionsAblationTerminal,
  renderInstructionsApplyTerminal,
  renderInstructionsAuditTerminal,
  renderConnectTerminal,
  renderDisconnectTerminal,
  renderGuardTerminal,
  renderMultiSessionTimelineTerminal,
  renderReceiptTerminal,
  renderReplayTerminal,
  renderStatusTerminal,
  renderSyncTerminal,
  renderUsageTerminal,
  renderContextThrottle,
  renderRescuePrompt,
  renderLiveGuardrails,
  renderWatchTerminal,
  renderWatchReport,
  renderTerminalReport,
  renderOptimizerFitTerminal,
  renderReportCardTerminal,
  renderDoctorTerminal,
  renderInitTerminal,
  runSetup,
  runOptimize,
  runBenchmark,
  runDoctor,
  runInit,
  runCli,
  scanRepo,
  getClaudeCodeCostSummary,
  getCursorSessionSummary,
  buildBoundaryCheck,
  buildInstructionsAblationPlan,
  buildInstructionsApply,
  buildReceipt,
  buildSyncPayload,
  buildInstructionsAudit,
  buildMultiSessionTimeline,
  buildReplay,
  runConnect,
  runDisconnect,
  runGuard,
  runRepair,
  renderRepairTerminal,
  REPAIR_CAUSES,
  runPlannerOnce,
  renderPlannerTerminal,
  decidePostToolUse,
  decidePreToolUse,
  renderEnforceTerminal,
  runEnforceInstall,
  runEnforceStatus,
  runEnforceUninstall,
  runConnectorInstall,
  runConnectorStart,
  runConnectorStatus,
  runConnectorStop,
  runConnectorUninstall,
  runStatus,
  runSync,
  getUsageSummary,
  analyzeCursorSessions,
  analyzeSessionFile,
  calculateClaudeCost,
  toDoctorJsonPayload,
  toJsonPayload,
  toWatchJsonPayload,
  watchUsage,
  writeWatchReport,
  writeReport,
};
