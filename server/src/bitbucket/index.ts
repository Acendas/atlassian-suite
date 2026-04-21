// Bitbucket Cloud tools — registered against the unified FastMCP server.
// Comprehensive coverage: PRs, branches, repos, comments, reviewers, file contents,
// commits, pipelines, code insights, native issues, snippets, webhooks, projects,
// tags, search, users, workspaces.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { loadBitbucketConfig } from "../common/config.js";
import { createBitbucketHttp, BitbucketHttpError } from "../common/http.js";
import { registerPullRequestTools } from "./pullRequests.js";
import { registerBranchTools } from "./branches.js";
import { registerRepositoryTools } from "./repositories.js";
import { registerWorkspaceTools } from "./workspace.js";
import { registerConfigTools } from "./config.js";
import { registerCommentTools } from "./comments.js";
import { registerCommitTools } from "./commits.js";
import { registerTagTools } from "./tags.js";
import { registerPipelineTools } from "./pipelines.js";
import { registerCodeInsightsTools } from "./codeInsights.js";
import { registerBitbucketIssueTools } from "./issues.js";
import { registerSnippetTools } from "./snippets.js";
import { registerWebhookTools } from "./webhooks.js";
import { registerProjectTools } from "./projects.js";
import { registerSearchTools } from "./search.js";
import { registerUserTools } from "./users.js";
import { registerWorkspaceMetadataTools } from "./workspaces.js";
import { registerDeploymentTools } from "./deployments.js";
import { registerBranchRestrictionTools } from "./branchRestrictions.js";
import { registerKeyTools } from "./deployKeys.js";
import { registerPipelineExtraTools } from "./pipelineExtras.js";
import { registerPullRequestTaskTools } from "./pullRequestTasks.js";
import { registerSourceTools } from "./source.js";

export interface RegisterOptions {
  readOnly: boolean;
}

export interface BitbucketContext {
  workspace: string;
  http: ReturnType<typeof createBitbucketHttp>;
  readOnly: boolean;
}

export function registerBitbucketTools(server: FastMCP, opts: RegisterOptions): void {
  const cfg = loadBitbucketConfig();
  if (!cfg) {
    console.error("[acendas-atlassian] Bitbucket: not configured, skipping tool registration.");
    return;
  }
  const ctx: BitbucketContext = {
    workspace: cfg.workspace,
    http: createBitbucketHttp(cfg),
    readOnly: opts.readOnly,
  };

  registerConfigTools(server, ctx);
  registerUserTools(server, ctx);
  registerWorkspaceTools(server, ctx);
  registerWorkspaceMetadataTools(server, ctx);
  registerProjectTools(server, ctx);
  registerRepositoryTools(server, ctx);
  registerBranchTools(server, ctx);
  registerTagTools(server, ctx);
  registerCommitTools(server, ctx);
  registerPullRequestTools(server, ctx);
  registerPullRequestTaskTools(server, ctx);
  registerCommentTools(server, ctx);
  registerSourceTools(server, ctx);
  registerPipelineTools(server, ctx);
  registerPipelineExtraTools(server, ctx);
  registerCodeInsightsTools(server, ctx);
  registerDeploymentTools(server, ctx);
  registerBranchRestrictionTools(server, ctx);
  registerKeyTools(server, ctx);
  registerBitbucketIssueTools(server, ctx);
  registerSnippetTools(server, ctx);
  registerWebhookTools(server, ctx);
  registerSearchTools(server, ctx);
}

export { z, type FastMCP, BitbucketHttpError };
