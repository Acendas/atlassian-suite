// Credential management tools — configure / inspect / clear ~/.acendas-atlassian/config.json.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import {
  loadStoredCreds,
  saveStoredCreds,
  clearStoredCreds,
  reloadStoredCreds,
  maskToken,
  configFileMode,
  mergeCreds,
  diffCreds,
  hasBackup,
  CONFIG_FILE_PATH,
  CONFIG_DIR_PATH,
  CONFIG_BACKUP_PATH,
  type StoredCreds,
} from "./credStore.js";
import {
  loadJiraConfig,
  loadConfluenceConfig,
  loadBitbucketConfig,
  isReadOnly,
} from "./config.js";

export function registerCredentialTools(server: FastMCP): void {
  server.addTool({
    name: "configure_credentials",
    description:
      `Persist Atlassian Cloud + Bitbucket Cloud credentials to ${CONFIG_FILE_PATH} (mode 0600). ` +
      `Subsequent server starts will use these without env vars. Env vars still take precedence when set, ` +
      `letting you override per-session for CI or temporary use. ` +
      `Pass only the fields you want to set/update; existing fields are preserved.`,
    parameters: z.object({
      atlassian_username: z
        .string()
        .optional()
        .describe("Shared username — fans out to Jira/Confluence/Bitbucket if those aren't set per-product"),
      atlassian_api_token: z
        .string()
        .optional()
        .describe("Shared API token — fans out to all three products"),
      jira_url: z.string().url().optional(),
      jira_username: z.string().optional().describe("Per-product override (rarely needed)"),
      jira_api_token: z.string().optional(),
      jira_projects_filter: z
        .array(z.string())
        .optional()
        .describe("Restrict Jira tools to these project keys"),
      confluence_url: z.string().url().optional(),
      confluence_username: z.string().optional(),
      confluence_api_token: z.string().optional(),
      confluence_spaces_filter: z.array(z.string()).optional(),
      bitbucket_workspace: z.string().optional(),
      bitbucket_username: z.string().optional(),
      bitbucket_api_token: z.string().optional(),
    }),
    execute: async (args: any) => {
      const before = loadStoredCreds();

      // Build the patch from tool args. Empty strings are filtered by mergeCreds.
      const patch: StoredCreds = {
        atlassian: {
          username: args.atlassian_username,
          api_token: args.atlassian_api_token,
        },
        jira: {
          url: args.jira_url,
          username: args.jira_username,
          api_token: args.jira_api_token,
          projects_filter: args.jira_projects_filter,
        },
        confluence: {
          url: args.confluence_url,
          username: args.confluence_username,
          api_token: args.confluence_api_token,
          spaces_filter: args.confluence_spaces_filter,
        },
        bitbucket: {
          workspace: args.bitbucket_workspace,
          username: args.bitbucket_username,
          api_token: args.bitbucket_api_token,
        },
      };

      const after = mergeCreds(before, patch);
      const { added, updated, preserved } = diffCreds(before, after);

      saveStoredCreds(after);
      reloadStoredCreds();

      return JSON.stringify(
        {
          ok: true,
          file: CONFIG_FILE_PATH,
          dir: CONFIG_DIR_PATH,
          backup: hasBackup() ? CONFIG_BACKUP_PATH : null,
          file_mode: configFileMode(),
          changes: {
            added,
            updated,
            preserved,
          },
          stored: maskAll(after),
          note:
            "Existing values not provided in this call were preserved — see `changes.preserved`. " +
            "A backup of the prior file is at ~/.acendas-atlassian/config.json.bak. " +
            "Restart Claude Code (or the MCP server) for the new credentials to take effect.",
        },
        null,
        2,
      );
    },
  });

  server.addTool({
    name: "get_credentials_status",
    description:
      "Report which credentials are currently configured: file path, file permissions, what's stored on file (tokens masked), what's currently effective per product, and resolution source for each value.",
    parameters: z.object({}),
    execute: async () => {
      reloadStoredCreds();
      const file = loadStoredCreds();
      const jira = loadJiraConfig();
      const confluence = loadConfluenceConfig();
      const bitbucket = loadBitbucketConfig();

      return JSON.stringify(
        {
          file_path: CONFIG_FILE_PATH,
          file_mode: configFileMode(),
          file_contents: maskAll(file),
          effective: {
            jira: jira
              ? {
                  base_url: jira.baseUrl,
                  username: jira.username,
                  api_token: maskToken(jira.apiToken),
                  projects_filter: jira.projectsFilter ?? null,
                  source: resolutionSource("jira"),
                }
              : { configured: false },
            confluence: confluence
              ? {
                  base_url: confluence.baseUrl,
                  username: confluence.username,
                  api_token: maskToken(confluence.apiToken),
                  spaces_filter: confluence.spacesFilter ?? null,
                  source: resolutionSource("confluence"),
                }
              : { configured: false },
            bitbucket: bitbucket
              ? {
                  workspace: bitbucket.workspace,
                  username: bitbucket.username,
                  api_token: maskToken(bitbucket.apiToken),
                  source: resolutionSource("bitbucket"),
                }
              : { configured: false },
            read_only: isReadOnly(),
          },
        },
        null,
        2,
      );
    },
  });

  server.addTool({
    name: "clear_credentials",
    description: `Delete the credential file at ${CONFIG_FILE_PATH}. Env vars are unaffected. Restart Claude Code afterwards.`,
    parameters: z.object({
      confirm: z
        .boolean()
        .describe("Must be true. Safety guard: tools won't delete by accident."),
    }),
    execute: async (args: any) => {
      if (!args.confirm) {
        return JSON.stringify(
          { ok: false, message: "confirm=true required to delete the credentials file." },
          null,
          2,
        );
      }
      clearStoredCreds();
      return JSON.stringify(
        {
          ok: true,
          deleted: CONFIG_FILE_PATH,
          note: "Restart Claude Code (or the MCP server) for changes to take effect.",
        },
        null,
        2,
      );
    },
  });
}

