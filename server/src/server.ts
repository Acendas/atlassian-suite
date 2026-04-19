#!/usr/bin/env node
// Acendas Atlassian Suite MCP server entrypoint.
// Single FastMCP server registering tools across Jira, Confluence, Bitbucket.

import { FastMCP } from "fastmcp";
import { registerBitbucketTools } from "./bitbucket/index.js";
import { registerJiraTools } from "./jira/index.js";
import { registerConfluenceTools } from "./confluence/index.js";
import { registerCredentialTools } from "./common/configTools.js";
import {
  loadJiraConfig,
  loadConfluenceConfig,
  loadBitbucketConfig,
  isReadOnly,
} from "./common/config.js";

const server = new FastMCP({
  name: "Acendas Atlassian Suite",
  version: "0.2.0",
});

const jiraReady = loadJiraConfig() !== null;
const confluenceReady = loadConfluenceConfig() !== null;
const bitbucketReady = loadBitbucketConfig() !== null;
const readOnly = isReadOnly();

console.error(
  `[acendas-atlassian] starting. jira=${jiraReady} confluence=${confluenceReady} bitbucket=${bitbucketReady} read_only=${readOnly}`,
);

// Credential tools are always available so the user can configure / inspect / clear
// credentials before any product is configured.
registerCredentialTools(server);

if (jiraReady) registerJiraTools(server, { readOnly });
if (confluenceReady) registerConfluenceTools(server, { readOnly });
if (bitbucketReady) registerBitbucketTools(server, { readOnly });

if (!jiraReady && !confluenceReady && !bitbucketReady) {
  console.error(
    "[acendas-atlassian] WARNING: no products configured. Set JIRA_URL, CONFLUENCE_URL, and/or BITBUCKET_WORKSPACE plus credentials.",
  );
}

server.start({ transportType: "stdio" });
