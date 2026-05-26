module.exports = function createInstructionsAudit(deps) {
  const {
    fs,
    path,
    INSTRUCTION_FILES,
    NPX_COMMAND,
    estimateTokens,
    formatTokenCount,
    getUsageSummary,
    readIfText,
  } = deps;

  const RULE_KEYWORDS = [
    "test", "tests", "pytest", "npm", "shield", "log", "logs", "dist", "build", "coverage",
    "package-lock", "lockfile", "lockfiles", "node_modules", "generated", "artifact", "cache",
    "read", "grep", "search", "edit", "diff", "commit", "auth", "frontend", "backend", "api",
    "database", "migration", "security", "lint", "format", "typescript", "python",
  ];

  function normalizeRule(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[`*_#>\-[\]().,:;]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function ruleKeywords(rule) {
    const normalized = normalizeRule(rule);
    return RULE_KEYWORDS.filter((keyword) => normalized.includes(keyword));
  }

  function extractRules(file) {
    const lines = file.text.split(/\r?\n/);
    const rules = [];
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (/^#{1,6}\s+/.test(trimmed)) return;
      if (/^[-*]\s*$/.test(trimmed)) return;
      if (/^```/.test(trimmed)) return;
      if (trimmed.length < 8) return;
      const cleaned = trimmed
        .replace(/^[-*]\s+/, "")
        .replace(/^\d+[.)]\s+/, "")
        .trim();
      if (cleaned.length < 8) return;
      rules.push({
        id: `${file.path}:${index + 1}`,
        file: file.path,
        line: index + 1,
        text: cleaned,
        tokens: estimateTokens(cleaned),
        keywords: ruleKeywords(cleaned),
        normalized: normalizeRule(cleaned),
      });
    });
    return rules;
  }

  function readInstructionFiles(root) {
    const files = [];
    for (const rel of INSTRUCTION_FILES.filter((item) => !["README.md", "README"].includes(item))) {
      const fullPath = path.join(root, rel);
      if (!fs.existsSync(fullPath)) continue;
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;
      const text = readIfText(fullPath) || "";
      files.push({
        path: rel,
        size: stat.size,
        tokens: estimateTokens(text || stat.size),
        text,
      });
    }
    return files;
  }

  function sessionEvidence(usage) {
    const sessions = usage?.sessions || [];
    const evidenceText = [];
    let toolOutputTokens = 0;
    let generatedArtifactMentions = 0;
    let repeatedReadMentions = 0;
    let repeatedCommandMentions = 0;
    let failureMentions = 0;
    let loopSessions = 0;
    for (const session of sessions) {
      toolOutputTokens += Number(session.estimatedToolTokens || 0);
      failureMentions += Number(session.failureMentions || 0);
      if (session.loopSuspicion) loopSessions += 1;
      for (const item of session.repeatedPathMentions || []) {
        evidenceText.push(item.value);
        repeatedReadMentions += Number(item.count || 0);
      }
      for (const item of session.generatedArtifacts || []) {
        evidenceText.push(item.value);
        generatedArtifactMentions += Number(item.count || 0);
      }
      for (const item of session.repeatedCommands || []) {
        evidenceText.push(item.value);
        repeatedCommandMentions += Number(item.count || 0);
      }
    }
    return {
      sessions,
      text: normalizeRule(evidenceText.join(" ")),
      toolOutputTokens,
      generatedArtifactMentions,
      repeatedReadMentions,
      repeatedCommandMentions,
      failureMentions,
      loopSessions,
    };
  }

  function normalizeEvidenceTerm(value) {
    return normalizeRule(String(value || "").replace(/['"`]/g, ""));
  }

  function extractRuleTerms(ruleText) {
    const source = String(ruleText || "");
    const terms = [];
    const pathPattern = /(?:[\w.@-]+\/)+[\w.@+-]+\.[A-Za-z0-9]{1,12}|[\w.@+-]+\.[A-Za-z0-9]{1,12}/g;
    for (const match of source.matchAll(pathPattern)) terms.push(match[0]);

    const beforeEditMatch = source.match(/\b(?:edit|editing|change|changing|modify|modifying|touch|touching)\s+([A-Za-z0-9_./@-]+(?:\s+[A-Za-z0-9_./@-]+){0,2})/i);
    if (beforeEditMatch) terms.push(beforeEditMatch[1]);

    return Array.from(new Set(terms.map(normalizeEvidenceTerm).filter((term) => term.length >= 3)));
  }

  function getRitualComplianceSignal(rule, evidence) {
    const text = rule.normalized;
    const asksReadBeforeEdit =
      /\b(?:always|must|first|before|prior to)\b/.test(text) &&
      /\b(?:read|review|check|inspect|open)\b/.test(text) &&
      /\b(?:before|prior to)\b/.test(text) &&
      /\b(?:edit|editing|change|changing|modify|modifying|touch|touching)\b/.test(text);
    if (!asksReadBeforeEdit) return null;

    const terms = extractRuleTerms(rule.text);
    if (terms.length < 2) return null;

    const matchedTerms = terms.filter((term) => evidence.text.includes(term));
    const enoughRitualEvidence = matchedTerms.length >= 2;
    const outcomeStillNoisy =
      evidence.failureMentions > 0 ||
      evidence.repeatedCommandMentions >= 3 ||
      evidence.toolOutputTokens >= 25000 ||
      evidence.loopSessions > 0;

    if (!enoughRitualEvidence || !outcomeStillNoisy) return null;
    return {
      terms,
      matchedTerms,
      reason: "read-before-edit ritual appeared in session evidence, but noisy/failing session evidence suggests it may not have constrained the final work",
    };
  }

  function classifyRule(rule, evidence, duplicateCount) {
    const text = rule.normalized;
    const evidenceHits = rule.keywords.filter((keyword) => evidence.text.includes(keyword));
    const concerns = [];
    const signals = [];

    if (duplicateCount > 1) concerns.push("duplicate");
    if (rule.tokens > 80) concerns.push("verbose");
    if (rule.keywords.length === 0) concerns.push("low-signal");
    if (/(always|never|must|do not|don't|avoid)/i.test(rule.text)) signals.push("directive");

    const asksNoArtifacts = /(do not|don't|avoid|never|ignore|exclude).*(generated|artifact|dist|build|coverage|node_modules|lockfile|package-lock|logs?)/i.test(rule.text);
    const asksNoOutputFlood = /(shield|summarize|avoid|do not|don't|never).*(output|logs?|stdout|stderr|command)/i.test(rule.text);
    const asksNarrowReads = /(small|narrow|scoped|focused|avoid broad|do not read|don't read).*(read|search|grep|context|file)/i.test(rule.text);

    if (asksNoArtifacts && evidence.generatedArtifactMentions > 0) concerns.push("violated-by-session-evidence");
    if (asksNoOutputFlood && evidence.toolOutputTokens >= 25000) concerns.push("violated-by-session-evidence");
    if (asksNarrowReads && evidence.repeatedReadMentions >= 10) concerns.push("violated-by-session-evidence");

    if (evidenceHits.length) signals.push("session-correlated");
    if (asksNoArtifacts || asksNoOutputFlood || asksNarrowReads) signals.push("guardrail");
    const ritualCompliance = getRitualComplianceSignal(rule, evidence);
    if (ritualCompliance) {
      concerns.push("paraphrased-not-applied");
      signals.push("ritual-compliance");
    }

    let status = "unclear";
    let recommendation = "Keep for now, but review after more sessions.";
    let score = 35;

    if (concerns.includes("violated-by-session-evidence")) {
      status = "observably-violated";
      score = 15;
      recommendation = `Keep the intent, but move it into a live guardrail/firewall or make it more enforceable; session evidence shows a measurable violation.`;
    } else if (concerns.includes("paraphrased-not-applied")) {
      status = "partial-compliance";
      score = 40;
      recommendation = "Rewrite this as an observable acceptance check; the session appears to perform the read/check ritual but still shows failure or noisy follow-through.";
    } else if (signals.includes("session-correlated") && signals.includes("directive")) {
      status = "pulling-weight";
      score = 80;
      recommendation = "Keep this rule; it maps to observed session behavior.";
    } else if (signals.includes("guardrail")) {
      status = "guardrail-no-recent-violation";
      score = 65;
      recommendation = "Keep, but consider moving task-specific parts into a firewall/context pack.";
    } else if (concerns.includes("duplicate")) {
      status = "duplicate";
      score = 25;
      recommendation = "Deduplicate this rule so it is paid for once, not in every instruction file.";
    } else if (concerns.includes("low-signal")) {
      status = "influence-unknown";
      score = 45;
      recommendation = "Do not prune automatically. This rule has no grep-able behavioral signal; use A/B ablation or rewrite it into observable instructions.";
    } else if (rule.tokens > 80) {
      status = "trim-candidate";
      score = 30;
      recommendation = "Shorten this rule or move details into a task-specific context pack.";
    }

    return {
      ...rule,
      score,
      status,
      signals,
      concerns,
      evidenceHits,
      partialCompliance: ritualCompliance || null,
      recommendation,
    };
  }

  function buildInstructionsAudit(options = {}) {
    const root = options.cwd || process.cwd();
    const limit = options.limit || 20;
    const files = readInstructionFiles(root);
    const rules = files.flatMap(extractRules);
    const duplicates = new Map();
    for (const rule of rules) {
      duplicates.set(rule.normalized, (duplicates.get(rule.normalized) || 0) + 1);
    }
    const usage = getUsageSummary({ cwd: root, tool: options.tool || "all", limit });
    const evidence = sessionEvidence(usage);
    const auditedRules = rules.map((rule) => classifyRule(rule, evidence, duplicates.get(rule.normalized) || 0));

    const byStatus = {};
    for (const rule of auditedRules) byStatus[rule.status] = (byStatus[rule.status] || 0) + 1;
    const prunable = auditedRules.filter((rule) => ["observably-violated", "duplicate", "trim-candidate"].includes(rule.status));
    const partialCompliance = auditedRules.filter((rule) => rule.status === "partial-compliance");
    const influenceUnknown = auditedRules.filter((rule) => rule.status === "influence-unknown");
    const pullingWeight = auditedRules.filter((rule) => rule.status === "pulling-weight" || rule.status === "guardrail-no-recent-violation");
    const duplicatedRules = auditedRules.filter((rule) => (duplicates.get(rule.normalized) || 0) > 1);
    const prunableTokensPerLoad = prunable.reduce((sum, rule) => sum + Number(rule.tokens || 0), 0);
    const sortedPrunable = prunable.sort((a, b) => a.score - b.score || b.tokens - a.tokens);

    return {
      schemaVersion: 1,
      command: "instructions audit",
      generatedAt: new Date().toISOString(),
      scannedPath: root,
      confidence: usage.confidence,
      files: files.map((file) => ({ path: file.path, tokens: file.tokens, size: file.size })),
      sessionsAnalyzed: evidence.sessions.length,
      evidence: {
        sources: usage.sources || [],
        toolOutputTokens: evidence.toolOutputTokens,
        generatedArtifactMentions: evidence.generatedArtifactMentions,
        repeatedReadMentions: evidence.repeatedReadMentions,
        repeatedCommandMentions: evidence.repeatedCommandMentions,
        failureMentions: evidence.failureMentions,
        loopSessions: evidence.loopSessions,
      },
      summary: {
        totalRules: auditedRules.length,
        byStatus,
        prunableCandidates: prunable.length,
        partialCompliance: partialCompliance.length,
        influenceUnknown: influenceUnknown.length,
        duplicatedRules: duplicatedRules.length,
        prunableTokensPerLoad,
        deadWeightCandidates: prunable.length,
        wastedTokensPerLoad: prunableTokensPerLoad,
      },
      pullingWeight: pullingWeight.sort((a, b) => b.score - a.score).slice(0, 10),
      prunable: sortedPrunable.slice(0, 20),
      partialCompliance: partialCompliance.sort((a, b) => a.score - b.score || b.tokens - a.tokens).slice(0, 20),
      influenceUnknown: influenceUnknown.sort((a, b) => b.tokens - a.tokens).slice(0, 20),
      deadWeight: sortedPrunable.slice(0, 20),
      rules: auditedRules,
      next: [
        prunable.length ? "Fix observably violated, duplicate, or trim-safe rules first." : "No safely prunable rules detected yet.",
        partialCompliance.length ? "Rewrite partial-compliance rules as observable acceptance checks." : null,
        influenceUnknown.length ? "Treat influence-unknown rules as A/B ablation candidates, not safe deletes." : null,
        duplicatedRules.length ? "Deduplicate repeated rules across CLAUDE.md / AGENTS.md / Codex instruction files." : null,
        evidence.sessions.length < 5 ? "Run this again after more sessions; multi-session evidence makes instruction ROI stronger." : null,
        `${NPX_COMMAND} firewall <task> for rules that only matter in one workflow.`,
      ].filter(Boolean),
    };
  }

  function renderInstructionsAuditTerminal(audit) {
    const lines = [];
    lines.push("");
    lines.push("Prismo Instruction ROI Audit");
    lines.push("");
    if (!audit.files.length) {
      lines.push("No instruction files found.");
      lines.push("Checked: CLAUDE.md, AGENTS.md, .codex/*, .openai/instructions.md");
      return lines.join("\n");
    }
    lines.push(`Files: ${audit.files.map((file) => `${file.path} (${formatTokenCount(file.tokens)} tokens)`).join(", ")}`);
    lines.push(`Rules: ${audit.summary.totalRules}`);
    lines.push(`Sessions analyzed: ${audit.sessionsAnalyzed}`);
    lines.push(`Safely prunable candidates: ${audit.summary.prunableCandidates} (~${formatTokenCount(audit.summary.prunableTokensPerLoad)} tokens/load)`);
    lines.push(`Partial compliance: ${audit.summary.partialCompliance}`);
    lines.push(`Influence unknown: ${audit.summary.influenceUnknown}`);
    lines.push(`Duplicates: ${audit.summary.duplicatedRules}`);
    lines.push("");
    lines.push("Pulling Weight");
    if (audit.pullingWeight.length) {
      audit.pullingWeight.slice(0, 5).forEach((rule) => {
        lines.push(`- ${rule.file}:${rule.line} [${rule.status}] ${rule.text}`);
      });
    } else {
      lines.push("- No high-confidence useful rules detected yet.");
    }
    lines.push("");
    lines.push("Safely Prunable / Rewrite Candidates");
    if (audit.prunable.length) {
      audit.prunable.slice(0, 8).forEach((rule) => {
        lines.push(`- ${rule.file}:${rule.line} [${rule.status}] ${rule.text}`);
        lines.push(`  ${rule.recommendation}`);
      });
    } else {
      lines.push("- No obvious candidates.");
    }
    lines.push("");
    lines.push("Partial Compliance / Ritual Without Proof");
    if (audit.partialCompliance.length) {
      audit.partialCompliance.slice(0, 6).forEach((rule) => {
        lines.push(`- ${rule.file}:${rule.line} [${rule.status}] ${rule.text}`);
        if (rule.partialCompliance?.matchedTerms?.length) {
          lines.push(`  Matched: ${rule.partialCompliance.matchedTerms.join(", ")}`);
        }
        lines.push(`  ${rule.recommendation}`);
      });
    } else {
      lines.push("- None detected.");
    }
    lines.push("");
    lines.push("Influence Unknown / A-B Candidates");
    if (audit.influenceUnknown.length) {
      audit.influenceUnknown.slice(0, 6).forEach((rule) => {
        lines.push(`- ${rule.file}:${rule.line} [${rule.status}] ${rule.text}`);
        lines.push(`  ${rule.recommendation}`);
      });
    } else {
      lines.push("- None detected.");
    }
    lines.push("");
    lines.push("Next");
    audit.next.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    return lines.join("\n");
  }

  return {
    buildInstructionsAudit,
    renderInstructionsAuditTerminal,
  };
};
