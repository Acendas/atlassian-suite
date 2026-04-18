// Jira tool registration entry point.

import type { FastMCP } from "fastmcp";
import { jiraIsConfigured } from "../common/jiraClient.js";
import { registerSearchTools } from "./search.js";
import { registerIssueTools } from "./issues.js";
import { registerProjectTools } from "./projects.js";
import { registerAgileTools } from "./agile.js";

export interface RegisterOptions {
  readOnly: boolean;
}

export function registerJiraTools(server: FastMCP, opts: RegisterOptions): void {
  if (!jiraIsConfigured()) {
    console.error("[acendas-atlassian] Jira: not configured, skipping tool registration.");
    return;
  }
  registerSearchTools(server);
  registerIssueTools(server, opts);
  registerProjectTools(server, opts);
  registerAgileTools(server, opts);
}
