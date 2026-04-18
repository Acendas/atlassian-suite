// Bitbucket setup + config-status tools.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute } from "./_helpers.js";
import { loadBitbucketConfig } from "../common/config.js";

export function registerConfigTools(server: FastMCP, ctx: BitbucketContext): void {
  server.addTool({
    name: "setup_bitbucket",
    description:
      "Validate Bitbucket Cloud credentials by hitting /user and the workspace endpoint. " +
      "Does not persist anything — env-var-based configuration is used at server startup. " +
      "Use this to verify a token works before relying on it.",
    parameters: z.object({
      workspace: z.string().describe("Bitbucket workspace slug"),
      username: z.string().describe("Atlassian account email"),
      api_token: z.string().describe("Atlassian API token"),
    }),
    execute: async (args) =>
      safeExecute(async () => {
        const auth = "Basic " + Buffer.from(`${args.username}:${args.api_token}`).toString("base64");
        const userRes = await fetch("https://api.bitbucket.org/2.0/user", {
          headers: { Authorization: auth, Accept: "application/json" },
        });
        if (userRes.status === 401) {
          return { ok: false, message: "Invalid credentials (401 from /user)." };
        }
        const wsRes = await fetch(
          `https://api.bitbucket.org/2.0/workspaces/${encodeURIComponent(args.workspace)}`,
          { headers: { Authorization: auth, Accept: "application/json" } },
        );
        if (wsRes.status === 404) {
          return { ok: false, message: `Workspace '${args.workspace}' not found.` };
        }
        if (wsRes.status === 403) {
          return { ok: false, message: `No permission to access workspace '${args.workspace}'.` };
        }
        if (!wsRes.ok) {
          return {
            ok: false,
            message: `Workspace check failed: ${wsRes.status} ${wsRes.statusText}`,
          };
        }
        return {
          ok: true,
          message: `Credentials valid for workspace '${args.workspace}'. Set BITBUCKET_USERNAME, BITBUCKET_API_TOKEN, BITBUCKET_WORKSPACE in your environment to use them.`,
        };
      }),
  });

  server.addTool({
    name: "get_config_status",
    description:
      "Check whether Bitbucket is configured (env vars present) and which workspace is active.",
    parameters: z.object({}),
    execute: async () =>
      safeExecute(async () => {
        const cfg = loadBitbucketConfig();
        return {
          configured: cfg !== null,
          workspace: cfg?.workspace ?? null,
          username: cfg?.username ?? null,
          read_only: ctx.readOnly,
        };
      }),
  });
}
