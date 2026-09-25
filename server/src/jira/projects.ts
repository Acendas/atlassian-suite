// Project, version, component, and user tools.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { jiraClient } from "../common/jiraClient.js";
import { safeJira, ensureWritable } from "./_helpers.js";

export interface ProjectOpts {
  readOnly: boolean;
}

export function registerProjectTools(server: FastMCP, opts: ProjectOpts): void {
  server.addTool({
    name: "jira_get_all_projects",
    description: "List all Jira projects visible to the authenticated user.",
    parameters: z.object({}),
    execute: async () =>
      safeJira(() => jiraClient().projects.searchProjects({ maxResults: 100 } as never)),
  });

  server.addTool({
    name: "jira_get_project_components",
    description: "List components for a project.",
    parameters: z.object({ project_key: z.string() }),
    execute: async (args: { project_key: string }) =>
      safeJira(() =>
        jiraClient().projectComponents.getProjectComponents({
          projectIdOrKey: args.project_key,
        } as never),
      ),
  });

  server.addTool({
    name: "jira_get_project_versions",
    description: "List versions (e.g. fixVersions) for a project.",
    parameters: z.object({ project_key: z.string() }),
    execute: async (args: { project_key: string }) =>
      safeJira(() =>
        jiraClient().projectVersions.getProjectVersions({
          projectIdOrKey: args.project_key,
        } as never),
      ),
  });

  server.addTool({
    name: "jira_create_version",
    description: "Create a new version on a project.",
    parameters: z.object({
      project_id: z.string().describe("Project numeric id (not key)"),
      name: z.string(),
      description: z.string().optional(),
      release_date: z.string().optional().describe("YYYY-MM-DD"),
      released: z.boolean().default(false),
    }),
    execute: async (args: {
      project_id: string;
      name: string;
      description?: string;
      release_date?: string;
      released: boolean;
    }) =>
      safeJira(() => {
        ensureWritable(opts.readOnly);
        return jiraClient().projectVersions.createVersion({
          projectId: Number(args.project_id),
          name: args.name,
          description: args.description,
          releaseDate: args.release_date,
          released: args.released,
        } as never);
      }),
  });

  server.addTool({
    name: "jira_update_version",
    description:
      "Update a version (release): rename, change dates, mark released/unreleased, or archive.",
    parameters: z.object({
      version_id: z.string().describe("Version id from jira_get_project_versions"),
      name: z.string().optional(),
      description: z.string().optional(),
      start_date: z.string().optional().describe("YYYY-MM-DD"),
      release_date: z.string().optional().describe("YYYY-MM-DD"),
      released: z.boolean().optional(),
      archived: z.boolean().optional(),
      move_unfixed_issues_to_version_id: z
        .string()
        .optional()
        .describe("When releasing: move this version's unresolved issues to that version id"),
    }),
    execute: async (args: {
      version_id: string;
      name?: string;
      description?: string;
      start_date?: string;
      release_date?: string;
      released?: boolean;
      archived?: boolean;
      move_unfixed_issues_to_version_id?: string;
    }) =>
      safeJira(async () => {
        ensureWritable(opts.readOnly);
        // Jira wants the target version's `self` URL here, not its id. Read it
        // back from Jira rather than building one, so the host (site vs API
        // gateway) always matches what Jira itself issued.
        let moveUnfixedIssuesTo: string | undefined;
        if (args.move_unfixed_issues_to_version_id) {
          const target = (await jiraClient().projectVersions.getVersion({
            id: args.move_unfixed_issues_to_version_id,
          } as never)) as { self?: string };
          if (!target?.self) {
            throw new Error(`Version ${args.move_unfixed_issues_to_version_id} not found (no self URL).`);
          }
          moveUnfixedIssuesTo = target.self;
        }
        return jiraClient().projectVersions.updateVersion({
          id: args.version_id,
          name: args.name,
          description: args.description,
          startDate: args.start_date,
          releaseDate: args.release_date,
          released: args.released,
          archived: args.archived,
          moveUnfixedIssuesTo,
        } as never);
      }),
  });

  server.addTool({
    name: "jira_batch_create_versions",
    description: "Create multiple versions on a project (sequential calls).",
    parameters: z.object({
      project_id: z.string(),
      versions: z
        .array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
            release_date: z.string().optional(),
            released: z.boolean().default(false),
          }),
        )
        .min(1)
        .max(50),
    }),
    execute: async (args: {
      project_id: string;
      versions: Array<{ name: string; description?: string; release_date?: string; released: boolean }>;
    }) =>
      safeJira(async () => {
        ensureWritable(opts.readOnly);
        const created: unknown[] = [];
        for (const v of args.versions) {
          const result = await jiraClient().projectVersions.createVersion({
            projectId: Number(args.project_id),
            name: v.name,
            description: v.description,
            releaseDate: v.release_date,
            released: v.released,
          } as never);
          created.push(result);
        }
        return { created_count: created.length, versions: created };
      }),
  });

  server.addTool({
    name: "jira_get_user_profile",
    description: "Look up a user by accountId or query.",
    parameters: z.object({
      account_id: z.string().optional(),
      query: z.string().optional().describe("Email or display-name query"),
    }),
    execute: async (args: { account_id?: string; query?: string }) =>
      safeJira(async () => {
        if (args.account_id) {
          return jiraClient().users.getUser({ accountId: args.account_id } as never);
        }
        if (args.query) {
          return jiraClient().userSearch.findUsers({ query: args.query } as never);
        }
        return jiraClient().myself.getCurrentUser();
      }),
  });

  server.addTool({
    name: "getJiraProjectIssueTypesMetadata",
    description:
      "List the issue types available in a project, with required fields per type. Useful before jira_create_issue.",
    parameters: z.object({ project_key: z.string() }),
    execute: async (args: { project_key: string }) =>
      safeJira(() =>
        jiraClient().issueTypes.getIssueTypesForProject({
          projectId: Number.isNaN(Number(args.project_key))
            ? (undefined as never)
            : Number(args.project_key),
        } as never),
      ),
  });
}
