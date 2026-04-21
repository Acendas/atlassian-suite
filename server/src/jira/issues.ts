// Jira issue lifecycle tools: get, create, update, delete, transitions, comments, worklogs, links, watchers, changelogs.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { jiraClient } from "../common/jiraClient.js";
import { markdownToAdf, resolveAdfBody } from "../common/adf.js";
import { safeJira, ensureWritable } from "./_helpers.js";

export interface IssueOpts {
  readOnly: boolean;
}

export function registerIssueTools(server: FastMCP, opts: IssueOpts): void {
  // ---------- Get / list ----------

  server.addTool({
    name: "jira_get_issue",
    description: "Get a single Jira issue by key or id.",
    parameters: z.object({
      issue_key: z.string(),
      fields: z.array(z.string()).optional(),
      expand: z.array(z.string()).optional(),
    }),
    execute: async (args: { issue_key: string; fields?: string[]; expand?: string[] }) =>
      safeJira(() =>
        jiraClient().issues.getIssue({
          issueIdOrKey: args.issue_key,
          fields: args.fields,
          expand: args.expand?.join(","),
        } as never),
      ),
  });

  server.addTool({
    name: "jira_get_issue_dates",
    description:
      "Get the date-typed fields on an issue (created, updated, duedate, resolutiondate, plus custom date fields).",
    parameters: z.object({ issue_key: z.string() }),
    execute: async (args: { issue_key: string }) =>
      safeJira(async () => {
        const issue: any = await jiraClient().issues.getIssue({
          issueIdOrKey: args.issue_key,
          fields: ["created", "updated", "duedate", "resolutiondate"],
        } as never);
        return {
          key: issue.key,
          created: issue.fields?.created,
          updated: issue.fields?.updated,
          duedate: issue.fields?.duedate ?? null,
          resolutiondate: issue.fields?.resolutiondate ?? null,
        };
      }),
  });

  // ---------- Create / update / delete ----------

  const issueFields = z.object({
    project_key: z.string(),
    summary: z.string(),
    issue_type: z.string().describe("e.g. Bug, Story, Task"),
    description: z.string().optional().describe("Markdown — converted to ADF"),
    description_adf: z
      .any()
      .optional()
      .describe("Pre-built ADF JSON for description (preferred for charts/panels/mentions)"),
    priority: z.string().optional(),
    labels: z.array(z.string()).optional(),
    assignee_account_id: z.string().optional(),
    components: z.array(z.string()).optional(),
    parent_key: z.string().optional().describe("Parent issue key (for sub-tasks/Epic link)"),
    fix_versions: z.array(z.string()).optional(),
    custom_fields: z
      .record(z.string(), z.any())
      .optional()
      .describe("Object of customfield_XXXXX → value"),
  });

  const buildFields = (raw: z.infer<typeof issueFields>): Record<string, unknown> => {
    const fields: Record<string, unknown> = {
      project: { key: raw.project_key },
      summary: raw.summary,
      issuetype: { name: raw.issue_type },
    };
    if (raw.description_adf !== undefined) {
      fields.description = resolveAdfBody({
        body_adf: raw.description_adf,
        context: "description_adf",
      });
    } else if (raw.description) {
      fields.description = markdownToAdf(raw.description);
    }
    if (raw.priority) fields.priority = { name: raw.priority };
    if (raw.labels) fields.labels = raw.labels;
    if (raw.assignee_account_id) fields.assignee = { accountId: raw.assignee_account_id };
    if (raw.components) fields.components = raw.components.map((name) => ({ name }));
    if (raw.parent_key) fields.parent = { key: raw.parent_key };
    if (raw.fix_versions) fields.fixVersions = raw.fix_versions.map((name) => ({ name }));
    if (raw.custom_fields) Object.assign(fields, raw.custom_fields);
    return fields;
  };

  server.addTool({
    name: "jira_create_issue",
    description: "Create a Jira issue. Description is treated as Markdown and converted to ADF.",
    parameters: issueFields,
    execute: async (args: z.infer<typeof issueFields>) =>
      safeJira(() => {
        ensureWritable(opts.readOnly);
        return jiraClient().issues.createIssue({ fields: buildFields(args) } as never);
      }),
  });

  server.addTool({
    name: "jira_batch_create_issues",
    description: "Create multiple Jira issues in one call.",
    parameters: z.object({ issues: z.array(issueFields).min(1).max(50) }),
    execute: async (args: { issues: z.infer<typeof issueFields>[] }) =>
      safeJira(() => {
        ensureWritable(opts.readOnly);
        return jiraClient().issues.createIssues({
          issueUpdates: args.issues.map((i) => ({ fields: buildFields(i) })),
        } as never);
      }),
  });

  server.addTool({
    name: "jira_update_issue",
    description: "Update fields on an existing Jira issue.",
    parameters: z.object({
      issue_key: z.string(),
      summary: z.string().optional(),
      description: z.string().optional().describe("Markdown — converted to ADF"),
      description_adf: z.any().optional().describe("Pre-built ADF JSON (preferred for complex content)"),
      priority: z.string().optional(),
      labels: z.array(z.string()).optional(),
      assignee_account_id: z.string().optional(),
      fix_versions: z.array(z.string()).optional(),
      custom_fields: z.record(z.string(), z.any()).optional(),
    }),
    execute: async (args: {
      issue_key: string;
      summary?: string;
      description?: string;
      description_adf?: unknown;
      priority?: string;
      labels?: string[];
      assignee_account_id?: string;
      fix_versions?: string[];
      custom_fields?: Record<string, unknown>;
    }) =>
      safeJira(() => {
        ensureWritable(opts.readOnly);
        const fields: Record<string, unknown> = {};
        if (args.summary !== undefined) fields.summary = args.summary;
        if (args.description_adf !== undefined) {
          fields.description = resolveAdfBody({
            body_adf: args.description_adf,
            context: "description_adf",
          });
        } else if (args.description !== undefined) {
          fields.description = markdownToAdf(args.description);
        }
        if (args.priority !== undefined) fields.priority = { name: args.priority };
        if (args.labels !== undefined) fields.labels = args.labels;
        if (args.assignee_account_id !== undefined)
          fields.assignee = { accountId: args.assignee_account_id };
        if (args.fix_versions !== undefined)
          fields.fixVersions = args.fix_versions.map((name) => ({ name }));
        if (args.custom_fields) Object.assign(fields, args.custom_fields);
        return jiraClient().issues.editIssue({
          issueIdOrKey: args.issue_key,
          fields,
        } as never);
      }),
  });

  server.addTool({
    name: "jira_delete_issue",
    description: "Delete a Jira issue.",
    parameters: z.object({
      issue_key: z.string(),
      delete_subtasks: z.boolean().default(false),
    }),
    execute: async (args: { issue_key: string; delete_subtasks: boolean }) =>
      safeJira(() => {
        ensureWritable(opts.readOnly);
        return jiraClient().issues.deleteIssue({
          issueIdOrKey: args.issue_key,
          deleteSubtasks: args.delete_subtasks,
        } as never);
      }),
  });

  // ---------- Transitions ----------

  server.addTool({
    name: "jira_get_transitions",
    description: "List available workflow transitions for an issue.",
    parameters: z.object({ issue_key: z.string() }),
    execute: async (args: { issue_key: string }) =>
      safeJira(() =>
        jiraClient().issues.getTransitions({ issueIdOrKey: args.issue_key } as never),
      ),
  });

  server.addTool({
    name: "jira_transition_issue",
    description: "Transition an issue to a new workflow state.",
    parameters: z.object({
      issue_key: z.string(),
      transition_id: z.string(),
      comment: z.string().optional().describe("Optional comment markdown to attach"),
    }),
    execute: async (args: { issue_key: string; transition_id: string; comment?: string }) =>
      safeJira(() => {
        ensureWritable(opts.readOnly);
        const payload: Record<string, unknown> = {
          issueIdOrKey: args.issue_key,
          transition: { id: args.transition_id },
        };
        if (args.comment) {
          payload.update = {
            comment: [{ add: { body: markdownToAdf(args.comment) } }],
          };
        }
        return jiraClient().issues.doTransition(payload as never);
      }),
  });

  // ---------- Comments ----------

  server.addTool({
    name: "jira_add_comment",
    description:
      "Add a comment to an issue. Provide body via Markdown (auto-converted to ADF) OR body_adf (pre-built ADF, preferred for charts/panels/mentions).",
    parameters: z.object({
      issue_key: z.string(),
      body: z.string().optional().describe("Markdown comment body"),
      body_adf: z.any().optional().describe("Pre-built ADF JSON object"),
      parent_id: z.string().optional().describe("If set, posts as a threaded reply"),
    }),
    execute: async (args: {
      issue_key: string;
      body?: string;
      body_adf?: unknown;
      parent_id?: string;
    }) =>
      safeJira(() => {
        ensureWritable(opts.readOnly);
        const adfBody = resolveAdfBody({
          body_adf: args.body_adf,
          body: args.body,
          context: "jira_add_comment.body",
        });
        return jiraClient().issueComments.addComment({
          issueIdOrKey: args.issue_key,
          comment: adfBody,
          parentId: args.parent_id,
        } as never);
      }),
  });

  server.addTool({
    name: "jira_edit_comment",
    description: "Edit an existing comment. Body is Markdown by default; use body_adf for ADF.",
    parameters: z.object({
      issue_key: z.string(),
      comment_id: z.string(),
      body: z.string().optional(),
      body_adf: z.any().optional(),
    }),
    execute: async (args: {
      issue_key: string;
      comment_id: string;
      body?: string;
      body_adf?: unknown;
    }) =>
      safeJira(() => {
        ensureWritable(opts.readOnly);
        const adfBody = resolveAdfBody({
          body_adf: args.body_adf,
          body: args.body,
          context: "jira_edit_comment.body",
        });
        return jiraClient().issueComments.updateComment({
          issueIdOrKey: args.issue_key,
          id: args.comment_id,
          body: adfBody,
        } as never);
      }),
  });

  server.addTool({
    name: "jira_delete_comment",
    description:
      "Permanently delete a comment from an issue. Destructive — Jira has no comment trash.",
    parameters: z.object({
      issue_key: z.string(),
      comment_id: z.string(),
    }),
    execute: async (args: { issue_key: string; comment_id: string }) =>
      safeJira(async () => {
        ensureWritable(opts.readOnly);
        await jiraClient().issueComments.deleteComment({
          issueIdOrKey: args.issue_key,
          id: args.comment_id,
        } as never);
        return { deleted: true, issue_key: args.issue_key, comment_id: args.comment_id };
      }),
  });

  // ---------- Worklog ----------

  server.addTool({
    name: "jira_add_worklog",
    description: "Log work against an issue (e.g. '30m', '2h', '1d').",
    parameters: z.object({
      issue_key: z.string(),
      time_spent: z.string().describe("e.g. '2h 30m', '1d', '45m'"),
      comment: z.string().optional().describe("Markdown comment"),
      comment_adf: z.any().optional().describe("Pre-built ADF JSON for the comment"),
      started: z.string().optional().describe("ISO 8601 timestamp; default now"),
    }),
    execute: async (args: {
      issue_key: string;
      time_spent: string;
      comment?: string;
      comment_adf?: unknown;
      started?: string;
    }) =>
      safeJira(() => {
        ensureWritable(opts.readOnly);
        let commentBody: unknown;
        if (args.comment_adf !== undefined) {
          commentBody = resolveAdfBody({
            body_adf: args.comment_adf,
            context: "jira_add_worklog.comment_adf",
          });
        } else if (args.comment) {
          commentBody = markdownToAdf(args.comment);
        }
        return jiraClient().issueWorklogs.addWorklog({
          issueIdOrKey: args.issue_key,
          timeSpent: args.time_spent,
          comment: commentBody,
          started: args.started,
        } as never);
      }),
  });

  server.addTool({
    name: "jira_get_worklog",
    description: "Get worklogs for an issue.",
    parameters: z.object({ issue_key: z.string() }),
    execute: async (args: { issue_key: string }) =>
      safeJira(() =>
        jiraClient().issueWorklogs.getIssueWorklog({ issueIdOrKey: args.issue_key } as never),
      ),
  });

  // ---------- Links ----------

  server.addTool({
    name: "jira_get_link_types",
    description: "List Jira issue link types (e.g. Blocks, Relates, Duplicates).",
    parameters: z.object({}),
    execute: async () => safeJira(() => jiraClient().issueLinkTypes.getIssueLinkTypes()),
  });

  server.addTool({
    name: "jira_create_issue_link",
    description: "Link two Jira issues with a given link type.",
    parameters: z.object({
      inward_issue_key: z.string(),
      outward_issue_key: z.string(),
      link_type: z.string().describe("Link type name (e.g. 'Blocks', 'Relates')"),
      comment: z.string().optional(),
    }),
    execute: async (args: {
      inward_issue_key: string;
      outward_issue_key: string;
      link_type: string;
      comment?: string;
    }) =>
      safeJira(() => {
        ensureWritable(opts.readOnly);
        return jiraClient().issueLinks.linkIssues({
          inwardIssue: { key: args.inward_issue_key },
          outwardIssue: { key: args.outward_issue_key },
          type: { name: args.link_type },
          comment: args.comment ? { body: markdownToAdf(args.comment) } : undefined,
        } as never);
      }),
  });

  server.addTool({
    name: "jira_remove_issue_link",
    description: "Remove an issue link by link id.",
    parameters: z.object({ link_id: z.string() }),
    execute: async (args: { link_id: string }) =>
      safeJira(() => {
        ensureWritable(opts.readOnly);
        return jiraClient().issueLinks.deleteIssueLink({ linkId: args.link_id } as never);
      }),
  });

  server.addTool({
    name: "jira_create_remote_issue_link",
    description: "Add a remote (web) link to an issue, e.g. linking a Bitbucket PR.",
    parameters: z.object({
      issue_key: z.string(),
      url: z.string().url(),
      title: z.string(),
      relationship: z.string().optional().describe("e.g. 'implements', 'fixes'"),
      icon_url: z.string().url().optional(),
    }),
    execute: async (args: {
      issue_key: string;
      url: string;
      title: string;
      relationship?: string;
      icon_url?: string;
    }) =>
      safeJira(() => {
        ensureWritable(opts.readOnly);
        return jiraClient().issueRemoteLinks.createOrUpdateRemoteIssueLink({
          issueIdOrKey: args.issue_key,
          relationship: args.relationship,
          object: {
            url: args.url,
            title: args.title,
            icon: args.icon_url ? { url16x16: args.icon_url } : undefined,
          },
        } as never);
      }),
  });

  server.addTool({
    name: "jira_list_remote_issue_links",
    description:
      "List all remote (web) links on an issue — useful for investigating what PRs, docs, or external resources are attached. Returns an array of {id, self, relationship, object: {url, title, icon, ...}}.",
    parameters: z.object({
      issue_key: z.string(),
      global_id: z
        .string()
        .optional()
        .describe(
          "Filter by an app-specific globalId (e.g. Bitbucket PR links use a deterministic globalId). Leave unset to list all.",
        ),
    }),
    execute: async (args: { issue_key: string; global_id?: string }) =>
      safeJira(() =>
        jiraClient().issueRemoteLinks.getRemoteIssueLinks({
          issueIdOrKey: args.issue_key,
          globalId: args.global_id,
        } as never),
      ),
  });

  server.addTool({
    name: "jira_delete_remote_issue_link",
    description:
      "Remove a remote (web) link from an issue. Accepts either the numeric link_id (from jira_list_remote_issue_links) OR a globalId via the global_id arg. Destructive.",
    parameters: z.object({
      issue_key: z.string(),
      link_id: z.string().optional(),
      global_id: z
        .string()
        .optional()
        .describe("Alternative to link_id — delete the link matching this globalId"),
    }),
    execute: async (args: { issue_key: string; link_id?: string; global_id?: string }) =>
      safeJira(async () => {
        ensureWritable(opts.readOnly);
        if (!args.link_id && !args.global_id) {
          throw new Error("jira_delete_remote_issue_link requires link_id or global_id");
        }
        if (args.link_id) {
          await jiraClient().issueRemoteLinks.deleteRemoteIssueLinkById({
            issueIdOrKey: args.issue_key,
            linkId: args.link_id,
          } as never);
          return { deleted: true, issue_key: args.issue_key, link_id: args.link_id };
        }
        await jiraClient().issueRemoteLinks.deleteRemoteIssueLinkByGlobalId({
          issueIdOrKey: args.issue_key,
          globalId: args.global_id,
        } as never);
        return { deleted: true, issue_key: args.issue_key, global_id: args.global_id };
      }),
  });

  server.addTool({
    name: "jira_link_to_epic",
    description: "Set the parent (Epic Link) on an issue.",
    parameters: z.object({
      issue_key: z.string(),
      epic_key: z.string(),
    }),
    execute: async (args: { issue_key: string; epic_key: string }) =>
      safeJira(() => {
        ensureWritable(opts.readOnly);
        return jiraClient().issues.editIssue({
          issueIdOrKey: args.issue_key,
          fields: { parent: { key: args.epic_key } },
        } as never);
      }),
  });

  // ---------- Watchers ----------

  server.addTool({
    name: "jira_get_issue_watchers",
    description: "List watchers on an issue.",
    parameters: z.object({ issue_key: z.string() }),
    execute: async (args: { issue_key: string }) =>
      safeJira(() =>
        jiraClient().issueWatchers.getIssueWatchers({ issueIdOrKey: args.issue_key } as never),
      ),
  });

  server.addTool({
    name: "jira_add_watcher",
    description: "Add a watcher (account id) to an issue.",
    parameters: z.object({
      issue_key: z.string(),
      account_id: z.string(),
    }),
    execute: async (args: { issue_key: string; account_id: string }) =>
      safeJira(() => {
        ensureWritable(opts.readOnly);
        return jiraClient().issueWatchers.addWatcher({
          issueIdOrKey: args.issue_key,
          accountId: args.account_id,
        } as never);
      }),
  });

  server.addTool({
    name: "jira_remove_watcher",
    description: "Remove a watcher (account id) from an issue.",
    parameters: z.object({
      issue_key: z.string(),
      account_id: z.string(),
    }),
    execute: async (args: { issue_key: string; account_id: string }) =>
      safeJira(() => {
        ensureWritable(opts.readOnly);
        return jiraClient().issueWatchers.removeWatcher({
          issueIdOrKey: args.issue_key,
          accountId: args.account_id,
        } as never);
      }),
  });

  // ---------- Changelogs ----------

  server.addTool({
    name: "jira_batch_get_changelogs",
    description: "Get changelogs for an issue (paginated).",
    parameters: z.object({
      issue_key: z.string(),
      max_results: z.number().int().min(1).max(100).default(50),
    }),
    execute: async (args: { issue_key: string; max_results: number }) =>
      safeJira(() =>
        jiraClient().issues.getChangeLogs({
          issueIdOrKey: args.issue_key,
          maxResults: args.max_results,
        } as never),
      ),
  });
}
