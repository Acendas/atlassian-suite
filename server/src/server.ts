#!/usr/bin/env node
// Acendas Atlassian Suite MCP server entrypoint.
// Single FastMCP server registering tools across Jira, Confluence, Bitbucket.

import { FastMCP } from "fastmcp";
import { registerBitbucketTools } from "./bitbucket/index.js";
import { runPipelineWatchCli } from "./bitbucket/_pipelineWatch.js";
import { registerJiraTools } from "./jira/index.js";
import { registerConfluenceTools } from "./confluence/index.js";
import { registerQMetryTools } from "./qmetry/index.js";
import { registerCredentialTools } from "./common/configTools.js";
import {
  loadJiraConfig,
  loadConfluenceConfig,
  loadBitbucketConfig,
  loadQMetryConfig,
  isReadOnly,
} from "./common/config.js";

// `server.js watch-pipeline …` is the follower that watch_pipeline hands to
// Claude Code's Monitor. Branch off before the MCP server exists: in this mode
// stdout is the Monitor's event stream, not JSON-RPC.
if (process.argv[2] === "watch-pipeline") {
  void runPipelineWatchCli(process.argv.slice(3));
} else {
  startServer();
}

function startServer(): void {
  const server = new FastMCP({
    name: "Acendas Atlassian Suite",
    version: "0.2.1",
  });

  const jiraReady = loadJiraConfig() !== null;
  const confluenceReady = loadConfluenceConfig() !== null;
  const bitbucketReady = loadBitbucketConfig() !== null;
  const qmetryReady = loadQMetryConfig() !== null;
  const readOnly = isReadOnly();

  console.error(
    `[acendas-atlassian] starting. jira=${jiraReady} confluence=${confluenceReady} bitbucket=${bitbucketReady} qmetry=${qmetryReady} read_only=${readOnly}`,
  );

  // Credential tools are always available so the user can configure / inspect / clear
  // credentials before any product is configured.
  registerCredentialTools(server);

  if (jiraReady) registerJiraTools(server, { readOnly });
  if (confluenceReady) registerConfluenceTools(server, { readOnly });
  if (bitbucketReady) registerBitbucketTools(server, { readOnly });
  if (qmetryReady) registerQMetryTools(server, { readOnly });

  if (!jiraReady && !confluenceReady && !bitbucketReady) {
    console.error(
      "[acendas-atlassian] WARNING: no products configured. Set JIRA_URL, CONFLUENCE_URL, and/or BITBUCKET_WORKSPACE plus credentials.",
    );
  }

  server.start({ transportType: "stdio" });
}
