// Jira Agile (boards, sprints, backlog) tools.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { jiraAgileClient } from "../common/jiraClient.js";
import { safeJira, ensureWritable } from "./_helpers.js";
import {
  AGILE_BULK_MAX,
  BACKLOG_FIELDS,
  assertRankRequest,
  estimationFieldId,
  summarizeRank,
} from "./_backlog.js";

export interface AgileOpts {
  readOnly: boolean;
}

export function registerAgileTools(server: FastMCP, opts: AgileOpts): void {
  server.addTool({
    name: "jira_get_agile_boards",
    description: "List agile boards (Scrum/Kanban).",
    parameters: z.object({
      type: z.enum(["scrum", "kanban", "simple"]).optional(),
      name: z.string().optional().describe("Filter by board name"),
      project_key_or_id: z.string().optional(),
      max_results: z.number().int().min(1).max(50).default(50),
    }),
    execute: async (args: {
      type?: "scrum" | "kanban" | "simple";
      name?: string;
      project_key_or_id?: string;
      max_results: number;
    }) =>
      safeJira(() =>
        jiraAgileClient().board.getAllBoards({
          type: args.type,
          name: args.name,
          projectKeyOrId: args.project_key_or_id,
          maxResults: args.max_results,
        } as never),
      ),
  });

  server.addTool({
    name: "jira_get_board_issues",
    description: "List issues on a board (across sprints + backlog).",
    parameters: z.object({
      board_id: z.number().int().positive(),
      jql: z.string().optional(),
      fields: z.array(z.string()).optional(),
      max_results: z.number().int().min(1).max(100).default(50),
      start_at: z.number().int().min(0).default(0),
    }),
    execute: async (args: {
      board_id: number;
      jql?: string;
      fields?: string[];
      max_results: number;
      start_at: number;
    }) =>
      safeJira(() =>
        jiraAgileClient().board.getIssuesForBoard({
          boardId: args.board_id,
          jql: args.jql,
          fields: args.fields,
          maxResults: args.max_results,
          startAt: args.start_at,
        } as never),
      ),
  });

  server.addTool({
    name: "jira_get_sprints_from_board",
    description: "List sprints for a board, filtered by state.",
    parameters: z.object({
      board_id: z.number().int().positive(),
      state: z.enum(["active", "future", "closed"]).optional(),
      max_results: z.number().int().min(1).max(50).default(50),
    }),
    execute: async (args: {
      board_id: number;
      state?: "active" | "future" | "closed";
      max_results: number;
    }) =>
      safeJira(() =>
        jiraAgileClient().board.getAllSprints({
          boardId: args.board_id,
          state: args.state,
          maxResults: args.max_results,
        } as never),
      ),
  });

  server.addTool({
    name: "jira_get_sprint_issues",
    description: "List issues in a sprint.",
    parameters: z.object({
      sprint_id: z.number().int().positive(),
      fields: z.array(z.string()).optional(),
      max_results: z.number().int().min(1).max(100).default(50),
      start_at: z.number().int().min(0).default(0),
    }),
    execute: async (args: {
      sprint_id: number;
      fields?: string[];
      max_results: number;
      start_at: number;
    }) =>
      safeJira(() =>
        jiraAgileClient().sprint.getIssuesForSprint({
          sprintId: args.sprint_id,
          fields: args.fields,
          maxResults: args.max_results,
          startAt: args.start_at,
        } as never),
      ),
  });

  server.addTool({
    name: "jira_create_sprint",
    description: "Create a new sprint on a board.",
    parameters: z.object({
      name: z.string(),
      origin_board_id: z.number().int().positive(),
      start_date: z.string().optional().describe("ISO 8601"),
      end_date: z.string().optional().describe("ISO 8601"),
      goal: z.string().optional(),
    }),
    execute: async (args: {
      name: string;
      origin_board_id: number;
      start_date?: string;
      end_date?: string;
      goal?: string;
    }) =>
      safeJira(() => {
        ensureWritable(opts.readOnly);
        return jiraAgileClient().sprint.createSprint({
          name: args.name,
          originBoardId: args.origin_board_id,
          startDate: args.start_date,
          endDate: args.end_date,
          goal: args.goal,
        } as never);
      }),
  });

  server.addTool({
    name: "jira_update_sprint",
    description:
      "Partially update a sprint. Use to start (state=active+dates), close (state=closed), rename, or update goal.",
    parameters: z.object({
      sprint_id: z.number().int().positive(),
      name: z.string().optional(),
      state: z.enum(["active", "closed", "future"]).optional(),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      goal: z.string().optional(),
    }),
    execute: async (args: {
      sprint_id: number;
      name?: string;
      state?: "active" | "closed" | "future";
      start_date?: string;
      end_date?: string;
      goal?: string;
    }) =>
      safeJira(() => {
        ensureWritable(opts.readOnly);
        return jiraAgileClient().sprint.partiallyUpdateSprint({
          sprintId: args.sprint_id,
          name: args.name,
          state: args.state,
          startDate: args.start_date,
          endDate: args.end_date,
          goal: args.goal,
        } as never);
      }),
  });

  server.addTool({
    name: "jira_add_issues_to_sprint",
    description:
      "Move issues into a sprint, optionally ranking them before/after an anchor issue. Max 50 per call.",
    parameters: z.object({
      sprint_id: z.number().int().positive(),
      issue_keys: z.array(z.string()).min(1).max(AGILE_BULK_MAX),
      rank_before_issue: z.string().optional(),
      rank_after_issue: z.string().optional(),
    }),
    execute: async (args: {
      sprint_id: number;
      issue_keys: string[];
      rank_before_issue?: string;
      rank_after_issue?: string;
    }) =>
      safeJira(async () => {
        ensureWritable(opts.readOnly);
        assertRankRequest(args.issue_keys, args.rank_before_issue, args.rank_after_issue, true);
        await jiraAgileClient().sprint.moveIssuesToSprintAndRank({
          sprintId: args.sprint_id,
          issues: args.issue_keys,
          rankBeforeIssue: args.rank_before_issue,
          rankAfterIssue: args.rank_after_issue,
        } as never);
        return { moved: args.issue_keys, sprint_id: args.sprint_id };
      }),
  });

  // ---------- Backlog ordering ----------

  server.addTool({
    name: "jira_get_backlog_issues",
    description:
      "List a board's backlog (issues in no active/future sprint) in rank order, top first. " +
      "Adds the board's story-points field automatically and reports its id as estimation_field.",
    parameters: z.object({
      board_id: z.number().int().positive(),
      jql: z.string().optional().describe("Extra filter within the backlog"),
      fields: z.array(z.string()).optional(),
      max_results: z.number().int().min(1).max(100).default(50),
      start_at: z.number().int().min(0).default(0),
    }),
    execute: async (args: {
      board_id: number;
      jql?: string;
      fields?: string[];
      max_results: number;
      start_at: number;
    }) =>
      safeJira(async () => {
        const agile = jiraAgileClient();
        // Estimation field is best-effort: a board without estimation (or a
        // token that can't read config) still returns the backlog.
        let estimation_field: string | undefined;
        try {
          estimation_field = estimationFieldId(
            await agile.board.getConfiguration({ boardId: args.board_id } as never),
          );
        } catch {
          estimation_field = undefined;
        }
        const fields = [...(args.fields ?? BACKLOG_FIELDS)];
        if (estimation_field && !fields.includes(estimation_field)) fields.push(estimation_field);
        const page = await agile.board.getIssuesForBacklog({
          boardId: args.board_id,
          jql: args.jql,
          fields,
          maxResults: args.max_results,
          startAt: args.start_at,
        } as never);
        return { estimation_field: estimation_field ?? null, ...(page as object) };
      }),
  });

  server.addTool({
    name: "jira_rank_issues",
    description:
      "Reorder the backlog: rank issues before or after an anchor issue. The listed issues keep their " +
      "relative order. Max 50 per call. Reports per-issue failures; never trust a rank not in `ranked`.",
    parameters: z.object({
      issue_keys: z.array(z.string()).min(1).max(AGILE_BULK_MAX).describe("Issues to move, in desired order"),
      rank_before_issue: z.string().optional().describe("Place the issues directly above this issue"),
      rank_after_issue: z.string().optional().describe("Place the issues directly below this issue"),
      rank_custom_field_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Rank field numeric id; omit to use the site's default Rank field"),
    }),
    execute: async (args: {
      issue_keys: string[];
      rank_before_issue?: string;
      rank_after_issue?: string;
      rank_custom_field_id?: number;
    }) =>
      safeJira(async () => {
        ensureWritable(opts.readOnly);
        assertRankRequest(args.issue_keys, args.rank_before_issue, args.rank_after_issue);
        const response = await jiraAgileClient().issue.rankIssues({
          issues: args.issue_keys,
          rankBeforeIssue: args.rank_before_issue,
          rankAfterIssue: args.rank_after_issue,
          rankCustomFieldId: args.rank_custom_field_id,
        } as never);
        return summarizeRank(args.issue_keys, response, {
          before: args.rank_before_issue,
          after: args.rank_after_issue,
        });
      }),
  });

  server.addTool({
    name: "jira_move_issues_to_backlog",
    description: "Remove issues from their sprint and put them back on the backlog. Max 50 per call.",
    parameters: z.object({
      issue_keys: z.array(z.string()).min(1).max(AGILE_BULK_MAX),
    }),
    execute: async (args: { issue_keys: string[] }) =>
      safeJira(async () => {
        ensureWritable(opts.readOnly);
        assertRankRequest(args.issue_keys, undefined, undefined, true);
        await jiraAgileClient().backlog.moveIssuesToBacklog({ issues: args.issue_keys } as never);
        return { moved_to_backlog: args.issue_keys };
      }),
  });

  server.addTool({
    name: "jira_get_board_configuration",
    description:
      "Get a board's configuration: filter, columns, ranking field and estimation (story points) field id.",
    parameters: z.object({ board_id: z.number().int().positive() }),
    execute: async (args: { board_id: number }) =>
      safeJira(async () => {
        const config = await jiraAgileClient().board.getConfiguration({ boardId: args.board_id } as never);
        return { estimation_field: estimationFieldId(config) ?? null, ...(config as object) };
      }),
  });
}
