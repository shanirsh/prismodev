module.exports = function createReplay(deps) {
  const {
    NPX_COMMAND,
    buildMultiSessionTimeline,
    buildReceipt,
    formatTokenCount,
  } = deps;

  function classifyIncident(receipt, timeline) {
    const primary = receipt.primary;
    if (!primary) {
      return {
        type: "no-session",
        severity: "low",
        summary: "No local coding-agent sessions were found for this repo.",
      };
    }
    if (primary.rootCause.cause === "tool-output-flood") {
      return {
        type: "tool-output-spiral",
        severity: primary.tokens.toolOutput >= 200000 ? "high" : "medium",
        summary: "Tool output dominated the session and likely crowded out useful working state.",
      };
    }
    if (primary.outputReceipt.loopSuspicion) {
      return {
        type: "command-loop",
        severity: primary.outputReceipt.loopConfidence === "high" ? "high" : "medium",
        summary: "The same command or workflow repeated enough times to look like a loop.",
      };
    }
    if (primary.rootCause.cause === "artifact-leak" || timeline.repeatedArtifacts.length) {
      return {
        type: "artifact-context-leak",
        severity: timeline.repeatedArtifacts.some((item) => item.sessions >= 2) ? "high" : "medium",
        summary: "Generated or low-signal artifacts repeatedly entered agent context.",
      };
    }
    if (primary.rootCause.cause === "repeated-file-read" || timeline.repeatedFiles.length) {
      return {
        type: "repeated-exploration",
        severity: timeline.repeatedFiles.some((item) => item.sessions >= 2) ? "medium" : "low",
        summary: "The agent repeatedly revisited the same files instead of converging.",
      };
    }
    if (primary.contextRisk === "High") {
      return {
        type: "stale-large-session",
        severity: "medium",
        summary: "The session reached high context pressure and should likely have split earlier.",
      };
    }
    return {
      type: "low-signal",
      severity: "low",
      summary: "No obvious incident pattern was detected.",
    };
  }

  function buildRecoveryPrompt(replay) {
    const primary = replay.receipt.primary;
    if (!primary) return "Start a coding-agent session in this repo, then rerun Prismo replay.";
    const blocked = [
      ...primary.artifactReceipt.generatedArtifacts.map((item) => item.value),
      ...replay.timeline.repeatedArtifacts.map((item) => item.value),
    ].slice(0, 8);
    const reads = primary.readReceipt.repeatedReads.slice(0, 5).map((item) => item.value);
    const lines = [];
    if (replay.incident.type === "low-signal") {
      lines.push("No high-confidence waste incident was detected. Use this as a lightweight handoff before continuing.");
    } else {
      lines.push("We are recovering from a high-waste AI coding session. Stop broad exploration and rebuild working state before continuing.");
    }
    lines.push("");
    lines.push(`Incident pattern: ${replay.incident.type} (${replay.incident.severity}).`);
    lines.push(`Root cause: ${primary.rootCause.summary}`);
    if (reads.length) lines.push(`Do not reread these unless they changed: ${reads.join(", ")}.`);
    if (blocked.length) lines.push(`Do not read these generated/noisy artifacts unless explicitly required: ${Array.from(new Set(blocked)).join(", ")}.`);
    lines.push("");
    lines.push("Before editing anything else, summarize:");
    lines.push("- files changed so far");
    lines.push("- exact failing command or error");
    lines.push("- current hypothesis");
    lines.push("- next smallest file or test to inspect");
    lines.push("");
    lines.push(`Use ${NPX_COMMAND} shield -- <command> for noisy commands.`);
    lines.push(`Use ${NPX_COMMAND} firewall <task> before the next scoped session.`);
    return lines.join("\n");
  }

  function buildReplay(options = {}) {
    const receipt = buildReceipt(options);
    const timeline = buildMultiSessionTimeline(options);
    const incident = classifyIncident(receipt, timeline);
    const primary = receipt.primary;
    const sequence = [];
    if (primary) {
      if (primary.tokens.toolOutput) {
        sequence.push({
          type: "tool-output",
          detail: `${formatTokenCount(primary.tokens.toolOutput)} tool/output tokens entered the session.`,
        });
      }
      primary.artifactReceipt.artifactGroups.forEach((group) => {
        sequence.push({
          type: "artifact-leak",
          detail: `${group.type} artifacts appeared ${group.count} time(s).`,
        });
      });
      primary.readReceipt.repeatedReads.forEach((item) => {
        sequence.push({
          type: "repeated-read",
          detail: `${item.value} appeared ${item.count} time(s).`,
        });
      });
      primary.outputReceipt.repeatedCommands.forEach((item) => {
        sequence.push({
          type: "repeated-command",
          detail: `${item.value} repeated ${item.count} time(s).`,
        });
      });
      if (primary.contextRisk === "High") {
        sequence.push({
          type: "split-needed",
          detail: "Context pressure reached High; future work should split at a task boundary.",
        });
      }
    }

    const replay = {
      schemaVersion: 1,
      command: "replay",
      generatedAt: new Date().toISOString(),
      scannedPath: receipt.scannedPath,
      tool: receipt.tool,
      incident,
      sequence,
      receipt,
      timeline,
      recoveryPrompt: "",
      next: primary
        ? [
            ...primary.nextRun,
            `${NPX_COMMAND} timeline --last ${Math.max(timeline.sessionsAnalyzed || 5, 5)}`,
          ]
        : receipt.next,
    };
    replay.recoveryPrompt = buildRecoveryPrompt(replay);
    return replay;
  }

  function renderReplayTerminal(replay) {
    const lines = [];
    lines.push("");
    lines.push("Prismo Incident Replay");
    lines.push("");
    lines.push(`Incident: ${replay.incident.type} (${replay.incident.severity})`);
    lines.push(replay.incident.summary);
    lines.push("");
    if (!replay.receipt.primary) {
      lines.push("No session evidence available yet.");
      lines.push(`Next: ${replay.next[0]}`);
      return lines.join("\n");
    }
    lines.push("What Happened");
    if (replay.sequence.length) replay.sequence.slice(0, 10).forEach((event) => lines.push(`- ${event.type}: ${event.detail}`));
    else lines.push("- No high-signal sequence detected.");
    lines.push("");
    lines.push("Why It Matters");
    lines.push(`- Root cause: ${replay.receipt.primary.rootCause.summary}`);
    lines.push(`- Sessions analyzed: ${replay.timeline.sessionsAnalyzed}`);
    if (replay.timeline.repeatedArtifacts.length) {
      lines.push(`- Recurring artifacts: ${replay.timeline.repeatedArtifacts.slice(0, 3).map((item) => item.value).join(", ")}`);
    }
    if (replay.timeline.repeatedFiles.length) {
      lines.push(`- Recurring repeated reads: ${replay.timeline.repeatedFiles.slice(0, 3).map((item) => item.value).join(", ")}`);
    }
    lines.push("");
    lines.push("Recovery Prompt");
    lines.push(replay.recoveryPrompt);
    lines.push("");
    lines.push("Next");
    replay.next.slice(0, 5).forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    return lines.join("\n");
  }

  return {
    buildReplay,
    renderReplayTerminal,
  };
};
