// Confluence tool registration entry point.

import type { FastMCP } from "fastmcp";
import { confluenceIsConfigured } from "../common/confluenceClient.js";
import { registerPageTools } from "./pages.js";
import { registerCommentTools } from "./comments.js";
import { registerSpaceTools } from "./spaces.js";
import { registerLabelAndAttachmentTools } from "./labels.js";
import { registerDiffTools } from "./diff.js";
import { registerEditTools } from "./edits.js";

export interface RegisterOptions {
  readOnly: boolean;
}

export function registerConfluenceTools(server: FastMCP, opts: RegisterOptions): void {
  if (!confluenceIsConfigured()) {
    console.error("[acendas-atlassian] Confluence: not configured, skipping tool registration.");
    return;
  }
  registerPageTools(server, opts);
  registerCommentTools(server, opts);
  registerSpaceTools(server);
  registerLabelAndAttachmentTools(server, opts);
  registerDiffTools(server);
  registerEditTools(server, opts);
}