function maskAll(creds: StoredCreds): StoredCreds {
  const clone = JSON.parse(JSON.stringify(creds)) as StoredCreds;
  if (clone.atlassian?.api_token) clone.atlassian.api_token = maskToken(clone.atlassian.api_token) as any;
  if (clone.jira?.api_token) clone.jira.api_token = maskToken(clone.jira.api_token) as any;
  if (clone.confluence?.api_token) clone.confluence.api_token = maskToken(clone.confluence.api_token) as any;
  if (clone.bitbucket?.api_token) clone.bitbucket.api_token = maskToken(clone.bitbucket.api_token) as any;
  return clone;
}

function resolutionSource(product: "jira" | "confluence" | "bitbucket"): {
  url_or_workspace: string;
  username: string;
  api_token: string;
} {
  const upperProduct = product.toUpperCase();
  const urlEnv = product === "bitbucket" ? "BITBUCKET_WORKSPACE" : `${upperProduct}_URL`;
  const userEnv = `${upperProduct}_USERNAME`;
  const tokenEnv = `${upperProduct}_API_TOKEN`;
  const sharedUserEnv = "ATLASSIAN_USERNAME";
  const sharedTokenEnv = "ATLASSIAN_API_TOKEN";
  const has = (k: string): boolean => Boolean(process.env[k]);
  return {
    url_or_workspace: has(urlEnv) ? `env:${urlEnv}` : "file",
    username: has(userEnv) ? `env:${userEnv}` : has(sharedUserEnv) ? `env:${sharedUserEnv}` : "file",
    api_token: has(tokenEnv)
      ? `env:${tokenEnv}`
      : has(sharedTokenEnv)
        ? `env:${sharedTokenEnv}`
        : "file",
  };
}
