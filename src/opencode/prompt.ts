import type { SummaryRequest } from "../contracts.js"

export function buildOpenCodePrompt(request: SummaryRequest): string {
  return [
    "Analyze this file for the current task.",
    `Current task: ${request.task}`,
    `Return plain text with at most ${request.maxSummaryChars} characters.`,
    "Use short bullets. Start each bullet with an exact name, type, or line number.",
    "Include only facts that help with the current task.",
    "Do not invent missing code. State when the page ends before the file ends.",
    `Path: ${request.candidate.path}`,
    `Page truncated: ${request.candidate.truncated}`,
    "",
    request.candidate.content,
  ].join("\n")
}

